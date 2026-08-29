# Handoff Changelog

## 2026-08-27 — Foundation

- Established master spec, asset manifest, implementation plan, reusable component primitives, and production shell assets.
- Merged foundation PRs #1524 and #1527.

## 2026-08-28 — Scope correction and asset iteration

- Stopped unintended global button changes and returned scope to Club Arena.
- Iterated BBJ, nine wallet families, and Club identity card against user references.
- Locked club card, BBJ, and long wallet layout.
- Preserved all mixed/unrelated work on `codex/clubbuttons-preserved-20260828` at `657925db0`.

## 2026-08-28 — Lobby command top

- Added premium joined welcome, Find Your Game, and campaign sections.
- Added Club Arena-scoped source and runtime artwork.
- Fixed self-hosted font delivery on Vercel preview.
- Pushed `a01d21c3c`; verified production build and responsive rendering.
- Deliberately excluded game cards from the push.

## 2026-08-28 — Preservation package

- Archived exact user directives and approved reference images for all five card families.
- Added operational handoff, style rules, asset indexes, system/credential maps, known issues, and ordered next steps.

## 2026-08-29 — Premium dynamic game-card replacement

- Promoted approved V2 MTT, NLH cash, PLO, Spins, and Heads Up skins as the
  automatic defaults for new lobby entries.
- Added separate desktop/mobile premium hardware shells for all five families;
  live titles, values, statuses, rule tags, and semantic action buttons remain
  DOM-driven.
- Preserved existing registration, waitlist, join, watch, and return handlers.
  MTT actions now render blue Register, red Unregister, gold Late Register or
  Return To Tournament, and neutral disabled closed/full states as appropriate.
- Retained V1 skins as explicit rollback/compare fallbacks.
- Passed focused Vitest coverage, TypeScript, production build, long-value
  stress checks, and rendered containment checks at 320, 375, 390, 430, 768,
  1024, and 1440 px in both template modes.
