# SESSION 11 SHIP SPEC — anchored patches against origin/main

Every patch below is old-string/new-string anchored against origin/main as of
f5d28382b (2026-08-22 22:46 UTC). If an anchor fails to match, main moved —
re-read the region and re-anchor; do NOT force. New files are provided whole
in this directory tree (copy them verbatim to the same relative path).

Bugs these fix (all found in the 2026-08-23 session-11 audit, all verified in
prod):

- BUG-1 (HEADS-UP LANE DEAD): TournamentManagerBase.start() hard-codes a
  3-player floor; a 2-seat Heads-Up SNG is full at 2, so every duel stands
  down forever and its interval schedule never respawns. Live evidence:
  tournament 0504c8fb "Heads-Up Hyper Duel", 2/2 seated, REGISTERING for 4+
  hours, exactly one spawn row all day.
- BUG-2 (GUARANTEES NEVER HONORED for scheduler-spawned events): the engine
  never applies guaranteed_prize to prize_pool anywhere; the recurring
  service pre-applied it at creation, the new scheduler does not. Live
  evidence: Bounty Builder Turbo COMPLETED with pool 12.5 vs GTD 500; Sunday
  Midway Major REGISTERING with pool 720 vs GTD 10000. (The lobby DISPLAYS
  max(pool, gtd) already — only payouts are wrong.)
- BUG-3 (SATELLITE SEAT COUNT IGNORED): processSatelliteAwards derives seats
  from floor(pool / ticketCost) and never reads satellite_seats; the
  advertised 5-seat Sunday Major Satellite would award pool-derived seats.
- BUG-4 (RESTART CLONES CAN CARRY AN ILLEGAL SPLIT): the restart lane copies
  buy_in_amount/buy_in_fee verbatim; a legacy over-cap split (e.g. 22+3) is
  rejected by tournaments_rake_within_10_pct on every clone attempt, forever.
- BUG-5 (DB, ALREADY FIXED IN PROD): fn_tournament_entry_split bounty branch
  defaulted rake to 10% when buy_in_fee = 0. Migration file
  supabase/migrations/20260823000000_fix_entry_split_no_default_rake.sql is
  the repo record — commit it; it is already applied (assertions passed).

Also in this tree, new feature (handoff pending item 3):

- RegistrationApprovalsPanel (.tsx/.css) + TournamentDetails integration —
  the owner-facing whitelist manager for authorized_to_register events.

---

## P1 — NEW FILE server/src/tournament/startRules.ts

Copy from `server/src/tournament/startRules.ts` in this tree.

## P2 — NEW FILE server/src/tournament/startRules.test.ts

Copy from `server/src/tournament/startRules.test.ts` in this tree.

## P3 — server/src/tournament/TournamentManagerBase.ts (three edits + import)

### P3.a import

OLD:

```ts
import { acceleratedLevelMs } from './acceleratedLevels.js';
```

NEW:

```ts
import { acceleratedLevelMs } from './acceleratedLevels.js';
import { startFloorFor, effectivePrizePool } from './startRules.js';
```

### P3.b the start floor (BUG-1)

OLD:

```ts
      if ((regCount || 0) < 3) {
```

NEW:

```ts
      // Heads-Up SNGs (2-seat, 2026-08-22 parity) are FULL at two players —
      // the historical hard floor of 3 held every duel in REGISTERING forever
      // (see startRules.ts for the incident). The floor is now min(3,
      // max_players), never below 2.
      const startFloor = startFloorFor(tournament.max_players);
      if ((regCount || 0) < startFloor) {
```

And in the stand-down log line just below, OLD:

```ts
`[Tournament:${this.tournamentId.slice(0, 8)}] Only ${regCount} player(s) — standing down so the field can be filled (NOT cancelling)`;
```

NEW:

```ts
`[Tournament:${this.tournamentId.slice(0, 8)}] Only ${regCount} player(s) of the ${startFloor} needed — standing down so the field can be filled (NOT cancelling)`;
```

### P3.c guarantee at start for no-late-reg events (BUG-2, exact case)

Anchor: immediately BEFORE the RUNNING flip:

```ts
// Set tournament to RUNNING
// Guard: only transition REGISTERING → RUNNING (prevents re-starting)
```

Insert ABOVE that comment:

