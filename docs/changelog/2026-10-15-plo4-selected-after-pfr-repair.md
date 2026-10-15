# PLO4 Is Selected Again After The Opponent-Read Repair

## What Was Wrong

- #6777 repaired HorseMind's opponent reads, which the Phase 10 policy digest hashes, so the
  round-3 PLO4 generation 1 (measured on c8bfc617) was set to null and PLO4 played shadow.

## What Changed

- The locked P10.2 PLO4 matrix was re-run on the exact repaired source
  c92768c85bc53a4a5a5972d09c6ee58561010035 (run 38656872350, every shard complete, 2,557,440
  pairs): cash after rake against the horse population +6.94 [+6.25, +7.62] bb/100, qualified
  with no reasons at policy digest a2265ab9....
- `PHASE10_PROTECTED_RELEASE_SELECTION` names that qualification at approval generation 2. The
  qualification and its strength record ship under `server/release-evidence/`. Generation 1 stays
  committed and is refused by digest.
- The tests that pinned the null selection while it was requalified now pin the selected path
  again: the live worker behaviour, the main-scheduler gate and the fresh-process exact replay of
  a qualified PLO4 owner (restored from #6775). The in-process replay laws keep the in-memory
  qualification fixture.

## Status

Implemented; natural accepted PLO4 use is read on the first serving release containing it.
