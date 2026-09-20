# The Diamond Tournament Lifecycle Cases Run

September 20, 2026. Phase 8 of the Diamond Arena build programme, fixture work,
part two. Part one is
[the doors are captured](2026-09-20-the-diamond-tournament-doors-are-captured.md).

## What was built

Part one stood 79 installed Diamond tournament doors up on the estate's
historical schema and stopped at one precise place: the arena's own membership
boundary. This work clears that boundary, captures the second half of the
doors - the trigger chain production fires rather than the functions it calls -
and runs lifecycle cases against them with the arena closed.

- `tests/sql/diamond-tournament-lifecycle-doors.sql` - 22 more installed doors,
  62KB, each carrying `-- @@PIN md5=... len=... owner=...`, its definition, its
  `ALTER FUNCTION ... OWNER TO` and the REVOKE/GRANT pair that restates its live
  ACL; plus the nine `public.tournaments` INSERT triggers production carries
  that the historical base does not, in production's own
  `pg_get_triggerdef()` text. The file ends in a block that reads every door
  back out of the catalogue it was just loaded into, refuses to finish if one
  renders to a different md5, and refuses if the trigger set is not the one it
  stood up.
- `tests/sql/diamond-tournament-lifecycle-doors.manifest.json` - per door:
  identity, md5, length, owner, live grants and `bytes_from`; plus the trigger
  definitions installed, the triggers deliberately left out with their reasons,
  and the one base trigger dropped with its reason.
- `tests/sql/diamond-tournament-lifecycle-schema.sql` - the two relations, four
  `tournaments` columns and four `tournaments` constraints the base still
  lacked, sliced verbatim from the migrations that created them where a
  migration on `main` carries the statement.
- `tests/sql/diamond-tournament-lifecycle-seed.sql` - the opening scene: one
  Diamond arena that satisfies its own guard, four synthetic accounts on the
  estate's reserved `@smarter-poker.invalid` fixture domain created through the
  real signup hooks, the staff account at `role='god'`, the arena settings row
  with both switches closed, and the MTT admission ABI production was observed
  running.
- `tests/sql/diamond-tournament-lifecycle-cases.sql` - the cases.
- `tests/sql/run-diamond-tournament-lifecycle.py` - the runner. Own cluster, own
  socket, `listen_addresses` empty, dropped afterwards. Never touches
  production, needs no credential, and never opens an arena switch.
- `tests/the-diamond-tournament-lifecycle-runs-the-installed-doors.law.test.ts`
  and its registry file - the repository-side half.

## The membership boundary, and how it was satisfied rather than removed

Part one stopped here, with production's own error text:

```
ERROR:  Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy
```

`poker_arena_membership_guard` is `fn_poker_guard_arena_structure`, attached
`BEFORE INSERT OR UPDATE` on `public.club_members`. For a club whose asset is
`diamonds`, the first term of its refusal is `TG_OP='INSERT'`:

```sql
IF TG_OP='INSERT' OR NEW.role IS DISTINCT FROM 'player' OR NEW.status IS DISTINCT FROM 'automatic'
   OR NEW.agent_id IS NOT NULL OR ... THEN
  RAISE EXCEPTION 'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy';
```

**There is no condition on which the guard admits an INSERT.** No exemption for
`postgres`, none for `service_role`, none for a platform admin. Part one's next
step was written as "read the guard and the shape of production's single
membership row and satisfy the guard"; read in full, the guard's answer is that
the row should not be inserted at all, and the doors say the same thing in their
own words. `fn_ca_entry_scope_ok`, captured in part one:

```sql
-- The Diamond arena has no membership rows by design: every account with a
-- profile is a member. A retired or missing profile is not.
```

and `fn_poker_arena_context` sets `member=true, role='player'` for a Diamond
arena without reading `club_members` at all.

Production's one row is a pre-guard artefact, and the timestamps say so. Read
read-only on 2026-09-20: the Diamond Arena club and its single `club_members` row
were both created at `2026-09-08T11:28:12.386252Z`; the guard arrived in
`supabase_migrations.schema_migrations` as version `20260908152855`
(`poker_arena_identity_guards`) four hours later; and that row's `updated_at` is
`2026-09-08T15:28:55.978014Z` - the migration's own timestamp, reshaping the row
into the only shape the guard tolerates on UPDATE (`role='player'`,
`status='automatic'`, every chip column zero).