```ts
// ── GUARANTEE, no-late-reg case (2026-08-23) ──
// An event with no late registration takes its last entry before this
// line, so the pool it holds now is the pool it dies with — apply the
// advertised guarantee here and finalize. Events WITH late reg are
// bumped at finalization instead, where the pool truly stops moving.
// Scheduler-spawned events accrue per-entry through the register RPCs
// and nothing else ever applied guaranteed_prize (the old recurring
// service pre-applied it at creation, which is why this was never seen
// before the 2026-08-22 data-driven schedules).
{
  const lateRegCap = Number(tournament.late_reg_levels ?? tournament.rebuy_levels ?? 0);
  const gtd = Number(tournament.guaranteed_prize) || 0;
  if (lateRegCap <= 0 && gtd > 0 && !this.prizePoolFinalized) {
    const { data: poolRow } = await supabase
      .from('tournaments')
      .select('prize_pool')
      .eq('id', this.tournamentId)
      .maybeSingle(); // FIX 168
    const poolNow = Number(poolRow?.prize_pool) || 0;
    const finalPool = effectivePrizePool(poolNow, gtd);
    if (finalPool > poolNow) {
      await supabase
        .from('tournaments')
        .update({ prize_pool: finalPool, prize_pool_finalized: true } as any)
        .eq('id', this.tournamentId);
      tournament.prize_pool = finalPool;
      if (this.tournamentCache) this.tournamentCache.prize_pool = finalPool;
      this.prizePoolFinalized = true;
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Guarantee applied at start: pool ${poolNow} -> ${finalPool}`
      );
    }
  }
}
```

### P3.d guarantee at late-reg close (BUG-2, main case)

OLD (inside the level-up handler):

```ts
this.prizePoolFinalized = true;
const { data: freshT } = await supabase
  .from('tournaments')
  .select('prize_pool')
  .eq('id', this.tournamentId)
  .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
if (freshT) {
  await supabase
    .from('tournaments')
    .update({
      prize_pool: freshT.prize_pool,
      prize_pool_finalized: true,
    } as any)
    .eq('id', this.tournamentId);
  console.log(
    `[Tournament:${this.tournamentId.slice(0, 8)}] Late reg/rebuy closed at level ${this.currentLevel} — prize pool finalized: ${freshT.prize_pool}`
  );
}
await this.broadcast('late_reg_closed', { prizePool: freshT?.prize_pool || 0 });
if (freshT) {
  await this.recalculateEliminatedPrizes(freshT.prize_pool);
}
```

NEW:

```ts
this.prizePoolFinalized = true;
const { data: freshT } = await supabase
  .from('tournaments')
  .select('prize_pool, guaranteed_prize')
  .eq('id', this.tournamentId)
  .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
// GUARANTEE (2026-08-23): the pool stops moving here, so this is
// where the advertised guarantee becomes real money. Writing the
// max back to prize_pool keeps every reader — payouts, lobby,
// fn_tournament_payout_reconcile — agreeing on one number.
const finalPool = freshT ? effectivePrizePool(freshT.prize_pool, freshT.guaranteed_prize) : 0;
if (freshT) {
  await supabase
    .from('tournaments')
    .update({
      prize_pool: finalPool,
      prize_pool_finalized: true,
    } as any)
    .eq('id', this.tournamentId);
  console.log(
    `[Tournament:${this.tournamentId.slice(0, 8)}] Late reg/rebuy closed at level ${this.currentLevel} — prize pool finalized: ${finalPool}`
  );
}
await this.broadcast('late_reg_closed', { prizePool: finalPool });
if (freshT) {
  await this.recalculateEliminatedPrizes(finalPool);
}
```

### P3.e guarantee at add-on end (BUG-2, add-on case)

OLD (finalizeAfterAddOn):

```ts
this.prizePoolFinalized = true;
const { data: freshT } = await supabase
  .from('tournaments')
  .select('prize_pool')
  .eq('id', this.tournamentId)
  .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
if (freshT) {
  await supabase
    .from('tournaments')
    .update({
      prize_pool: freshT.prize_pool,
      prize_pool_finalized: true,
    } as any)
    .eq('id', this.tournamentId);

  await this.recalculateEliminatedPrizes(freshT.prize_pool);
}
```

NEW:

```ts
this.prizePoolFinalized = true;
const { data: freshT } = await supabase
  .from('tournaments')
  .select('prize_pool, guaranteed_prize')
  .eq('id', this.tournamentId)
  .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
if (freshT) {
  // GUARANTEE (2026-08-23): same rule as the late-reg-close site — the
  // pool is final now, so the advertised guarantee is applied here.
  const finalPool = effectivePrizePool(freshT.prize_pool, freshT.guaranteed_prize);
  await supabase
    .from('tournaments')
    .update({
      prize_pool: finalPool,
      prize_pool_finalized: true,
    } as any)
    .eq('id', this.tournamentId);

  await this.recalculateEliminatedPrizes(finalPool);
}
```

## P4 — server/src/tournament/TournamentManager.ts (BUG-3)

OLD:

```ts
const seats = ticketCost > 0 ? Math.floor(pool / ticketCost) : 0;
```

NEW:

```ts
// 2026-08-23 parity follow-up: satellite_seats is the ADVERTISED seat
// count and wins when set (the 2026-08-22 template stores it; the Sunday
// Major Satellite promises 5). floor(pool / ticket) remains the fallback
// for legacy satellites created before the column existed. With no open
// target (ticketCost 0) seats stay 0 so the whole pool falls through to
// the cash path below — advertised seats into a vanished target would
// otherwise pay nothing at all.
const configuredSeats = Math.max(
  0,
  Math.floor(Number((tournament as { satellite_seats?: unknown })?.satellite_seats) || 0)
);
const seats =
  ticketCost > 0 ? (configuredSeats > 0 ? configuredSeats : Math.floor(pool / ticketCost)) : 0;
