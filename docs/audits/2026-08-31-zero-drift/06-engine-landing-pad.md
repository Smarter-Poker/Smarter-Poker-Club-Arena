# Engine Landing Pad (Phase 5) - syncStacks, Promo Accrual, and the Two Engine Bugs

The database side is live in production. This document is the engine-side adoption guide -
none of these engine changes are deployed by the zero-drift work; they are drafts for the
engine repo (`server/src`), to be shipped through the normal PR flow.

## 1. Per-hand stack settlement: `fn_ca_settle_hand_stacks` (LIVE in DB)

One RPC call settles a hand's stack deltas atomically or not at all:

```js
// engine: replace the multi-step syncStacks table_seats writes with ONE rpc
const { data, error } = await supabase.rpc('fn_ca_settle_hand_stacks', {
  p_table_id: table.id,
  p_hand_id: hand.id,                 // stable per hand - this IS the idempotency key
  p_hand_number: hand.number,
  p_deltas: seats.map(s => ({ user_id: s.userId, delta: round2(s.net) })),
  p_rake: round2(hand.rake),          // conservation only; banking stays with
  p_bbj: round2(hand.bbjDrop),        // atomic_distribute_rake as today
});
// data.success === true        -> stacks written, walk to 'final' recorded
// data.replay === true         -> this hand was already settled; adopt data verbatim
// data.reason === 'in_flight'  -> another writer holds the claim; back off, retry
// data.success === false       -> NOTHING was written (full rollback); the claim
//                                 records the error; safe to retry with same ids
```

Contract guarantees (all enforced in the DB, verified by rolled-back probes):
sum(deltas) + rake + bbj must equal 0 to the cent; every delta exact 2dp; every
seat must exist, be active, and stay non-negative - else the entire hand write is
rejected and a `hand-conservation:*` incident is raised. A hard-killed engine can
re-send every unacknowledged hand on restart: succeeded hands return `replay`,
failed hands re-run. `drainHands()` stays as the deploy-time flush; the
StateVerifier keeps its role as an independent check.

## 2. Promo accrual queue: `ca_pending_promo_accruals` (LIVE in DB)

When `promo_apply_playthrough` fails (the PostgREST schema-reload windows dropped
rake-queue writes at 19:23 UTC today - promo accruals die the same way):

```js
// engine: in the catch around promo_apply_playthrough
await supabase.from('ca_pending_promo_accruals').insert({
  club_id, user_id: userId, wagered: round2(wagered),
  hand_id: handId ?? null, source: 'engine:promoAccrual',
  last_error: String(err).slice(0, 500),
});
```

`ca-promo-accrual-retry-10m` re-drives the queue through the real RPC every 10
minutes (same pattern as `pending_fee_distributions` for rake - which, note, the
engine should ALSO write on rake-queue failure; today's three lost hands had to be
reconstructed from alert metadata).

## 3. Engine bug: tournament-table cashouts MINTED real chips (guarded in DB)

The engine calls `atomic_table_cashout` for horse seats on tournament-attached
tables. A tournament stack is play chips; the cashout credited it to
`club_members.chip_balance` as real chips - 46.4M chips created since 2026-08-24,
zero matching debits. The DB now closes tournament-table seats with NO credit and
raises `tourney-cashout-blocked:*` warnings per attempt. **Engine fix required:**
the exit path must branch on `tables.tournament_id` - tournament seats are torn
down by the tournament lifecycle (prizes via the payout path), never by the cash
cashout RPC. Until fixed, the warnings show exactly where it still happens.

## 4. Engine bug: ~2% of BBJ banking calls drop under load

Pre-existing; now harmless (15-minute self-heal cron re-banks from rake_records)
but the call-site retry/enqueue should still be fixed at the source.

## 5. The burn-in gate (LIVE in DB)

Before Midway / Shark Club / Club JAQK reopen normal tables:

```sql
select public.fn_ca_midway_burnin_gate(24);  -- horse-only burn-in window
```

Returns `pass` plus eleven named checks (open criticals, new criticals in window,
unknowns, suspense flow, ledger-write failures, blocked tournament mints,
failed/stuck settlements, checksum chain, structural guards, unregistered money
RPCs, last supply snapshot explained). The reopening rule from doc 05 §3: run the
epoch-3 reset, then the gate must return `pass:true` over 24 hours of horse-only
play before normal tables come back. Today (2026-08-31) it correctly fails on
`no_new_criticals_in_window` and `last_supply_snapshot_explained` - the mint was
found today; tomorrow's snapshots prove whether it stayed stopped.

## 6. Exporting byte-exact migration mirrors

41+ applied migrations still need repo files (CA #2309 tightens the check). Pull
them byte-exact from production rather than reconstructing:

```bash
# scripts/dev/export-applied-migrations.sh  (run with a service DATABASE_URL)
psql "$DATABASE_URL" -At -c "
  select version || ' ' || name from supabase_migrations.schema_migrations
  where version >= '20260831'" | while read -r v n; do
  f="supabase/migrations/${v}_${n}.sql"
  [ -e "$f" ] && continue
  psql "$DATABASE_URL" -At -c "
    select array_to_string(statements, E'\n') from supabase_migrations.schema_migrations
    where version='${v}'" > "$f"
  echo "exported $f"
done
```

The phase 2-5 mirror files in this tree marked "canonical body in prod
schema_migrations" are placeholders for exactly this export.
