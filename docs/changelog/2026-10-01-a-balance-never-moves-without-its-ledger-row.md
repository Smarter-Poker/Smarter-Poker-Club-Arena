# A balance never moves without its ledger row (2026-10-01)

Dan: "fix any and all issues with the chip drift, and why hasn't this been made
atomic yet? chip drifts should not be possible and should never happen when
EVERY SINGLE TRANSACTION is logged, and on the same ledger...?"

## The answer, in one paragraph

Every transaction was logged, but by a second hand. A chip balance on this
platform is written directly by its door (176 functions write one of
club*members.chip_balance, clubs.chip_treasury, table_seats.stack,
union_wallets.*, bbj_pools._ or the ledger itself; the table is in
`docs/evidence/chip-balance-writers-2026-10-01.md`, read live from `pg_proc`
through the new view `v_ca_chip_balance_writers`), and the chip_ledger leg is
written AFTER the fact by a trigger - fn_club_members_ledger_writer on the
wallet, fn_ca_autoledger on the treasuries, banks and pools. Both triggers stand
down when a door sets `app.ledger_autoskip_<table>`and promises to write the
leg itself. Thirty-six doors make that promise and nothing ever checked it, so a
stand-down whose leg was missing, the wrong amount, or named the wrong wallet
committed clean (the 2026-09-14 rakeback close moved 84,041.00 under anonymous
legs; the 2026-09-09 commission round wrote 40,754.98 of legs for 20,377.49 of
movement; promo_apply_playthrough, found today, released promo into wallets
with no leg at all). The felt - table_seats.stack - had no journal trigger of
any kind, which is how the 2026-08-25 probe destroyed 48 chips by deleting a
seat row. Every detector (fn_ca_trial_balance_watch, fn_ca_ledger_replay,
reconcile_ledger_nightly) compared balance to journal hours later, by
snapshot: nets, not constraints. It cannot happen now because migration`20261001160611`makes the comparison a constraint evaluated at COMMIT of every
transaction: one transaction-scoped tally collects every covered balance delta
and every ledger leg, and a deferred constraint trigger refuses the whole
transaction by name -`REFUSED: balance_moved_without_its_ledger_row` - unless,
for every account touched, balance delta equals ledger net to the cent. The
promise the stand-down makes is now verified, the felt is now an account, a leg
with no balance behind it is refused too, and nothing is corrected or swept up
afterwards (CLAUDE.md 10.11, 10.12): the door either writes the movement whole
or writes nothing.

## What was measured before building (JOB 1)

- 176 writers in `public`/`smarter_private` whose body writes a chip balance
  column or a chip_ledger row: 84 ledger-atomic (the autoledger writes their
  leg), 36 stand-down, 27 felt writers, 11 journal-only, 18 that touch only
  stores this migration does not yet cover. Engine (`server/src`) and World Hub
  (`pages/api/club-arena`) reach every balance through those RPCs; the one
  direct engine write is a `club_members` INSERT journalled by
  `trg_ca_autoledger_insert`.
- Over the seven days to 2026-10-01 15:05 UTC the felt and the club treasuries
  reconciled to the journal exactly (76,113.47 = 76,113.47; -1,466,746.14 =
  -1,466,746.14). Player wallets were 75.00 short of the journal and the
  tournament liability 81.00 over it across the window ends; the union wallets
  2.15. The hourly trial-balance incidents (366.50, 142.50, -420.39, -150.00)
  reverse sign window to window: a leg is stamped created_at at transaction
  start and the balance commits after the snapshot, so a long registration or
  payout straddling a reading shows as drift in one window and un-drift in the
  next. The per-entity replay (fn_chip_drift_since_baseline) reads 0.00 drift
  on all 1,502 baselined wallets.
- The ledger conventions the invariant needs held on 100.00% of the 1,946,078
  legs written in that window: player_wallet legs name user and club, union legs
  name the wallet row or the union, bbj legs name the pool row, table_stack legs
  name a cash chip table. No live writer has to change to pass.
- The largest transaction in 48 hours wrote 9 legs; the tally's O(accounts
  touched) cost per write is negligible at that scale and well under a second
  for a 420-wallet weekly close.

## What was built (JOB 2)

Shape 2 of the three offered, adapted to the architecture the catalog actually
has. "One writer" (shape 1) would mean rewriting 176 doors and the autoledger
is already the one writer for 84 of them; a GUC-stamped BEFORE trigger (shape 2
as written) would refuse legitimate doors that write the balance in one
statement and the leg in the next. So the stamp is a tally and the check is
deferred to commit:

