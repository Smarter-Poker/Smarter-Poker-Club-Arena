/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY HORSE PLAYS AT LEAST TWO TABLES (Dan, 2026-09-05, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "EVERY HORSE SHOULD 100% BE ABLE TO PLAY 4 TABLES AT ONCE ...
 * 100% OF THEM SHOULD BE PLAYING A MINIMUM OF 2 AT A TIME 33% PLAYING 3 AT A
 * TIME AND 33% PLAYING 4 AT A TIME."
 *
 * WHAT THIS LAW IS DEFENDING AGAINST, measured on 2026-09-05 an hour before
 * it was written: of 364 seated horses, 270 held exactly ONE table, 76 held
 * two, 17 held three, and ONE held four.
 *
 * Nothing was broken in the seeding weight - Dan's earlier instruction
 * ("THEY SHOULD BE PLAYING 4 TABLES AT ONCE", 2026-09-02) had been
 * implemented correctly and was working. The ceiling underneath it had been
 * lowered two days later by a different system: `MAX_TABLES_BY_PERSONA` gave
 * grinder 4, regular 3, mixer 2, night_owl 2, weekend_heavy 3, and
 * `MAX_TABLES_TOURNEY_ONLY` pinned 473 of 1,000 horses at ONE. A target and a
 * ceiling that disagree are not two settings, they are a bug with a config
 * file in front of it, and the ceiling wins silently every time.
 *
 * THE SECOND TRAP, which this law also pins, is subtler and was live for one
 * retag before it was caught. The first implementation allocated the ceiling
 * over `tagOrder` - the same ordering `assignTags` uses to hand out MODE. The
 * fleet-wide split came out at a perfect 34/33/33 and the summary query
 * looked finished; underneath it, ALL 473 cash-only horses had 2, ALL 410
 * tourney horses had 3, and every horse allowed 4 was mode `both`. The cash
 * floor - the thing Dan was asking about - drew exclusively from the horses
 * with the lowest ceiling. So the law is not only "the percentages are
 * right"; it is "the percentages are right WITHIN EVERY MODE".
 *
 * Registry: docs/laws.d/every-horse-plays-at-least-two-tables.md
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_TABLES_PER_HORSE,
  MAX_TABLES_TOURNEY_ONLY,
  MIN_TABLES_PER_HORSE,
  TABLE_LOAD_MIX,
  assignTags,
  seatsPerHorseBand,
  tableLoadFor,
} from '../server/src/services/StableHand.js';
import { tagMaxTables } from '../server/src/services/StableHandTags.js';

const ROOT = join(__dirname, '..');
const fleet = () =>
  Array.from({ length: 900 }, (_, i) => ({
    horseId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    clubId: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
  }));

