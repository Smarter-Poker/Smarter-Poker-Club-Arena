/**
 * THE WIRING. Two whole layers of Operation Stable Hand had been written,
 * tested and left unreachable: nothing read a membership tag, and nothing
 * called `evaluateSit`. These pins are about the seeding loop actually
 * consulting them, and about every one of those consultations failing OPEN.
 *
 * Source pins because this is a call site inside a 2,000-line cycle that no
 * unit test drives end to end. Each one is a sentence of behaviour, not a byte
 * count.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RAW = readFileSync(resolve(__dirname, 'HorseFleetManager.ts'), 'utf8');
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
/* 2026-09-05: the mutex call moved into the ONE sit predicate
   (HorseSitVerdict.sitVerdictFor), which the seat stage asks for the chair and
   the cluster buyer count asks for the count. The call is pinned where it
   lives; the fleet is pinned to ask it before it buys a seat. */
const VRAW = readFileSync(resolve(__dirname, 'HorseSitVerdict.ts'), 'utf8');
const VERDICT = VRAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const vat = (needle: string) => {
  const i = VERDICT.indexOf(needle);
  expect(i, `expected to find ${JSON.stringify(needle)} in HorseSitVerdict`).toBeGreaterThan(-1);
  return i;
};
const at = (needle: string) => {
  const i = SRC.indexOf(needle);
  expect(i, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return i;
};

describe('the tag book is read, and the club is resolved before it', () => {
  it('loads the book once per cycle, only when the controller is on', () => {
    expect(SRC).toContain('const book = controllerEnabled() ? await tagBook.load() : null;');
  });

  it('resolves the seat club BEFORE looking a tag up', () => {
    // A tag is per MEMBERSHIP: a horse holds a JAQK tag and a Shark tag
    // independently, and which applies is decided by the wallet that pays.
    expect(at('const seatClub = this.resolveSeatClub(membership, table, h.id);')).toBeLessThan(
      at('const tag = seatClub ? book?.tags.get(tagKey(h.id, seatClub)) : undefined;')
    );
  });

  it('says out loud when it could not read the book', () => {
    expect(SRC).toContain('Tag book unread this cycle');
  });
});

describe('EVERY TAG GATE FAILS OPEN', () => {
  it('the lane gate falls back to the old hash rule when there is no tag', () => {
    expect(SRC).toContain(
      "if (cashOk === undefined && gameLaneFor(h.id) === 'events') return false;"
    );
  });

  it('the stake gate falls back to the old stake band when there is no tag', () => {
    // Still `stakeOk === undefined` - an explicit tag verdict always wins, and
    // the band is only consulted when the tag book had nothing to say. The
    // band gate gained the table's host on 2026-09-11; the fallback shape is
    // what this pins.
    expect(SRC).toMatch(/if \(\s*stakeOk === undefined &&\s*!stakeBandAllows\(/);
    expect(SRC).toContain("String((table as { club_id?: string | null }).club_id ?? '')");
  });

  it('no gate refuses on `undefined` - only on an explicit false', () => {
    for (const g of ['cashOk', 'variantOk', 'stakeOk']) {
      expect(SRC).toContain(`if (${g} === false`);
      expect(SRC, `${g} must not refuse an unknown answer`).not.toContain(`if (!${g})`);
    }
  });

  it('an unresolvable club means no tag rather than a refusal by tag', () => {
    expect(SRC).toContain(
      'const tag = seatClub ? book?.tags.get(tagKey(h.id, seatClub)) : undefined;'
    );
  });
});

describe('A WAITING HUMAN OUTRANKS EVERY TEXTURE RULE', () => {
  it('variant, stake, rest day and daily cap are all bypassed on rescue', () => {
    for (const guard of [
      'if (variantOk === false && !humanNeedsRescue)',
      'if (stakeOk === false && !humanNeedsRescue)',
      'if (!humanNeedsRescue && isRestDayFor(st, chicagoWeekday))',
      'if (!humanNeedsRescue && dailyCapReached(st, todayKey))',
    ]) {
      expect(SRC).toContain(guard);
    }
  });

  it('but the CLUB rule is never bypassed - a horse plays inside its own club', () => {
    expect(SRC).not.toContain('clubDropped++;\n              return humanNeedsRescue');
  });
});

describe('the mutex is called, and only on a horse it can actually judge', () => {
  it('evaluateSit gates the seat', () => {
    vat('const verdict = evaluateSit({');
    expect(at('const verdict = sitVerdictFor(horse.id, table, sitCtx);')).toBeLessThan(
      at('const success = await this.seatHorse(')
    );
    // a refusal skips the chair
    expect(SRC).toMatch(/if \(!verdict\.ok\) \{[\s\S]*?continue;\s*\}/);
  });

  it('IS SKIPPED for an untagged horse rather than refusing it', () => {
    /* maySitOnKey(null, n) is FALSE by design - a tourney-only horse takes no
       cash sits - so calling the mutex on an untagged horse would refuse every
       one of them. That is fail-CLOSED, and it is the exact shape of the bug
       that emptied the cash floor for forty minutes on 2026-08-31. */
    expect(VERDICT).toContain('if (seatClub && sitTag && sitState && sitTag.personaCash) {');
  });

  it('judges against the SAME key the counter is written on', () => {
    expect(VERDICT).toContain('sitsOnKeyToday: sitsOnKeyToday(sitState, key, ctx.todayKey)');
    // the key the mutex judged travels back on the verdict, and the fleet
    // records the sit against exactly that key
    expect(VERDICT).toContain('sitKey = key;');
    expect(SRC).toContain('const key = verdict.sitKey;');
    expect(SRC).toContain('sitKeyOf.set(`${horse.id}:${table.id}`, key)');
    expect(SRC).toContain('const takenKey = sitKeyOf.get(`${horse.id}:${table.id}`);');
  });

  it('reads where the horse already is from the SEAT MAP, not from the state table', () => {
    // The seat rows are what actually happened. The state table's mirror of
    // them is written by this cycle, not trusted by it.
    expect(VERDICT).toContain('activeClubId: ctx.activeClubOf.get(horseId) ?? null');
    expect(VERDICT).toContain('activeHostId: ctx.activeHostOf.get(horseId) ?? null');
    // and the fleet hands the verdict the maps it built from the seat rows
    expect(SRC).toMatch(
      /const sitCtx: SitVerdictContext = \{[\s\S]*?activeClubOf,\s*activeHostOf,/
    );
    expect(SRC).toContain('for (const seat of allActiveSeats) {');
  });

  it('reports its refusals by reason', () => {
    expect(SRC).toContain('Stable Hand mutex refused:');
  });

  it('honours the kill switch', () => {
    expect(SRC).toContain('killed: stableHandKilled()');
  });
});

describe('the counters are written once per cycle, and the exits are DIFFED', () => {
  it('collects mutations and flushes them after the seating loop', () => {
    expect(at('const stateMutations: StateMutation[] = [];')).toBeLessThan(
      at('const folded = foldMutations(book.states, stateMutations, todayKey, nowMs);')
    );
  });

  it('opens the two-hour window from the key set that DISAPPEARED', () => {
    /* A seat is given up by a stand, a session end, a bust, or a table closing
       under it. Only the paths somebody remembered to hook would fire a
       listener; the diff catches all of them. */
    expect(SRC).toContain(
      'if (!nowKeys?.has(key)) stateMutations.push({ horseId, closedKey: key });'
    );
    expect(SRC).toContain('this.previousSeatKeys = currentSeatKeys;');
  });

  it('caps a long accrual gap so a restart cannot credit hours nobody played', () => {
    expect(SRC).toContain('Math.min(30, (nowMs - this.lastMinutesAccrualAt) / 60_000)');
  });

  it('folds what it wrote back into the cached book', () => {
    // Otherwise the next cycle reads the counter as it was before this one.
    expect(SRC).toContain('for (const [id, st] of folded.next) book.states.set(id, st);');
  });

  it('writes nothing when nothing happened', () => {
    expect(SRC).toContain('if (book && stateMutations.length > 0) {');
  });
});

describe("the horse table ceiling is the horse's own, inside the platform's", () => {
  it('hands the platform ceiling to the tag rather than replacing it', () => {
    expect(SRC).toContain('tagMaxTables(tag, MAX_TABLES_PER_HORSE)');
    expect(SRC).toContain('const MAX_TABLES_PER_HORSE = 4');
  });
});
