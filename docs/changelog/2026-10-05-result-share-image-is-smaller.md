# A Smaller Tournament Result Share Image

The opaque result picture is encoded as JPEG at quality 0.9 instead of PNG.
A browser-rendered 1000 x 1420 result fell from 935,730 to 185,105 bytes, about
80% smaller, while retaining the chrome, text and payout at the same size.
The image still pre-paints before the tap so native sharing keeps its user
activation. No new dependency or first-paint module was added.

The File MIME type and filename extension follow the actual returned Blob.
Browsers that fall back to PNG therefore still share and save a correctly
named PNG. Component tests cover JPEG and PNG on both the native file-share
and download paths. Text-only sharing and cancelled-share behavior remain.

Validation: 42 card/host tests, TypeScript, production build at 312 kB initial
gzip, no new first-paint modules, and a real built-client browser share capture
with the JPEG filename and MIME type. Physical iOS share-sheet behavior after
a real tournament is not claimed by this isolated browser verification.
