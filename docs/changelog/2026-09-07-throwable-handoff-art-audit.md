# Throwable handoff audit, Cake/Cash Stack art and cue credits

The attached handoff undercounted the current catalogue: 48 items, 18 rigs,
30 legacy items. It omitted magic_8_ball. The item-by-item audit in
`docs/throwables/reviews/2026-09-07-handoff-audit/AUDIT.md` explicitly tracks
all 48 playback and picker surfaces and the future named items. The whole
programme remains incomplete; eight revised rigs do not mean 48 replaced
images or completed 3D artwork.

Cake now has cylindrical tiers, layered frosting, shaded seeded berries,
plate contact shading and a recessed rim. Cash Stack has visible paper
edges, bill printing and articulated feather silhouettes. Both remain
resolution-independent SVG with their existing separate moving parts.

The darkroom exposed two Cash Stack defects while reviewing the artwork.
The nested bundle fade started with opacity zero, hiding the bundle until
the fade itself started at 700 ms. It now starts visible. Bill delays were
333 ms too early: the earliest bill appeared at 367 ms from launch instead
of the 700 ms burst. The inline per-bill delays now start at 367 ms FROM
LANDING, which is 700 ms from launch. No measured beats or grammar limits
were changed. The regression is pinned in throwableDarkroom.test.ts and
verified against Chromium's actual computed animation states.

The inherited cue-builder --only bug is fixed at its source. Credits are
collected from every cue in the source manifest before encoding begins;
selection limits encoding only. Both --only forms work, and empty/unknown
selections fail before overwriting metadata. Four isolated CLI tests cover
credit retention and invalid selections without requiring ffmpeg in CI.
No audio files or generated cue manifest were hand-edited.

Validation:

- 63 tests pass across six focused suites: cue builder, specs, measured
  grammar, catalogue integrity, darkroom and player lifecycle.
- Scoped strict TypeScript passes for both rigs and the new cue-builder test.
- Chromium: 24 beat/rung screenshots inspected, plus two 3x enlarged renders.
  Computed-state assertions verify visible landing/settle bundle, hidden
  pre-burst bills, visible first burst bill, clean cut and reduced motion.
- No new source Sentry reporting, raster images, emoji glyphs or cue
  placeholders. No hooks or guards bypassed. Existing registry entries call
  the changed rigs; the existing audio CLI calls the changed builder.
- Full build and full test suite are delegated to the existing CI gates
  because this local workspace is a partial source snapshot.

PR #3494 merged as f53c1a4763bb035f62e2a29c55a2db0d29ccec4d. Its three
PR-triggered workflows passed. Production during this audit still reported
ca_sha a9b7697172fa9cd4388329249879d7c6cb20823f. This patch is a new branch
from main 89a29af8ec19b140b6129dfb553d4e79b99416c2 and is not claimed live.