- `zy_ca_tally_balance_move` (AFTER INSERT/UPDATE/DELETE, row) on club_members,
  clubs, table_seats, table_pending_addons, union_wallets, bbj_pools adds the
  row's delta for its account to the transaction-local setting
  `ca.ledger_tally`.
- `zy_ca_tally_ledger_leg` (AFTER INSERT, row) on chip_ledger adds +amount to
  the to-account and -amount to the from-account. A fn_ca_post_correction
  journal-only restatement is outside the tally, as it is outside every meter.
- `zz_ca_balance_has_its_ledger_row` / `zz_ca_ledger_row_has_its_balance`
  (CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED) fire at COMMIT, verify the
  tally once per change (a version counter makes later events O(1)), and raise
  `REFUSED: balance_moved_without_its_ledger_row account=... balance_delta=...
ledger_net=...` (SQLSTATE 23514) with the first statement that touched the
  account in the DETAIL.

Accounts covered: `player_wallet:<user>:<club>`, `club_treasury:<club>`,
`table_stack` (the whole cash felt as one account, exactly as
fn*ca_account_balance defines it, plus the pending add-on float),
`union_bank:<union>`, `union_wallet:<union>`, `bbj_pool:<pool>`. Named as NOT
yet covered: promo wallets, agents, club_wallets, insurance, spin reserve and
the tournament escrow, whose balance is partly driven from the ledger by the
`zz_ca_escrow*\*\_leg` triggers and needs its own model. They keep their existing
autoledger and detectors and are the next migration.

Staged. The migration installs `ca_ledger_invariant_mode = 'observe'`: the full
path runs on every live transaction and a would-be refusal is recorded in
`ca_ledger_invariant_findings` (txid, account, both amounts, actor, role, the
statement) and raised as a WARNING. A trigger on the two hottest tables of a
live room cannot be probed on production before it exists, and a refusal
nobody foresaw on the hand-commit path would stop every table. One hour of real
traffic with zero findings is what the flip to `refuse` reads; the flip is a
one-row UPDATE in its own migration, and the law pins that `refuse` is the final
state on main and that no later migration may set it back.

Also fixed at its line: `promo_apply_playthrough` now writes the one leg a
promo release is (promo_wallet -> player_wallet, released amount) inside the
stand-down it already had; pinned to the live body's md5 so a changed function
is not overwritten blind. Dormant (0 releases in 30 days, 0.00 promo
outstanding), so nothing to settle.

## Proof (JOB 2 and JOB 4)

`scripts/dev/test-ledger-invariant.sh` runs the real migration file on an
isolated PostgreSQL 17 against `tests/fixtures/ledger-invariant` (production's
column shapes, production's autoledger contract, the live
promo_apply_playthrough body so the md5 pin is exercised) and proves:

- refused by name, at commit: a cash stack that grows with no leg; the
  2026-08-25 deleted seat; a stand-down with no leg, with a 9.99 leg for a
  10.00 move, with the leg on the wrong wallet; a leg with no balance behind
  it; a union rake stand-down with no leg; a jackpot stand-down with no leg; a
  pending add-on float with no leg; a cash-out that pays the wallet and leaves
  the stack on the felt; a session-scoped stand-down leaking onto a later plain
  write;
- committed untouched: buy-in, raked hand with jackpot drop, cash-out, pending
  add-on request and resolution, the treasury-to-wallet stand-down pair with the
  leg written first, a rolled-back subtransaction, tournament and Diamond felt,
  a seat moving between cash tables, a journal-only correction, a zero-delta
  write, a union leg keyed by union id meeting an autoledger leg keyed by wallet
  row;
- observe mode records the same regression under the writer's statement and
  commits.

Twenty-four cases, all green on the Mac (PostgreSQL 17.11) and wired into the
Server Engine CI lane beside the other real-PostgreSQL accounting proofs. The
law `tests/a-balance-never-moves-without-its-ledger-row.law.test.ts` pins the
migration's shape, the refusal name, the triggers on every covered table, the
catalog view, the promo fix, the harness, and the staged mode.

Why the proof is a fixture and not a production probe: CLAUDE.md section 2 rule
7, a probe never carries DDL, and the triggers do not exist on production until
the migration is applied. The post-apply production probes (rolled-back `DO`
blocks ending in `RAISE EXCEPTION`, `SET CONSTRAINTS ALL IMMEDIATE` before the
raise) are recorded below once the migration is installed.

## The open incidents (JOB 3)

Recorded in this file's "Settlement" section after the migration is applied
and the incidents are read against it.

## Settlement

(filled in by the delivery that applies the migration)
