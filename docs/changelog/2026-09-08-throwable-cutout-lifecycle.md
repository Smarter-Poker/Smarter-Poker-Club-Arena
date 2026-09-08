# Throwable Cutout Load And Cleanup Ownership

A stalled image request could hold the sequential preload queue indefinitely. Each thumbnail and raw fallback request now has a ten-second network deadline, releases its event handlers and timer when settled, and allows later retries after failure.

Cache cleanup now advances a generation. Work started before cleanup cannot recreate object URLs after image decoding or canvas encoding completes. An old failed request cannot delete the newer cached request for the same item and size.

Validation: 15 focused tests pass, including stalled thumbnail/fallback retries, cleanup during asynchronous canvas encoding, cache ownership, actual black-sphere opacity at all delivery sizes and existing cutout behavior. Full checkout TypeScript, relevant tests and production build are required before publication.
