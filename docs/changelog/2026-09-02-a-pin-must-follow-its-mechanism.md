# A Pin Must Follow Its Mechanism

2026-09-02, 16:07 UTC onward. `main` went red and the publisher stopped. Two
commits sat merged and unpublished until this landed.

## What broke

`build-for-world-hub.yml` runs `npx vitest run tests/ --shard=N/4` and
`sync-to-world-hub` needs all four shards. Shard 4 was failing on one
assertion, so the bundle never shipped:

    FAIL tests/config/spinEngineWiring.test.ts
      > start updates the IN-MEMORY structure too, not just the row
    expected engine source to match /tournament\.blind_structure\s*=\s*spinBlinds/

Publisher runs 3033 (`d60971ad`) and 3034 (`5031c72c`) both failed on it.
Production stayed on `0f47ad06`, two commits behind `main`.

## Why

PR #2645 was right and the test was stale. The Spin draw used to sync its
patch to memory with a hand-written per-field copy, and that copy listed FOUR
of the patch's five fields. `payout_structure` was the one it dropped, so a
started Spin's `tournamentCache` held the pre-draw winner-take-all placeholder
for the life of the game and `recalculateEliminatedPrizes` topped players up
against a structure that had not paid them. 62 completed spins at 10x and above
mispaid 252.00 chips. #2645 replaced the whole block with `applySpinDrawPatch`,
which copies every key of whatever patch it is handed, so the patch is now the
only list of field names there is.

The pin in `spinEngineWiring.test.ts` was still matching one line of the copy
that #2645 deleted on purpose. CLAUDE.md section 5 rule 8 covers this exactly:
if you deliberately replace behaviour a test pins, update that test IN THE SAME
COMMIT. #2645 did move its own guards, and added
`SpinDrawIntegrity.guard.test.ts`, but this second pin in another directory was
missed.

## The fix

Forward, not a revert. The pin moves to the new mechanism.

The old assertion named a field. Re-pinning a field name would have re-created
the precise hazard #2645 removed: a second place that has to be remembered
whenever the patch grows. What must never come back is the DB-only write, so
that is what is pinned now. The draw hands the WHOLE patch to the sync, and it
lands on both the live `tournament` object and `tournamentCache`:

    expect(engine).toMatch(/applySpinDrawPatch\(/);
    const sync = sliceEnclosingBlock(engine, 'applySpinDrawPatch(', 0, 1);
    expect(sync).toMatch(/spinRowPatch/);
    expect(sync).toMatch(/\btournament\b/);
    expect(sync).toMatch(/tournamentCache/);

Plus a narrow negative: no assigning a DRAWN value field by field
(`.blind_structure = spinBlinds`, `.payout_structure = spinPayouts`). Narrow on
purpose. A first attempt banned `tournament.blind_structure =` outright and went
red against two legitimate `JSON.parse` normalisations of a column that can
arrive as a string on non-Spin paths. A guard that fires on correct code is a
guard people learn to delete.

## Verified

- `spinEngineWiring` 20 of 20, `SpinDrawIntegrity.guard` green.
- The pin bites. Two mutations of the source, each restored afterwards:
  replacing the whole-patch sync with the old `tournament.blind_structure =
spinBlinds` turns it red, and dropping only the `tournamentCache` target
  turns it red. A pin that cannot fail is decoration.
- Full `npx vitest run tests/ --shard=4/4`, the shard CI was failing, green.

## The lesson worth keeping

The reason this cost a publish outage rather than a code review comment is that
the pin lived in `tests/config/` while the mechanism lived in
`server/src/tournament/`, and the author of #2645 updated every guard sitting
next to the code. When you delete a mechanism, grep the whole repository for
its name before you commit, not just the directory you are standing in.
