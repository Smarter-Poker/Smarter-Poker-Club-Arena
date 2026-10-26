# Lightning Early Fold Waits For Its Turn; Stand Up Stops Re-Entry

The owner clarified on October 26 that early fold may move a player to the next Lightning game, but cannot fold their cards out of turn. Lightning now stores private fold intent, uses the existing exposure/reservation release for a priced fold, and applies the old hand's fold through its ordinary turn door. Opponents see no early fold, action record or card removal. Horses use the same path, and their accepted-action witness settles when the actual turn action lands. The hand controller also refuses its legacy immediate-fold bypass off turn; a normal-table leaver queues the existing auto-fold and retains their live appearance until action.

An unpriced seat retains its reservation until its turn or a legitimate uncontested walk. The existing Check/Fold pre-action still takes a free check. No money, payout or exposure function is changed.

A persistent Stand Up & Leave control on the table first persists the existing authenticated Stop Playing request, preventing new matchmaking, and then invokes the original anchor-seat leave and cash-out flow. It remains available between hands. Repeated presses collapse while pending; an unconfirmed stop never claims a completed leave. Old-engine compatibility queues off-turn client folds on every street; priced immediate movement is enabled only by the new engine's fold_on_turn capability.

Verification is recorded in CHECKPOINT-lightning-turn-fold-leave.md. Client publication is independent; the engine runtime change activates through the existing daily maintenance route.
