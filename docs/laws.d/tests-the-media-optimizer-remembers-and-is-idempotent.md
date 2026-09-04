# tests/the-media-optimizer-remembers-and-is-idempotent.law.test.ts

optimize-dist-media runs a worker pool with `sharp.concurrency(1)`, caches results by the sha256 of the INPUT bytes plus every other input to the encode (rule, extension, ENCODER_SETTINGS_VERSION, sharp's version), and recognises its own output so a second pass re-encodes nothing - no generational quality loss on a restored dist
