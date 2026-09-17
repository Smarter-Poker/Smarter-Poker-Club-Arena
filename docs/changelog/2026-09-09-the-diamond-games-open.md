# The Diamond Games open, and get a voice

**2026-09-09. Dan, asked who is allowed to play: "ANYONE WHO HAS DIAMONDS IN
THERE ACCOUNT, INCLUDING HORSES." Asked what to build next: "THIS IS ON YOU TO
DECIDE." Asked whether to add more games: finish these three first.**

Continues `docs/changelog/2026-09-09-diamond-games-on-the-console.md`.

## What the database said

Three finished games, all six configs enabled, and the play counters read
zero. Not a slow start: **zero spins, zero drops, zero rounds, ever.**

The cause was a guard of mine. All three took purchased diamonds only, to
honour the 2026-09-05 ruling that nothing ever earns chips. But the store has
never taken a payment: no `iap_events` at all against ten configured products
and eight diamond packages. Three legacy purchase rows became two lots held by
one account, worth 200 diamonds. So the entire addressable audience for the
programme was one player with two spins in him, while 1,172 players sat on
3,529,754 diamonds they could not spend here.

Put to Dan with that arithmetic, he opened it.

## Certified before it was opened, not after

Nothing had ever run for real. `20260909193244` was not applied until the
money paths had been through a certification pass.

**The tables, exactly.** Every prize table audits to 0.800000 from its live
rows: the wheel's eleven segments (chip share 0.743, diamond share 0.057,
house 0.200, hit rate 0.7653) and all three Plinko boards (Steady 20x, Bold
130x, Moonshot 1000x, each 0.800000). Not a simulation: the sum over the rows.

**The curve, 500,000 times.** Crash is a formula, not a table, so it was
sampled through the live `fn_crash_point_cents`. Every cash-out target returns
80 percent, which is the whole design claim: 1.5x -> 0.7999, 2x -> 0.8009,
5x -> 0.8030, 10x -> 0.8030, 50x -> 0.7955, 100x -> 0.7910. Instant crash
20.75 percent against a theoretical 20.79.

**The plumbing, for real, rolled back.** 117 rounds through the live money
doors as an ordinary player - a horse, which is the ruling above proving
itself - then `RAISE EXCEPTION` so none of it persisted. 60 wheel spins, 45
Plinko drops across all three boards, 12 Crash rounds. Every identity held to
the cent: the wheel minted 44.58 chips on 60 chips of intake, Plinko 36.00 on
45.00, Crash 9.60 on 12.00; the bank moved by mint less prizes exactly; the
member wallet moved by exactly the prizes; 73 prizes carried 73 union receipts
and 73 chip receipts; every Crash reservation was taken while its round was
open and released on settle, leaving zero reserved.

## The detector that is not in this changelog

The plan said a detector: register the three games with `ca_detector_registry`
so drift raises an incident. It was half written when 10.12 was read properly.
"I DO NOT WANT SYSTEMS IN PLACE THAT 'MONITOR FOR ERRORS'! ... a monitor, a
watch, an audit or an alert **presented as the resolution**." That is what it
was. It was deleted rather than shipped.

It would have been redundant as well as forbidden. The bound is enforced at
the line, inside the transaction: `fn_wheel_spin` refuses seven ways,
`fn_plinko_drop` two, `fn_crash_start` one, `fn_crash_decide` two, and each
tests paid-plus-reserved against minted-plus-allowance before it will commit.
A round that would break the invariant does not commit and then get noticed.
It does not commit.

## A voice

All three games were silent. `SoundService` already carries the kit built for
the Spin And Go ladder, so nothing was designed and nothing is loaded - it is
synthesised, it obeys the player's own sound settings, and it declines when
the tab has no audio.

- **The wheel** starts, ticks down over exactly the duration it is turning
  for, and stops: `playSpinStart`, `playSpinTicking(dur)`, `playSpinResult`.
  The prize then speaks for itself, `playBigWin` at five chips or more.
- **Plinko** ticks once per peg row, on the frame the ball crosses it, so the
  rhythm is the fall rather than a loop guessing at it. The slot's own
  multiplier picks the landing: a big multiplier sings, a paying one wins, the
  centre just lands. Under reduced motion the fall collapses and the landing
  still speaks.
- **Crash** starts, and the cash-out sings at the multiplier it got. A crash
  says nothing at all. Silence after a climb is the loudest thing this game
  has.

## Two doors instead of none

The games had exactly one entrance: a banner on the Promotions page, and that
banner was a `<div>` with a border on it, which is a button drawn in CSS. Both
are fixed. The Promotions entry is now the painted action shell the Daily
Bonus stands on, and there is a second door in the club lobby itself, under
the ad strip, where players actually are.

## Gates

`check-ui-text`, `check-title-case`, `check-painted-text-case`,
`check-nav-title-case`, `tsc`, and the full vitest suite: 1,266 files,
**17,626 tests, all passing.** The migration was dry-run against production and
rolled back before it was applied and registered.
