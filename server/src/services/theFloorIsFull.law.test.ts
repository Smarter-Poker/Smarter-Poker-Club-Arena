/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: THE FLOOR IS FULL, AND A HORSE GETS UP ONLY FOR A PERSON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-02, verbatim: "HORSES CAN FILL ALL SEATS, AND ONLY 'GET UP' WHEN
 * A REAL HUMAN IS ON THE WAITING LIST FOR 75% OF ALL GAMES. THE OTHER 25% OF
 * GAMES SHOULD HAVE ANYWHERE FROM ONE, TO A FULL GAME. IT SHOULD BE SPARATIC,
 * BUT HORSES NEED TO BE OCCUPYING AT LEAST 75% OF ALL SEATS IN THE CASH GAMES,
 * AND THEY SHOULD BE PLAYING 4 TABLES AT ONCE!"
 *
 * The arithmetic of the rule is pinned next door in HorseOccupancy.test.ts.
 * What is pinned HERE is the wiring, because every part of this rule is a
 * property of two files agreeing with each other and none of it survives one
 * of them being rewritten in isolation:
 *
 *   - the fleet reads the waiting list and subtracts it from the target;
 *   - the rotator reads the same list and stands a horse up when it is not
 *     empty, and holds a full table still when it is;
 *   - the fleet drives horses TOWARD four tables instead of away from them;
 *   - nothing queues a horse any more.
 *
 * Source-level, because the alternative is standing up a live fleet manager
 * with a database behind it. Windows are bounded by the structure they are
 * about (tests/helpers/sourceWindow's rule), never by a byte count.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');
const FLEET = read('src/services/HorseFleetManager.ts');
const ROTATOR = read('src/services/HorseSessionRotator.ts');
const BEHAVIOR = read('src/services/HorseBehavior.ts');
/* The platform's four-game limit, mirrored from the database. See the
   "hard ceiling" pin below. */
const GAME_LOAD = read('src/services/HorseGameLoad.ts');

