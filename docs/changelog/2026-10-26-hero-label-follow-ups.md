# 2026-10-26 - Hero label and migration follow-ups

Four follow-ups to the 2026-10-25 hero-label and migration-record work.

## 1. Why the flash pool migration was never installed

`20261024232449_flash_pool_join_never_takes_chips.sql` (#7970) merged at
2026-10-25 03:07 UTC. The automatic installer for merged migrations,
`dispatch-merged-migrations.sh` in `agent-autopilot.yml` (#8012), landed at
07:56 UTC the same day, so #7970 merged before it existed and installing was
still a manual step nobody took. No event was lost and no code needed
changing. Proved working on #8109's merge (2026-10-26 02:15 UTC): it
dispatched all three recordings and the applier answered `ALREADY-APPLIED ...
Nothing sent` for each, so it cannot install a migration twice.

## 2. Applying before merging

Not changed. PUBLISHING.md documents applying through the Supabase MCP, and the
recording manifest exists for that practice; forbidding it is an owner
decision, left to Dan.

## 3. The longer labels at phone width

Rendered the real `SeatSlot` with the real CSS and fonts at 393 px (the
#ClubArenaConsole harness, not committed), from `Flush` up to the longest a
player can get, `Three of a Kind · 8-7 Low / Two Pair · 7-6 Low` (about 270 px).
Every label stays centred under the hero box, inside the screen, unclipped. No
change needed.

## 4. Short Deck joins the seat-versus-engine check

`tests/unit/seatLabelAgreesWithTheEngine.test.ts` now also deals 6,000 seeded
Short Deck hands (flop, turn, river) and requires the seat label to name what
the engine's `evaluateHand(..., shortDeck = true)` names. They agree on every
deal.
