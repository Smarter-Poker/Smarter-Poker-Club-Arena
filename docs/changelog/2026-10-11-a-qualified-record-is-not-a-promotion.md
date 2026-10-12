# A qualified record is not a promotion (2026-10-11)

## What broke

#6687 (`c6baabe27`) committed
`docs/evidence/phase13/1235b47a/phase13-qualification-2026-10-10-plo8.json`, a
genuine P13.2 measurement: the PLO8 cash objective qualified, the tournament
objective is an unavailable dependency, and `admissionAlsoRequires` still names
the natural completion-share evidence. The record says `"qualified": true`.

`server/src/engine/HorsePhase13Authority.test.ts` refused any Phase 13
qualification record saying `qualified: true` while
`PHASE13_PROTECTED_RELEASE_SELECTIONS` is all null, so the required check
"Server Engine shard 3/4" failed on every pull request after #6687.

#6687 itself never ran that test: it changed only `docs/`, and
`scripts/ci/classify-ci-changes.mjs` treated `docs/evidence/` as documentation,
so every server shard was skipped on the one pull request that added the file
they read.

## What changed

1. **The test was updated deliberately, not weakened.** A qualification record
   is a measurement, not a promotion. The case now accepts a `qualified: true`
   Phase 13 record only when:
   - its variant's `PHASE13_PROTECTED_RELEASE_SELECTIONS` entry is null;
   - it still names the admission requirement the running code honours:
     `admissionAlsoRequires`, non-empty and equal to the running contract's
     `liveConditions.admissionAlsoRequires`, which admission demands verbatim
     and satisfies only from a natural completion record meeting the floor;
   - the running admission refuses it: the committed release returns
     `unselected` with no selected authority, and a hypothetical selection of
     that exact record with no completion record is refused
     `completion_evidence_missing`.

   The completion-record rule is unchanged. Selecting a variant still fails the
   case until somebody updates it deliberately. No selection, promotion or
   horse behaviour changed.

2. **`docs/evidence/` is test input.** The classifier now selects the server
   shards and the client tests for any change under `docs/evidence/`. It names
   the whole directory, so the next phase's evidence is admitted by where it is
   written. Pinned in `tests/unit/fixtureNativeCi.test.ts`.
