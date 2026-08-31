/**
 * V14 TABLE OCCUPANCY — Dan 2026-08-23:
 * "SOME TABLES SHOULD BE FULL WITH HORSES WAITING, SOME SHOULD HAVE 2-3 OPEN
 *  SEATS, HORSES SHOULD BE RANDOMLY LEAVING GAMES, AND GOING TO OTHERS."
 *
 * Every table used to carry one fixed target, so the lobby looked identical
 * hour after hour. These pin the properties that make it look like a floor.
 */

import { describe, it, expect } from 'vitest';
import {
  tableVibe,
  occupancyTargetFor,
  wantsTableChange,
  cashTableHeldEmpty,
  gameLaneFor,
  VIBE_BUCKET_MS,
  EMPTY_BUCKET_MS,
} from './HorseBehavior.js';

const tables = Array.from({ length: 400 }, (_, i) => `tbl-${i}-${i * 7919}`);

describe('a floor is lopsided, not uniform', () => {
  it('produces full-with-a-queue, near-full, a couple open, and short-handed', () => {
    const seen = new Map<string, number>();
    for (const id of tables) {
      const v = tableVibe(id, 1_700_000_000_000);
      seen.set(v, (seen.get(v) ?? 0) + 1);
    }
    // Every kind of table must actually occur — the point is variety.
    for (const v of ['hot', 'busy', 'steady', 'quiet']) {
      expect(seen.get(v) ?? 0, `no ${v} tables`).toBeGreaterThan(20);
    }
  });

  it('some tables are FULL WITH A WAITING LIST and some have 2-3 open seats', () => {
    let full = 0;
    let queued = 0;
    let couple = 0;
    let short = 0;
    for (const id of tables) {
      const { seatTarget, waitTarget } = occupancyTargetFor(id, 6, false, 1_700_000_000_000);
      if (seatTarget >= 6) full++;
      if (waitTarget > 0) queued++;
      const open = 6 - seatTarget;
      if (open >= 2 && open <= 3) couple++;
      if (open >= 3) short++;
    }
    expect(full, 'no full tables').toBeGreaterThan(60);
    expect(queued, 'nobody ever waiting').toBeGreaterThan(50);
    expect(couple, 'no tables with 2-3 open seats').toBeGreaterThan(60);
    expect(short, 'no short-handed tables').toBeGreaterThan(40);
  });

  it('a table holds its popularity long enough to be read, then drifts', () => {
    const id = tables[3];
    const t0 = 1_700_000_000_000;
    // Stable within its bucket — otherwise seats thrash every 30s cycle and
    // horses sit down and stand up for no visible reason.
    expect(tableVibe(id, t0)).toBe(tableVibe(id, t0 + VIBE_BUCKET_MS - 1000));
    // ...but the floor does not look the same all night.
    const later = new Set<string>();
    for (let b = 0; b < 40; b++) later.add(tableVibe(id, t0 + b * VIBE_BUCKET_MS));
    expect(later.size).toBeGreaterThan(1);
  });

  it("a human's game is never left short-handed underneath them", () => {
    for (const id of tables) {
      const { seatTarget } = occupancyTargetFor(id, 6, true, 1_700_000_000_000);
      expect(seatTarget).toBeGreaterThanOrEqual(4);
    }
  });

  it('never asks for more seats than the table has, or fewer than a game (unless held empty)', () => {
    for (const max of [2, 6, 8, 9]) {
      for (const id of tables.slice(0, 80)) {
        const { seatTarget, waitTarget, vibe } = occupancyTargetFor(
          id,
          max,
          false,
          1_700_000_000_000
        );
        expect(seatTarget).toBeLessThanOrEqual(max);
        // Dan 2026-08-26: a held-empty table wants exactly zero. Anything
        // that is actually running still wants at least a playable game.
        if (vibe === 'empty') {
          expect(seatTarget).toBe(0);
          expect(waitTarget).toBe(0);
        } else {
          expect(seatTarget).toBeGreaterThanOrEqual(2);
        }
        expect(waitTarget).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('held-empty cash tables (Dan 2026-08-26: leave 15% of cash tables empty)', () => {
  it('holds roughly 15% of tables empty at any moment', () => {
    const t0 = 1_700_000_000_000;
    const empty = tables.filter((id) => cashTableHeldEmpty(id, t0)).length;
    const frac = empty / tables.length;
    expect(frac).toBeGreaterThan(0.08);
    expect(frac).toBeLessThan(0.24);
  });

  it('an empty table stays empty for its whole bucket, then the set rotates', () => {
    // Aligned to the bucket start: the old test added EMPTY_BUCKET_MS - 1000
    // to an UNALIGNED timestamp, which lands in the NEXT bucket — it only
    // passed because the pre-2026-08-30 hash correlated adjacent buckets,
    // which was itself the ~30-hour-hold bug.
    const t0 = Math.floor(1_700_000_000_000 / EMPTY_BUCKET_MS) * EMPTY_BUCKET_MS;
    const id = tables.find((x) => cashTableHeldEmpty(x, t0))!;
    expect(cashTableHeldEmpty(id, t0 + EMPTY_BUCKET_MS - 1000)).toBe(true);
    const later = new Set<boolean>();
    for (let b = 0; b < 60; b++) later.add(cashTableHeldEmpty(id, t0 + b * EMPTY_BUCKET_MS));
    expect(later.has(false)).toBe(true);
  });

  it('a HUMAN sitting down releases the hold - their game populates normally', () => {
    const t0 = 1_700_000_000_000;
    const id = tables.find((x) => cashTableHeldEmpty(x, t0))!;
    const { seatTarget } = occupancyTargetFor(id, 6, true, t0);
    expect(seatTarget).toBeGreaterThanOrEqual(4);
  });
});

describe('game lanes (Dan 2026-08-26: 33% events-only, 33% cash-only, 34% both)', () => {
  it('splits the stable roughly in thirds, stably', () => {
    const horses = Array.from({ length: 3000 }, (_, i) => `horse-${i}-${i * 104729}`);
    const seen = { events: 0, cash: 0, both: 0 };
    for (const h of horses) {
      const lane = gameLaneFor(h);
      seen[lane]++;
      // Stable identity: same horse, same lane, every time.
      expect(gameLaneFor(h)).toBe(lane);
    }
    for (const lane of ['events', 'cash', 'both'] as const) {
      const frac = seen[lane] / horses.length;
      expect(frac, `${lane} share`).toBeGreaterThan(0.25);
      expect(frac, `${lane} share`).toBeLessThan(0.42);
    }
  });
});

describe('horses move between games', () => {
  it('nobody table-hops the moment they sit down', () => {
    for (const id of tables.slice(0, 100)) {
      expect(wantsTableChange(`h-${id}`, id, 6, 3)).toBe(false);
    }
  });

  it('a short-handed game sheds players faster than a full one', () => {
    let shortHanded = 0;
    let fullTable = 0;
    for (let i = 0; i < 4000; i++) {
      const hid = `horse-${i}`;
      const tid = `t-${i % 50}`;
      const at = 1_700_000_000_000 + i * 60_000;
      if (wantsTableChange(hid, tid, 3, 40, at)) shortHanded++;
      if (wantsTableChange(hid, tid, 6, 40, at)) fullTable++;
    }
    expect(shortHanded).toBeGreaterThan(fullTable);
    // It must actually happen — a churn rate of zero is the current bug.
    expect(fullTable).toBeGreaterThan(0);
  });

  it('churn is a trickle, not an exodus', () => {
    let moves = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      if (wantsTableChange(`h${i}`, 't1', 6, 40, 1_700_000_000_000 + i * 60_000)) moves++;
    }
    // A few percent per cycle keeps the floor alive without emptying it.
    expect(moves / N).toBeLessThan(0.05);
  });
});
