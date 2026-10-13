import type { Page } from '@playwright/test';
import { sharedNaturalLevel, type HudLevel } from './tournamentHudWitness';

export type EngineHudScope = { tableId: string; tournamentId: string };
export type EngineHudLevel = HudLevel & { tableId: string; eventTimestamp: number };

/** Match the actual engine origin and table transport, without retaining URL credentials. */
export function isScopedEngineTransport(
  url: string,
  engineHealthUrl: string,
  tableId: string
): boolean {
  try {
    const actual = new URL(url);
    const expected = new URL(engineHealthUrl);
    return (
      actual.protocol === (expected.protocol === 'https:' ? 'wss:' : 'ws:') &&
      actual.host === expected.host &&
      (actual.pathname === '/ws/multi' || actual.pathname === `/ws/table/${tableId}`)
    );
  } catch {
    return false;
  }
}

/** Serving producer and HUD consumer both use a zero-based new_level. */
export function receivedEngineHudLevel(
  raw: string,
  at: number,
  scope: EngineHudScope
): EngineHudLevel | null {
  try {
    const frame = JSON.parse(raw);
    const data = frame?.payload;
    if (
      !frame ||
      Array.isArray(frame) ||
      frame.type !== 'EVENT' ||
      frame.tableId !== scope.tableId ||
      !data ||
      Array.isArray(data) ||
      data.type !== 'level_up' ||
      data.table_id !== scope.tableId ||
      data.tournament_id !== scope.tournamentId ||
      frame.replayed === true ||
      data.replayed === true
    )
      return null;
    const value = data.new_level;
    const index =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : NaN;
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !Number.isSafeInteger(data.timestamp) ||
      data.timestamp <= 0 ||
      !Number.isFinite(at) ||
      at <= 0
    )
      return null;
    return {
      tableId: scope.tableId,
      tournamentId: scope.tournamentId,
      levelIndex: index,
      eventTimestamp: data.timestamp,
      at,
    };
  } catch {
    return null;
  }
}

export function observeEngineHudLevels(
  page: Page,
  scope: EngineHudScope,
  engineHealthUrl: string
): EngineHudLevel[] {
  const levels: EngineHudLevel[] = [];
  page.on('websocket', (socket) => {
    if (!isScopedEngineTransport(socket.url(), engineHealthUrl, scope.tableId)) return;
    socket.on('framereceived', ({ payload }) => {
      const level = receivedEngineHudLevel(String(payload), Date.now(), scope);
      if (level) levels.push(level);
    });
  });
  return levels;
}

/** Both independent physical receipts must be produced after the admitted baseline. */
export function sharedNaturalEngineLevel(
  a: EngineHudLevel[],
  b: EngineHudLevel[],
  scope: EngineHudScope,
  baselineIndex: number,
  since: number
): EngineHudLevel | undefined {
  const current = (levels: EngineHudLevel[]) =>
    levels.filter(
      (level) =>
        level.tableId === scope.tableId &&
        level.tournamentId === scope.tournamentId &&
        level.eventTimestamp > since
    );
  return sharedNaturalLevel(current(a), current(b), scope.tournamentId, baselineIndex, since) as
    | EngineHudLevel
    | undefined;
}
