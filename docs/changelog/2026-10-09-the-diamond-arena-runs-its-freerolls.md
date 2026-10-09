# The Diamond Arena Runs Its Freerolls

**Date:** 2026-10-09

The Diamond freeroll was built exactly as Midway runs it (20261007000010): free to enter, a guarantee set aside on the house, and $1 rebuys and add-ons that go wholly to the prize pool, gated by the `freeroll_allowed`, `freeroll_rebuy_cost` and `freeroll_addon_cost` economics. The engine marks every freeroll as a free buy, and one line left from 20261006090619 still refused a free buy as `diamond_tournament_format_not_open`. So the four Diamond Arena "$100 Freeroll" schedules seeded on 2026-10-07 were refused on every poll and no occurrence ever existed.

Migration 20261009161341 admits a free buy on a zero-entry event, where every freeroll check below it still applies (a plain MTT, a guarantee of at least one Diamond, the three economics). A paid event that says freeBuy is still refused by the same name.

Within two minutes of the apply the scheduler created 12 occurrences across the four schedules (free entry, 100 Diamond guarantee, $1 rebuys, $1 add-ons), and the first had 12 players registered.

Law: `tests/a-refused-hand-frees-its-table.law.test.ts`.
