# Original seats recover historical paid jackpot reporting

The remaining historical gap was 199 paid recipient receipts across 47 jackpots.
Six receipts retain an original table seat covering the payment timestamp, with
one unambiguous funded club. Capture those witnesses in the private reporting
owner table, including original seat IDs, club, occupancy boundaries, payment time
and amount. Duplicate agreeing seat archives produce one owner and one counted
award. Conflicting or null clubs, later/closed seats and explicit display-only
seed hands cannot qualify. Existing ownership is never overwritten.

This is reporting only: no wallet, stack, paid receipt, ledger or hand fact changes,
and no credit function call. Repeating capture produces no second owner or signal.
The original transaction already captures every new Main/Mini winner, loser and
table share owner under migration20261031044413; that repair remains unchanged.

Native PostgreSQL tests exercise before/after reporting, duplicate/conflicting
witnesses, occupancy boundaries, retained ownership after seat deletion, unchanged
money/receipt rows, replay and private member-record signals. They run through the
existing required Data Console accounting verdict.

## Evidence limit

The other193 cannot be assigned from the evidence found in this investigation.
124 receipts belong to24 July25-Aug19 payouts whose hands were pruned before the
August27 retention change. The contemporary changelog
`2026-08-27-bbj-phase5-and-6.md` independently recorded those24 orphaned hands.
The July payment function credited the legacy global PLAYER wallet or a seat and
did not retain recipient club ownership.69 September receipts have no retained
funded ownership after the six qualifying seat recoveries.

Checked live payout/recipient rows, original seat occupancy, wallet/chip ledgers,
funding receipts, certified outcomes, hand facts, rake attribution, session
intervals, seat exits, audit trail, deleted-ledger archive and BBJ evidence logs,
plus retained BBJ source/audit archives. Cash session club fields are copied from
the table host and cannot establish a union participant's funded club. Current
membership, nearest-in-time exits, and the BBJ pool's club are not substitutes.
Unresolved reporting stays explicitly unavailable instead of silently zero or
assigned to a guessed club. No claim of complete historical recovery is made.
