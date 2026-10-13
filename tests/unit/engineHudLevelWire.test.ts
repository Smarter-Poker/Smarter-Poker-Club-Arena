import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import type { Page } from '@playwright/test';
import { receivedHudLevel } from '../e2e/support/tournamentHudWitness';

import {
  observeEngineHudLevels,
  receivedEngineHudLevel,
  sharedNaturalEngineLevel,
  isScopedEngineTransport,
} from '../e2e/support/engineHudLevelWitness';

const tableId = 'dc198272-ac8c-4949-baf4-144189d93f29';
const tournamentId = 'a39a80c6-d038-4976-ba87-da88701a5eee';
const frame = {
  type: 'EVENT',
  tableId,
  seq: 901,
  payload: {
    type: 'level_up',
    table_id: tableId,
    tournament_id: tournamentId,
    new_level: 24,
    previous_level: 23,
    timestamp: 1791921973315,
  },
};

it('the production legacy parser cannot observe the actual serving event', () => {
  expect(receivedHudLevel(JSON.stringify(frame), 1791921973675)).toBeNull();
});

it('both physical spectator wire events qualify one matching natural level', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local fixture port');
  const url = `ws://127.0.0.1:${address.port}/ws/multi`;
  const clients: WebSocket[] = [];
  try {
    const make = async () => {
      const page = new EventEmitter();
      const levels = observeEngineHudLevels(
        page as unknown as Page,
        { tableId, tournamentId },
        `http://127.0.0.1:${address.port}/health`
      );
      const socket = new WebSocket(url);
      clients.push(socket);
      const browserSocket = new EventEmitter();
      Object.assign(browserSocket, { url: () => url });
      page.emit('websocket', browserSocket);
      socket.on('message', (data) =>
        browserSocket.emit('framereceived', { payload: data.toString() })
      );
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      return levels;
    };
    const primary = await make();
    const peer = await make();
    const delivered = [...clients].map(
      (socket) => new Promise<void>((resolve) => socket.once('message', () => resolve()))
    );
    for (const socket of server.clients) socket.send(JSON.stringify(frame));
    await Promise.all(delivered);
    expect(primary).toHaveLength(1);
    expect(peer).toHaveLength(1);
    expect(
      sharedNaturalEngineLevel(primary, peer, { tableId, tournamentId }, 23, 1791921779798)
        ?.levelIndex
    ).toBe(24);
  } finally {
    for (const socket of clients) socket.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('physical engine level admission boundaries', () => {
  const scope = { tableId, tournamentId };
  const at = 1791921973675;
  const since = 1791921779798;
  const parse = (value: unknown) => receivedEngineHudLevel(JSON.stringify(value), at, scope);
  it('retains zero-based units and matches the HUD numeric-string normalization', () => {
    expect(parse(frame)?.levelIndex).toBe(24);
    expect(parse({ ...frame, payload: { ...frame.payload, new_level: '24' } })?.levelIndex).toBe(
      24
    );
  });
  it.each([
    { ...frame, type: 'SNAPSHOT' },
    { ...frame, tableId: 'other' },
    { ...frame, payload: { ...frame.payload, table_id: 'other' } },
    { ...frame, payload: { ...frame.payload, tournament_id: 'other' } },
    { ...frame, replayed: true },
    { ...frame, payload: { ...frame.payload, replayed: true } },
    { ...frame, payload: { ...frame.payload, timestamp: null } },
    { ...frame, payload: { ...frame.payload, new_level: '' } },
    { ...frame, payload: { ...frame.payload, new_level: -1 } },
    { ...frame, payload: { ...frame.payload, new_level: 24.5 } },
  ])('refuses unrelated, replayed, or malformed physical frames %#', (invalid) => {
    expect(parse(invalid)).toBeNull();
  });
  it('requires both peers and refuses a delayed pre-baseline event', () => {
    const level = parse(frame)!;
    expect(sharedNaturalEngineLevel([level], [], scope, 23, since)).toBeUndefined();
    expect(
      sharedNaturalEngineLevel([level], [{ ...level, eventTimestamp: since }], scope, 23, since)
    ).toBeUndefined();
    expect(
      sharedNaturalEngineLevel([level], [{ ...level, at: since }], scope, 23, since)
    ).toBeUndefined();
    expect(
      sharedNaturalEngineLevel([level], [{ ...level, tableId: 'other' }], scope, 23, since)
    ).toBeUndefined();
  });
  it('requires the configured physical engine origin and exact table transport', () => {
    const health = 'https://engine.smarter.poker/health';
    expect(isScopedEngineTransport('wss://engine.smarter.poker/ws/multi', health, tableId)).toBe(
      true
    );
    expect(
      isScopedEngineTransport(`wss://engine.smarter.poker/ws/table/${tableId}`, health, tableId)
    ).toBe(true);
    for (const url of [
      'wss://other.example/ws/multi',
      'ws://engine.smarter.poker/ws/multi',
      'wss://engine.smarter.poker/realtime/v1',
      'wss://engine.smarter.poker/ws/table/other',
    ])
      expect(isScopedEngineTransport(url, health, tableId)).toBe(false);
  });
});
