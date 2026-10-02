# Diamond Phase 9: the funded conservation rehearsal, every format

Evidence for the funded half of the Phase 9 line "Test prize-pool
conservation, capped exposure, rounding and cancellation recovery". The
closed-arena half runs in CI (cases 9 to 13 of
`tests/sql/diamond-tournament-lifecycle-cases.sql`); this half cannot, because
every case in it needs a Diamond entry and `fn_poker_diamond_reserve` refuses
one while `tournaments_enabled` is closed, and no CI fixture may open it.

`rehearsal-fixture.sql` is the whole fixture. It is **not** loaded by any CI
runner. It runs against production through the estate's rehearsal helper, as
one transaction that ends in a deliberate `RAISE EXCEPTION 'REHEARSAL OK ...'`,
so nothing it does persists: the synthetic wallets it sets, the staff role, the
Spin reserve source it authorizes, the house cover and the opened
`tournaments_enabled` are all rolled back with everything else.

## How to run it

Seven formats do not fit one transaction under the ten-second rehearsal target,
so the fixture is run once per slice. The slice is one line near the top:

```sql
SELECT set_config('conservation.slice', 'mtt', true);
```

Run it with `mtt`, `sng`, `bounty`, `pko`, `mystery` and `satellite,spin`, each
through the helper with an empty migration file first:

```sh
: > /tmp/empty-migration.sql
/Users/smarter.poker/Documents/diamond-arena/bin/rehearse.sh /tmp/empty-migration.sql rehearsal-fixture.sql <agent-name>
```

The helper takes the swarm mutex, waits out the :49 to :03 UTC break window and
passes only when the output contains `REHEARSAL OK`.

## The run of record

2026-09-29, 18:31 to 18:32 UTC, against production with every migration through
`20260929181500` applied (including `20260929180000`, which put a Diamond
tournament chair in the arena; before it, the deferred seat guard P0812 refused
every Diamond tournament chair at commit). The six slice files differ from
`rehearsal-fixture.sql` only in the slice line.

| Slice          | Fixture md5                        | Result                                                                                                                      |
| -------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| mtt            | `457519babd94d8f96e57fea97a120ab0` | `REHEARSAL OK [slice mtt]: 112 of 112 assertions passed (arithmetic 5/5, mtt 104/104, all 3/3).`                            |
| sng            | `11ad824ff2d13164d6b9275db061249c` | `REHEARSAL OK [slice sng]: 112 of 112 assertions passed (arithmetic 5/5, sng 104/104, all 3/3).`                            |
| bounty         | `7a38028df861f722bf1885dea8ba5462` | `REHEARSAL OK [slice bounty]: 129 of 129 assertions passed (arithmetic 5/5, bounty 121/121, all 3/3).`                      |
| pko            | `4c937d5137d22a26682bf50ffd0e0e32` | `REHEARSAL OK [slice pko]: 114 of 114 assertions passed (arithmetic 5/5, pko 106/106, all 3/3).`                            |
| mystery        | `1420759dfd3f4075757463afac212c0d` | `REHEARSAL OK [slice mystery]: 130 of 130 assertions passed (arithmetic 5/5, mystery 122/122, all 3/3).`                    |
| satellite,spin | `2f3a0a40f250a8dbcdb0fdd32d00defc` | `REHEARSAL OK [slice satellite,spin]: 146 of 146 assertions passed (spin 45/45, arithmetic 5/5, satellite 93/93, all 3/3).` |

743 assertions, none failed. Every deferred constraint was forced at each point
a real transaction would commit (`SET CONSTRAINTS ALL IMMEDIATE`), and a launch
was one commit per RPC, as the engine runs it.

## What each slice drives, through the installed doors

