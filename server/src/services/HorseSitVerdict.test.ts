/**
 * ONE SIT PREDICATE FOR THE COUNT AND THE CHAIR (2026-09-05).
 *
 * Measured 2026-09-05 14:55 CDT: in 45 minutes 8 feeders opened, 2 went live,
 * 6 were abandoned. Two games (NLH 1/2 Classic, PLO5 0.10/0.25 Classic)
 * opened a feeder every five minutes with "buyers": 2 and no horse EVER sat
 * on one (table_seats rows created on those feeders: 0), and the engine log
 * had no line about them. The seeding loop reached the seat stage with a
 * non-empty pool and `continue`d silently on every selected horse - a wallet
 * that would not resolve, a buy-in sized to zero, the aggregate ceiling, or
 * the mutex - while the CANDIDATE filter that produced the buyer count never
 * asked any of those four questions.
 *
 * Part 1 drives the predicate itself. Part 2 pins that the fleet asks it in
 * BOTH places and that the pool handed to the buyer allocation is the pool it
 * left. Source pins because seatHorse ends in atomic_table_buyin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatSkipCounts,
  isMutexRejection,
  SEAT_STAGE_SKIP_REASONS,
  sitVerdictFor,
  type SitTable,
  type SitVerdictContext,
} from './HorseSitVerdict.js';
import { JAQK_CLUB_ID, MIDWAY_UNION_ID } from './StableHand.js';
import { tagKey, type HorseState, type HorseTag } from './StableHandTags.js';
import {
  EMPTY_REJOIN_CONSTRAINTS,
  rejoinPlayerKey,
  rejoinTableKey,
} from './HorseRejoinConstraints.js';

const HORSE = '11111111-1111-4111-8111-111111111111';
const TABLE: SitTable = {
  id: 'tbl-1',
  name: 'NLH 1/2 Classic Feeder 1',
  club_id: MIDWAY_UNION_ID,
  union_id: MIDWAY_UNION_ID,
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 80,
  max_buy_in: 400,
};

function ctxWith(over: Partial<SitVerdictContext> = {}): SitVerdictContext {
  return {
    resolveSeatClub: () => JAQK_CLUB_ID,
    sizeBuyIn: () => ({ buyIn: 200, telemetry: [] }),
    bankrolls: new Map([[`${JAQK_CLUB_ID}:${HORSE}`, 100_000]]),
    bankrollsLoaded: true,
    rejoin: EMPTY_REJOIN_CONSTRAINTS,
    horseTables: new Map(),
    horseExposure: new Map(),
    activeClubOf: new Map(),
    activeHostOf: new Map(),
    book: null,
    todayKey: '2026-09-05',
    chicagoWeekday: 5,
    killed: false,
    maxTablesPerHorse: 4,
    ...over,
  };
}

const tag: HorseTag = {
  horseId: HORSE,
  clubId: JAQK_CLUB_ID,
  mode: 'cash',
  cashFreeroll: false,
  personaCash: 'grinder',
  personaMtt: null,
  variants: ['nlh'],
  preferredStakes: [2],
  maxTables: 4,
};
const state: HorseState = {
  horseId: HORSE,
  restWeekday: null,
  dailyCapMinutes: null,
  minutesPlayedToday: 0,
  sessionStartBalance: null,
  cashSitsToday: {},
  twoHourWindow: {},
  countersResetOn: null,
};
const bookWith = (t: HorseTag = tag, s: HorseState = state) => ({
  tags: new Map([[tagKey(HORSE, JAQK_CLUB_ID), t]]),
  states: new Map([[HORSE, s]]),
  tagsReadAt: 0,
  statesReadAt: 0,
});

describe('sitVerdictFor - the ok path', () => {
  it('returns the wallet and the sized buy-in, no sit key when the mutex was not consulted', () => {
    const v = sitVerdictFor(HORSE, TABLE, ctxWith());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.seatClub).toBe(JAQK_CLUB_ID);
    expect(v.buyIn).toBe(200);
    expect(v.sitKey).toBeUndefined();
    expect(v.telemetry).toEqual([]);
  });

  it('an UNRESOLVED wallet (membership map did not load) is ok with seatClub undefined - the database decides', () => {
    const v = sitVerdictFor(HORSE, TABLE, ctxWith({ resolveSeatClub: () => undefined }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.seatClub).toBeUndefined();
  });

  it('carries the sizing telemetry back instead of emitting it', () => {
    const v = sitVerdictFor(
      HORSE,
      TABLE,
      ctxWith({ sizeBuyIn: () => ({ buyIn: 120, telemetry: ['buyin_capped'] }) })
    );
    expect(v.ok).toBe(true);
    expect(v.telemetry).toEqual(['buyin_capped']);
  });

  it('with a tag and state the mutex is consulted and the judged game key comes back', () => {
    const v = sitVerdictFor(HORSE, TABLE, ctxWith({ book: bookWith() }));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.sitKey).toBe(`${MIDWAY_UNION_ID}:NLH 1/2 Classic Feeder 1:nlh:1:2`);
  });

  it('hands the sizing the rejoin floor keyed the way the filter keyed the bar', () => {
    const floors = new Map([[rejoinPlayerKey(HORSE, rejoinTableKey(TABLE)), 333]]);
    let seen: number | undefined = -1;
    sitVerdictFor(
      HORSE,
      TABLE,
      ctxWith({
        rejoin: { barred: new Set(), rejoinFloor: floors },
        sizeBuyIn: (_t, _h, _c, floor) => {
          seen = floor;
          return { buyIn: 333, telemetry: [] };
        },
      })
    );
    expect(seen).toBe(333);
  });
});

describe('sitVerdictFor - every refusal, named', () => {
  it('no_seat_club: no membership of this horse can pay here', () => {
    const v = sitVerdictFor(HORSE, TABLE, ctxWith({ resolveSeatClub: () => null }));
    expect(v).toMatchObject({ ok: false, reason: 'no_seat_club' });
  });

  it('zero_buy_in: the sizing came back at zero, and its telemetry still travels', () => {
    const v = sitVerdictFor(
      HORSE,
      TABLE,
      ctxWith({ sizeBuyIn: () => ({ buyIn: 0, telemetry: ['seat_refused_share_below_min'] }) })
    );
    expect(v).toMatchObject({ ok: false, reason: 'zero_buy_in' });
    expect(v.telemetry).toEqual(['seat_refused_share_below_min']);
  });

  it('aggregate_exposure: the whole position is at the ceiling, and the counter is named for the caller', () => {
    const v = sitVerdictFor(
      HORSE,
      TABLE,
      ctxWith({ horseExposure: new Map([[HORSE, 1_000_000_000]]) })
    );
    expect(v).toMatchObject({ ok: false, reason: 'aggregate_exposure' });
    expect(v.telemetry).toEqual(['seat_refused_aggregate_exposure']);
  });

  it('aggregate ceiling FAILS OPEN on an unknown roll, and is not asked when rolls did not load', () => {
    const noRoll = sitVerdictFor(
      HORSE,
      TABLE,
      ctxWith({ bankrolls: new Map(), horseExposure: new Map([[HORSE, 1_000_000_000]]) })
    );
    expect(noRoll.ok).toBe(true);
    const notLoaded = sitVerdictFor(
      HORSE,
      TABLE,
      ctxWith({ bankrollsLoaded: false, horseExposure: new Map([[HORSE, 1_000_000_000]]) })
    );
    expect(notLoaded.ok).toBe(true);
  });

  it('the mutex refuses by ITS reason: killed', () => {
    const v = sitVerdictFor(HORSE, TABLE, ctxWith({ book: bookWith(), killed: true }));
    expect(v).toMatchObject({ ok: false, reason: 'killed' });
  });

  it('the mutex refuses by ITS reason: seat_cap when the horse already holds its ceiling', () => {
    const v = sitVerdictFor(
      HORSE,
      TABLE,
      ctxWith({
        book: bookWith(),
        horseTables: new Map([[HORSE, new Set(['a', 'b', 'c', 'd'])]]),
      })
    );
    expect(v).toMatchObject({ ok: false, reason: 'seat_cap' });
  });

  it('the mutex refuses by ITS reason: other_club when the horse is live in another club', () => {
    const v = sitVerdictFor(
      HORSE,
      TABLE,
      ctxWith({ book: bookWith(), activeClubOf: new Map([[HORSE, 'some-other-club']]) })
    );
    expect(v).toMatchObject({ ok: false, reason: 'other_club' });
  });

  it('the mutex is NOT consulted for an untagged horse (fail open), so a kill switch alone refuses nobody untagged', () => {
    const v = sitVerdictFor(HORSE, TABLE, ctxWith({ killed: true }));
    expect(v.ok).toBe(true);
  });

  it('is side-effect free: the same inputs give the same verdict and mutate none of the maps', () => {
    const horseTables = new Map([[HORSE, new Set(['a'])]]);
    const horseExposure = new Map([[HORSE, 200]]);
    const ctx = ctxWith({ book: bookWith(), horseTables, horseExposure });
    const a = sitVerdictFor(HORSE, TABLE, ctx);
    const b = sitVerdictFor(HORSE, TABLE, ctx);
    expect(a).toEqual(b);
    expect(horseTables.get(HORSE)?.size).toBe(1);
    expect(horseExposure.get(HORSE)).toBe(200);
    expect(ctx.book?.states.get(HORSE)?.cashSitsToday).toEqual({});
  });
});

describe('the reason vocabulary', () => {
  it('splits the three seat-stage skips from the mutex reasons', () => {
    for (const r of SEAT_STAGE_SKIP_REASONS) expect(isMutexRejection(r)).toBe(false);
    for (const r of ['killed', 'seat_cap', 'brm', 'sit_cap', 'other_club'] as const) {
      expect(isMutexRejection(r)).toBe(true);
    }
  });

  it('formats non-zero counts only, in first-seen order', () => {
    expect(
      formatSkipCounts(
        new Map([
          ['zero_buy_in', 3],
          ['no_seat_club', 0],
          ['seat_cap', 1],
        ])
      )
    ).toBe('zero_buy_in=3 seat_cap=1');
    expect(formatSkipCounts(new Map())).toBe('');
  });
});

/* ── PART 2: the fleet asks it in both places ─────────────────────────── */

