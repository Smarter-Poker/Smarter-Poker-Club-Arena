import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const seating = readFileSync('src/engine/ServerTableEngineSeating.ts', 'utf8');
const behavior = readFileSync('src/engine/ChipContinuityLeave.behaviour.test.ts', 'utf8');

describe('owner 2026-10-29: 2/5 PLO5 Horses do not hit and run', () => {
  it('guards the common leave door before any voluntary cashout or durable departure', () => {
    const door = seating.slice(seating.indexOf('public async leaveTable('));
    const guard = door.indexOf('player.is_horse === true');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(door.indexOf('atomicCashoutVoluntary('));
    const cash = door.indexOf('// CHIP CONTINUITY (Operation Table Stakes');
    expect(guard).toBeLessThan(cash);
    expect(door.slice(guard, cash)).toContain(".from('cash_player_session')");
  });
  it('retains executable boundary, reload, unknown-cost and scope regression cases', () => {
    expect(behavior).toContain('2249.99');
    expect(behavior).toContain('[2250, 2250.01, 3000]');
    expect(behavior).toContain('counts reloads as invested money rather than winnings');
    expect(behavior).toContain('retains the seat on a failed session read');
    expect(behavior).toContain('preserves unrelated exits');
  });
});
