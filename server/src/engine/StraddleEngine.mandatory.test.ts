import { describe, it, expect } from 'vitest';
import { StraddleEngine } from './StraddleEngine.js';

// UTG is the first entry in seatOrder (left of BB).
const seatOrder = [
  { seat: 4, playerId: 'utg' },
  { seat: 5, playerId: 'mp' },
  { seat: 6, playerId: 'co' },
];
const stacks = new Map([
  ['utg', 1000],
  ['mp', 1000],
  ['co', 1000],
]);
const BB = 2;

describe('StraddleEngine - mandatory (auto) UTG straddle', () => {
  it('auto-posts the UTG straddle every hand with NO opt-in when mandatoryUtg is true', () => {
    const eng = new StraddleEngine();
    eng.configure('t', {
      enabled: true,
      maxStraddles: 1,
      straddleMultiplier: 2,
      mandatoryUtg: true,
    });

    const result = eng.processStraddles('t', BB, seatOrder, stacks);
    expect(result.posted).toBe(true);
    expect(result.straddles).toHaveLength(1);
    expect(result.straddles[0].playerId).toBe('utg');
    expect(result.straddles[0].amount).toBe(BB * 2); // 4
    expect(result.adjustedBigBlind).toBe(BB * 2);
    // First to act is the seat after the straddler (mp).
    expect(result.firstToAct).toBe(5);
  });

  it('does NOT auto-post without opt-in when mandatoryUtg is false (voluntary mode)', () => {
    const eng = new StraddleEngine();
    eng.configure('t', {
      enabled: true,
      maxStraddles: 1,
      straddleMultiplier: 2,
      mandatoryUtg: false,
    });

    const result = eng.processStraddles('t', BB, seatOrder, stacks);
    expect(result.posted).toBe(false);
    expect(result.straddles).toHaveLength(0);
  });

  it('still honors voluntary opt-in when mandatoryUtg is false', () => {
    const eng = new StraddleEngine();
    eng.configure('t', {
      enabled: true,
      maxStraddles: 1,
      straddleMultiplier: 2,
      mandatoryUtg: false,
    });
    eng.toggleAutoStraddle('t', 'utg', true);

    const result = eng.processStraddles('t', BB, seatOrder, stacks);
    expect(result.posted).toBe(true);
    expect(result.straddles[0].playerId).toBe('utg');
  });

  it('treats undefined mandatoryUtg as voluntary-only', () => {
    const eng = new StraddleEngine();
    eng.configure('t', { enabled: true, maxStraddles: 1, straddleMultiplier: 2 });
    const result = eng.processStraddles('t', BB, seatOrder, stacks);
    expect(result.posted).toBe(false);
  });

  it('mandatory UTG straddle is skipped when the UTG player cannot afford it', () => {
    const eng = new StraddleEngine();
    eng.configure('t', {
      enabled: true,
      maxStraddles: 1,
      straddleMultiplier: 2,
      mandatoryUtg: true,
    });
    const poorStacks = new Map([
      ['utg', 3], // needs 4 to straddle
      ['mp', 1000],
      ['co', 1000],
    ]);
    const result = eng.processStraddles('t', BB, seatOrder, poorStacks);
    expect(result.posted).toBe(false);
  });
});
