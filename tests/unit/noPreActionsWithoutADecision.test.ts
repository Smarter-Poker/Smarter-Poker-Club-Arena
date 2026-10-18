/**
 * NO PRE-ACTION BUTTONS WHEN NO DECISION IS COMING (Dan 2026-10-18).
 *
 * Dan, verbatim: "WHEN YOU MAKE A BET OR RAISE AND ARE NOT 'FACING ANY
 * ACTION' THE DEFAULT CHECK FOLD, CHECK, CALL ANY BUTTONS SHOULD NEVER
 * APPEAR UNLESS YOU ARE FACING A DECISION."
 *
 * Reported from a live Diamond Arena tournament: the hero raised to 600
 * preflop and the bar offered Check/Fold, Check, Call Any for a turn that
 * could only come if somebody raised over him.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { heroAwaitsADecision } from '../../src/lib/preActionPanelGate';

describe('heroAwaitsADecision', () => {
  it('a hero who bet or raised and is not facing more has no decision coming', () => {
    expect(heroAwaitsADecision('raise', 0)).toBe(false);
    expect(heroAwaitsADecision('bet', 0)).toBe(false);
  });

  it('the same holds after a call or a check that nobody has bet into', () => {
    expect(heroAwaitsADecision('call', 0)).toBe(false);
    expect(heroAwaitsADecision('check', 0)).toBe(false);
  });

  it('a raise over the hero brings the decision back', () => {
    expect(heroAwaitsADecision('raise', 1200)).toBe(true);
    expect(heroAwaitsADecision('check', 400)).toBe(true);
  });

  it('a hero who has not acted this street still has a decision (big blind option included)', () => {
    expect(heroAwaitsADecision(null, 0)).toBe(true);
    expect(heroAwaitsADecision(undefined, 0)).toBe(true);
    expect(heroAwaitsADecision(null, 300)).toBe(true);
  });
});

describe('TablePage wires the rule into the bar and the bottom-bar state', () => {
  const TABLE_PAGE = readFileSync(
    path.resolve(__dirname, '../../src/pages/TablePage.tsx'),
    'utf8'
  );

  it('the PreActionBar mount is gated on the hero facing a decision', () => {
    const mount = TABLE_PAGE.indexOf('<PreActionBar');
    const gate = TABLE_PAGE.slice(TABLE_PAGE.lastIndexOf('{handStillTakingAction &&', mount), mount);
    expect(gate).toContain('(heroFacesADecision || suppressPanelForPreAction)');
  });

  it("data-hero-action 'waiting' asks the same question, so the two cannot disagree", () => {
    const memo = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf("const heroActionState: 'none' | 'waiting' | 'active'"),
      TABLE_PAGE.indexOf('const tablePage = (')
    );
    expect(memo).toContain('(heroFacesADecision || suppressPanelForPreAction)');
    expect(memo).toContain('heroFacesADecision,');
  });

  it('reads the hero action from the current street and the live call price', () => {
    const decl = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf('const heroFacesADecision = heroAwaitsADecision('),
      TABLE_PAGE.indexOf('const awaitingPreActionExec =')
    );
    expect(decl).toContain('tableState.lastActions?.[tableState.heroSeat - 1]');
    expect(decl).toContain('preActionCallDue');
  });
});
