import { describe, expect, it } from 'vitest';
import { enforceAuthoritativeDecision } from './HorseLogic.js';

/*
 * AT AN ALL-IN-OR-FOLD TABLE, CALLING IS THE ALL-IN (2026-10-26).
 *
 * The AoF menu is ['fold', 'all_in'] (ServerTableEngineTurns aofMenu,
 * LightningHorse). The authoritative menu check answered a `call` intent with
 * its safe fallback whenever `call` was absent, before it ever looked for the
 * all-in - so the V27 big-blind-vs-jam chart and the priced-in guard, which
 * both propose `call`, folded every hand the brain had decided to call.
 * Latent: no AoF table or tournament was open when found (8 tables and 3
 * tournaments configured).
 */

function state(o: { aof?: boolean; legal?: string[]; toCall?: number }): any {
  const toCall = o.toCall ?? 900;
  return {
    stateSchemaVersion: 1,
    allInOrFold: o.aof ?? true,
    legalActions: o.legal ?? ['fold', 'all_in'],
    toCall,
    currentBet: toCall + 100,
    bigBlind: 100,
    minRaiseTo: null,
    maxRaiseTo: null,
    players: [],
  };
}
const hero: any = { seat: 1, user_id: 'hero', stack: 1500, bet: 100, cards: ['As', 'Kd'] };
const callIntent: any = { action: 'call', amount: 900, thinkTime: 0 };

describe('the authoritative menu at an all-in-or-fold table', () => {
  it('turns an owed call into the all-in', () => {
    expect(enforceAuthoritativeDecision(callIntent, hero, state({}))).toEqual({
      action: 'all_in',
      thinkTime: 0,
    });
  });

  it('still checks when nothing is owed', () => {
    const r = enforceAuthoritativeDecision(
      callIntent,
      hero,
      state({ toCall: 0, legal: ['check', 'all_in'] })
    );
    expect(r.action).toBe('check');
  });

  it('keeps fold and the all-in as they are', () => {
    expect(
      enforceAuthoritativeDecision({ action: 'fold', thinkTime: 0 } as any, hero, state({})).action
    ).toBe('fold');
    expect(
      enforceAuthoritativeDecision({ action: 'all_in', thinkTime: 0 } as any, hero, state({}))
        .action
    ).toBe('all_in');
  });

  it('changes nothing off an AoF table: a menu without call still degrades safely', () => {
    expect(enforceAuthoritativeDecision(callIntent, hero, state({ aof: false })).action).toBe(
      'fold'
    );
  });

  it('an ordinary menu still calls for the owed amount', () => {
    expect(
      enforceAuthoritativeDecision(
        callIntent,
        hero,
        state({ aof: false, legal: ['fold', 'call', 'raise', 'all_in'] })
      )
    ).toEqual({ action: 'call', amount: 900, thinkTime: 0 });
  });
});
