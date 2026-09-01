import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isWakeableCashTable } from './services/onDemandTableWake.js';

describe('new cash table engine wake policy', () => {
  it.each(['waiting', 'running', 'active'])('admits a live %s cash table', (status) => {
    expect(
      isWakeableCashTable({
        tournament_id: null,
        status,
        game_type: 'cash',
        is_deleted: false,
      })
    ).toBe(true);
  });

  it('rejects closed, deleted, tournament, and non-cash rows', () => {
    expect(isWakeableCashTable(null)).toBe(false);
    expect(isWakeableCashTable({ status: 'closed', game_type: 'cash' })).toBe(false);
    expect(isWakeableCashTable({ status: 'waiting', game_type: 'cash', is_deleted: true })).toBe(
      false
    );
    expect(
      isWakeableCashTable({
        status: 'waiting',
        game_type: 'cash',
        tournament_id: '11111111-1111-4111-8111-111111111111',
      })
    ).toBe(false);
    expect(isWakeableCashTable({ status: 'waiting', game_type: 'tournament' })).toBe(false);
  });

  it('is wired from production bootstrap into both WebSocket admission paths', () => {
    const root = path.resolve(import.meta.dirname);
    const bootstrap = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');
    const transport = fs.readFileSync(
      path.join(root, 'transport', 'EngineWebSocketServer.ts'),
      'utf8'
    );

    expect(bootstrap).toContain(
      'ensureTable: (tableId) => gameServer.ensureCashTableEngine(tableId)'
    );
    expect(transport.match(/await this\.ensureTable\(tableId\)/g)).toHaveLength(2);
  });
});
