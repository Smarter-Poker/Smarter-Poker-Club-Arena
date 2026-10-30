# Weekly-payout custody releases retired table engines

The serving EED engine exhausted its main-isolate V8 heap twice on 2026-10-29
(restarts at 16:27 and 23:10 UTC, each about 6.7 hours after the previous
start, each with the main heap at roughly 3.9 GB used of the default 4.1 GiB
limit). Three independent read-only source audits of the main-thread
containers found one unbounded strong registry: `GameServer.weeklyPayoutTableListeners`,
added by #8474 on 2026-10-28 and first served by this release. It was a
`Map<ServerTableEngine, unsubscribe>` that gained an entry for every adopted
engine generation (each tournament table, each replacement after lease loss,
each cash wake or zombie rebuild, and every weekly-payout refresh) and lost
entries only in `stopWeeklyPayout` at process shutdown. None of the registry
exits (`unregisterTableEngine`, `unregisterTournamentTableEngine`,
`replaceTableEngine`, `performDirectTableEngineRecovery`, `performStop`)
touched it, so every retired engine stayed reachable with its hand controller,
telemetry rings and, through its uncleared owner callbacks, its whole
TournamentManager.

The registry is now a `WeakMap`, so it can never own an engine, and a new
`releaseWeeklyPayout(engine)` drops the subscription on every registry exit
above; shutdown releases the engines still published, including retained mixed
F06 custody. Adoption, the weekly drain, the hand-boundary admission and the
quarantined-incumbent refusal are unchanged.

`WeeklyPayoutCustodyReleasesRetiredEngines.test.ts` builds the actual
GameServer and ServerTableEngine and pins each exit; five of its seven cases
fail on the previous source. The existing registry, weekly wiring, direct
recovery and lifecycle ownership suites pass, and the server compiler passes.

This repairs the demonstrated retention. The clean-start heap slope and the
heap-object counts of the next served release are the live proof; this source
change installs nothing by itself. The audits also recorded smaller or by-design
retention outside this change (unsealed completed-F06 custody, per-table metric
series on the gated registry, Lightning pool-session rooms in TableStateHub,
and the per-engine telemetry interval on a hung or stranded teardown).
