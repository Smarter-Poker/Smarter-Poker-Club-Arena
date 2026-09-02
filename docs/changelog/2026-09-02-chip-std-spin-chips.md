# 2026-09-02 - chip-std Lane F: tournament chips are conserved hand by hand

Lane F of the chip-accounting swarm (`docs/CHIP-ACCOUNTING-STANDARD.md` section
2.5 and section 5 Lane F). Branch `fix/chip-std-spin-chips`.

## The finding

`fn_spin_chip_conservation_check` reported in-play chip conservation broken on
~10% of completed spin/SNG games: 114 of 1,206 in 6h minted 18,406 tournament
chips, worst single game +1,000. The standard document guessed the cause was
`tournament_players.chips` being overwritten from engine memory
(`tables.ts:338`, `Math.floor`) and rebuy/add-on credits racing it.

That guess was wrong. This is what production says.

## Forensics (read-only, hand_history per game, before any code was touched)

Games taken from the two most recent alerts:

- `ebec3ad9` 2026-08-31 23:25 UTC, 6h window, 20 sampled games
- `164c1866` 2026-09-01 04:38 UTC, 2h window, 3 sampled games

For every one of the 23 games the stack sum of consecutive `hand_history`
rows was compared. **Within every hand `awarded - pot_size = 0.00`** - settlement
arithmetic is exact. **Every single change in the stack sum happens BETWEEN
two hands, across a gap of 49-169 seconds** (normal hand cadence at these
tables is 3-20 s), and each gap lines up with an engine restart visible as a
per-minute `hand_history` dip (17:16, 19:09, 19:57, 20:03 on 08-31; 04:09 on
09-01).

