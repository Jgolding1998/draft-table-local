# Design choices informed by existing tools

This app takes a narrower role than a design editor or a photo library: review a few raster directions on one computer, keep the feedback attached, and make the work easy to export.

## Feedback stays beside the design

[Penpot](https://github.com/penpot/penpot) is a mature collaborative design platform. Its [workspace-comment discussion](https://github.com/penpot/penpot/issues/10239) describes friction when people must choose between seeing feedback and acting on the design. Draft Table keeps the image and its feedback in the same detail view. This is an interaction lesson, not a claim to reproduce Penpot's editor or collaboration features.

## Deletion should say what it removes

[Immich](https://github.com/immich-app/immich) manages large personal image libraries. Its [remove-from-album discussion](https://github.com/immich-app/immich/discussions/8390) shows why removing something from a collection and deleting the original must be distinct. Draft Table uses one clear ownership model: a design belongs to one board, deleting a board removes the designs inside it, and original files outside this app are untouched. Export keeps both the review notes and original uploaded bytes together.

## Mobile controls must fit the screen

[Nextcloud Photos](https://github.com/nextcloud/photos) provides album and gallery interactions. Its [mobile overflow report and linked fix](https://github.com/nextcloud/photos/issues/3579) demonstrate how a single long action can force horizontal scrolling. Draft Table uses wrapping controls and a small-screen layout; browser checks include a 390-pixel viewport and keyboard navigation.

These are primary-source examples and issue reports reviewed during development. No implementation was copied and no benchmark against these applications has been performed.
