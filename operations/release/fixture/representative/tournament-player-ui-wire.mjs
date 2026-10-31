import assert from 'node:assert/strict';
import { patched } from './tournament-wire.mjs';

// Observe the actual playing browser's sockets. No second playing transport,
// injected frame, private-card archive or client-state mutation is created.
export function collectPlayerUIWire(page, userId) {
  const tables = new Map(),
    events = [],
    sockets = new Set();
  let failure;
  function receive(raw) {
    assert.ok(typeof raw === 'string' && Buffer.byteLength(raw) <= 2 * 1024 * 1024);
    const m = JSON.parse(raw),
      at = Date.now();
    if (!m.tableId) return; // Supabase and control frames are not engine evidence.
    assert.notEqual(m.type, 'ERROR', 'PLAYER_UI_ENGINE_ERROR');
    const table = tables.get(m.tableId) ?? { generation: 0, sequence: null, state: null };
    if (m.type === 'SNAPSHOT') {
      assert.ok(Number.isSafeInteger(m.seq) && m.seq >= 0);
      if (table.sequence === null) table.generation++;
      else {
        assert.ok(m.seq >= table.sequence);
        if (m.seq === table.sequence) assert.deepEqual(m.state, table.state);
      }
      table.state = structuredClone(m.state);
      table.sequence = m.seq;
      tables.set(m.tableId, table);
    } else if (m.type === 'DELTA') {
      assert.ok(table.state && m.prev === table.sequence && m.seq === table.sequence + 1);
      table.state = patched(table.state, m.patch);
      table.sequence = m.seq;
    } else if (m.type === 'USER_EVENT' && m.payload?.kind === 'pre_action') {
      const p = m.payload;
      events.push({
        tableId: m.tableId,
        user_id: userId,
        generation: table.generation,
        receivedAt: at,
        kind: p.kind,
        action: p.action,
        hand_number: p.hand_number,
        to_call_at_set: p.to_call_at_set,
        reason: p.reason ?? null,
      });
    } else if (m.type === 'EVENT' && m.payload?.type === 'player_action') {
      const p = m.payload;
      events.push({
        tableId: m.tableId,
        user_id: p.user_id,
        generation: table.generation,
        receivedAt: at,
        hand_number: p.hand_number,
        action: p.action,
        amount: p.amount,
        seat: p.seat,
        stage: p.stage,
        replayed: p.replayed === true,
      });
    }
    assert.ok(events.length <= 4096, 'PLAYER_UI_WIRE_EVENT_CAP');
  }
  const attach = (socket) => {
    if (!/\/ws\/(?:multi|table\/)/.test(new URL(socket.url()).pathname)) return;
    const frame = (event) => {
      try {
        receive(event.payload);
      } catch {
        failure ??= new Error('PLAYER_UI_WIRE_REFUSED');
      }
    };
    const close = () => {
      for (const table of tables.values()) {
        table.sequence = null;
        table.state = null;
      }
    };
    socket.on('framereceived', frame);
    socket.on('close', close);
    sockets.add({ socket, frame, close });
  };
  page.on('websocket', attach);
  const selected = ({ tableId, userId: actor, handNumber, since }) => {
    if (failure) throw failure;
    const table = tables.get(tableId);
    assert.ok(table?.state, 'PLAYER_UI_NO_CURRENT_WIRE');
    return events.filter(
      (e) =>
        e.tableId === tableId &&
        e.user_id === actor &&
        e.hand_number === handNumber &&
        e.receivedAt >= since &&
        e.generation === table.generation
    );
  };
  return {
    readActions({ tableId, handNumber }) {
      if (failure) throw failure;
      const table = tables.get(tableId);
      assert.ok(table?.state, 'PLAYER_UI_NO_CURRENT_WIRE');
      return events.filter(
        (e) =>
          e.kind === undefined &&
          e.tableId === tableId &&
          e.hand_number === handNumber &&
          e.generation === table.generation
      );
    },
    readArm: (_journal, key) => {
      const arms = selected(key).filter(
        (e) => e.kind === 'pre_action' && e.action !== null && e.reason !== 'resync'
      );
      assert.ok(arms.length <= 1, 'PLAYER_UI_DUPLICATE_ARM');
      return arms[0];
    },
    readCalls: (_journal, key) =>
      selected(key).filter((e) => e.action === 'call' && e.kind === undefined),
    state(tableId) {
      if (failure) throw failure;
      return tables.get(tableId)?.state ?? null;
    },
    close() {
      page.off('websocket', attach);
      for (const { socket, frame, close } of sockets) {
        socket.off('framereceived', frame);
        socket.off('close', close);
      }
      tables.clear();
      events.length = 0;
    },
  };
}
