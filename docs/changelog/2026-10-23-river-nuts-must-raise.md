# River nuts raise when closing the action

Owner request: a horse must never flat-call last to act on the river with the nuts when it can legally raise. Production hand 44826179 (PLO5, 2d 3s 6s Jh 4d, muckGhost's 7c 5d) ended in a 50-chip call despite an authoritative raise-to range of 100 through 269.

The reference policy's estimated-equity gates and randomized value-raise mix could return a call with the nuts. Later variant, tournament and joint owners could also retain or replace that action. There was no final exact nuts invariant. The incident geometry reproduces as a call on seed 1 before this repair.

`HorseRiverNuts` now resolves that decision after every strategy owner and before timing. It enumerates unseen opponent pairs using the existing exact evaluators, excluding only the horse's own cards, its known discards and public boards. It never reads opponents' private cards. This is exhaustive for Omaha's two-hole plus three-board rule across PLO4/5/6 as well as Hold'em, fixed-limit Hold'em, Short Deck and river Pineapple. Hi/lo requires the nuts on both halves when a low is possible; multiple boards require the nuts on every board. A single nut half or board must not be mistaken for the whole pot.

When every other live player has answered the current wager, and the controller's immutable legal menu allows a raise, a passive nuts decision becomes a legal maximum raise (or the legal short all-in). Already selected raises keep their original sizing. No raise is invented when betting was not reopened, the fixed-limit cap was reached, only an all-in call remains, opponents cannot respond, or another player still owes an action.

The executable graph records the rule as `river_nuts`, version 2. Version 1 journal graphs retain their original eight-node interpretation. Strategy receipts stay bound to what their owner selected; the continuous graph binds the superseding action actually returned. The new source participates in the existing policy digests. Existing unqualified pack selections remain off; this fix does not grant a pack qualification.

The table executor rechecks the same rule against the fresh controller menu after acceptance-time authority rechecks. A pack withdrawn during think time can restore its baseline, so this boundary must not restore a forbidden river call. Its regression first submits a passive worker result and observes the wrong call, then proves the executor submits the legal raise after the repair.

That fresh menu passes through the existing `applyTableCommitmentCap` owner, just like the worker and HTTP inputs. A fixed-limit `all_in` button that the controller would clamp to a call is not treated as a raise: the street cap and exact full-raise/completion target distinguish it from a real short all-in. Both boundaries have failing-before/passing-after regressions.

Regression protection includes the reported river situation across all five styles and seeds, all nine variants, multiple boards, high/low, Short Deck ordering, weaker hands, reopening/caps, short all-ins and the real HandController's menu and accepted raise. Tests also cover graph transport, earlier utility receipts and retained version 1 journal records. Provider deployment and live proof are recorded separately in the task evidence checkpoint, never inferred from this document.
