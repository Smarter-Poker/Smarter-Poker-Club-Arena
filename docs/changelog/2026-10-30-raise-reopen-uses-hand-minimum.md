# Raise reopening uses the current hand's published minimum

The regular action panel and tile controls both pass the engine's positive
`min_raise` to `heroMayReopenBetting`. That value already includes the dealt
hand's blind and last full raise. The helper incorrectly compared it with the
independently updated table blind again. A level announcement from 1,000 to
1,200 could therefore disable Raise after a player checked and faced a legal
1,000 bet during the unfinished old-level hand.

The helper now uses a finite positive published increment directly, retaining
the metadata blind only when that increment is unavailable or invalid. The
fixed-limit half-bet rule and short-all-in refusal are unchanged. The client
does not change submitted amounts, server bounds, action context or clocks.
This correction requires no new engine contract and does not depend on the
separate hand-bound BB display proposal.

Regression validation: the next-level case and invalid/missing increment
cases produced four assertion failures before the fix; all 14 maintained
reopening tests passed afterward, including short-all-in and fixed-limit
coverage. No production actions or bets were used. This reproduces the source
defect, not the precise cause of Mongo's reported missing-context error.

Real-time law: existing level_up and table_meta_update events continue to
update table metadata; authoritative hand snapshots carry min_raise. No new
polling, snapshot-diff trigger or scheduled repair was added.
