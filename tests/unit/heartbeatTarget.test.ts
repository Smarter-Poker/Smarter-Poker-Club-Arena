/**
 * What the HTTP heartbeat beats at (2026-10-24). 1,864 /heartbeat 404s a day:
 * 666 from Lightning pool-session rooms (no table engine exists for them) and
 * 776 from tables whose row is closed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  shouldAskTableRow,
  shouldHeartbeatOverHttp,
  tableRowSaysClosed,
} from '../../src/lib/heartbeatTarget';

const root = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('shouldHeartbeatOverHttp', () => {
  it('never beats a Lightning pool-session room', () => {
    expect(shouldHeartbeatOverHttp({ isLightningRoom: true })).toBe(false);
    expect(shouldHeartbeatOverHttp({ isLightningRoom: false })).toBe(true);
  });

  it('matches the server: /heartbeat resolves table engines only', () => {
    const handler = read('server/src/handlers/heartbeat.ts');
    expect(handler).toContain('deps.gameServer.getTableEngine(tableId)');
    expect(handler).not.toMatch(/lightning|actionEngineFor|anchorFor/i);
  });
});

describe('tableRowSaysClosed', () => {
  it('stops only on a positive answer', () => {
    expect(tableRowSaysClosed({ status: 'closed' })).toBe(true);
    expect(tableRowSaysClosed({ status: 'CLOSED' })).toBe(true);
    expect(tableRowSaysClosed({ status: 'running', is_deleted: true })).toBe(true);
    expect(tableRowSaysClosed({ status: 'running' })).toBe(false);
    expect(tableRowSaysClosed({ status: 'waiting' })).toBe(false);
    expect(tableRowSaysClosed(null)).toBe(false);
    expect(tableRowSaysClosed(undefined)).toBe(false);
  });
});

describe('shouldAskTableRow', () => {
  it('asks only at the first404 of an episode, without a new row-polling loop', () => {
    const asked = Array.from({ length: 60 }, (_, i) => i + 1).filter(shouldAskTableRow);
    expect(asked).toEqual([1]);
    expect(shouldAskTableRow(0)).toBe(false);
  });
});

describe('TablePage heartbeat wiring', () => {
  const page = read('src/pages/TablePage.tsx');

  it('every HTTP heartbeat call site checks for a Lightning room', () => {
    const calls = page.split('sendHeartbeat(tableId').length - 1;
    const gates =
      page.split('shouldHeartbeatOverHttp({ isLightningRoom: !!lightningRoomRef.current })')
        .length - 1;
    expect(calls).toBe(3);
    expect(gates).toBe(3);
  });

  it('a closed row stops the beat and a connected socket starts it again', () => {
    expect(page).toContain('if (heartbeatRowClosedRef.current) return;');
    expect(page).toContain('heartbeatRowClosedRef.current = true;');
    expect(page).toContain(
      'shouldAskTableRow(notRunningBeats) && !rowCheckInFlight && isUUID(tableId)'
    );
    const connected = page.indexOf("if (engineWsStatus === 'connected') {");
    expect(page.indexOf('heartbeatRowClosedRef.current = false;', connected)).toBeGreaterThan(
      connected
    );
  });
});
