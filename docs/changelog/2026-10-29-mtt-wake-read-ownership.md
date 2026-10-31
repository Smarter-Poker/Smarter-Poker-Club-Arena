# Tournament wake reads retain their original owner

GameServer.drainTournamentManagerWakePages treated a null inbox response as a successfully drained queue, clearing its failed-read cause. It also admitted an awaited page after the process lifecycle changed. The actual method now requires an array response and checks its captured lifecycle before each page and admission. Existing exact receipt acknowledgements and retry ownership remain unchanged; no new timer or repair loop is added.

Two actual-method regressions failed before the change. A proved empty inbox remains successful. All 71 connected ownership, durable receipt and capacity-admission tests pass; root and server TypeScript checks pass. This is preventive source hardening, not an attribution of the current stalled hands or proof of production recovery.
