# server/src/cluster/aCommittedPlanReachesItsFeederBeforeTheDeal.law.test.ts

The ClusterController signals a game's feeders, in-process, the moment fn_cash_clusters_tick_all or fn_cash_cluster_tick returns a committed `moves_planned` for it - right after the call's own lifecycle fence and before any follow-up awaits - and only for games that actually planned. A failed call, or one fenced by stop(), signals nothing. The engine half is server/src/engine/aMainSeatTakesTheNextHand.law.test.ts.
