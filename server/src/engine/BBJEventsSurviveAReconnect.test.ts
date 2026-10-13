/**
 * THE JACKPOT EVENTS SURVIVE A RECONNECT
 * ═══════════════════════════════════════════════════════════════════════════
 * BBJ build plan phase 1, 2026-09-05.
 *
 * The hub keeps an EVENT only if it declares its own expiry (`replay_until`,
 * D3 in TableStateHub). `bbj_hit` and `bbj_payout_complete` declared nothing,
 * so a player whose socket was between reconnects for the one second either
 * went out - a train, a backgrounded phone, the reconnect ladder itself -
 * never received them and never could: the hand names the celebration is
 * built from and the trigger for the celebration were each a single
 * un-replayed packet. The biggest moment on the platform, missed permanently
 * by exactly the players least able to say why.
 *
 * These pins read the settlement source: all three jackpot events carry a
 * replay_until inside the hub's 60-second ceiling, and the hub honours it.
 */
import { describe, it, expect, vi } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TableStateHub } from '../transport/TableStateHub.js';

const here = dirname(fileURLToPath(import.meta.url));
const settlement = readFileSync(resolve(here, 'ServerTableEngineSettlement.ts'), 'utf8');
const settlementAst = ts.createSourceFile(
  'settlement.ts',
  settlement,
  ts.ScriptTarget.Latest,
  true
);

/** Read each actual event object, including announcements emitted through a variable. */
function eventBlocks(type: string): string[] {
  const blocks: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(settlementAst) === 'type' &&
          ts.isStringLiteral(property.initializer) &&
          property.initializer.text === type
      )
    )
      blocks.push(node.getText(settlementAst));
    ts.forEachChild(node, visit);
  }
  visit(settlementAst);
  expect(blocks.length, `${type} is emitted`).toBeGreaterThan(0);
  return blocks;
}

/** The emit block for one event type, from `type: '<name>'` to its closing `});`. */
function emitBlock(type: string): string {
  const at = settlement.indexOf(`type: '${type}'`);
  expect(at, `${type} is emitted`).toBeGreaterThan(0);
  const end = settlement.indexOf('});', at);
  return settlement.slice(at, end);
}

describe('every jackpot event asks the hub to keep it', () => {
  it.each(['bbj_hit', 'bbj_payout_complete', 'bbj_hit_global'])(
    '%s carries replay_until',
    (type) => {
      for (const block of eventBlocks(type)) {
        if (/asset:\s*'diamonds'/.test(block)) {
          expect(settlement).toMatch(/const emittedAt = Date\.now\(\);/);
          expect(block).toMatch(/emitted_at:\s*emittedAt/);
          expect(block).toMatch(/replay_until:\s*emittedAt\s*\+\s*60_000/);
        } else {
          expect(block).toMatch(/replay_until:\s*Date\.now\(\)\s*\+\s*60_000/);
        }
      }
    }
  );

  it('the near-miss toast does NOT ask to be retained - it is a teaching moment, not a payout', () => {
    expect(emitBlock('bbj_near_miss')).not.toMatch(/replay_until/);
    /* Settlement emits bbj_near_miss TWICE since phase 3 - main and mini - and
       `emitBlock` takes the first. Neither may be replayed: a near miss is a
       teaching banner for the hand in front of you, not a thing to re-show on
       reconnect. */
    const emits = [...settlement.matchAll(/type: 'bbj_near_miss'/g)].map((m) => m.index ?? 0);
    expect(emits.length, 'main and mini both emit').toBeGreaterThanOrEqual(2);
    for (const at of emits) {
      expect(settlement.slice(at, settlement.indexOf('});', at))).not.toMatch(/replay_until/);
    }
  });
});

describe('the hub replays a retained jackpot event to a socket that connects afterwards', () => {
  function socket() {
    const sent: string[] = [];
    return {
      id: Math.random().toString(36).slice(2),
      readyState: 1,
      send: (d: string) => {
        sent.push(d);
      },
      sent,
    };
  }

  it('delivers bbj_payout_complete to a late subscriber, marked replayed, once', () => {
    const hub = new TableStateHub();
    const tableId = 'table-1';
    const early = socket();
    hub.subscribe(tableId, early);
    hub.emitEvent(tableId, {
      type: 'bbj_payout_complete',
      table_id: tableId,
      hand_number: 42,
      emitted_at: Date.now(),
      replay_until: Date.now() + 60_000,
      totalPayout: 100,
    });
    const late = socket();
    hub.subscribe(tableId, late);
    const replayed = late.sent
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === 'EVENT' && m.payload?.type === 'bbj_payout_complete');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].payload.replayed).toBe(true);
    // The subscriber that got it live is not handed it again on a resync.
    hub.resync(tableId, early);
    const earlyCopies = early.sent
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === 'EVENT' && m.payload?.type === 'bbj_payout_complete');
    expect(earlyCopies).toHaveLength(1);
  });

  it('an event past its own deadline is not replayed', () => {
    const hub = new TableStateHub();
    const tableId = 'table-2';
    hub.emitEvent(tableId, {
      type: 'bbj_hit',
      replay_until: Date.now() - 1,
    });
    const late = socket();
    hub.subscribe(tableId, late);
    expect(late.sent.filter((m) => JSON.parse(m).type === 'EVENT')).toHaveLength(0);
  });

  it.each(['bbj_hit', 'bbj_payout_complete', 'bbj_hit_global'])(
    'retains Diamond %s until its captured-clock deadline',
    (type) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        const emittedAt = Date.now();
        const hub = new TableStateHub();
        hub.emitEvent('diamond-table', {
          type,
          asset: 'diamonds',
          emitted_at: emittedAt,
          replay_until: emittedAt + 60_000,
        });
        vi.setSystemTime(emittedAt + 59_000);
        const late = socket();
        hub.subscribe('diamond-table', late);
        const events = late.sent
          .map((message) => JSON.parse(message))
          .filter((message) => message.type === 'EVENT' && message.payload?.type === type);
        expect(events).toHaveLength(1);
        expect(events[0].payload.emitted_at).toBe(emittedAt);
        expect(events[0].payload.replay_until).toBe(emittedAt + 60_000);
        expect(events[0].payload.replayed).toBe(true);
        vi.setSystemTime(emittedAt + 60_001);
        const expired = socket();
        hub.subscribe('diamond-table', expired);
        expect(
          expired.sent
            .map((message) => JSON.parse(message))
            .filter((message) => message.type === 'EVENT')
        ).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
