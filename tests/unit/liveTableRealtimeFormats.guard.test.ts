import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EngineSocketJournal } from '../e2e/support/liveTableRealtime';

vi.mock('@playwright/test', () => ({ expect: {} }));

const root = resolve(__dirname, '../..');
const spec = readFileSync(join(root, 'tests/e2e/production-live-table-realtime.spec.ts'), 'utf8');
const server = readFileSync(join(root, 'server/src/GameServer.ts'), 'utf8');

describe('the production realtime certificate covers every live-game lane', () => {
  it('runs MTT, Spin and Sit & Go through the same read-only WebKit contract', () => {
    expect(spec).toContain("const TOURNAMENT_FORMATS = ['mtt', 'spin', 'sng'] as const");
    expect(spec).toContain('certifyReadOnlyTournamentFormat(page, request, testInfo, gameFormat)');
    expect(spec).toContain('selectProgressingTournamentTable(request, gameFormat)');
    expect(spec).toContain('journal.waitForCausalHandCycle(');
    expect(spec).toContain('expectNextHandPresentation(page, cycle');
    expect(spec).toContain('whileConnectionBannerStaysHidden(');
    const tournamentHelper = spec.slice(
      spec.indexOf('async function certifyReadOnlyTournamentFormat('),
      spec.indexOf("test.describe('production mobile WebKit live-table realtime continuity'")
    );
    expect(tournamentHelper).toContain('await context.setOffline(true)');
    expect(tournamentHelper).toContain('await context.setOffline(false)');
    expect(tournamentHelper).toContain('did not resubscribe after network restoration');
    expect(tournamentHelper).toContain('did not recover exactly one multiplexed transport');
  });

  it('observes tournament routes directly and refuses participation mutations', () => {
    expect(spec).toContain('page.goto(`table/${candidate.id}`');
    expect(spec).toContain('isSpectatorParticipationMutation(');
    expect(spec).toContain("type: 'ACTION'");
    expect(spec).toContain('participationMutations,');
    expect(spec).toContain(').toEqual([]);');
  });

  it('gets only a public format category from engine health', () => {
    expect(server).toContain('gameFormat:');
    expect(server).toContain('tournamentDescriptorByTableId.get(id)');
    expect(server).toContain('manager.getPublicLiveTableFormat()');
    expect(spec).toContain('table.clubId === CLUB_ID');
  });
});

class ObservedSocket extends EventEmitter {
  closed = false;
  constructor(private readonly address = 'wss://engine.example/ws/multi?pv=4') {
    super();
  }
  url() {
    return this.address;
  }
  isClosed() {
    return this.closed;
  }
}

function observedJournal() {
  const page = new EventEmitter();
  const journal = new EngineSocketJournal(page as never);
  const socket = new ObservedSocket('wss://engine.example/ws/multi?untrusted=test_url_secret');
  page.emit('websocket', socket);
  return { page, journal, socket };
}

const observedTable = '7d5e73d1-6a8f-4ef1-8ac5-46dc50e15f70';

describe('the existing live-table report retains bounded private-safe connection facts', () => {
  it('retains global refusals and subscribe/snapshot identity without secrets or state payloads', () => {
    const { journal, socket } = observedJournal();
    socket.emit('framesent', {
      payload: JSON.stringify({ type: 'SUBSCRIBE', tableId: observedTable }),
    });
    socket.emit('framereceived', {
      payload: JSON.stringify({
        type: 'ERROR',
        code: 'ACCESS_CHECK_FAILED',
        message: 'test_private_error',
        token: 'test_token_secret',
      }),
    });
    socket.emit('framereceived', {
      payload: JSON.stringify({ type: 'SUBSCRIBED', tableId: observedTable }),
    });
    socket.emit('framereceived', {
      payload: Buffer.from(
        JSON.stringify({
          type: 'SNAPSHOT',
          tableId: observedTable,
          payload: { player: 'test_player_secret', hand: 'test_hand_secret' },
        })
      ),
    });
    socket.emit('socketerror', 'test_socket_secret');
    socket.closed = true;
    socket.emit('close');
    const report = journal.summary(observedTable);
    const diagnostic = report.connectionDiagnostics as any;
    expect(diagnostic.sockets[0]).toMatchObject({
      path: '/ws/multi',
      authPresent: null,
      authObservation: 'subprotocol-not-exposed-by-playwright',
      socketErrorObserved: true,
    });
    expect(diagnostic.sockets[0].socketObservedAt).toEqual(expect.any(Number));
    expect(diagnostic.sockets[0].socketErrorAt).toEqual(expect.any(Number));
    expect(diagnostic.sockets[0].closedAt).toEqual(expect.any(Number));
    expect(
      diagnostic.frames.map((frame: any) => [
        frame.direction,
        frame.type,
        frame.tableId,
        frame.code,
      ])
    ).toEqual([
      ['sent', 'SUBSCRIBE', observedTable, undefined],
      ['received', 'ERROR', null, 'ACCESS_CHECK_FAILED'],
      ['received', 'SUBSCRIBED', observedTable, undefined],
      ['received', 'SNAPSHOT', observedTable, undefined],
    ]);
    expect(diagnostic.frames.every((frame: any) => Number.isFinite(frame.at))).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/test_(?:url|private|token|player|hand|socket)/);
    // Reporting does not rewrite the frames used by the original assertions.
    expect(journal.matchingFrames({ tableId: observedTable, type: 'SNAPSHOT' })).toHaveLength(1);
    expect(journal.matchingFrames({ type: 'ERROR' })[0].message.message).toBe('test_private_error');
  });

  it('refuses arbitrary diagnostic types/codes/identities and ignores the unrelated channel socket', () => {
    const { page, journal, socket } = observedJournal();
    page.emit('websocket', new ObservedSocket('wss://engine.example/ws/channel'));
    socket.emit('framereceived', {
      payload: JSON.stringify({ type: ['ERROR'], code: 'test_array_secret' }),
    });
    socket.emit('framereceived', {
      payload: JSON.stringify({
        type: 'ERROR',
        code: 'test_code_secret',
        tableId: 'test_identity_secret',
      }),
    });
    socket.emit('framereceived', { payload: 'not JSON: test_parse_secret' });
    const diagnostic = journal.summary(observedTable).connectionDiagnostics as any;
    expect(diagnostic.sockets).toHaveLength(1);
    expect(diagnostic.frames).toEqual([
      {
        at: expect.any(Number),
        direction: 'received',
        socketId: 1,
        type: 'ERROR',
        tableId: null,
        code: 'UNKNOWN',
      },
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain('test_');
  });

  it('caps exported socket/control/table histories while leaving assertion input complete', () => {
    const { page, journal, socket } = observedJournal();
    for (let i = 0; i < 18; i++) page.emit('websocket', new ObservedSocket());
    for (let i = 0; i < 140; i++)
      socket.emit('framereceived', {
        payload: JSON.stringify({ type: 'SNAPSHOT', tableId: observedTable }),
      });
    const report = journal.summary(observedTable);
    const diagnostic = report.connectionDiagnostics as any;
    expect(diagnostic.sockets).toHaveLength(16);
    expect(diagnostic.frames).toHaveLength(128);
    expect(diagnostic.omittedSockets).toBe(3);
    expect(diagnostic.omittedFrames).toBe(12);
    expect(report.sockets).toHaveLength(16);
    expect(report.received).toHaveLength(128);
    expect(report.omitted).toEqual({ sockets: 3, sent: 0, received: 12 });
    expect(journal.matchingFrames({ tableId: observedTable, type: 'SNAPSHOT' })).toHaveLength(140);
  });
});
