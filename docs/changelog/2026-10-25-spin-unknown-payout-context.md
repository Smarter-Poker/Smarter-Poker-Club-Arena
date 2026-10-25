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
