# The profile modal leaves first paint

The initial-load gate (`scripts/ci/bundle-size.mjs`) measured `main` at its 320kB gzip ceiling, so the next change to add anything to first paint would fail its build. The largest piece of first paint that most players never see was the Complete Profile modal: AppLayout imported it statically, and with it the SpadeConsole art and the whole AvatarGallery.

The gate's decision, `useCompleteProfile`, moved unchanged into `src/components/modals/useCompleteProfile.ts` (re-exported from `CompleteProfileModal.tsx`, so existing imports keep working). AppLayout runs the hook at boot as before and loads the modal through `lazyWithRetry` only when the gate actually stops a player, inside the same `profileReady` condition. The modal already rendered nothing while closed, so mounting it only while open changes nothing a player sees.

Initial load drops from 320kB to 296kB gzip. The new hook file is declared in `scripts/ci/entry-chunk.d/perf-club-arena-entry-headroom.json`.
