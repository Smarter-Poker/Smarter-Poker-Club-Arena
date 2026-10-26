/**
 * A DESIGNED RESET IS NOT A RECOVERY (2026-10-25).
 *
 * Measured on engine-01 in ten minutes of the live log: 49,517 `[TurnFSM]
 * FORCED state: timer_running -> waiting` and 2,601 `[PreActionFSM] FORCED
 * state: idle -> idle` - the two designed boundary resets (turn start, hand
 * end) printed as if they were recoveries, a quarter of every line the engine
 * wrote, and the reason the 250 MB json-file window held under two hours. The
 * boundary resets go through `reset()` and say nothing; `forceState()` keeps
 * its warning for a state the table did not expect to be in.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateMachine } from './StateMachine.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = (rel: string) => readFileSync(join(here, rel), 'utf8');

afterEach(() => vi.restoreAllMocks());

describe('StateMachine.reset', () => {
  type S = 'waiting' | 'timer_running' | 'time_bank_active';
  const build = () =>
    new StateMachine<S>('TurnFSM', 'waiting', [
      { from: 'waiting', to: 'timer_running' },
      { from: 'timer_running', to: 'time_bank_active' },
    ]);

  it('returns to the boundary state without printing anything', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fsm = build();
    fsm.transition('timer_running');
    fsm.reset('waiting');
    expect(fsm.state).toBe('waiting');
    fsm.reset('waiting');
    expect(fsm.state).toBe('waiting');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('forceState still warns, so a genuine recovery stays visible in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsm = build();
    fsm.forceState('time_bank_active');
    expect(fsm.state).toBe('time_bank_active');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('FORCED state: waiting');
  });
});

describe('the two designed boundary resets use reset(), not forceState()', () => {
  it('the turn-start reset in handleTurnChange', () => {
    const src = source('ServerTableEngineTurns.ts');
    expect(src).toContain("this.turnFSM.reset('waiting')");
    expect(src).not.toMatch(/turnFSM\.forceState\('waiting'\)/);
  });

  it('the hand-end reset in PreActionEngine.clearTable', () => {
    const src = source('PreActionEngine.ts');
    expect(src).toContain("fsm.reset('idle')");
    expect(src).not.toMatch(/fsm\.forceState\('idle'\)/);
  });
});
