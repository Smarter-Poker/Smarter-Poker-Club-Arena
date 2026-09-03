# 2026-08-15 follow-up wave — every open finding from the seated E2E closed

Companion to `2026-08-15-live-e2e-money-loop-and-dead-tables.md`. All shipped
and verified same-session.

## 1. Hole-cards Realtime CHANNEL_ERROR — root cause + production fix

`table_hole_cards` was NEVER in the `supabase_realtime` publication, so the
client's secure channel (`table-cards-secure-<table>-<user>`, postgres_changes)
errored on every table page load since the feature shipped. Migration
`add_table_hole_cards_to_realtime_publication`: added to publication +
REPLICA IDENTITY FULL (engine upserts via ON CONFLICT DO UPDATE on re-push).
RLS "Users can read own hole cards" keeps delivery per-player. VERIFIED LIVE:
fresh table page load, 60+ seconds, zero CHANNEL_ERROR (previously errored
within seconds, repeatedly).

## 2. Pre-action armed mid-turn — engine fix (PR #47, b32f6cb3)

Pre-actions only executed at turn START (handleTurnChange step 1); one armed
after the turn began sat queued for the NEXT turn (live repro: CALL ANY armed
as a bet landed — timer ran out on two pair). setPreAction now resolves and
performs the pre-action immediately through handlePlayerAction when it is
currently the caller's turn. Deployed via auto-deploy-hetzner (engine restart
observed 03:36 UTC; hand rate healthy at ~36/min after boot).

## 3. /action 429 drop — client retry (PR #48, d3d572ae)

The engine rate-limits /action to 1/250ms/user; a pre-action auto-fire or a
fold racing a leave landed a second post inside the window, which surfaced a
raw "Server error (429)" toast and DROPPED the action (hit twice in the live
session). submitAction now waits 350ms and retries exactly once on 429 —
always safe, since 429 means the request was not processed.

## 4. Session Complete stats — biggest pot / peak stack (PR #48)

`biggestPotRef` was declared but never written ANYWHERE (modal showed
"BIGGEST POT 0" every session); `peakStackRef` only moved on buy-ins/rebuys.
useTableSession now subscribes to MasterBus POT_DISTRIBUTED (authoritative
total_pot per completed hand) and CHIPS_ADDED (post-top-up stack). Exact
tick-by-tick stack peaks require TablePage's WS merge — TablePage.tsx is
307KB and above the bridge push ceiling (~65KB), documented inline as the
one remaining refinement.

## 5. Heartbeat 502/404 — diagnosed, no code change needed

404 = "Table engine not found": fires transiently while the engine boots
after a deploy (engines re-register), and used to fire persistently for
dead tables (fixed by the recovery sweep + closed-table cleanup). Verified
live: two 404s exactly at the 03:36 restart, then 40+ seconds of clean 5s
heartbeats. 502s are the reverse proxy during the restart window itself.
Both are deploy-transient now, not a steady-state fault.

## Deploy chain status at close

- Engine: #46 + #47 live on Hetzner (restarts observed 03:11 and 03:36 UTC).
- Client: side-pot fix live on production (Vercel dpl_8puZsUTj READY);
  #48 synced to World Hub 03:37 (3ee2824a), Vercel auto-promotes on READY.
- DB: 4 migrations tonight (definer RPCs + grants, orphaned-seat cashout,
  realtime publication), all with in-migration assertions.
