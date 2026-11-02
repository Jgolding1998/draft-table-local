# Changelog

## 0.1.1

- Storage lock waits respect request deadlines, and transactions check expiry before commit. Timed-out changes no longer apply later when a blocked store becomes available.
- Reply drafts stay with their own feedback thread. Failed status changes revert to the last saved value.
- Batch uploads stop when the workspace quota is reached. Detail previews get a fresh retry budget when moving to another design.
- Deleting the current design continues to the next available design. Export errors appear in the app instead of starting a failed download.

## 0.1.0

- Initial local design gallery with boards, raster uploads, feedback, comparison, export and confirmed deletion.
