# The wheel gives a free spin a day

**2026-09-09. Dan, on the three Diamond Games: "PROCEED TO THE NEXT PHASE OF
THIS COMPLEX BUILD AND UPGRADE / ENHANCEMENT OF THE DIAMON TO CHIPS GAMES."
Asked earlier what to build and what a free spin should pay: "YOU CAN DECIDE,
IM OK WITH IT."**

Continues `docs/changelog/2026-09-09-the-wheel-recut-and-the-floor.md`.

## Why a free spin

1,172 players hold diamonds and, until the games opened this morning, had no
reason to open the wheel. A free spin a day is the reason: the same wheel, the
same provably fair commit-and-reveal, one spin on the house every day, per
player, per host. It is the oldest retention device a casino has and the
cheapest: the table below pays 9.75 diamonds a spin on average, about ten
cents, and the diamonds it grants go straight back into the paid games at the
20 percent edge.

## What it pays, and why only that

**Diamonds. Never chips.** A free spin takes nothing in, and the games' law
(Dan 2026-09-07, `tests/the-wheel-never-pays-more-than-it-takes-in.law.test.ts`)
is that they never pay out more than they take in. A chip minted against
nothing is exactly the faucet that law exists to close. Diamonds are the
platform's promotional currency and are granted every day already, by the
Daily Bonus, the missions and the challenges; a free spin is the same class
of grant, dealt from a wheel.

The table, weights out of 1,000: 5 diamonds at 700, 10 at 200, 25 at 70, 50
at 25, 250 at 5. Every segment pays. A free spin that lands on Nothing is a
small insult, and the point of this is goodwill.

## Its own machine

Free spins live in their own table, `wheel_free_spins`, not in `wheel_spins`.
A spin with no intake would put the paid wheel's realised return over 100
percent and poison the z-score the operator console reads. Nothing in
`fn_wheel_spin`, `fn_wheel_metrics` or the paid law changes.

The commit is the same commit (`fn_wheel_commit`) and the derivation is the
same derivation: the first 48 bits of HMAC-SHA256(server seed, client:nonce)
over the table's weights. So the player's own verifier checks a free spin
exactly as it checks a paid one; the page walks the free table for a free
spin and the paid table for a paid one, and the unit test pins the same
Postgres-produced vector the paid test uses onto the free weights (point 397
of 1,000, ord 1).

## The guards

- One per player per host per day (America/Chicago, like every other daily
  count here), as a `UNIQUE (host_id, user_id, day)` constraint, not a check.
- A per-host daily pot, `free_spin_daily_budget_diamonds`, 2,000 by default
  and editable from the operator console. When the day's free spins have paid
  it out, the offer simply is not made: the state says `pot_empty`, the lobby
  says "Gone For Today", and the wheel opens on the paid table. That is a
  product rule announced before the player commits, not a refusal of an
  earned reward, so ruling 21 (a budget is a forecast, never a gate on a
  reward already earned) is respected. The pot is counted under the host's
  row lock, so two spins cannot both squeeze through the last of it.
- The grant goes through `add_diamonds_to_balance` with reference
  `wheel:<id>:free`, so the diamond earn ledger attributes it to the wheel
  engine and the per-user daily cap applies as it applies to every promotional
  grant. The profile guard names the door, the way it names `fn_wheel_spin`.
- A commit is spent once: the second call with the same commit replays the
  first spin and pays nothing twice. The record is append-only.

## What the player sees

When today's free spin is on offer the wheel page opens in free mode: the
pill, the Spin bay and the primary plate all say **Free Spin** in gold, the
wheel wears the five-prize table (the 250 in gold, the 50 in glass, the rest
in the club's blue), and the odds console prints the free table under "On
The House". When it lands, the readout says what it paid and where ("Paid
Into Your Diamonds, On The House"), the toast says the same, and the paid
wheel returns with its eleven prizes. The idle line then says when the next
one comes. The lobby's wheel console carries the same pill and a "Free Spin"
row: Ready, Tomorrow, or Gone For Today. History prints paid and free spins
together, newest first, a free one marked as such.

## What the operator sees

A console of its own under the wheel controls: the switch (Turn It Off / On),
the daily pot, and the day's count: free spins today, diamonds given today of
the pot. Turning the wheel off turns the free spin off with it. It pays
diamonds only, so it never touches the bank, the exposure or the invariant
printed above it.

## Proved before it was applied

Both migrations were dry-run against production inside one transaction with
a probe and rolled back before they were applied and registered:
`20260909234101_the_wheel_gives_a_free_spin_a_day` and
`20260909235623_the_wheel_remembers_its_free_spins`.

The probe, as a horse in Club JAQK (a horse is a player, 10.5): the opening
state (enabled, available, pot 2,000, five segments); the free spin (won 10
Diamonds, diamonds 12,273 to 12,283, nonce 1); the verifier's arithmetic
redone in SQL from the revealed seed (it hashes to the commitment; roll
246,773,286,745,074, point 876 of 1,000, ord 2); the ledger (one
`wheel_prize` transaction of 10 with the free reference, the daily award and
the engine-spend row, the commit consumed); the replay (same spin, nothing
paid twice); the second spin of the day refused with its reason and the
state saying `used`; the append-only trigger; a second member turned away
with the pot spent and spinning once it was refilled (two free spins, 20
diamonds paid, on the host that day); the switch (a player refused, an
operator setting it off with a pot of 500, the state saying `closed`, the
spin refused, a negative pot refused); and an anonymous caller getting
neither a state that says available nor a spin.

The first dry run found the profile guard: `fn_guard_profile_privileged_columns`
admits writes to `profiles.diamonds` only from named money doors, and refused
the free spin's grant exactly as it had refused the paid wheel's first
diamond prize on 2026-09-08. The door was added to the guard in the same
migration, patched into the live body the way the arena doors were, and the
migration now refuses to commit unless the guard names it.

## Gates

`check-ui-text`, `check-title-case`, `check-painted-text-case`,
`check-nav-title-case`, `tsc`, the new law test
(`tests/a-free-spin-pays-diamonds-and-nothing-else.law.test.ts`, registered
in `docs/laws.d`), the new unit test (`tests/unit/wheelFreeSpin.test.ts`),
and the full vitest suite.
