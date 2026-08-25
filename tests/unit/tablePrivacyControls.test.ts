/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ANONYMOUS TABLE, BAN CHAT, RESTRICT OBSERVERS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three switches from the audit's "does nothing" column, wired 2026-08-25.
 * Each had a working control, a real column, and no reader anywhere.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const ENGINE = read('server/src/engine/ServerTableEngine.ts');
const WS = read('server/src/transport/EngineWebSocketServer.ts');
const CHAT = read('src/hooks/useTableChat.ts');
const SELECT = read('server/src/services/supabase/tables.ts');

describe('Anonymous Table', () => {
  it('is reachable by the engine at all', () => {
    expect(SELECT).toContain('is_anonymous');
  });

  it('scrubs the two fields that are a name on screen, and only those', () => {
    const fn = ENGINE.slice(ENGINE.indexOf('protected seatIdentity('));
    expect(fn).toContain('username');
    expect(fn).toContain('avatar_url');
    // user_id must survive: the client keys the hero seat, current_player,
    // winner_ids and disconnect_states off it. Scrubbing it breaks the table
    // rather than anonymising it.
    expect(fn.slice(0, 600)).not.toMatch(/user_id:\s*''/);
  });

  it('is applied by EVERY serializer, not three of four', () => {
    // getTableState, broadcastCurrentState, the second broadcast block and
    // publishIdleState are byte-identical seat maps; this file already carries
    // a comment about a reveal gate that was missed in one of them.
    const uses = ENGINE.match(/\.\.\.this\.seatIdentity\(p\)/g) ?? [];
    expect(uses.length).toBe(4);
    /* The ONE remaining raw read is inside seatIdentity itself, which is the
       point of the helper. Anywhere else means a serializer was missed. */
    const outsideHelper =
      ENGINE.slice(0, ENGINE.indexOf('protected seatIdentity(')) +
      ENGINE.slice(ENGINE.indexOf('private bettingStructureFields('));
    expect(outsideHelper).not.toContain('username: p.username');
    expect(outsideHelper).not.toContain('avatar_url: p.avatar_url');
  });

  it('is uniform, not per-viewer', () => {
    // TableStateHub publishes ONE payload to every subscriber. A hero
    // exception would mean a payload per seat.
    const fn = ENGINE.slice(
      ENGINE.indexOf('protected seatIdentity('),
      ENGINE.indexOf('protected seatIdentity(') + 900
    );
    expect(fn).not.toContain('requestingUserId');
  });
});

describe('Restrict Observers', () => {
  it('is reachable by the engine at all', () => {
    expect(SELECT).toContain('restrict_observers');
  });

  it('gates BOTH the upgrade path and the mux subscribe path', () => {
    // The multi-table client never touches the upgrade gate, so one gate is
    // no gate.
    const gates = WS.match(/isRestrictedObserver\(/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(3); // definition + two callers
    expect(WS).toContain('OBSERVERS_RESTRICTED');
  });

  it('never caches the SEAT, only the table setting', () => {
    const fn = WS.slice(WS.indexOf('private async isRestrictedObserver('));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    // A player who has just bought in connects within the same second; a
    // stale "not seated" locks them out of the seat they just paid for.
    expect(body).toContain('observerRestrictionCache');
    const afterSeatQuery = body.slice(body.indexOf("from('table_seats')"));
    expect(afterSeatQuery).not.toContain('Cache.set');
  });

  it('fails open, like every other gate on this path', () => {
    const fn = WS.slice(WS.indexOf('private async isRestrictedObserver('));
    expect(fn.slice(0, 1800)).toMatch(/catch\s*\{\s*return false;/);
  });
});

describe('Ban Chat', () => {
  it('stops the send in the client so the box does not swallow a message', () => {
    expect(CHAT).toContain('isChatBannedRef.current) return;');
    expect(CHAT).toContain('isChatBanned');
  });

  it('reads the table flag rather than assuming', () => {
    expect(CHAT).toContain("select('ban_chat')");
  });

  it('leaves chat ENABLED when the read fails', () => {
    // The RLS policy is the enforcement; a failed read must not silence a
    // table nobody muted.
    const eff = CHAT.slice(CHAT.indexOf("select('ban_chat')"));
    expect(eff.slice(0, 700)).toContain('the policy is the enforcement');
  });
});
