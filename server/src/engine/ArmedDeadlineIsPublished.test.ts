/**
 * THE PUBLISHED CLOCK IS THE ARMED CLOCK (disconnect audit item 1, 2026-09-04)
 *
 * When DisconnectEngine.onPlayerTurn declines to hand the turn to a seat, it
 * arms one of two things under `disconnect:<uid>`: the 30s timeout countdown
 * for a MISSING seat, or the 350/1250ms beat for a sat-out one. The engine
 * used to broadcast neither - the ordinary 15s deadline had already been
 * stamped - so every client drew a 15s ring for a seat that would be acted
 * for in under a second, or one that would take 30s. These pin that the
 * armed deadline is readable and that handleTurnChange re-stamps from it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod, sliceBlockAfter } from '../testHelpers/sourceWindow.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { SIT_OUT_FREE_BEAT_MS, SIT_OUT_BEAT_JITTER_MS } from './sitOutBeat.js';

const TABLE = 'table-1';
const PLAYER = 'player-1';

describe('armedAutoActionDeadlineMs', () => {
  let eng: DisconnectEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
    eng = new DisconnectEngine(new PreciseActionTimer());
    eng.registerPlayer(TABLE, PLAYER);
  });
  afterEach(() => vi.useRealTimers());

  it('is 0 for a connected player whose turn was handed over', () => {
    expect(eng.onPlayerTurn(TABLE, PLAYER, true)).toBe(true);
    expect(eng.armedAutoActionDeadlineMs(TABLE, PLAYER)).toBe(0);
  });

  it('is the 30s timeout countdown for a disconnected seat', () => {
    eng.markDisconnected(TABLE, PLAYER);
    expect(eng.onPlayerTurn(TABLE, PLAYER, false)).toBe(false);
    const dl = eng.armedAutoActionDeadlineMs(TABLE, PLAYER);
    expect(dl - Date.now()).toBe(30_000);
  });

  it('is the sit-out beat for a sat-out seat, never the 15s action clock', () => {
    eng.sitOut(TABLE, PLAYER, 'voluntary');
    expect(eng.onPlayerTurn(TABLE, PLAYER, true)).toBe(false);
    const wait = eng.armedAutoActionDeadlineMs(TABLE, PLAYER) - Date.now();
    expect(wait).toBeGreaterThanOrEqual(SIT_OUT_FREE_BEAT_MS);
    expect(wait).toBeLessThanOrEqual(SIT_OUT_FREE_BEAT_MS + SIT_OUT_BEAT_JITTER_MS);
    expect(wait).toBeLessThan(15_000);
  });

  it('is 0 again once the countdown is cancelled', () => {
    eng.markDisconnected(TABLE, PLAYER);
    eng.onPlayerTurn(TABLE, PLAYER, false);
    eng.cancelTimeout(TABLE, PLAYER);
    expect(eng.armedAutoActionDeadlineMs(TABLE, PLAYER)).toBe(0);
  });
});

describe('handleTurnChange re-stamps the published deadline from the armed one', () => {
  const src = readFileSync(resolve(__dirname, 'ServerTableEngineTurns.ts'), 'utf8');
  const body = sliceMethod(src, 'protected async handleTurnChange(');

  it('reads the armed deadline in the !playerCanAct branch, before returning', () => {
    const block = sliceBlockAfter(body, 'if (!playerCanAct) {');
    expect(block).toMatch(/armedAutoActionDeadlineMs\(this\.tableId, player\.user_id\)/);
    expect(block).toMatch(/this\.playerTurnStartTime = now;/);
    expect(block).toMatch(/this\.playerTurnDuration = Math\.max\(0, \(armed - now\) \/ 1000\);/);
  });
});