describe('every horse plays at least two tables', () => {
  it('the floor is two and the ceiling is four', () => {
    expect(MIN_TABLES_PER_HORSE).toBe(2);
    expect(MAX_TABLES_PER_HORSE).toBe(4);
  });

  it('a tourney-only horse is no longer pinned at one', () => {
    expect(MAX_TABLES_TOURNEY_ONLY).toBe(MIN_TABLES_PER_HORSE);
  });

  it('Dan’s split is 34/33/33 and nothing sits below two', () => {
    const tags = assignTags(fleet());
    const at = (n: number) => tags.filter((t) => t.maxTables === n).length;
    expect(at(1)).toBe(0);
    expect(tags.every((t) => t.maxTables >= 2 && t.maxTables <= 4)).toBe(true);
    // 33% at three and 33% at four, to within one row of rounding.
    expect(Math.abs(at(3) / tags.length - 0.33)).toBeLessThan(0.02);
    expect(Math.abs(at(4) / tags.length - 0.33)).toBeLessThan(0.02);
    expect(at(2) + at(3) + at(4)).toBe(tags.length);
  });

  it('the split holds INSIDE every mode, not only across the fleet', () => {
    const tags = assignTags(fleet());
    for (const mode of ['cash', 'tourney', 'both'] as const) {
      const inMode = tags.filter((t) => t.mode === mode);
      expect(inMode.length).toBeGreaterThan(50);
      for (const n of [2, 3, 4]) {
        const share = inMode.filter((t) => t.maxTables === n).length / inMode.length;
        // The 2026-09-05 regression put this at 1.00 for one value and 0.00
        // for the others inside every mode. Anything near that fails here.
        expect(share).toBeGreaterThan(0.2);
        expect(share).toBeLessThan(0.5);
      }
    }
  });

  it('the ceiling is drawn from its own ordering, not the mode ordering', () => {
    const members = fleet();
    const load = tableLoadFor(members);
    const tags = assignTags(members);
    // Same input, same answer, every time.
    expect(tableLoadFor(members)).toEqual(load);
    for (const t of tags) {
      expect(t.maxTables).toBe(load.get(`${t.horseId}:${t.clubId}`));
    }
  });

  it('the mix itself is Dan’s numbers', () => {
    expect(TABLE_LOAD_MIX).toEqual([
      ['two', 0.34],
      ['three', 0.33],
      ['four', 0.33],
    ]);
  });

  it('a stale or missing tag can never hold a horse to one table', () => {
    expect(tagMaxTables(undefined)).toBe(MAX_TABLES_PER_HORSE);
    const tag = (maxTables: number) =>
      ({
        horseId: 'h',
        clubId: 'c',
        mode: 'cash',
        cashFreeroll: false,
        personaCash: null,
        personaMtt: null,
        variants: [],
        preferredStakes: [],
        maxTables,
      }) as never;
    expect(tagMaxTables(tag(1))).toBe(MIN_TABLES_PER_HORSE);
    expect(tagMaxTables(tag(0))).toBe(MIN_TABLES_PER_HORSE);
    expect(tagMaxTables(tag(9))).toBe(MAX_TABLES_PER_HORSE);
    expect(tagMaxTables(tag(3))).toBe(3);
  });

  it('the persona map is not wired back into a tag', () => {
    const src = readFileSync(join(ROOT, 'server/src/services/StableHand.ts'), 'utf8');
    const assign = src.slice(src.indexOf('export function assignTags('));
    expect(assign).not.toContain('MAX_TABLES_BY_PERSONA');
  });

  it('the seats-per-horse band follows the law instead of alerting on it', () => {
    // The mix means a mean of 2.99 seats per horse. A band that tops out below
    // that alerts `seats_per_horse_out_of_band` on a floor doing as it is told.
    for (const hour of [4, 12, 19]) {
      const band = seatsPerHorseBand(hour);
      expect(band.min).toBeGreaterThanOrEqual(MIN_TABLES_PER_HORSE);
      expect(band.max).toBeLessThanOrEqual(MAX_TABLES_PER_HORSE);
    }
    expect(seatsPerHorseBand(12).max).toBeGreaterThan(2.9);
  });

  it('the seeder reaches the floor before it chases the ceiling', () => {
    const fleetSrc = readFileSync(join(ROOT, 'server/src/services/HorseFleetManager.ts'), 'utf8');
    // A horse short of the FLOOR outranks one merely short of its ceiling.
    expect(fleetSrc).toMatch(/at > 0 && at < MIN_TABLES_PER_HORSE/);
    expect(fleetSrc).toMatch(/at >= MIN_TABLES_PER_HORSE && at < ceiling/);
    // And the platform cap is imported, never a second literal 4.
    expect(fleetSrc).toContain('MAX_TABLES_PER_HORSE = PLATFORM_MAX_TABLES');
  });

  it('the schema carries the floor too, so no writer can undercut it', () => {
    const mig = readFileSync(
      join(ROOT, 'supabase/migrations/20260905155903_every_horse_plays_at_least_two_tables.sql'),
      'utf8'
    );
    expect(mig).toContain('DROP CONSTRAINT IF EXISTS sh_tourney_only_one_table');
    expect(mig).toContain('CHECK (max_tables >= 2 AND max_tables <= 4)');
  });
});
