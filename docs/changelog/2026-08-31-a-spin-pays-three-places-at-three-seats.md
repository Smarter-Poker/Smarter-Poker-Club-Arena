# A Spin Pays Three Places At Three Seats, And The Creation RPC Refused Exactly That

**Date:** 2026-08-31
**Branch:** `cowork-claude-spinpay`

## What was wrong

`public.fn_create_tournament` refused a tournament with

```sql
IF jsonb_array_length(v_payouts) >= v_max_players THEN
  RETURN ... 'more_paid_places_than_players';
```

The error names "more paid places THAN players". `>=` does not test that; it
tests "as many paid places as players", which is a stricter and different
claim, and it refuses this platform's own shipped product. A Spin & Go is
three-handed (`SPIN_SEATS = 3`) and its 25x / 50x / 100x tiers pay three
places, 80 / 12 / 8. Counted live on 2026-08-31: **21 rows** in `tournaments`
where paid places `>=` max_players, and all 21 are three-seat Spins paying
three, completed and paid.

The table-level `tournaments_creation_guard`, added the day before in
`20260831180000`, already enforced the correct `>` and recorded the divergence
in its own header as a product question for Dan rather than fixing it. This
closes it, so one rule about paid places exists instead of two that disagree.

## Why nobody noticed

Nothing broke, because both paths that hit the RPC were bent around the check:

- `src/lib/tournamentFieldRules.ts` — `capPaidPlaces` trimmed every ladder to
  `fieldCapFor(fieldCap) - 1`. The `- 1` existed for this operator and nothing
  else. Fed 80 / 12 / 8 at a three-seat field it dropped third place and
  rescaled by 100/92, so the operator was shown, and the row was written, as
  **86.96 / 13.04** — a structure nobody chose.
- `src/lib/tournamentFromTableConfig.ts` — wrote winner-take-all for every Spin
  under the comment "a spin is winner-take-all by definition". Three of the
  seven tiers pay more than one place; the definition was the workaround.

The direct-insert spawner (`TournamentRecurringService.createSpin`) never went
through the RPC, so it was never affected and is not changed here. That is why
the 21 rows exist at all.

## What changed

| File | Change |
| --- | --- |
| `supabase/migrations/20260831200000_a_spin_pays_three_places_at_three_seats.sql` | Rewrites the one operator in the live `fn_create_tournament` from `>=` to `>` |
| `src/lib/tournamentFieldRules.ts` | `maxPlaces` is `fieldCapFor(fieldCap)`, not `- 1`; an all-zero ladder is now caught before the trim rather than inside it |
| `src/lib/tournamentFromTableConfig.ts` | Spin payouts derive from `SPIN_TIERS[0]` (the placeholder tier) instead of a hard-coded literal, with the false "by definition" comment replaced |
| `tests/unit/tournamentFieldRules.test.ts` | Three pins re-encoded to the corrected law, plus a new pin that a three-seat Spin keeps 80 / 12 / 8 un-renormalised |
| `tests/unit/TournamentFromTableConfig.test.ts` | The spin payout pin reads the spec instead of asserting a literal |

## The migration technique, and why not a hand-typed body

The migration reads the LIVE `pg_get_functiondef`, replaces exactly one
substring, and `EXECUTE`s the result — the same pattern as
`20260831_tournament_fee_is_keyed_on_seats_not_on_the_word_sng`. It refuses to
run unless the target appears exactly once (verified: 1), and asserts
afterwards that the new form is present, the old one is gone, the
`more_paid_places_than_players` code survived, and the table guard is still
attached.

This matters more than convenience here. **The live body and every migration
file that defines it have already diverged.** Diffed live against the newest
repo copy (`20260823103000_union_tournament_creation_parity`), three
substantive differences:

- fee CASE is seat-keyed live (`maxPlayers BETWEEN 1 AND 2`), label-keyed in
  the file (`round(v_total * 0.1)`);
- the file carries a `WHEN c.is_union THEN c.id` union branch that is **not**
  live;
- the file writes `lateRegistrationLevels` into `late_reg_mins`; live writes
  `lateRegistrationMinutes`.

A `CREATE OR REPLACE` typed from any migration file would have silently
reverted at least one shipped fix. Emitting from `pg_get_functiondef` also
reproduces the parameter list exactly, so the 42P13 default-mismatch trap is
not reachable.

## Not applied

Per instruction, the migration is committed but **not** applied to production.
No write of any kind was made; every database call in this work was a `SELECT`
(CLAUDE.md 11.5).

## Deliberately not changed

`PayoutEngine.payoutsForChoice` clamps auto-generated MTT ladders to `n - 1`
places. That is a stated product rule — "so a bubble always exists" — about how
many places to GENERATE, not a refusal of a ladder the operator chose, and it
is not fed by the RPC guard. Left alone.