```

## P5 — server/src/tournament/TournamentManagerEliminations.ts (BUG-3 select)

OLD:

```ts
'payout_structure, prize_pool, buy_in_fee, current_players, club_id, name, status, is_bounty, is_pko, is_mystery_bounty, variant, tournament_type, spin_multiplier, satellite_target_id';
```

NEW:

```ts
'payout_structure, prize_pool, buy_in_fee, current_players, club_id, name, status, is_bounty, is_pko, is_mystery_bounty, variant, tournament_type, spin_multiplier, satellite_target_id, satellite_seats';
```

## P6 — server/src/services/ScheduledTournamentService.ts (BUG-4)

Anchor, in maybeRestartTournament, OLD:

```ts
for (const col of ScheduledTournamentService.RESTART_COPY_COLUMNS) {
  if (old[col] !== undefined) row[col] = old[col];
}
```

NEW:

```ts
for (const col of ScheduledTournamentService.RESTART_COPY_COLUMNS) {
  if (old[col] !== undefined) row[col] = old[col];
}

// A legacy instance can carry a pre-floor fee split (e.g. 22+3 = 12%)
// that tournaments_rake_within_10_pct now rejects on INSERT — the clone
// would fail on every poll for 24 hours. Re-cut the fee from the same
// player-paid total (floor 10%, splitBuyIn's arithmetic without the
// ladder snap — a manual event keeps its price). Compliant splits,
// including every spin's fee-free 0, pass through untouched.
{
  const amt = Number(row.buy_in_amount) || 0;
  const fee = Number(row.buy_in_fee) || 0;
  const cap = Math.floor((amt + fee) * 0.1 + 1e-9);
  if (fee > cap) {
    row.buy_in_amount = amt + fee - cap;
    row.buy_in_fee = cap;
  }
}
```

## P7 — client: approvals panel

- NEW `src/components/tournament/RegistrationApprovalsPanel.tsx` (this tree)
- NEW `src/components/tournament/RegistrationApprovalsPanel.css` (this tree)
- `src/pages/tournament/TournamentDetails.tsx`, two edits:

Import — OLD:

```ts
import { FinalTableOverlay } from '../../components/tournament/FinalTableOverlay';
```

NEW:

```ts
import { FinalTableOverlay } from '../../components/tournament/FinalTableOverlay';
import RegistrationApprovalsPanel from '../../components/tournament/RegistrationApprovalsPanel';
```

Render — OLD:

```tsx
        {activeTab === 'detail' && (
          <>
            {/* Tournament Results (for completed tournaments) */}
```

NEW:

```tsx
        {activeTab === 'detail' && (
          <>
            {/* Authorized-to-register approvals (2026-08-23): the owner-facing
                whitelist manager the gate shipped without. Renders null for
                non-admins and for events without the flag. */}
            <RegistrationApprovalsPanel
              tournamentId={tournament.id}
              clubId={String((tournament as any).club_id || '')}
              authorizedToRegister={Boolean((tournament as any).authorized_to_register)}
            />
            {/* Tournament Results (for completed tournaments) */}
```

## P8 — supabase/migrations/20260823000000_fix_entry_split_no_default_rake.sql

Copy from this tree. ALREADY APPLIED to prod (assertions passed) — this is
the repo record. `scripts/ci/check-migrations-applied.mjs` should pass since
the function exists in the live schema and the file declares no new tables
or columns.

## P9 — MIGRATION-CHANGELOG.md

Insert the entry from `changelog-session11b.md` (this tree) at the top of the
entries (after the `---` under the header block), same as every session.

---

## SHIP STEPS (from a machine with a shell)

```bash
eval "$(bash scripts/agent-workspace.sh cowork-s11 fix/tournament-audit-fixes)"
# apply P1-P9 (copy new files, apply anchored edits)
cd server && npx tsc --noEmit && cd ..
npx tsc --noEmit
npx vitest run server/src/tournament/startRules.test.ts server/src/tournament/payoutStructure.test.ts tests/ --silent   # shard if in a VM (~175s cap)
git add -A && git commit -m "fix(tournament): heads-up start floor, honored guarantees, advertised satellite seats, restart-clone rake recut + approvals panel"
git push -u origin HEAD && gh pr create --fill
# STOP. Autopilot merges.
```

VERIFY after engine redeploy (server/\*\* changed → auto-deploy):

1. Heads-Up Hyper Duel 0504c8fb leaves REGISTERING (or its lane respawns).
2. `select name, prize_pool, guaranteed_prize from tournaments where name='Sunday Midway Major' and status='REGISTERING';`
   → prize_pool becomes 10000 at late-reg close Sunday (or watch a smaller
   gtd event finalize sooner).
3. First Sunday Major Satellite completion awards exactly satellite_seats
   rows in the target's tournament_players.
4. Zero new postgres log lines for rake_within_10_pct (BUG-5 already fixed).
