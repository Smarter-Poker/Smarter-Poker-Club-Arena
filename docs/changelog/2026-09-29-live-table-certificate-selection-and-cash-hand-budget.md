# 2026-09-29: the live-table certificate chooses tables that can satisfy it, and cash gets a hand budget sized from real hands

Phase 6A's last gate is the post-deploy live-table certificate
(`tests/e2e/production-live-table-realtime.spec.ts`). SPIN and SNG passed after
#5578. MTT and cash still failed on the serving engine `c0c986ad`. Each failure
was read from rows and engine logs before anything was changed.

## MTT: "The recovered MTT has no eligible natural HUD clock" (runs 36525050502, 36526016402)

Cause, test defect. The table was chosen by seat count. The largest field was
tournament `4dddfe78` (383 players) whose add-on period was open until
06:07:47Z. `eligibleHudClock` is read minutes later, after the hand, offline
and rejoin proof, and correctly refuses an add-on period. The predicate was
right; the selector never asked it.

Fix. The MTT case qualifies its candidate tables at selection with the same
predicate (`selectableHudClock` = `eligibleHudClock` plus a three-level
look-ahead, because a level can roll over during setup and the later read then
judges the next level's successor). The post-recovery read is unchanged and
still refuses loudly; selection also refuses loudly, naming why, when nothing
qualifies. Only the MTT does this.

## Cash, run 36525050502: hand 17217169 "repeats player_action/turn_change"

Not an engine livelock. `hand_history` for table `e78717a2` (NLH 1/2 Classic,
9 seated): hand 17217169 started 05:27:17.239Z and ended 05:29:09.654Z, 112.4
seconds and 12 actions, with an action every 9 to 16 seconds. The certificate
gave up at 05:28:58, eleven seconds before the hand finished, because the two
causal cycles each had a fixed 90-second budget. Cash hands are not short. Over
20,488 non-tournament hands in three hours: p50 30s, p90 87s, p99 149s, max
300s (tournament MTT hands: p90 105s, p99 190s). A fixed 90s begins mid-hand and
must cover the rest of the hand plus the next deal, so it fails a large share of
the time through nobody's fault.

Fix. Cash uses the tournament design: the case gets the base 300s plus one
full-hand bound for readiness, one fixed deadline, and both cycles draw on what
is left of it (with a 15s reserved tail so a named failure fires before the
case's own timeout). The pre-navigation "next hand started" proof now races up
to eight occupied tables and keeps the first to deal, exactly as tournaments
race baselines. The 45s silence limit, which is the real liveness proof, is
unchanged, and so is every assertion. The enclosing job budget arithmetic
(`tests/await-engine-gameplay.test.ts`) is updated for the longer cash case and
still leaves five minutes of cleanup margin inside the 60-minute job.

## Cash, run 36526016402: "Connecting To The Table became visible after its grace period"

Not a test defect and not fixed here. Engine log for the exact table and
minute: `mux subscription timing attempt 227 ... authorityReturnedAtMs 2135.7,
ackQueuedAtMs 2136.6`. The database function behind that authority check
(`fn_ca_engine_table_connection_access`) executes in 9.6 ms
(`EXPLAIN ANALYZE`), but the engine took 2.1 s to return it, after receiving
the SUBSCRIBE about 0.7 s late. Over the engine's 234 measured subscriptions
since its 03:55:58Z start: authority p50 397 ms, p90 980 ms, p99 3,796 ms, max
7,485 ms, and 13 above the banner's 1,200 ms grace (5.5 percent). At the same
moment the engine reported `equityGovernor.scale 0.35` (event-loop p50 108 ms),
the host load average was 8.0 on 4 cores, and equity workers were timing out.
Every await on the shared single-threaded engine loop pays that lag, so a 10 ms
query returns in hundreds of milliseconds and in the tail in seconds. The
certificate's rule (ack and snapshot before the banner grace) is Dan's
"table loads instantly" rule and stays exactly as strict. The cause is engine
event-loop saturation from horse decision and equity load, and needs the load
taken off the main loop (or a larger host), not a looser test.
