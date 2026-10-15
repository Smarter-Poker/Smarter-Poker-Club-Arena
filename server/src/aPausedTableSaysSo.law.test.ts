/**
 * LAW: A PAUSED TABLE SAYS SO (2026-10-15)
 *
 * The 6:00 AM Freeroll (a38b88a9) sat RUNNING with 58 players for 35 hours
 * while its 8 tables could not be admitted. The engine answered every viewer
 * of those tables TABLE_NOT_FOUND, exactly what it answers for a table that
 * does not exist, and after three of them the felt told a seated player "This
 * Table Is No Longer Running".
 *
 * The engine now names the pause: a SUBSCRIBE for a table a tournament manager
 * is failing to admit keeps its TABLE_NOT_FOUND code (so every client keeps
 * polling and rejoins the moment the table deals) and carries the message
 * TABLE_PAUSED_MESSAGE. The client maps it to its own close reason and says
 * the table is paused, once, instead of announcing a closure.
 *
 * The rule for an event that cannot resume, as built: its blind clock does not
 * advance on hands that were never dealt (levelClockOutage.ts and the
 * advanceBlindLevel hold), its floor is paged after ten minutes and every
 * thirty after (Tournament.table_admission_failing), its players are told the
 * table is paused, and it is never cancelled or paid out automatically.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameServer } from './GameServer.js';
import { TABLE_PAUSED_MESSAGE } from './transport/EngineWebSocketServer.js';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const INDEX = read('src/index.ts');
const MUX_CLIENT = read('../src/services/EngineSocketMux.ts');
const TABLE_PAGE = read('../src/pages/TablePage.tsx');

function serverWith(failing: Record<string, string[]>): GameServer {
  const server = new GameServer();
  const engines = (server as unknown as { tournamentEngines: Map<string, unknown> })
    .tournamentEngines;
  for (const [tournamentId, tables] of Object.entries(failing)) {
    engines.set(tournamentId, {
      getTablesFailingAdmission: () => tables.map((tableId) => ({ tableId, msFailing: 1 })),
    });
  }
  return server;
}

describe('a paused table says so', () => {
  it('a table is paused exactly while some manager is failing to admit it', () => {
    const server = serverWith({ t1: ['a', 'b'], t2: ['c'] });
    expect(server.isTournamentTablePaused('a')).toBe(true);
    expect(server.isTournamentTablePaused('c')).toBe(true);
    expect(server.isTournamentTablePaused('d')).toBe(false);
    expect(serverWith({}).isTournamentTablePaused('a')).toBe(false);
  });

  it('a manager without the probe never pauses a table', () => {
    const server = new GameServer();
    (server as unknown as { tournamentEngines: Map<string, unknown> }).tournamentEngines.set(
      't',
      {}
    );
    expect(server.isTournamentTablePaused('a')).toBe(false);
  });

  it('production wires the probe into the engine socket', () => {
    expect(INDEX).toContain(
      'tablePaused: (tableId) => gameServer.isTournamentTablePaused(tableId),'
    );
  });

  it('the client mirrors the message and keeps the 4404 ladder', () => {
    expect(MUX_CLIENT).toContain(
      `export const TOURNAMENT_TABLE_PAUSED_MESSAGE = '${TABLE_PAUSED_MESSAGE}';`
    );
    expect(MUX_CLIENT).toMatch(
      /msg\.code === 'TABLE_NOT_FOUND' \? 4404 :[\s\S]{0,200}msg\.code === 'TABLE_NOT_FOUND' && msg\.message === TOURNAMENT_TABLE_PAUSED_MESSAGE\s*\?\s*TOURNAMENT_TABLE_PAUSED_REASON/
    );
  });

  it('the felt says paused, once, before the closed-table verdict can count it', () => {
    const effect = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf('if (engineLastError.code === 4404) {'),
      TABLE_PAGE.indexOf("heartbeatToastRef.current?.info?.('This Table Is No Longer Running');")
    );
    const paused = effect.indexOf(
      'if (isTournamentTablePausedClose(engineLastError.code, engineLastError.reason)) {'
    );
    const counted = effect.indexOf('notFoundCountRef.current += 1;');
    expect(paused).toBeGreaterThan(0);
    expect(counted).toBeGreaterThan(paused);
    expect(effect.slice(paused, counted)).toContain('notFoundCountRef.current = 0;');
    expect(effect.slice(paused, counted)).toContain('tablePausedToastShownRef.current = true;');
    expect(effect.slice(paused, counted)).toContain(
      "'This Table Is Paused. Your Seat And Stack Are Safe And The Floor Has Been Alerted'"
    );
    expect(effect.slice(paused, counted)).not.toContain('—');
    expect(TABLE_PAGE).toMatch(
      /if \(engineWsStatus === 'connected'\) \{\s*notFoundCountRef\.current = 0;\s*tableClosedToastShownRef\.current = false;\s*tablePausedToastShownRef\.current = false;/
    );
  });
});
