# Follow Players Through The Existing Engine Tournament Feed

Live schema verification found that tournament_players is intentionally excluded from Postgres Changes because of its write volume. A channel could join successfully while never receiving a move. Player following now uses the existing shared tournament engine feed, including committed-hand and lifecycle events, reconnect, and visibility recovery. Each notification reads the watched player’s authoritative assignment; stale reads and stopped follows remain guarded. No polling, database publication change, or new engine contract is introduced.

Regression coverage requires this maintained feed and exercises assignment changes, terminal states, delayed reads, played-seat preservation, and engine reconnect. Production publication and live behavior remain separate verification steps.

Explicit player following also suppresses initial recovery of the observer’s old personal bust report while the tournament is running. Otherwise a returning eliminated entrant could be ejected from the observed table. Ordinary result recovery, new elimination handling, and completed-event handling remain intact; both table layouts carry the per-tab follow flag.
