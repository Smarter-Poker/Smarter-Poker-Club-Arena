# Boot grace and the storage pass (2026-08-30)

## Supervisor boot grace 120s -> 300s

During the Supabase compute resize the engine's cold boot legitimately ran
5-8 minutes (repair sweeps and loaders against a cold-cache database). The
supervisor's 120s boot grace made it one of THREE things restarting the
engine mid-boot (with the deploy train and the leadership standby-to-leader
exit), and the fleet went ~80 minutes without dealing a hand. A healthy warm
boot clears in under 2 minutes and is unaffected by the wider grace; a
genuinely wedged boot is still caught by FAIL_THRESHOLD / CHURN_THRESHOLD,
three minutes later than before. `server/scripts/engine-supervisor.sh`,
env-overridable as ever.

## ca_hand_player_idx finally prunes with its hands

`sp_prune_hand_history` deleted `rake_attributions` beside each pruned hand
but never `ca_hand_player_idx` - 12.5M orphaned rows (3.4GB) accumulated
since May, every sampled one pointing at a hand that no longer exists. The
pruner now deletes the per-player index rows in the same pass, a `hand_id`
index makes that delete an index scan, and
`sp_sweep_ca_hand_player_idx_orphans()` exists for any future backlog. The
existing backlog was drained in production with NOT EXISTS-guarded
date-sliced deletes; 1,173 old rows remain and all of them point at hands
that still exist. Also dropped the advisor-confirmed duplicate index on
`tournament_tickets`. Migration:
`supabase/migrations/20260830236000_ca_hand_player_idx_prunes_with_its_hands.sql`
(already applied to production via the Supabase MCP; the file is the RULE 2
record).

## Open item for Dan

`hand_state_snapshots` holds 1.9M rows / 6GB, dominated by the 7-day
forensic window of COMPLETED snapshots (the engine only ever reads
incomplete ones). Tightening that window to 2 days would reclaim ~4GB.
That is a storage-policy knob in the same family as
`hand_history_retention_policy`, so it is Dan's to set, not an agent's.