| Game                                           | Variant | Start stack | Hand before (sum)                                          | Hand after (sum)                                 | Delta      | Gap            | What moved                                                                                                                                                   |
| ---------------------------------------------- | ------- | ----------- | ---------------------------------------------------------- | ------------------------------------------------ | ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0573b719` (worst, +1000)                      | spin    | 1000        | 3976291 (0 / 1527 / 1473 = 3000)                           | 3976383 (1000 / 1497 / 1503 = 4000)              | +1000      | 51.9 s         | seat 1 had BUSTED (0) and came back with exactly 1000; busted again at 3976905, eliminated_at 19:12:37 - three minutes after the real bust                   |
| `2579af22`                                     | sng     | 1000        | 3976323 (664 / 1336)                                       | 3976370 (1020 / 1316, i.e. 1000 / 1336 pre-deal) | +336       | 58.1 s         | seat 1 raised 664 -> 1000; seat 2 (above 1000) untouched                                                                                                     |
| `39607ce4`                                     | spin    | 1000        | 3947231 (1587 / 915 / 498)                                 | 3947458 (1572 / 1015 / 1000)                     | +587       | 90.8 s         | seats 2 and 3 raised to 1000 (+85, +502); seat 1 (above 1000) untouched                                                                                      |
| `27fdc78d`                                     | sng     | 300         | 3986772 (140 / 460)                                        | 3986778 (pre-deal 300 / 460)                     | +160       | 52.8 s         | seat 1 raised 140 -> 300                                                                                                                                     |
| `27fdc78d` (second restart)                    | sng     | 300         | 3987744 (760 / 0)                                          | 3987793 (pre-deal 760 / 300)                     | +300       | 50.0 s         | BUSTED seat 2 revived at 300                                                                                                                                 |
| `a4aacb17`                                     | spin    | 1000        | 3976168 (3000)                                             | 3976386 (3773)                                   | +773       | 83.1 s         | two short seats raised to 1000                                                                                                                               |
| `6be766a6`                                     | spin    | 300         | two restarts                                               |                                                  | +380, +110 | 61.5 s, 70.8 s | short seats raised to 300 twice                                                                                                                              |
| `40be4b3b` (post-#2333)                        | sng     | 300         | 4104637 (600, one seat at 0)                               | 4104855 (900)                                    | +300       | 129.7 s        | BUSTED seat revived at 300                                                                                                                                   |
| `d1bbea54` (post-#2333)                        | sng     | 300         | 4104605 (600, one seat at 0)                               | 4104914 (900)                                    | +300       | 168.8 s        | BUSTED seat revived at 300                                                                                                                                   |
| `3a2fee36` (post-#2333, worst of the 2h alert) | spin    | 300         | no hand_history row survives from before the 04:09 restart | 4104877 (pre-deal 300 / 620 / 300 = 1220)        | +320       | -              | play was under way (one seat held 620 > 300) but `hand_history` had no row for the game, so the "no hand dealt yet" branch topped both short seats up to 300 |

Confirmed again on the day of the fix, from the widened detector's own worst
game after the migration was applied (`9b653f4c`, SNG, 1000 stack, 2 entrants):
hand 4571722 ended 28 / 1972; a 245 s restart gap follows during which one
hand was played and its `hand_history` row was lost (seat 1's last 28 chips
moved to seat 2, so the seats read 0 / 2000); on resume the seat at 0 was
revived to 1000 and hand 4572306 dealt from 1000 / 2000 = 3000. Both root
causes below in one game, post-#2333. (Side observation, not this lane's:
hand 4572371 of that game persisted stacks of 1655.58 / 1344.42 - fractional
tournament chips, conserved to 3000.00 but not whole.)

The remaining 13 sampled games (`d23b9411`, `c9868ff4`, `2b488639`,
`92c5fcb1`, `6d093c26`, `975faa7c`, `8ec50b78`, `fa27c0cd`, `392a62d5`,
`e56b8ea5`, `2e0b4154`, `8f436557`, `a082f585`) show the identical shape:
one restart gap, every seat below `starting_chips` raised to exactly
`starting_chips`, every seat above it untouched, `awarded = pot` on every hand.

Classification against the three classes in the brief: **23 of 23 are class
(c) - a stack credit with no source, written between hands by the restart
recovery path.** Zero are class (a) (persistence race), zero are class (b)
(settlement arithmetic). `tournament_players.chips` was faithfully mirroring
`table_seats.stack`; the mint happened on `table_seats.stack` itself.

## Root cause

`TournamentManagerBase.creditSeatStacks()` is the function that turns a Spin's
zero-chip reservations into real stacks after the wheel. It is also called
from `resume()` on EVERY engine restart ("A RESTART MUST NOT LEAVE THE FIELD ON
ZERO CHIPS", 2026-08-23). Until PR #2333 (merged 2026-08-31 20:09 UTC) it
raised every seat with `stack < starting_chips` to `starting_chips`, which
after a restart mid-game is "give every losing player a fresh stack". #2333
narrowed the in-play branch to `stack <= 0` - but:

1. **A seat at 0 during play is a BUSTED player, not a stranded reservation.**
   The bust is finalised by the elimination sweep a few seconds after the
   hand; a SIGTERM inside that window leaves the seat live at 0, and on
   resume the "stranded reservation" branch hands the busted player a new
   starting stack. `0573b719`, `27fdc78d`, `40be4b3b`, `d1bbea54` above.
2. **"Play under way" was decided from `hand_history`**, and a hand whose
   history write did not land before the restart makes a running game look
   pre-deal. `3a2fee36` above: a seat holding 620 on a 300-chip board is
   proof of play by itself, and the code never looked at the seats.

## The fix (engine)

- `server/src/tournament/seatStackCredit.ts` (new, pure):
  `selectSeatsToFund()` decides which seats a credit may touch. Play is under
  way if a hand was ever recorded OR any live seat holds more than the
  starting stack (chip conservation makes that a signature of play that
  survives a lost history row). Once play is under way NOTHING is funded -
  a seat at 0 is a bust for the elimination sweep to finish, never a
  reservation. Pre-deal, seats below the target are raised to it, but only
  while the felt total plus the credit stays within the tournament's chip
  supply (`entrants x starting_chips` + rebuy/add-on chips); a credit that
  would exceed the supply is refused and reported.
- `TournamentManagerBase.creditSeatStacks()` now delegates to it and reads
  the supply from `tournament_players`.
- `server/src/engine/tournamentChipConservation.ts` (new, pure) +
  `ServerTableEngineSettlement.postHandTasks`: for a tournament table the
  settled stacks of the dealt players must sum to what they were dealt with
  (rake is 0 on tournament tables). If not, the engine raises the CRITICAL
  financial alert `Tournament.chip_conservation_broken` with the hand id and
  the two totals, and REFUSES to persist the hand's stacks (`syncStacks` and
  `syncTournamentChips` are skipped, so the pre-hand stacks stay on the
  record). A hand that does not conserve can no longer decide a winner
  silently.
- `tables.ts syncStacks`: when `fn_ca_settle_hand_stacks_absolute` refuses a
  write for a conservation violation the legacy per-seat fallback is NOT run
  (it would persist exactly the total the database just refused).

## The fix (database) - migration `20260902<HHMMSS>_tournament_chips_are_conserved_hand_by_hand`

- `fn_ca_settle_hand_stacks_absolute`: live body from `pg_proc` kept
  byte-identical, with one block ADDED for tournament tables after the delta
  loop: the new stack sum must equal the persisted stack sum for the named
  seats. A shortfall that exactly equals rebuy/re-entry/add-on grants landed
  on those seats since the table's previous settlement (`wallet_transactions`
  category `rebuy`/`addon` for the tournament, chips from
  `rebuy_chips`/`addon_chips`/`starting_chips`) is the engine having dealt
  from a stack that did not yet hold the grant; the grant is re-added to that
  seat so the write conserves instead of erasing it. Anything else raises
  `conservation violation (tournament): ...` with the numbers, which the
  existing handler turns into a drift incident and a `rolled_back` result.
- `fn_spin_chip_conservation_check`: rebuy/add-on games are no longer
  excluded; their grants are added to the expected total instead
  (`rebuys x rebuy_chips` and `add_on x addon_chips`, each defaulting to
  `starting_chips` exactly as `process_tournament_rebuy` does). The number is
  no longer a lower bound.

## Tests

- `server/src/tournament/seatStackCredit.test.ts` - the production games
  above as fixtures: pre-fix red (the old rule funds the busted seat and the
  620/300 table), post-fix green.
- `server/src/engine/tournamentChipConservation.test.ts` - the assertion.
- `server/src/engine/TournamentChipsAreConserved.law.test.ts` - pins the
  decision rule, the refusal to persist, the no-fallback rule and the
  presence of the DB assertion in the migration. Negative-controlled: nine
  flips (drop the seat-above-target signal, fund during play, persist despite
  the verdict, mirror chips despite the verdict, downgrade the alert, read
  the live field instead of the snapshot, bypass the decision in
  creditSeatStacks, tolerate one chip, disable the DB block, fall back on a
  DB refusal) each went red; restored tree green.
- `server/src/tournament/creditCannotRescueALosingStack.guard.test.ts`
  (#2333) pinned the inline filter this change replaces; its three pins were
  moved to the new mechanism in the same commit, keeping their intent.
- Full run: `server/src/engine`, `server/src/tournament`,
  `server/src/services/supabase` - 211 files, 2,372 tests green; `tsc` clean
  in both roots; `tests/law-registry.law.test.ts` green.

## Migration - applied

`20260902173645_tournament_chips_are_conserved_hand_by_hand` applied to
production at 17:44 UTC (listed in `supabase_migrations.schema_migrations`).
Live `fn_ca_settle_hand_stacks_absolute` body was md5-matched to the mirror
before the replace (`fc883b17...`, 6,316 bytes) so the only differences are
the added block and four declared variables.

Rolled-back probes (pg_temp copy of the new body, transaction ended by a
deliberate exception, nothing persisted), against a live tournament table:

    r1 (+100 to one seat, other unchanged)  -> refused: "conservation violation
        (tournament 70a8b129...): stack deltas 100.00 across 2 seat(s) ...
        (grants since previous settlement: 0) ... write refused whole"
    r2 (10 chips moved between the seats)   -> success, net_deltas 0.00
    r3 (-10 with no grant)                   -> refused, stack deltas -10.00
    r4 (cash table, +1 with rake null)       -> success as before (block does
                                                not engage off tournament tables)
    r5 (rebuy fixture for u1, engine dealt from s1 - 5000, settles s1-5010)
                                             -> success, explained 5000, seat
                                                written as s1 - 10 (grant kept)
    r6 (same, shortfall 5005)                -> refused, "stack deltas -5005.00
                                                (grants: 5000)"

Baseline immediately after apply, widened detector, trailing 6h (engine fix
not yet deployed): 13 of 2,179 games minted 5,615 chips, worst +1000,
`lost_final_write 0`, `chips_moved_in_play 13`.

## Companion migration - grants only, applied

`20260902183000_conservation_definers_stay_closed` (production version
`20260902183255`). `scripts/ci/check-definer-authorization.mjs` blocked the
push: it reads a branch's migrations and treats a declared SECURITY DEFINER
writer as browser-reachable until a REVOKE naming PUBLIC, anon and
authenticated closes it. Production's ACL for both functions was read back
before the file was written and both were already `{postgres, service_role}`
only - `CREATE OR REPLACE FUNCTION` preserves the ACL, so the first migration
opened nothing. The companion states the REVOKE/GRANT in the repo so the
declaration carries its own authorization. Applying it changed nothing
(ACL re-read after apply: identical). GRANT/REVOKE are not in
`pgrst_ddl_watch`, so no schema-cache reload was triggered.

## Post-apply evidence for the verifier

The engine half deploys with the merge (Hetzner auto-deploy on `server/**`).
Expected DB-visible proof within 6h of that deploy:

    select context->>'minted_games', context->>'destroyed_games', created_at
      from financial_alerts
     where source = 'fn_spin_chip_conservation_check'
     order by created_at desc limit 3;

`minted_games` -> 0 on every alert whose window starts after the deploy, and
no new `financial_alerts` row from this source at all once the existing open
one is resolved (the check dedupes on verdict). Restarts will keep happening;
the stack sum across a restart gap in `hand_history` must now be flat.
