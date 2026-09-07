# Throwable Artwork And Reporting

Continues the throwable handoff after PR #3481. This is one review batch, not completion of Phase 3 or the full artwork mandate.

## Changes

- Removed throwable-specific `reportError` imports and calls from `ThrowableService`, `ThrowableSoundService`, `ThrowablePlayer` and `ThrowAnimation`, as Dan explicitly requested in this session. Removed the reporting-only effect in the legacy animation and the audio-report deduplication set.
- Retained the existing purchase failure results, single atomic purchase RPC, unresolved-target cleanup and in-memory audio-drop counters. No replacement reporting service, console logging or network telemetry was added.
- Moved the existing law's telemetry assertions to assert absence of reporting in the eight throwable entry files. Kept the audio-drop reason, animation clock, completion and geometry assertions. Added two purchase-failure tests covering RPC errors and rejected requests without repeat charges.
- Beer: glass flutes, rim refraction, amber shading, foam highlights and contact shadow.
- Trophy: gold reflection bands, recessed rim, detailed stem, inset base plaque, star engraving and contact shadow.
- Rocket: missile material detail, continuous flame crown and shaded smoke billows. The existing specs, audio schedules, CSS timing and registry entries are unchanged.

## Verification

- Three focused suites: 53 tests passed (`throwableSpecs`, `throwables-play-the-measured-grammar`, `ThrowableService`). RPC failure tests use mocks; no production purchase was executed.
- Scoped strict TypeScript check passed for the three edited rigs, both edited services and the purchase test. This is not the full application typecheck.
- The existing darkroom generated before/after harnesses using the real components and CSS. Chromium screenshots were captured by explicitly selecting a locally installed browser, because the darkroom's default Playwright browser was unavailable. Forty beat/size screenshots per version were captured; the contact sheet and selected enlarged frames were visually inspected. Final selected frames are under `docs/throwables/reviews/2026-09-07-material-pass/`.
- The darkroom keeps static payload markup at the last beat rather than emulating player unmount. Its cut tiles are therefore not proof of production cleanup. The existing completion assertion passes; live end-to-end cleanup remains unverified here.
- All nine edited source/test paths were compared with current main before creating the review branch; their base content was unchanged.

## Remaining Gates

This session assembled a partial source snapshot through the connected GitHub API. It has no authenticated Git checkout or Mac host terminal. The complete application build, repository-wide suite, host hooks and live browser verification have not run. Keep this PR draft until those gates are completed. No `--no-verify` was used. No claim of production publication is made.

The other 15 existing rigs still need the requested artwork review. The remaining legacy rigs, Phase 3 character performances and later phases remain outstanding. The previously documented trophy reference-frame discrepancy is unchanged. New Phase 3 cue names are not in the current sound manifest and were not invented or substituted.
