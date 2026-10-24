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

  describe('the Lightning room around that chair', () => {
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
        /\[lightningHeroWaiting, lightningRoomClusterId, tableId, lightningBalanceVersion\]/
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
    const entry = readFileSync('src/pages/LightningEntryPage.tsx', 'utf8');

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
      expect(page).toMatch(
        /if \(anchorLightningClusterId\) \{\s*\/\*[\s\S]*?\*\/\s*navigate\(lightningRoute\(anchorLightningClusterId\)\);\s*return false;\s*\}\s*toast\.info\('This Seat Is Reserved/
      );
    });

    it('opens the buy-in on the held chair as soon as Join Lightning lands', () => {
      expect(entry).toContain('navigate(`/table/${r.table_id}?buyin=1`);');
    });
  });

  it('is how the table draws the hero chair in a Lightning room', () => {
    const page = readFileSync('src/pages/TablePage.tsx', 'utf8');
    expect(page).toContain('lightningWaitingHero({');
    // The placeholder chair takes its status and balance from the waiting seat.
    expect(page).toMatch(
      /stack:\s*lightningWaitingSeat\?\.stack \?\? heroRowStack \?\? pendingSeatStackRef\.current \?\? 0/
    );
    expect(page).toMatch(
      /status: lightningWaitingSeat \? lightningWaitingSeat\.status : 'sitting_out'/
    );
  });
});
