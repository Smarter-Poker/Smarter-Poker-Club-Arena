# tests/a-superseded-mixed-custody-row-does-not-refuse-the-stopped-park.law.test.ts

The stopped-custody park refuses `mixed_custody_adopted` over an F06 mixed
custody row only while that row can still be adopted: it is overwritten only
when its hand number is a readable non-negative integer strictly below the
custody being parked and hand_history holds a hand on the table strictly above
the row and at or below the custody (no engine can ever boot at the row's hand
again). On 2026-09-28 tournament 4e2de62d dealt two minutes past its 09-26 mixed
rows, lost its lease, and every stop was refused for ever on all four tables.
The open-transfer refusal still comes first, every later refusal still runs
before the write, that branch is the only change from the previous body, and
the migration guards its pre-image and post-image (migration 20260928154327).
