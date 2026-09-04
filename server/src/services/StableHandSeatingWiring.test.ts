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
    expect(SRC).toContain(
      'if (stakeOk === undefined && !stakeBandAllows(h.id, table.big_blind)) return false;'
    );
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
    expect(at('const verdict = evaluateSit({')).toBeLessThan(
      at('const success = await this.seatHorse(')
    );
  });

  it('IS SKIPPED for an untagged horse rather than refusing it', () => {
    /* maySitOnKey(null, n) is FALSE by design - a tourney-only horse takes no
       cash sits - so calling the mutex on an untagged horse would refuse every
       one of them. That is fail-CLOSED, and it is the exact shape of the bug
       that emptied the cash floor for forty minutes on 2026-08-31. */
    expect(SRC).toContain('if (seatClub && sitTag && sitState && sitTag.personaCash) {');
  });

  it('judges against the SAME key the counter is written on', () => {
    expect(SRC).toContain('sitsOnKeyToday: sitsOnKeyToday(sitState, key, todayKey)');
    expect(SRC).toContain('sitKeyOf.set(`${horse.id}:${table.id}`, key)');
    expect(SRC).toContain('const takenKey = sitKeyOf.get(`${horse.id}:${table.id}`);');
  });

  it('reads where the horse already is from the SEAT MAP, not from the state table', () => {
    // The seat rows are what actually happened. The state table's mirror of
    // them is written by this cycle, not trusted by it.
    expect(SRC).toContain('activeClubId: activeClubOf.get(horse.id) ?? null');
    expect(SRC).toContain('activeHostId: activeHostOf.get(horse.id) ?? null');
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
