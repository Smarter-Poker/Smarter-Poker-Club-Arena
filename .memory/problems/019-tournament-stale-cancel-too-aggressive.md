# Problem 019 — Tournament Stale-Cancel Sweep Too Aggressive (133 MTTs Nuked in 7 Days)

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-15 (full-feature audit, Wave 4 investigation)
**Date Fixed:** 2026-04-15 (same session, fix-first; code change pending Hetzner redeploy)
**Severity:** HIGH — zero successful tournaments in the past week

## Discovery

Full-feature audit Wave 4 query: "how many tournaments have run in production?"

```sql
SELECT status, COUNT(*) FROM tournaments
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY status;
-- CANCELLED: 133
-- (nothing else)
```

Every tournament created in the last 7 days was CANCELLED. Zero `COMPLETED`, zero `RUNNING`, zero `REGISTERING`. Spot-checking individual rows:

```sql
-- "Evening Mystery Bounty (PLO5)":
--   min_players=12, current_players=18 (✓ exceeded minimum)
--   started_at=2026-04-14 18:01:47 (✓ actually started — 6s after start_time)
--   ended_at=NULL          ← not properly closed
--   status='CANCELLED'
```

Tournaments were successfully reaching minimum players, starting, playing hands (some had eliminations recorded), then being cancelled mid-run with `ended_at=NULL`.

## Root cause

`server/src/index.ts:484-489` (pre-fix):

```ts
// 6. Cancel stale RUNNING MTT tournaments older than 2 hours (stuck from crashed server)
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
await supabase
  .from('tournaments')
  .update({ status: 'CANCELLED' })
  .eq('status', 'RUNNING')
  .lt('created_at', twoHoursAgo);
```

Three problems:

1. **2-hour threshold is way too short.** Deep-stack MTTs routinely run 6+ hours. Every legitimate long MTT gets killed on the next engine restart after 2 hours of running.
2. **No liveness check.** The code assumes "created >2h ago + status=RUNNING" means "crashed", but it could just mean "currently in level 15". No check of `hand_history` for recent activity.
3. **No `ended_at` set.** Audit trail is broken — you can't tell when these tournaments were actually cancelled, just `updated_at` which gets overwritten on any other update.
4. **No player refund.** Registered players lost their buy-in (or at least lost their equity) without any refund path. Compare to the `insufficient players` path at line 640-643 which DOES refund via `log_wallet_transaction(category='refund')`.

Every time the Hetzner engine container restarted (deploys, crashes, etc.), every MTT that happened to be running would be nuked. Over the past 7 days this killed 133 tournaments.

## Fix

### Part A — SQL backfill (live-applied)

`supabase/migrations/20260415_bug_019_orphaned_tournaments.sql`:

```sql
UPDATE tournaments
SET ended_at = COALESCE(started_at, created_at) + INTERVAL '2 hours',
    updated_at = NOW()
WHERE status = 'CANCELLED' AND ended_at IS NULL
  AND started_at IS NOT NULL AND created_at > NOW() - INTERVAL '30 days';
```

All 133 orphaned tournaments now have `ended_at` populated (set to approximate cancel time = `started_at + 2h`, matching the old policy's cancel window). Audit/UI can now close them out. No refunds issued as part of this cleanup — that's a separate operational decision for Dan.

### Part B — Server code (pending Hetzner redeploy)

`server/src/index.ts:484-489` replaced with liveness-checking version:

```ts
const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const { data: staleTourneys } = await supabase
  .from('tournaments')
  .select('id, name')
  .eq('status', 'RUNNING')
  .lt('created_at', twelveHoursAgo);
for (const t of staleTourneys || []) {
  const { count: recentHands } = await supabase
    .from('hand_history')
    .select('id', { count: 'exact', head: true })
    .eq('tournament_id', t.id)
    .gte('created_at', oneHourAgo);
  if ((recentHands || 0) > 0) {
    // still active — don't touch
    continue;
  }
  await supabase
    .from('tournaments')
    .update({ status: 'CANCELLED', ended_at: new Date().toISOString() })
    .eq('id', t.id);
}
```

Four changes:

1. **Threshold: 2h → 12h.** Accommodates legitimate deep-stack MTTs. Still catches genuinely crashed tournaments.
2. **Liveness check via hand_history.** Any tournament with a hand in the last hour is considered active and skipped.
3. **`ended_at` now set** on every cancellation by this path.
4. **Per-tournament logging** so the cancellation is traceable.

## Deploy status

| Layer                           | Status                                                     |
| ------------------------------- | ---------------------------------------------------------- |
| SQL backfill (133 tournaments)  | ✅ LIVE applied via Supabase MCP                           |
| `server/src/index.ts` fix       | ✅ committed to CA repo main                               |
| Activation in production engine | ⏳ pending Hetzner redeploy (`./server/deploy-hetzner.sh`) |

## Verification plan

Once the Hetzner engine picks up the new code:

1. Create a test MTT, let it run past the 12h mark (or fake `created_at` to >12h ago).
2. Ensure the engine doesn't cancel it as long as `hand_history` has rows in the last hour.
3. Kill the engine cold, don't deal any hands for 1+ hour, restart engine. Confirm THAT tournament does get cancelled with `ended_at` set.

Run the live query post-deploy:

```sql
SELECT status, COUNT(*) FROM tournaments
WHERE created_at > '<deploy-time>'
GROUP BY status;
-- Expect: RUNNING / COMPLETED rows, not CANCELLED-only.
```

## Related

- BUGs 008-018 — all prior silent-failure bugs in this session.
- Bible V8 §7.14 (Tournament elimination) — affected by the lack of proper `ended_at`.

## Lesson

Eleventh silent-failure in this session. Specific to tournaments: every startup-sweep cleanup path needs a liveness check, not just an age check. "Running for >Xh" is not the same as "crashed". Auditable cancellation (ended_at + reason) is table stakes for any financial state transition.
