# Diamond Phase 9: Every Diamond Format Conserves

September 29, 2026. Phase 9 of the Diamond Arena build programme, the line
"Test prize-pool conservation, capped exposure, rounding and cancellation
recovery". Earlier today
[the closed-arena half](./2026-09-29-diamond-phase-9-cross-format-conservation.md)
went into CI for five formats, and the line stayed open. Since then the create
door began admitting satellites and Spins. This finishes the line for all seven
formats: the closed-arena half in CI, the funded half as a rolled-back
production rehearsal through the installed doors.

## The closed-arena half, in CI, for all seven formats

`tests/sql/diamond-tournament-lifecycle-cases.sql`, run by
`tests/sql/run-diamond-tournament-lifecycle.py` through the Diamond acceptance
wrapper, never opening either arena switch:

- **Satellite and Spin rows in the format table.** The satellite is the
  estate's committed "Sunday Major Satellite" (buy-in 5, which is too small to
  carry a fee at the Diamond unit) feeding the table's own MTT row; without its
  promised five seats, because a promised seat is a guarantee and the door
  refuses it by name (asserted). The Spin is the estate's board at its smallest
  buy-in (1 Diamond, the Deep Stack of 1000 and the draw receipt's twelve-level
  blind ladder) on the published Spin table, which the seed now slices verbatim
  from the migrations that seed it. Pricing, rounding at both units, capped
  exposure (48 refusals by name, nothing moved), the closed-switch refusal and
  cancellation before launch now loop over eight rows. The Spin row also proves
  its multiplier table is pinned by sha256 and that every tier's pool and every
  place of its ladder is a whole Diamond at a buy-in of one.
- **The Spin's reserve source.** A Diamond Spin can only be created against an
  authorized source (`a_diamond_spin_draws_a_whole_prize`); production has none.
  The case asserts that refusal by name first, then authorizes, inside the
  disposable cluster only, exactly the published table's own worst excess as
  the cap and gives the house exactly its required cover, both read from the
  contract the create door applies. No number is typed.
- **The stale expectations.** Case 1 expected a satellite, a Spin and a stray
  satellite target to be refused as `diamond_tournament_format_not_open`; they
  are now refused by their own rules (`diamond_satellite_requires_a_target`,
  `diamond_spin_rejects_a_non_spin_configuration`,
  `diamond_tournament_target_requires_a_satellite_format`), and the money-key
  fence (`diamond_tournament_money_key_not_read`) joined them.
- **The captures refreshed.** Every pin of both captures was read against
  production. Twelve doors had moved and were re-pinned: the create door, the
  four this morning's changelog recorded as stale (the reserve, chip-escrow,
  late-registration and maintenance-boundary doors), and seven more today's
  migrations changed (the guard watchlist, both escrow readers, the drain, the
  open-shadow, the refund and the satellite-target guard). Fifteen doors joined the second capture, two INSERT
  triggers production attached after 2026-09-20 were installed, and a retired
  trigger was dropped from three more relations.
  [`tests/sql/diamond-tournament-doors.README.md`](../../tests/sql/diamond-tournament-doors.README.md)
  says how a capture is refreshed and lists them.
- **Measured, not assumed.** Run with `track_functions` on, the cases execute
  174 production functions; 165 are byte-identical to production. The nine
  that are not are named in the README: five on the seed's signup path (setup,
  not under test) and four on the UPDATE half of the `tournaments` trigger chain,
  which this fixture has never stood up. A Spin's own table is written through
  the base's `tables` trigger chain, where six production INSERT triggers do not
  fire; the funded rehearsal runs them.

Run locally the way CI runs it (the wrapper, `--only
run-diamond-tournament-lifecycle.py`, PostgreSQL 17.11): passed in 4.5 seconds.

## The funded half, a rolled-back production rehearsal

CI cannot take a Diamond entry without opening `tournaments_enabled`, which no
fixture may do. The evidence the estate accepts for funded tournament behaviour
is a rolled-back rehearsal through the real doors, and that is what
[`docs/evidence/diamond-phase-9-funded-conservation/`](../evidence/diamond-phase-9-funded-conservation/README.md)
keeps: one fixture, repeatable by hand, run once per slice so no transaction
outgrows the rehearsal safety target. On 2026-09-29 at 18:31 to 18:32 UTC,
after every migration of the day was applied:

```
REHEARSAL OK [slice mtt]: 112 of 112 assertions passed (arithmetic 5/5, mtt 104/104, all 3/3).
REHEARSAL OK [slice sng]: 112 of 112 assertions passed (arithmetic 5/5, sng 104/104, all 3/3).
REHEARSAL OK [slice bounty]: 129 of 129 assertions passed (arithmetic 5/5, bounty 121/121, all 3/3).
REHEARSAL OK [slice pko]: 114 of 114 assertions passed (arithmetic 5/5, pko 106/106, all 3/3).
REHEARSAL OK [slice mystery]: 130 of 130 assertions passed (arithmetic 5/5, mystery 122/122, all 3/3).
REHEARSAL OK [slice satellite,spin]: 146 of 146 assertions passed (spin 45/45, arithmetic 5/5, satellite 93/93, all 3/3).
```

For every format: entries in whole Diamonds and their replays, a withdrawal and
its replay, the launch (every deferred seat guard forced at each commit), the
knockouts, a rebuy and its replay, capped exposure against funded banks, a
cancellation of the started event refused by name and moving nothing, the
terminal and its replays, and three cancellations on events of their own
(before launch, after a launch that began, after a rebuy) that return every
Diamond. A satellite seat moves custody to custody into its target and settles
there like a paid entry, or comes home whole when the target is cancelled; a
Spin's draw moves only the pool's difference from the entries, against its
source, the right way. Every event ends with every bank at zero, what came in
equal to what went out, every custody row released, each format's players
having lost exactly the fees the house kept, and the supply identity where the
rehearsal found it.

Not driven, and why, in the evidence README: a PKO knockout (the collector
needs the engine's accepted-hand evidence, which a rehearsal cannot forge, so
the PKO bounty bank is proved at the terminal), the public rebuy door (the same
evidence; the rehearsal calls the money core it calls), and the global
settlement lane (never taken on a live platform: cancellations run inside the
finish lane the rehearsal already holds).

## The ladder version: unchanged, and why

Version 1 of the prize ladder can pay a lower place more than a higher one at
the Diamond unit (the defect the rounding cases found this morning). Version 2
does not. The Diamond create door stamps no version, so the column default, 1,
applies. So does every chip creation door: `fn_create_tournament` and
`fn_create_tournament_governed_legacy` never set `payout_math_version`, and all
270,797 tournaments in production carry version 1. There is no chip rule
stamping version 2 for the Diamond door to mirror (and the
`tournament_prize_math_contract_valid` check admits version 2 only for MTT-type
events, not sit-and-gos, Spins or satellites). Which ladder a Diamond event
pays by is therefore a product decision, and it is Dan's; nothing was changed.
