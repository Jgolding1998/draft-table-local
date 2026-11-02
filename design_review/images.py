"""Bounded structural validation for the two supported raster formats."""

import struct
import zlib

MAX_UPLOAD = 8 * 1024 * 1024
MAX_PIXELS = 16_000_000


def dimensions(width, height):
    if not (0 < width <= 8192 and 0 < height <= 8192 and width * height <= MAX_PIXELS):
        raise ValueError("Images must be at most 8192 pixels per side and 16 megapixels.")


def inspect_png(data):
    offset, header, compressed, ended = 8, None, [], False
    chunks, palette = 0, False
    while offset < len(data):
        chunks += 1
        if chunks > 1024 or offset + 12 > len(data):
            raise ValueError("Invalid PNG structure.")
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        if not all(65 <= letter <= 90 or 97 <= letter <= 122 for letter in kind):
            raise ValueError("Invalid PNG chunk.")
        if kind[0] < 97 and kind not in {b"IHDR", b"PLTE", b"IDAT", b"IEND"}:
            raise ValueError("Unsupported PNG chunk.")
        end = offset + 12 + length
        if end > len(data):
            raise ValueError("Truncated PNG.")
        payload = data[offset + 8:end - 4]
        checksum = struct.unpack(">I", data[end - 4:end])[0]
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != checksum:
            raise ValueError("PNG checksum failed.")
        if header is None:
            if kind != b"IHDR" or length != 13:
                raise ValueError("Missing PNG header.")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            dimensions(width, height)
            channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
            if not channels or compression or filtering or interlace:
                raise ValueError("Use a standard, non-interlaced PNG or a JPEG.")
            if depth not in ({1, 2, 4, 8} if color in {0, 3} else {8}):
                raise ValueError("Use an 8-bit PNG or a JPEG.")
            header = (width, height, (width * channels * depth + 7) // 8 + 1)
        elif kind == b"IHDR" or kind == b"acTL":
            raise ValueError("Use a single-frame PNG or a JPEG.")
        if kind == b"PLTE":
            if palette or compressed or color in {0, 4} or not length or length % 3 or length > 768:
                raise ValueError("Invalid PNG palette.")
            palette = True
        if kind == b"IDAT":
            if color == 3 and not palette:
                raise ValueError("PNG palette is missing.")
            compressed.append(payload)
        if kind == b"IEND":
            if length or end != len(data):
                raise ValueError("Unexpected bytes after PNG image.")
            ended = True
            break
        offset = end
    if not header or not compressed or not ended:
        raise ValueError("Incomplete PNG image.")
    width, height, row = header
    expected = row * height
    decoder = zlib.decompressobj()
    try:
        pixels = decoder.decompress(b"".join(compressed), expected + 1)
    except zlib.error as error:
        raise ValueError("Invalid PNG image data.") from error
    if len(pixels) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError("Invalid or oversized PNG image data.")
    if any(pixels[index] > 4 for index in range(0, expected, row)):
        raise ValueError("Invalid PNG row filter.")
    return "image/png", "png", width, height


def inspect_jpeg(data):
    if not data.endswith(b"\xff\xd9"):
        raise ValueError("Incomplete JPEG image.")
    offset, size = 2, None
    while offset < len(data) - 2:
        if data[offset] != 0xFF:
            raise ValueError("Invalid JPEG marker.")
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in {0xD8, 0xD9, 0x00} or 0xD0 <= marker <= 0xD7:
            raise ValueError("Unexpected JPEG marker.")
        if offset + 2 > len(data):
            break
        length = struct.unpack(">H", data[offset:offset + 2])[0]
        if length < 2 or offset + length > len(data):
            raise ValueError("Truncated JPEG segment.")
        if marker in {0xC0, 0xC1, 0xC2}:
            if size is not None or length < 8:
                raise ValueError("Invalid JPEG frame.")
            depth, height, width, components = struct.unpack(">BHHB", data[offset + 2:offset + 8])
            dimensions(width, height)
            if depth != 8 or components not in {1, 3, 4} or length != 8 + 3 * components:
                raise ValueError("Unsupported JPEG frame.")
            size = (width, height)
        if marker == 0xDA:
            if not size or offset + length >= len(data) - 2:
                break
            return "image/jpeg", "jpg", *size
        offset += length
    raise ValueError("Use a standard or progressive JPEG.")


def inspect_image(data, content_type):
    if not data or len(data) > MAX_UPLOAD:
        raise ValueError("Choose a PNG or JPEG of at most 8 MiB.")
    if data.startswith(b"\x89PNG\r\n\x1a\n") and content_type == "image/png":
        return inspect_png(data)
    if data.startswith(b"\xff\xd8") and content_type == "image/jpeg":
        return inspect_jpeg(data)
    raise ValueError("Only PNG and JPEG image files are supported.")