**mtt, sng, bounty, pko, mystery.** Created at a 25-Diamond buy-in (the 2.50
fee a chip event would keep is floored to 2 at the Diamond unit); six players
register as clients, one replays a registration, one withdraws, replays the
withdrawal and re-enters; the launch; the first knockout (the flat bounty a
three-way split, the mystery bounty before its chests are sealed); a rebuy and
its replay; capped exposure (a prize and a bounty one Diamond past their banks,
the fee bank and the whole custody drained one past, the pay door's missing fee
category); the rest of the field (the mystery event seals its chests when four
remain, the odd bounty bank's mystery half floored, a half-Diamond chest
refused); a cancellation of the started event refused by name and moving
nothing; a terminal priced one Diamond past a bank refused; the engine's one
terminal door; replays of the terminal, a place payment and the fee settlement.
Then three cancellation cases on events of their own: before launch (one
entrant with a second custody row), after a launch that began and seated its
players, and after a rebuy charged before launch (the whole custody row, entry
and rebuy, goes home).

**satellite.** Two Diamond targets and three satellites. Satellite 1 settles
108 Diamonds into one whole 100-Diamond ticket for its winner, custody to
custody, and pays the 8 left over to second place; its replay returns the same
receipt. Target 1 launches with that seat and two bought entries and plays out:
the satellite-funded entry settles like any paid one. Satellite 2 seats its
winner in target 2, which is then cancelled holding the seat: the seat comes
home in whole Diamonds. Satellite 3 is cancelled before launch, and a started
satellite's cancellation is refused.

**spin.** Refused by name while no reserve source is authorized (production
today). The fixture then authorizes, inside the transaction only, exactly the
published table's own worst excess at a 10-Diamond buy-in as the cap and gives
the house exactly the table's required cover, both read from the contract the
create door applies. Three seats bought as clients; the draw moves the pool's
difference from the three entries against the source, the right way; the draw
replays and moves nothing; the drawn Spin's cancellation is refused; the
terminal pays the drawn ladder in whole Diamonds; a second Spin cancelled
before it fills returns both seats whole. A 2.5x table at a 3-Diamond buy-in is
refused because its pool is not a whole Diamond.

**Every event and every slice ends with:** every bank at exact zero; what came
in equal to what went out; every ledger row decomposed into whole parts; every
custody row released at zero with its movements netting to zero; no orphaned
ledger or custody row; every prize, bounty and custody movement naming its
journal row; every obligation settled; no fractional Diamond anywhere; the
escrow closed (or the cancellation receipt written); each format's players
having lost exactly the fees the house kept from their events (and, for the
Spin, the reserve legs); and the supply identity exactly where the rehearsal
found it.

## What it does not drive, and why

- **A PKO knockout.** `fn_collect_bounty` refuses a PKO knockout without the
  engine's accepted-hand evidence (a knockout candidate bound to
  `hand_atomic_commits`, a succeeded settlement key and `hand_history`), which a
  rehearsal cannot forge. Every PKO bust here settles at the terminal, where the
  whole PKO bounty bank is paid to the champion as the unclaimed pool. So "after
  a paid bounty" is shown for the flat bounty and the mystery bounty, not PKO.
- **The public rebuy door.** `process_tournament_rebuy` needs the same bust
  evidence; the rehearsal calls the money core it calls,
  `fn_ca_process_tournament_chip_purchase_money_v1`.
- **The global settlement lane.** A cancellation asks for it first. On a live
  platform the rehearsal never takes it: every finish, settlement and
  cancellation runs last, inside one finish lane the rehearsal queues for like
  any live finish, and a cancellation names its own event as the lane it is
  inside. That changes which advisory keys are held, never what moves.

## What it cost production

Each slice holds the shared terminal-settlement lane from its first
registration and the finish lane only for its last stage: 2.4 to 3.8 seconds
per slice, 7.8 for the mystery slice, whose terminal alone takes 5.2 seconds
(production's own terminal RPC averages 3.0 seconds over 21,552 calls). Every
lock wait but the finish-lane queue is bounded at two seconds, so the rehearsal
gives way to live play; two earlier runs did exactly that and failed cleanly.