describe('LAW: a seat opens for a person, and for nothing else', () => {
  it('the fleet counts humans on the list and subtracts them from the target', () => {
    expect(FLEET).toContain('humansWaitingByTable');
    const loader = sliceMethod(FLEET, 'private async humansWaitingByTable(');
    expect(loader).toContain("from('table_waitlist')");
    // A notified row is a seat already being HELD for that person - leaving it
    // out would have the fleet refill the very seat the queue is about.
    expect(loader).toContain("'waiting'");
    expect(loader).toContain("'notified'");
    // A horse in the count would make a horse stand up for a horse.
    expect(loader).toContain('horseIdSet.has(');
    // Fails closed: an unreadable queue releases nobody.
    expect(loader).toContain('return new Map()');
  });

  it('the target itself is what gives the seat back', () => {
    const target = sliceMethod(BEHAVIOR, 'export function occupancyTargetFor(');
    expect(target).toContain('humansWaiting');
    expect(target).toMatch(/seatTarget\s*-\s*humansWaiting/);
    // ...but never below a game the person can actually join.
    expect(target).toMatch(/Math\.max\(1,\s*seatTarget\s*-\s*humansWaiting\)/);
  });

  it('the rotator stands a horse up when somebody is waiting, and only then', () => {
    expect(ROTATOR).toContain("from('table_waitlist')");
    expect(ROTATOR).toContain('releaseWanted');
    // Certain, not probabilistic: somebody is waiting, so somebody stands up.
    expect(ROTATOR).toMatch(/if \(releaseWanted > 0\) \{[\s\S]{0,120}POSITIVE_INFINITY/);
  });

  it('a full table with nobody waiting does not shed players', () => {
    // Both discretionary departures - fancying a change, and the session
    // simply ending - are held on a full table. This is the half of the rule
    // that stops the floor draining itself back out of the seats it fills.
    expect(ROTATOR).toMatch(/const holdsFull =\s*fill === 'full' && releaseWanted === 0/);
    expect(ROTATOR).toMatch(/!holdsFull &&[\s\S]{0,160}wantsTableChange\(/);
    expect(ROTATOR).toMatch(/if \(holdsFull\) p = 0;/);
  });

  it('but a money decision still gets a horse out of its seat', () => {
    /* Booking a win and stopping a loss are NOT held. A horse that plays past
       its stop-loss because the table wanted to look full is a bug in the
       bankroll law, and this rule does not get to break that one. */
    const idxVerdict = ROTATOR.indexOf("bankrollEvent(verdict === 'book_win'");
    expect(idxVerdict).toBeGreaterThan(-1);
    const idxHold = ROTATOR.indexOf('if (holdsFull) p = 0;');
    expect(idxHold).toBeGreaterThan(idxVerdict);
  });
});

describe('LAW: four tables is the target, not the ceiling', () => {
  it('a horse already playing outranks one sitting at nothing', () => {
    expect(FLEET).toContain('const MAX_TABLES_PER_HORSE = 4');
    // The old weight was `random / (1 + tables)`, which pulled the other way:
    // a horse at nothing outranked one at three, so nobody reached four.
    expect(FLEET).not.toMatch(/w:\s*Math\.random\(\)\s*\/\s*\(1 \+/);
    expect(FLEET).toMatch(/at > 0 && at < MAX_TABLES_PER_HORSE \? 4 : 1/);
  });

  it('and four is still the hard ceiling', () => {
    /* PIN MOVED 2026-09-04, and the law is STRICTER for it. The ceiling used
       to be the literal MAX_TABLES_PER_HORSE for every horse; it is now that
       constant handed to tagMaxTables, which clamps the horse's OWN tagged
       limit into it - a grinder carries four, a mixer one, and nothing carries
       more than four. `tagMaxTables` is pinned separately in
       StableHandTags.test.ts to never return above what it is given, and to
       return the ceiling untouched for a horse with no tag. */
    /* PIN MOVED AGAIN 2026-09-06, and the law is stricter again. The tag
       ceiling is unchanged and still measured against the horse's live SEATS -
       it is `ownCashCeiling` now - but the test it feeds also asks the
       platform's four-GAME limit, which counts tournament bookings the way
       `fn_concurrent_game_load` counts them. The database was refusing that
       fifth game 10,577 times in four hours while this line said the horse was
       free. Both rules, one predicate: see HorseGameLoad. */
    expect(FLEET).toContain('ownCashCeiling: tagMaxTables(tag, MAX_TABLES_PER_HORSE),');
    expect(FLEET).toContain('if (!mayEnterAnotherGame(gameLoad)) {');
    // the constant is still the ceiling that gets handed in
    expect(FLEET).toContain('const MAX_TABLES_PER_HORSE = 4');
    // ...and the platform limit it can never exceed is the database's four
    expect(GAME_LOAD).toContain('export const CONCURRENT_GAME_LIMIT = 4;');
    // and nothing raises it anywhere
    expect(FLEET).not.toMatch(/MAX_TABLES_PER_HORSE\s*\+/);
  });
});

describe('LAW: nothing queues a horse', () => {
  it('the occupancy rule never asks for a horse queue', () => {
    const target = sliceMethod(BEHAVIOR, 'export function occupancyTargetFor(');
    expect(target).toContain('waitTarget: 0');
  });

  it('and the seeder that used to fill queues is gone', () => {
    // ensureWaitlist seeded horses INTO waiting lists to make a full table
    // look wanted. Under this rule the queue is the release signal, so a horse
    // in it delays the person it is supposed to make room for.
    expect(FLEET).not.toContain('private async ensureWaitlist');
    // The pruner stays: it is what takes horse rows back OUT of every list.
    expect(FLEET).toContain('private async pruneHorseWaitlist');
  });
});

describe('LAW: the rules this one replaced are gone, not merely unused', () => {
  it('no held-empty rule survives anywhere', () => {
    /* Dan's 2026-08-26 "leave 15% of all cash game tables empty" cannot be
       true at the same time as a floor of one seat on every table. Leaving it
       in place as dead code is how a retired law comes back: the next agent
       reads it, believes it, and re-enforces it. */
    for (const src of [BEHAVIOR, FLEET, ROTATOR]) {
      expect(src).not.toContain('cashTableHeldEmpty');
      expect(src).not.toContain('CASH_EMPTY_FRACTION');
      expect(src).not.toContain('setSoleOpenCashTables');
    }
  });

  it('no vibe drift survives either', () => {
    // hot / busy / steady / quiet put three quarters of the floor BELOW full
    // by construction, which is the arithmetic that made 75% unreachable.
    for (const src of [BEHAVIOR, FLEET, ROTATOR]) {
      expect(src).not.toContain('tableVibe');
      expect(src).not.toContain('TableVibe');
      expect(src).not.toContain('VIBE_BUCKET_MS');
    }
  });
});