So the seed creates **no membership row**, and gives the arena **no owner**.
`clubs.owner_id` is nullable in production (`pg_attribute`, read 2026-09-20) as
it is in the base, and `fn_club_owner_has_a_player_wallet` - the
`DEFERRABLE INITIALLY DEFERRED` constraint trigger that would otherwise create
the owner's wallet row at COMMIT - returns on its first line when `owner_id IS
NULL`. The trigger is not disabled, not dropped, not deferred past: it is
satisfied. Two other things the arena needs and gets honestly: `chip_treasury`
is passed as `0` explicitly, because `public.clubs.chip_treasury` defaults to
`100000` in production and the CHECK constraint `poker_arena_diamond_identity`
requires a Diamond arena to hold no chips; and the seed then attempts
production's exact membership row and **is refused**, so the guard is proved
still armed rather than assumed to be.

## The second capture, and why the first was not enough

Part one captured the closure of what the Diamond tournament doors **call**. The
create door's own `INSERT INTO public.tournaments` also fires what production
**attaches**, and there the base and production disagree.

Measured on the loaded fixture and on production, both read read-only,
2026-09-20:

|                                                      |     |
| ---------------------------------------------------- | --- |
| triggers production attaches to `public.tournaments` | 60  |
| distinct functions they name                         | 58  |
| already byte-identical in the historical base        | 34  |
| rendering to different text in the base              | 13  |
| absent from the base entirely                        | 11  |
| triggers not attached in the base at all             | 12  |
| triggers the base carries that production does not   | 1   |

The one base-only trigger is `a0_tournament_manager_write_scope`, naming
`trg_tournament_manager_write_scope` - a function production does not have
(`pg_proc` returned zero rows, and no trigger anywhere in production uses it).
A retired refusal that still fires is a fixture certifying a door the platform
does not have, so the capture drops that trigger with its reason recorded in the
manifest.

The 22 functions the create path needs are captured md5-pinned. **Twenty were
already committed in this repository, byte-identical to the installed
definition**, found by hashing every `CREATE FUNCTION` block on disk against the
production pins rather than by assuming - mostly in
`tests/fixtures/sep8-spin-custody/tournament-catalog.json`,
`tests/fixtures/full-weekly-accounting/schema.sql`,
`scripts/qualification/fixtures/spin-mixed-positive-fee/provider-supplement.sql`
and `scripts/ci/fixtures/mtt-format-activation/funding-frame-dependencies-20260918.json`.
Two were transported from production in this session:
`fn_ca_satellite_target_accepts_new_feeder` and `fn_ca_blind_contract_number`.
Every one of the 22, whatever its source, is proved byte-identical to the
installed definition by its md5.

Nine triggers are installed, in production's own deparse. Three are named and
deliberately not installed, with their reasons in the manifest:
`trg_clear_seats_on_game_end` and `trg_release_seats_on_tournament_finish` fire
only on an UPDATE of status to a terminal value, which no case here performs,
and `union_pnl_original_inventory_no_truncate` is the same function on the same
events as `union_pnl_original_inventory`.

## What ran, and what it printed

```
$ python3 tests/sql/run-diamond-tournament-lifecycle.py
PASS: 79 doors in diamond-tournament-doors-captured.sql agree with their own pins and the manifest
PASS: 22 doors in diamond-tournament-lifecycle-doors.sql agree with their own pins and the manifest
using postgres (PostgreSQL) 17.11 (Homebrew)
PASS: private socket-only PostgreSQL 17, owned by this run
the Diamond tournament fixture delta is present and both switches are closed
all 79 captured Diamond tournament doors match their installed pins
the Diamond tournament lifecycle delta is present
all 22 captured Diamond tournament lifecycle doors match their installed pins
public.tournaments carries 57 of production's 60 trigger definitions; the three not installed are named in this file
...
the Diamond tournament lifecycle cases ran against the installed doors
all 101 captured Diamond tournament doors are installed on the historical base
cash_games_enabled and tournaments_enabled are both closed
Diamond tournament lifecycle cases verified against the installed doors, with the arena closed.
```

Ninety-one assertions between those lines. The full output is 98 lines; every
one of them is an assertion that passed or a refusal that fired for the reason
it was asked for.

`npx vitest run tests/the-diamond-tournament-lifecycle-runs-the-installed-doors.law.test.ts
tests/the-diamond-tournament-doors-are-the-installed-doors.law.test.ts
tests/law-registry.law.test.ts` passes 463 assertions.

## The cases, one by one

**1. Registration.** A Diamond MTT created through
`fn_poker_diamond_create_tournament`, all the way through production's trigger
chain, opens `REGISTERING` with nobody in it and an unlocked entry contract; is
priced in whole Diamonds with buy-in plus fee exactly the total and the fee
equal to `fn_ca_unit_floor_cents` of ten percent at the Diamond unit; is
recognised by `fn_ca_tournament_unit_cents` (100), `fn_poker_diamond_tournament`,
`fn_ca_tournament_recorded_format` (`mtt-v2`) and
`fn_ca_tournament_is_unlimited`; records its capacity in its format rather than
a cap; stores every paid place it was given, totalling one hundred percent; and
is seen exactly once by production's own `union_pnl_original_inventory` observer.
Fifteen refused configurations and two refused callers (a player, then nobody)
write no event at all.

**2. Late entry, as far as the create path reaches.** An MTT the door created
carries the late-registration window the door states (8 levels, 8 minutes); the
window is shut while the event is REGISTERING; a sit-and-go is capped, is not an
unlimited MTT, records `sng-v1` and is created with no window, and never opens
one. **The window is never proved OPEN** - see the limits below.

**3. Re-entry, rebuy and add-on.** The door writes whole-Diamond rebuy and
add-on costs and the stack each one buys; a freezeout carries no rebuy,
re-entry or add-on price at all; `fn_tournament_entry_split` returns the fee as
rake and the rest as prize with no bounty. Fractional and zero rebuy and add-on
costs are refused by name.

**4. Blind clocks.** `fn_tournament_current_blinds` reads the first level of the
ladder the event was created with, advances to the second, and carries a level
past the end of the ladder through the estate's own `mtt_overflow` at ratio 1.6
rather than stalling.

**5. Prize escrow separation.** An event nobody has paid into holds nothing in
any of its three banks; no custody row and no ledger line exists; with **no chip
`tournament_escrow` row at all** the Diamond event still answers from its own
banks, `enforced` and `asset: diamonds`; one Diamond cannot be paid out of an
empty prize bank, and the bounty bank and refund total are separately empty. The
playing stack stays tournament chips while the obligation is priced in whole
Diamonds.

**6. The closed switch is what refuses the money.** `..._charge('entry')` and
`fn_poker_diamond_reserve('tournament_entry')` both refuse
`diamond_tournaments_not_open`, and the refusal moves no wallet, opens no
custody, writes no ledger line and no movement, journals no arena row, reserves
nothing against a purchase lot and does not lock the entry contract. A rebuy,
re-entry and add-on with no entry held are refused separately, and the
whole-parts rule and the registration requirement are refused before anything
else is read.

**7. One obligation, and nothing paid twice or out of an empty bank.**
Unregistering an entry nobody holds answers `{"ok": false, "reason":
"not_registered"}` rather than paying; refunding it is refused
`diamond_tournament_entry_not_held`; paying one Diamond is refused
`diamond_tournament_bank_short`; draining one is refused
`diamond_tournament_custody_short`; and settling a fee nobody paid returns
`{"ok": true, "amount": 0, "destination": "none"}` - a zero, not a phantom
payment. Five refused calls and one zero settlement wrote no ledger line and no
movement.

**8. A cancelled event, and the same cancellation twice.** The cancel door is
the engine's: it says so itself ("A service-role call carries no uid") and
`fn_guard_managed_game_lifecycle` admits a lifecycle change from the engine and
nobody else, so the fixture calls it the way production does and proves both
refusals first - a non-engine caller gets `Tournament lifecycle changes must use
fn_close_managed_game`, and a player gets `Only platform staff may cancel a
Diamond tournament`. The cancellation of an event nobody entered comes back
fully settled owing nobody anything, closes the event with every cached pool
zeroed, writes exactly one immutable receipt, closes every custody bank at exact
zero, and **cancelling the same event again returns the stored receipt byte for
byte and writes no second receipt**. A started event is refused: `Tournament has
started or committed awards; resume or settle it instead of cancelling`.

The fixture then asserts it finishes as it began: both switches closed, no
Diamond arena membership row, every synthetic wallet holding exactly its signup
grant, and not one arena journal row.

## What is claimed against the Phase 8 checklist

Nothing. **No Phase 8 checklist line is ticked or unticked by this work**, and
the programme document is not edited. Phase 8's lines were re-ticked on
September 20 on the strength of the three rolled-back production rehearsals and
the law tests that pin the migration text; this fixture is a second, isolated
kind of evidence for part of the same ground, and it is honest about which part.

What it genuinely exercises, end to end, against the installed doors: the
creation half of registration, the rebuy/re-entry/add-on contract, the blind
clock, prize escrow separation from the playing units, single-obligation
settlement at zero, duplicate payout and duplicate cancellation attempts, and
cancelled events.

What it does NOT exercise, and must not be read as covering: a funded
registration, late entry actually taken, a rebuy or add-on actually bought,
table balancing, finishing-position evidence for a real finish, restart recovery
of a pending obligation, every paid place actually paid, and ties.

## Where this stops, exactly, and what the next lane hits first

Two walls, both named rather than worked around.

**1. The arena switch is closed, and opening it is not a fixture's to do.**
`tournaments_enabled` is false in production, and this task's constraints forbid
flipping it anywhere. `fn_poker_diamond_reserve` refuses
`diamond_tournaments_not_open` for `purpose='tournament_entry'` unless
`ca_arena_settings.id=1` has it true, and `fn_poker_diamond_tournament_charge`
repeats the test for a rebuy, re-entry or add-on. So **no custody row can be
created through a door in this fixture**, and every funded case is therefore a
refusal case. Everything downstream of a funded entry - paid places, ties,
finishing positions, restart recovery of a real obligation - sits behind that one
boolean. For the record, the estate's own merged cash fixture does open its
counterpart locally
(`tests/sql/poker-diamond-cash-admission-setup.sql`: `-- Local-only
certification enables its own fixture settings. Never run on production.` then
`UPDATE ca_arena_settings SET cash_games_enabled=true WHERE id=1;`), so a
sanctioned local-only route exists; it was not taken here because this lane was
told not to, and the runner asserts both switches closed so that nobody can take
it by accident. **That is an owner decision, not an agent's.**

**2. The UPDATE half of the `tournaments` trigger chain is not captured.**
Reaching `RUNNING` - which is the first test in
`fn_tournament_late_registration_open`, and therefore the gate on late entry,
table balancing and every finish - is refused on the historical base by
`fn_guard_tournament_start_readiness`, whose reader
`fn_tournament_management_readiness_for_row` requires
`COALESCE(max_players,0) >= 2` and so cannot start an unlimited MTT at all. That
reader differs from production's (base 7,583 bytes, production 7,757, md5
`0b9fecc5c10bdcf459510bbb19a3268a`) and is **the only one of these that is not
already committed byte-identical somewhere in this repository** - it needs a
transport. Nine more trigger functions on the UPDATE path also differ from
production and **all nine were located byte-identical on disk** while checking:
`fn_guard_managed_game_lifecycle`, `fn_ca_fund_overlay_on_lock`,
`fn_spin_tournament_contract_is_draw`, `fn_guard_tournament_completing_claim`,
`fn_satellite_target_contract_is_immutable`,
`trg_tournament_atomic_place_completion_guard`,
`trg_lock_atomic_final_table_deal_status`,
`trg_atomic_final_table_deal_completion_guard` and
`fn_guard_tournament_completed_certificate`. Their first closure round needs
four more, all four found on disk: `fn_raise_server_financial_alert`,
`fn_tournament_finish_readiness`, `fn_ca_verify_terminal_final_deal_batch` and
`fn_tournament_payout_terms_committed_v1`. The round after that needs four more,
whose production md5s are recorded here so the next lane does not have to
re-read them: `fn_accounting_tournament_terminal_fee_receipt`
(`b73bac5809d0e042837fcc32bacc0769`), `fn_ca_tournament_place_amounts`
(`a660188273312037c813a0d3d0fb807c`), `fn_check_atomic_satellite_finish`
(`c02bec623cd5324bba53c719164384af`) and `fn_tournament_has_unsettled_bounties`
(`8041a7f3d6b2886ce7d688bb5525d952`). One name that closure walks,
`fn_ca_verify_terminal_place_batch`, **does not exist in production at all** -
the same observation `scripts/ci/fixtures/mtt-unlimited/README.md` already
records for it; it is a dead branch, not a missing capture.

So the next lane's first move is the UPDATE-path capture, in exactly that shape,
and its second is a decision about the switch that is not an agent's to take.

## The two doors part one deliberately left uncaptured

`fn_ca_register_for_tournament_with_ticket_for` and
`fn_ensure_late_registration_capacity` were named in part one's README as
uncaptured, with the instruction to capture them the same md5-pinned way if a
case reached either. **Neither was reached.** A satellite target is still refused
at the creation door (`diamond_tournament_format_not_open`, asserted), and no
case seats a late registrant because no case reaches `RUNNING`. Both remain
uncaptured for the reasons part one gave.

## Two things checked on the way, for whoever owns them

1. `public.tournaments.payout_math_version` and `payout_unit_cents` are
   installed in production as `smallint NOT NULL DEFAULT 1` and `integer NOT
NULL DEFAULT 1`, and **no migration on `main` carries their `ADD COLUMN`**.
   The fixture delta states them from production's own `pg_attribute` and
   `pg_attrdef`, read read-only, and says so in its comment; the estate's
   `tests/fixtures/tournament-fee-sources/tournament-terminal-native-schema.sql`
   declares the same two columns for the same reason. Whoever reconciles that
   migration history will want it.
2. Part one recorded that
   `20260913235649_the_diamond_seat_guards_know_a_tournament_seat.sql` is
   installed under version `20260914004611`. That is unchanged and nothing here
   depends on it.

## Production was read only

Every production read in this work was a `SELECT` through the Supabase
`execute_sql` path wrapped in
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`: function
definitions and md5s from `pg_proc`, trigger definitions from `pg_trigger`,
column and constraint definitions from `pg_attribute`, `pg_attrdef` and
`pg_constraint`, the arena club and its one membership row, and two rows of
`supabase_migrations.schema_migrations`. Nothing was written. No migration was
applied, and none is needed: this change is test fixtures, a law and
documentation.
