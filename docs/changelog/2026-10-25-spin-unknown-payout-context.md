# A Spin with unknown payouts is not confirmed winner-take-all

`icmRisk` treated an absent, empty or untrusted Spin tournament context as
one paid place through `explicit?.spotsPaid ?? 1`. It returned zero survival
premium before the existing incomplete-context fallback could run. A Spin
can pay multiple places, so missing evidence cannot establish chip EV.

The zero-premium shortcut now requires a trusted context explicitly naming
exactly one paid place. Unknown contexts use the existing fallback; confirmed
one-place and multi-place payouts retain their respective behavior. This
does not invent a payout curve or change the tournament utility authority.

Three regression cases fail on the previous source and pass with the repair:
absent context, empty context and schema-1 incomplete context claiming one
place. Positive controls retain confirmed one-place zero premium and
multi-place ICM pressure. The change does not activate shadow policy packs,
certify the fleet, or establish improved tournament returns.

The directly affected public-action evidence also had two false-absence
cases. It refused canonical blind level zero, and it rejected a hand still
using the exact previous blind level after the cache advanced. Public capture
now accepts zero and projects a matching, valid previous level. Mismatched
stakes, unknown duration, invalid level, wrong ante rule and incomplete
context remain unavailable. The actual decision context already supported
the previous-level case; these capture repairs do not establish a historical
ICM strategy failure. Two regression cases fail before and pass afterward.

The adaptive-observation consumer also rejected first-level public nodes.
Its level validation now agrees with the canonical zero-based producer; a
real completed-hand regression fails before and passes after this correction.
Negative levels and unavailable tournament contexts remain rejected.
