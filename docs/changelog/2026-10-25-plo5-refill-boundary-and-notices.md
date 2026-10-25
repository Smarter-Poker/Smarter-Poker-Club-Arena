# PLO5 refill choices and add-on notices

Classic PLO5 cash games now use the nearest whole-horse 30% Auto Top Up quota
across the whole Cluster, retaining existing choices whenever the quota matches.
Admission still uses the stable hash; each table applies only its own minimum
seat changes at its next hand boundary. This avoids rounding every short table
up and skewing a game's mix above 30%. Standalone tables use their own roster.
Membership changes converge at natural hand boundaries; integer rounding still
means a fractional horse is impossible.
Lightning, Diamond cash and tournaments retain their own refill paths.

One table roster read and two shared session/wallet reads replace three reads
per eligible horse. Wallets remain keyed by both club and user, missing context
refuses the optional purchase, and departed seat ids cannot receive flag writes.
Partial flag writes and lifecycle changes return unknown rather than claiming
that every preference was saved. No timer or repair job was added. Purchases
still use the existing bankroll policy and immutable funding receipt door, with
separate rebuy and top-up operation identities and the authoritative returned
stack. The settlement method is directly exercised for simultaneous purchases,
unknown responses, ownership loss and excluded formats.

Add-on notices now disappear when their player leaves the chair, reject
non-finite amounts, and remember a bounded set of event receipts so a reconnect
cannot restart the same notice. A React integration test delivers two top-ups
and a replay through the real event hook and checks both players keep exactly
one notice. PostgreSQL coverage exercises a live-stack wallet-funded purchase,
a lost acknowledgement, and two concurrent requests for that same purchase.

Local validation and production observations are recorded in the owning task
checkpoint. Production browser checks are observation-only through an isolated
zero-balance certification spectator. Source checks and local behavior are not
claims that the new engine is installed; routine engine activation follows the
existing daily 04:00 America/Chicago certified maintenance route.

Live observation also exposed a binary-cent rounding defect: a 191.31 stack
was topped up by 8.68 and remained at 199.99 instead of 200.00. Shortfalls now
subtract integer cent amounts, and the policy/cap floors remove only a bounded
floating representation error at the cent boundary. A genuinely fractional
policy limit still rounds down. The observed example and fractional-cent caps
are regression cases.
