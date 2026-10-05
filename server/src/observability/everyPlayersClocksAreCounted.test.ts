/**
 * EVERY PLAYER'S CLOCKS ARE COUNTED (2026-10-05).
 *
 * The horse input-device series (aHorseActionReleasesItsClocks) count a
 * horse's clock running out. These count the same events for every seat,
 * human or horse, on the always-on registry, so a timeout, a forced sit-out,
 * a disconnect's length and a presence auto-action each have a number.
 * Observation only: nothing reads them to decide anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { alwaysOnPrometheusLines } from './engineInstruments.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { DisconnectEngine } from '../engine/DisconnectEngine.js';
import { PreciseActionTimer } from '../engine/PreciseActionTimer.js';
import { DeadlineScheduler } from '../engine/DeadlineScheduler.js';

const read = (series: string): number => {
  const line = alwaysOnPrometheusLines().find((l) => l.startsWith(series + ' '));
  return line ? Number(line.slice(series.length + 1)) : NaN;
};
const srcOf = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

afterEach(() => vi.restoreAllMocks());

function presenceEngine() {
  let now = 50_000_000;
  let tick: (() => void) | null = null;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const sched = new DeadlineScheduler({
    tickMs: 100,
    now: () => now,
    setInterval: (cb: () => void) => {
      tick = cb;
      return 1 as any;
    },
    clearInterval: () => {},
  });
  sched.start();
  const eng = new DisconnectEngine(new PreciseActionTimer(undefined, sched, () => now));
  return {
    eng,
    advance(ms: number) {
      now += ms;
      tick?.();
    },
  };
}

describe('the always-on player clock series', () => {
  it('are registered, at zero, before anything happens', () => {
    const text = alwaysOnPrometheusLines().join('\n');
    for (const name of [
      'poker_turn_timeouts_total{audience="human",format="cash",kind="timer"} ',
      'poker_turn_timeouts_total{audience="horse",format="mtt",kind="timebank"} ',
      'poker_forced_sit_outs_total{audience="human",format="spin"} ',
      'poker_disconnect_auto_actions_total{action="fold",reason="timeout"} ',
      '# TYPE poker_disconnect_seconds histogram',
    ]) {
      expect(text).toContain(name);
    }
    // The horse series stay where they were.
    expect(text).toContain('poker_horse_turn_timeouts_total');
    expect(text).toContain('poker_horse_forced_sit_outs_total');
  });

  it('a turn timeout is counted for a human and for a horse, by the seat', () => {
    const engine = new ServerTableEngine('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1') as any;
    engine.seatedPlayers = [
      { user_id: 'horse-1', seat_number: 1, is_horse: true },
      { user_id: 'human-2', seat_number: 2, is_horse: false },
    ];
    const format = engine.tableFormat();
    const human = `poker_turn_timeouts_total{audience="human",format="${format}",kind="timer"}`;
    const horse = `poker_turn_timeouts_total{audience="horse",format="${format}",kind="timebank"}`;
    const [h0, r0] = [read(human), read(horse)];
    engine.notePlayerTurnTimeout('human-2', 'timer');
    engine.notePlayerTurnTimeout('horse-1', 'timebank');
    expect(read(human)).toBe(h0 + 1);
    expect(read(horse)).toBe(r0 + 1);
  });

  it('is fed at all three expiry sites that record a strike, and the forced sit-out', () => {
    const turns = srcOf('../engine/ServerTableEngineTurns.ts');
    expect(turns.match(/this\.notePlayerTurnTimeout\(userId, 'timer'\)/g)?.length).toBe(1);
    expect(turns.match(/this\.notePlayerTurnTimeout\(userId, 'timebank'\)/g)?.length).toBe(2);
    expect(turns.match(/recordConnectedTimeout\(this\.tableId, userId\)/g)?.length).toBe(3);
    expect(srcOf('../engine/ServerTableEngineBase.ts')).toContain(
      'EngineMetrics.forcedSitOutsTotal.inc(1'
    );
  });

  it('the length of a disconnect is observed when the player comes back', () => {
    const h = presenceEngine();
    h.eng.registerPlayer('t', 'u');
    const c0 = read('poker_disconnect_seconds_count');
    const s0 = read('poker_disconnect_seconds_sum');
    h.eng.markDisconnected('t', 'u');
    h.advance(12_000);
    h.eng.heartbeat('t', 'u');
    expect(read('poker_disconnect_seconds_count')).toBe((Number.isNaN(c0) ? 0 : c0) + 1);
    expect(read('poker_disconnect_seconds_sum')).toBeCloseTo((Number.isNaN(s0) ? 0 : s0) + 12, 6);
    // A beat from somebody who never left observes nothing.
    h.eng.heartbeat('t', 'u');
    expect(read('poker_disconnect_seconds_count')).toBe((Number.isNaN(c0) ? 0 : c0) + 1);
  });

  it('a presence auto-action is counted by action and reason', () => {
    const h = presenceEngine();
    h.eng.registerPlayer('t', 'u');
    h.eng.onAutoAction('t', () => {});
    const series = 'poker_disconnect_auto_actions_total{action="fold",reason="sitting_out"}';
    const before = read(series);
    h.eng.sitOut('t', 'u', 'voluntary');
    h.eng.onPlayerTurn('t', 'u', false);
    h.advance(2_000);
    expect(read(series)).toBe(before + 1);
  });
});
