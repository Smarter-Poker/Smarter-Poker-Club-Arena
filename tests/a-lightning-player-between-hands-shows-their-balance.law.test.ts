/**
 * LAW (Dan 2026-10-24): "IN LIGHTNING GAMES, WHEN YOU MOVE TO A NEW TABLE AFTER
 * FOLDING... IT SHOUDN'T SAY SITTING OUT... AND IT SHOULD 100% ALWAYS SHOW YOUR
 * BALANCE AT ALL TIMES, IT SHOULD NEVER SAY 0.00"
 *
 * After a Lightning fold the engine publishes the idle room (no players), so
 * the table draws the hero's chair itself. That chair used to be the cash
 * seat-row placeholder: status 'sitting_out' and a stack of 0 (a pool session
 * has no seat row and no pending buy-in). It is now decided by
 * lightningWaitingHero.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  lightningIdleBalanceFor,
  lightningSessionStackFor,
  lightningWaitingHero,
} from '../src/lightning/lightningWaitingHero';

describe('a Lightning player between hands', () => {
  it('is not sitting out after a fold', () => {
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: 187.5, sessionStack: null }).status
    ).toBe('active');
  });

  it('is sitting out only when they asked to be', () => {
    expect(
      lightningWaitingHero({ sittingOut: true, lastSeenStack: 187.5, sessionStack: null }).status
    ).toBe('sitting_out');
  });

  it('keeps the balance they folded with', () => {
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: 187.5, sessionStack: 200 }).stack
    ).toBe(187.5);
  });

  it('reads the pool balance when the room has not shown them yet', () => {
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: null, sessionStack: 200 }).stack
    ).toBe(200);
  });

  it('prefers the pool balance over a last-seen zero (an unpaid all-in)', () => {
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: 0, sessionStack: 412 }).stack
    ).toBe(412);
  });

  it('never invents a zero', () => {
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: null, sessionStack: null }).stack
    ).toBeNull();
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: Number.NaN, sessionStack: -5 }).stack
    ).toBeNull();
  });

  it('adopts a session read only for its own room', () => {
    expect(lightningSessionStackFor('room-a', { poolSessionId: 'room-a', stack: 150 })).toBe(150);
    expect(lightningSessionStackFor('room-a', { poolSessionId: 'room-b', stack: 150 })).toBeNull();
    expect(lightningSessionStackFor('room-a', { poolSessionId: null, stack: 150 })).toBeNull();
    expect(lightningSessionStackFor(null, { poolSessionId: 'room-a', stack: 150 })).toBeNull();
  });

  describe('the engine says the balance on the idle room itself', () => {
    const idle = (room: string, user: string, stack: unknown) => ({
      table_id: room,
      stage: 'waiting',
      lightning: { player_balance: { user_id: user, stack } },
    });

    it('takes the engine figure over the roster and the database', () => {
      expect(
        lightningWaitingHero({
          sittingOut: false,
          engineStack: 163.25,
          lastSeenStack: 187.5,
          sessionStack: 200,
        }).stack
      ).toBe(163.25);
      expect(
        lightningWaitingHero({
          sittingOut: false,
          engineStack: 0,
          lastSeenStack: 0,
          sessionStack: 9,
        }).stack
      ).toBe(0);
    });

    it('still keeps the player own Sit Out with the engine figure', () => {
      expect(
        lightningWaitingHero({
          sittingOut: true,
          engineStack: 50,
          lastSeenStack: null,
          sessionStack: null,
        })
      ).toEqual({ status: 'sitting_out', stack: 50 });
    });

    it('falls back when the engine sends nothing usable (an older engine)', () => {
      for (const engineStack of [undefined, null, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
        expect(
          lightningWaitingHero({
            sittingOut: false,
            engineStack,
            lastSeenStack: 187.5,
            sessionStack: 200,
          }).stack
        ).toBe(187.5);
        expect(
          lightningWaitingHero({
            sittingOut: false,
            engineStack,
            lastSeenStack: null,
            sessionStack: 200,
          }).stack
        ).toBe(200);
      }
    });

    it('adopts the engine figure only for this player in this room', () => {
      expect(lightningIdleBalanceFor('room-a', 'me', idle('room-a', 'me', 142.5))).toBe(142.5);
      expect(
        lightningIdleBalanceFor('room-a', 'me', idle('room-a', 'someone-else', 142.5))
      ).toBeNull();
      expect(lightningIdleBalanceFor('room-a', 'me', idle('room-b', 'me', 142.5))).toBeNull();
      expect(lightningIdleBalanceFor(null, 'me', idle('room-a', 'me', 142.5))).toBeNull();
      expect(lightningIdleBalanceFor('room-a', null, idle('room-a', 'me', 142.5))).toBeNull();
      expect(lightningIdleBalanceFor('room-a', 'me', idle('room-a', 'me', -3))).toBeNull();
      expect(lightningIdleBalanceFor('room-a', 'me', idle('room-a', 'me', 'nope'))).toBeNull();
      expect(
        lightningIdleBalanceFor('room-a', 'me', {
          table_id: 'room-a',
          stage: 'waiting',
          lightning: {},
        })
      ).toBeNull();
      expect(lightningIdleBalanceFor('room-a', 'me', null)).toBeNull();
    });
  });

  describe('the Lightning room around that chair', () => {
    const pageForEngine = readFileSync('src/pages/TablePage.tsx', 'utf8');

    it('hands the engine figure for this room and player to the waiting chair first', () => {
      expect(pageForEngine).toMatch(
        /lightningIdleBalanceFor\(\s*tableId,\s*userId,\s*engineSnapshot as unknown as LightningIdleBalanceSnapshot \| null\s*\)/
      );
      expect(pageForEngine).toMatch(
        /sittingOut: lightningSitOut\.sittingOut,\s*engineStack: lightningEngineIdleStack,\s*lastSeenStack:/
      );
      // Chips added between hands make the fold-time engine figure stale too.
      expect(pageForEngine).toMatch(
        /lightningLastSeenStackRef\.current = null;\s*lightningEngineStackSupersededRef\.current = engineSnapshotRef\.current;/
      );
      expect(pageForEngine).toMatch(
        /engineSnapshot !== lightningEngineStackSupersededRef\.current\s*\?\s*lightningIdleBalanceFor\(/
      );
    });

    const page = readFileSync('src/pages/TablePage.tsx', 'utf8');

    it('remembers the roster stack and reads the pool balance while the hero waits', () => {
      expect(page).toMatch(
        /if \(lightningHeroInRoster && Number\.isFinite\(lightningHeroInRoster\.stack\)\) \{\s*lightningLastSeenStackRef\.current = lightningHeroInRoster\.stack;/
      );
      expect(page).toMatch(/lastSeenStack: lightningLastSeenStackRef\.current,/);
      expect(page).toMatch(/sessionStack: lightningSessionStack,/);
      expect(page).toMatch(
        /setLightningSessionStack\(lightningSessionStackFor\(tableId, session\)\)/
      );
    });

    it('reads the balance again after chips are added between hands', () => {
      expect(page).toMatch(
        /if \(lightningRoomRef\.current && !res\.queued && applied > 0\) \{\s*setLightningBalanceVersion/
      );
      expect(page).toMatch(
        /\[\s*lightningHeroWaiting,\s*lightningRoomClusterId,\s*tableId,\s*lightningBalanceVersion,\s*lightningBalanceReadVersion,?\s*\]/
      );
    });

    it('gives a room opened between hands its player a chair', () => {
      expect(page).toMatch(/hasLightningRoom\(session\) && session\.poolSessionId === tableId/);
      expect(page).toMatch(
        /if \(!lightningRoom \|\| !lightningSessionHoldsRoom\) return;[\s\S]{0,200}heroSeatRef\.current = 1;/
      );
    });

    it('says nothing in the footer between hands, but keeps I am Back for a real sit-out', () => {
      expect(page).toMatch(
        /\{lightningRoom && !lightningHeroInRoster && !heroIsSittingOut \? \(\s*\/\*[\s\S]*?\*\/\s*<div className="spectator-footer-bar" data-state="lightning-between-hands">\s*<span className="spectator-footer-bar__label" \/>/
      );
    });

    it('never sells a seat in a Lightning room', () => {
      expect(page).toMatch(
        /canSit=\{\s*tableState\.heroSeat <= 0 &&\s*pendingSeat === null &&\s*!lightningRoom &&/
      );
      expect(page).toMatch(
        /const handleSeatClick = \(seatNumber: number\) => \{\s*\/\*[\s\S]*?\*\/\s*if \(lightningRoomRef\.current\) return;/
      );
    });

    it('shows Leave and Add Chips the same balance', () => {
      expect(page).toContain('heroStack={heroDisplayStack}');
      expect(page).toMatch(
        /const heroDisplayStack = lightningRoom\s*\?\s*\(lightningHeroInRoster\?\.stack \?\? lightningWaitingSeat\?\.stack \?\? 0\)/
      );
    });

    it('never runs the cash bust prompt or cash session restore against a pool session', () => {
      expect(page).toMatch(
        /tableState\.heroSeat <= 0\) return;\s*\/\*[^*]*Lightning room rebuys[\s\S]*?\*\/\s*if \(lightningRoomRef\.current\) return;/
      );
      expect(page).toMatch(/const hasCashSessionSeat =[\s\S]{0,400}!lightningRoom;/);
    });
  });

  describe('Lightning entry never queues and never asks for a seat', () => {
    const page = readFileSync('src/pages/TablePage.tsx', 'utf8');

    it('treats only a Cluster in a Lightning mode as Lightning (never Classic)', () => {
      expect(page).toMatch(
        /\(lightningObserver \|\| isLightningMode\(tableGameLightningState\?\.clusterMode\)\)/
      );
      expect(page).not.toMatch(/spectatorLightningStates\[tableState\.clusterId\] != null/);
    });

    it('offers no chair to tap on a Lightning game table', () => {
      expect(page).toMatch(/!lightningRoom &&\s*\/\*[\s\S]*?\*\/\s*!anchorLightningClusterId &&/);
    });

    it('sends a lapsed Lightning chair back through Join Lightning, never the list', () => {
      /* Join Lightning is one tap (2026-10-24): the refusal opens the game's
         door with the amount question already up, never the waiting list. */
      expect(page).toMatch(
        /if \(anchorLightningClusterId\) \{\s*\/\*[\s\S]*?\*\/\s*openLightningAnchorEntry\(\);\s*return false;\s*\}\s*toast\.info\('This Seat Is Reserved/
      );
      expect(page).toMatch(
        /const openLightningAnchorEntry = \(\) => \{\s*if \(!anchorLightningClusterId\) return;\s*navigate\(lightningJoinRoute\(anchorLightningClusterId\)\);\s*\};/
      );
    });
  });

  it('is how the table draws the hero chair in a Lightning room', () => {
    const page = readFileSync('src/pages/TablePage.tsx', 'utf8');
    expect(page).toContain('lightningWaitingHero({');
    // The placeholder chair takes its status and balance from the waiting seat.
    expect(page).toMatch(
      /stack:\s*lightningWaitingSeat\?\.stack \?\? heroRowStack \?\? pendingSeatStackRef\.current \?\? 0/
    );
    expect(page).toMatch(/status:\s*lightningWaitingSeat\s*\? lightningWaitingSeat\.status\s*:/);
  });
});
