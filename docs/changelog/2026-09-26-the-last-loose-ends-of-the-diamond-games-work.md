# The last loose ends of the Diamond games work (2026-09-26)

Three small items left after the audit fixes (#5300), each closed at its cause.

- **A publish can no longer fail on a Google font file name.** `scripts/self-host-fonts.mjs` named each downloaded woff2 after its URL. Google usually answers with `https://fonts.gstatic.com/s/...` URLs, but sometimes with a kit URL (`/l/font?kit=...&skey=...`), and the old rule turned that into a file name containing `:` and `?`. Publish run 36222857383 (06:11 UTC today) failed on exactly that, at the dist upload. `scripts/lib/font-file-name.mjs` now keeps the existing names for normal URLs (the origin's append-only font pool already holds them) and names any other URL by a hash, so every name is `[A-Za-z0-9._-]` only. Checked with a real build and font download (39 files, all clean names) and `tests/unit/fontFileName.test.ts`.
- **The Plinko peg lights allocate nothing per frame.** `light()` in `plinkoPegField.ts`, called every frame, built a new array and a joined string to decide whether the lit set changed; it now reuses two arrays and compares them in place.
- **The scene kit no longer returns an unused `governor`.** Nothing read it; the governor stays inside the kit, where it is fed every frame.

Also confirmed on the live database, no change needed: `fn_crash_start` draws the crash point through `fn_crash_point_cents(roll, bet, minimum)`, which never returns less than 110 (1.10x), and `fn_crash_decide` books a round whose curve reaches its cap as `cashed` at exactly `cap_cents`, which is what the receipt's crown now keys on.