const FLEET = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
const SEED = FLEET.slice(
  FLEET.indexOf('private async seedAllTables('),
  FLEET.indexOf('\n  private async ', FLEET.indexOf('private async seedAllTables(') + 1)
);
const CODE = SEED.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the fleet: one predicate, asked for the count and for the chair', () => {
  it('builds ONE context per cycle, before the table loop, from the live maps', () => {
    const ctxAt = CODE.indexOf('const sitCtx: SitVerdictContext = {');
    const loopAt = CODE.indexOf('for (const table of tablesToSeed) {');
    expect(ctxAt).toBeGreaterThan(-1);
    expect(ctxAt).toBeLessThan(loopAt);
    const ctxBlock = CODE.slice(
      ctxAt,
      CODE.indexOf('maxTablesPerHorse: MAX_TABLES_PER_HORSE', ctxAt) + 60
    );
    for (const field of [
      'resolveSeatClub:',
      'sizeBuyIn:',
      'bankrolls,',
      'bankrollsLoaded,',
      'rejoin,',
      'horseTables,',
      'horseExposure,',
      'activeClubOf,',
      'activeHostOf,',
      'book,',
      'todayKey,',
      'chicagoWeekday,',
      'killed: stableHandKilled()',
      'maxTablesPerHorse: MAX_TABLES_PER_HORSE',
    ]) {
      expect(ctxBlock, field).toContain(field);
    }
  });

  it('the CANDIDATE filter for a CLUSTER table narrows to the sittable pool with the same predicate', () => {
    const cand = CODE.indexOf('const candidateHorses = validHorses.filter(');
    const sittable = CODE.indexOf('let sittable = candidateHorses;');
    expect(cand).toBeGreaterThan(-1);
    expect(sittable).toBeGreaterThan(cand);
    const block = CODE.slice(sittable, CODE.indexOf('let pool =', sittable));
    expect(block).toMatch(
      /if \(table\.cluster_id\) \{\s*sittable = candidateHorses\.filter\(\(h\) => \{/
    );
    expect(block).toContain('const v = sitVerdictFor(h.id, table, sitCtx);');
    expect(block).toMatch(/if \(v\.ok\) return true;/);
    // a refusal here is counted, never silent
    expect(block).toContain('bump(unsittable, v.reason);');
    expect(block).toContain('noteSkip(diag, v.reason);');
    // and the cheap gates ran FIRST: the verdict is asked of candidateHorses, not validHorses
    expect(block).not.toContain('validHorses');
  });

  it('the pool used for allocation AND for selection is the sittable pool', () => {
    expect(CODE).toContain('let pool = sittable.filter((h) => isActiveNow(h.id, hourUTC));');
    expect(CODE).toContain(
      'if (pool.length < emptySeats.length && humanNeedsRescue) pool = sittable;'
    );
    // the cluster pool the allocator walks is built from `pool`
    expect(CODE).toMatch(/clusterPool = \{[\s\S]*?pool: pool\.map\(\(h\) => h\.id\),/);
    expect(CODE).toMatch(
      /for \(const \[tableId, n\] of allocateBuyers\(clusterPools, capacityByHorse\)\)/
    );
    // and the weighting that selects the chairs reads the same `pool`
    expect(CODE).toMatch(/const weighted = pool\s*\.map\(/);
  });

  it('the SEAT STAGE asks the same predicate, emits its telemetry once, and counts every refusal', () => {
    const seat = CODE.slice(CODE.indexOf('for (let i = 0; i < selectedHorses.length; i++)'));
    expect(seat).toContain('const verdict = sitVerdictFor(horse.id, table, sitCtx);');
    expect(seat).toContain('for (const e of verdict.telemetry) bankrollEvent(e);');
    expect(seat).toMatch(
      /if \(!verdict\.ok\) \{\s*if \(isMutexRejection\(verdict\.reason\)\) \{\s*mutexRefused\.set\(verdict\.reason, \(mutexRefused\.get\(verdict\.reason\) \?\? 0\) \+ 1\);\s*\} else \{\s*bump\(seatStageSkipped, verdict\.reason\);\s*\}\s*noteSkip\(diag, verdict\.reason\);\s*continue;\s*\}/
    );
    // the chair is bought with the verdict's wallet and buy-in
    expect(seat).toContain('const { seatClub, buyIn } = verdict;');
    expect(seat.indexOf('const verdict = sitVerdictFor(')).toBeLessThan(
      seat.indexOf('const success = await this.seatHorse(')
    );
    // no silent continue is left in the seat stage. Two remain and both are
    // counted: the verdict's refusal (above) and, since 2026-09-05, the
    // lone-seat refusal that keeps a single horse off an EMPTY cluster table
    // (loneSeatRefused++, noted in the diag as lone_seat_refused).
    const stage = seat.slice(0, seat.indexOf('const success = await this.seatHorse('));
    expect(stage.match(/continue;/g)?.length).toBe(2);
    expect(stage).toMatch(
      /refusesLoneSeat\(\{[\s\S]*?\}\)\s*\)\s*\{\s*loneSeatRefused\+\+;\s*noteSkip\(diag, 'lone_seat_refused'\);\s*continue;/
    );
  });

  it('the fleet emits the sizing telemetry only where it acts: computeHorseBuyIn takes a sink, the verdict collects', () => {
    expect(FLEET).toMatch(/note: \(e: BankrollEvent\) => void = bankrollEvent/);
    expect(CODE).toMatch(
      /sizeBuyIn: \(t, id, club, floor\) => \{\s*const telemetry: BankrollEvent\[\] = \[\];\s*const buyIn = this\.computeHorseBuyIn\(\s*t,\s*id,\s*bankrolls,\s*bankrollsLoaded,\s*club,\s*floor,\s*\(e\) => telemetry\.push\(e\)\s*\);/
    );
    // the verdict module itself emits nothing
    const VERDICT = readFileSync(join(process.cwd(), 'src/services/HorseSitVerdict.ts'), 'utf8');
    expect(VERDICT).not.toContain('bankrollEvent(');
    expect(VERDICT).not.toContain('stateMutations');
  });
});

describe('the fleet: an opening feeder says what happened', () => {
  it('logs exactly one line per opening feeder per cycle, from a finally, in the pinned format', () => {
    expect(CODE).toMatch(
      /if \(table\.cluster_id && table\.lifecycle === 'opening'\) \{\s*diag = \{/
    );
    const fin = CODE.indexOf('} finally {');
    expect(fin).toBeGreaterThan(-1);
    const finBlock = CODE.slice(fin, CODE.indexOf('this.lastEligibleByTable = nextEligible;'));
    expect(finBlock).toContain('beat.openingFeeders.push(diag);');
    expect(finBlock).toContain(
      '`[HorseFleet] opening feeder "${diag.name}": candidates ${diag.candidates}, `'
    );
    expect(finBlock).toContain(
      '`sittable ${diag.sittable}, wanted ${diag.wanted}, empty seats ${diag.empty_seats}, `'
    );
    expect(finBlock).toContain('`selected ${diag.selected}, seated ${diag.seated}, `');
    expect(finBlock).toContain(
      '`skipped {${formatSkipCounts(new Map(Object.entries(diag.skipped)))}}`'
    );
    // the only place the line is written
    expect((FLEET.match(/\[HorseFleet\] opening feeder "/g) ?? []).length).toBe(1);
  });

  it('every count on the line is filled from the stage that produced it', () => {
    for (const write of [
      'diag.candidates = candidateHorses.length;',
      'diag.sittable = sittable.length;',
      'if (diag) diag.wanted = seatsNeeded;',
      'if (diag) diag.empty_seats = emptySeats.length;',
      'if (diag) diag.selected = selectedHorses.length;',
      'if (diag) diag.seated = seated;',
      'if (diag) diag.withheld = tableWithheld;',
    ]) {
      expect(CODE, write).toContain(write);
    }
  });

  it('the beat detail carries the same counts', () => {
    expect(FLEET).toContain('openingFeeders: OpeningFeederDiag[];');
    expect(FLEET).toContain('opening_feeders: beat.openingFeeders,');
  });

  it('a cycle summary names every seat-stage skip reason when any occurred', () => {
    expect(CODE).toMatch(/if \(seatStageSkipped\.size > 0\) \{/);
    expect(FLEET).toContain("'[HorseFleet] seat stage skipped: '");
    for (const r of ['no_seat_club', 'zero_buy_in', 'aggregate_exposure']) {
      expect(FLEET).toContain(`\`${r}=\${seatStageSkipped.get('${r}') ?? 0}`);
    }
    expect(CODE).toMatch(/if \(unsittable\.size > 0\) \{/);
  });
});
