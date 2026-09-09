/**
 * LAW: A SCHEMA-CACHE RELOAD CANNOT LOSE A HAND.
 *
 * A hand's immutable settlement payload remains owned by the awaited
 * post-hand promise. It is never handed to a timer, watcher, reconciler, or
 * replacement engine. That promise retries longer than the measured 28-second
 * PostgREST reload and returns success only with the authoritative receipt.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAND_COMMIT_RETRY_DELAYS_MS } from '../server/src/services/supabase/handHistory.js';
import { sliceMethod } from '../server/src/testHelpers/sourceWindow.js';

const ROOT = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readCode = (path: string): string =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

describe('the accepted hand itself owns the schema-reload window', () => {
  it('retries beyond the measured 28-second reload', () => {
    const retryWindowMs = HAND_COMMIT_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(retryWindowMs).toBeGreaterThan(28_000);
  });

  it('remains inside the five-minute settlement barrier at full request deadlines', () => {
    const attempts = HAND_COMMIT_RETRY_DELAYS_MS.length + 1;
    const requestDeadlinesMs = attempts * 15_000;
    const retryWindowMs = HAND_COMMIT_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(requestDeadlinesMs + retryWindowMs).toBeLessThan(300_000);
  });

  it('builds one payload and reuses it for every idempotent RPC attempt', () => {
    const source = readCode('server/src/services/supabase/handHistory.ts');
    const method = sliceMethod(source, 'async function insertHandHistoryRow(');

    expect(method.match(/const payload =/g)).toHaveLength(1);
    expect(method).toContain("supabase.rpc('fn_ca_commit_hand_settlement', payload)");
    expect(method.indexOf('const payload =')).toBeLessThan(method.indexOf('for (let attempt = 0;'));
  });

  it('never delegates the money payload to an off-path queue or reconciler', () => {
    const source = readCode('server/src/services/supabase/handHistory.ts');
    const method = sliceMethod(source, 'async function insertHandHistoryRow(');
    expect(method).not.toMatch(/pendingWrites|enqueuePendingWrite|drainPendingWrites/);
    expect(method).not.toMatch(/reconcile|watch|setInterval/);
  });

  it('keeps the raw settlement promise visible to stop and terminal closeout', () => {
    const settlement = readCode('server/src/engine/ServerTableEngineSettlement.ts');
    const base = readCode('server/src/engine/ServerTableEngineBase.ts');
    expect(settlement).toContain('this.trackSettlementInFlight(this.postHandTasksPromise)');
    expect(settlement).toContain('this.finishTerminalBoundaryPersistence(');
    expect(base).toContain('protected settlementInFlight: Set<Promise<void>> = new Set();');
    expect(base).toContain('settlements.add(p)');
    expect(base).toContain('settlements.delete(tracked)');
  });
});
