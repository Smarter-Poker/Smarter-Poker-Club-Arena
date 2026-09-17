# Diamond Games Retain The Sealed Round

Scope: Plinko, Crash, Donkey Crossing and Mines only. The owner redirected this
task to Diamond-to-Chip game audit, improvement and enhancement on September 15.
Must Move work is preserved separately and is outside this continuation.

New bonus requests retain the seed hash displayed before play. A complete
receipt must carry that same hash before the pending request is cleared. The
client still replays an unchanged older saved request that lacks this new field;
it does not manufacture an earlier commitment or replace an unanswered wager.
Malformed tickets and invalid custom seeds are rejected before persistence or
the money request. Previously an empty seed could be saved, then fail the
recovery parser while handling the server's refusal.

Crash settlement responses are checked before normalization can coerce missing
prizes to zero or truthy strings to success. Polls and cashouts bind the round,
club, entry, original fairness commitment and accepted limits. Open rounds must
remain sealed; settled responses must contain consistent status, cents and
revealed outcome. Donkey Crossing and Mines continuations also retain their
original settings, commitment, prize ladder and ordered selection prefix.

Crash now owns each polling generation through the asynchronous response and
error continuation. A stopped poll cannot overwrite a new round or schedule
another poll after the page closes. Overlapping poll/cashout receipts finish
the displayed round once. The next wager waits for the admitted cashout to
finish, and an unanswered cashout is described as unconfirmed rather than
asserting it never reached the server.

The existing Three.js scenes remain. Donkey Crossing and Mines now allow WebGL
context restoration and retire the fallback message when restoration succeeds;
game controls remain available during graphics loss.

No payout mathematics, owner funding terms, wallet ordering, welcome eligibility
or claimed tenth-day Daily Bonus rules change. The wheel redesign and prepaid
wheel-to-game ticket contract remain the separate phase awaiting owner design.

Regression source covers all four commitment substitutions, invalid seed
preflight, older saved-request compatibility, malformed Crash receipts, changed
round identity, both choice-game continuations, delayed poll/cashout ordering,
and leaving the Crash page during a failed poll. Tests, typechecks, application
builds, native wallet checks and browser/graphics checks have not run on these
bytes: the protected local pipeline is not qualified for source jobs. Ordinary
local source checks and commit formatting are not execution evidence. No
migration, GitHub operation, source admission or publication is requested here.

Research reviewed from primary sources: [InOut Chicken Road Two](https://inout.games/en/game/chicken-road-two),
[Stake Mines](https://stake.com/casino/games/mines), and
[Stake's commitment and verification description](https://stake.com/provably-fair/implementation).
They inform mechanics and commitment review; the games retain their own original
assets and existing internal payout model.
