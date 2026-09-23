/**
 * A NEW TABLE IS WAKING, NOT GONE - AND A REFUSED VIEWER IS NOT RECONNECTING
 * (Create A Club Phase 2, 2026-09-20).
 *
 * Owner report: after creating a cash table the host sometimes immediately
 * sees "This Table Is No Longer Running" or an endless "Reconnecting To The
 * Table". Three transport causes, each pinned here:
 *
 *   C  a 4404 sent EVERY client to the ~30s end of the ladder, including one
 *      that had never connected - the host of a table the engine is still
 *      building on first demand. Never-connected clients now get a few fast
 *      attempts first; clients that have connected are untouched.
 *   B  three 4404s produced the closed-table toast without anyone asking the
 *      `tables` row. The rule the row is judged by is the engine's own
 *      (server/src/services/onDemandTableWake.ts), mirrored and pinned equal;
 *      a wakeable row gets a prompt reconnect through reconnectNow() - its
 *      own verb since 2026-09-22, so requestSnapshot() is the purchase resync
 *      it always was and never opens a socket.
 *   D  the engine's access verdicts (CLUB_MEMBERSHIP_REQUIRED,
 *      OBSERVERS_RESTRICTED) rode the generic ladder. They now end in
 *      'access_refused' with no timer armed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isWakeableCashTable } from '../server/src/services/onDemandTableWake';
import { sliceBlockAfter } from './helpers/sourceWindow';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  constructor(
    public url: string,
    public protocols?: string | string[]
  ) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  _open() {
    this.readyState = 1;
    this.onopen?.();
  }
  _frame(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const TABLE = 'bbbbbbbb-2222-4222-8222-222222222222';
const live = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
/** Every SUBSCRIBE for the table, on every physical socket: one per attempt. */
const subscribes = () =>
  FakeWebSocket.instances
    .flatMap((ws) => ws.sent)
    .map((s) => JSON.parse(s) as { type?: string; tableId?: string })
    .filter((m) => m.type === 'SUBSCRIBE' && m.tableId === TABLE).length;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** The server pings every 25s; without it the mux rightly replaces a silent socket. */
async function tickWithPings(ms: number) {
  for (let done = 0; done < ms; done += 5_000) {
    if (live().readyState === 1) live()._frame({ type: 'PING', ts: Date.now() });
    await tick(Math.min(5_000, ms - done));
  }
}

let mod: typeof import('../src/services/EngineStateClient');

beforeEach(async () => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
  // No jitter: the ladder's steps are then exact and the pins can be too.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  // The mux is a module singleton that lingers its socket; see the note in
  // tests/engine-state-client-recovery.test.ts.
  vi.resetModules();
  mod = await import('../src/services/EngineStateClient');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const statuses: string[] = [];
  const errors: Array<{ code?: number; reason?: string }> = [];
  const c = new mod.EngineStateClient({
    baseUrl: 'https://engine.example',
    tableId: TABLE,
    getToken: async () => 'tok',
    onSnapshot: () => undefined,
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
  });
  return { c, statuses, errors };
}

/** Connect and open the PHYSICAL socket; the table's facade is still unanswered. */
async function connectUnanswered() {
  const made = client();
  void made.c.connect();
  await tick(0);
  live()._open();
  await tick(0);
  expect(subscribes()).toBe(1);
  return made;
}
const refuse = async (code: string) => {
  live()._frame({ type: 'ERROR', tableId: TABLE, code, message: 'refused' });
  await tick(0);
};

describe('C - a client that has never connected retries a 4404 on the fast end', () => {
  it('1s, 2s, 2s - then falls into the slow ladder it always had', async () => {
    const { c, statuses, errors } = await connectUnanswered();
    try {
      expect(mod.NEVER_CONNECTED_FAST_NOT_FOUND_RETRIES).toBe(3);

      await refuse('TABLE_NOT_FOUND');
      expect(errors.at(-1)?.code).toBe(4404);
      await tick(999);
      expect(subscribes()).toBe(1);
      await tick(1);
      expect(subscribes()).toBe(2);

      await refuse('TABLE_NOT_FOUND');
      await tick(1_999);
      expect(subscribes()).toBe(2);
      await tick(1);
      expect(subscribes()).toBe(3);

      await refuse('TABLE_NOT_FOUND');
      await tick(1_999);
      expect(subscribes()).toBe(3);
      await tick(1);
      expect(subscribes()).toBe(4);

      // The fourth 4404: the fast allowance is spent. Today's ~30s step.
      await refuse('TABLE_NOT_FOUND');
      await tickWithPings(25_000);
      expect(subscribes()).toBe(4);
      await tickWithPings(5_000);
      expect(subscribes()).toBe(5);

      // A missing table is never announced as a lost connection.
      expect(statuses).toContain('idle');
      expect(statuses).not.toContain('reconnecting');
      expect(statuses).not.toContain('failed');
    } finally {
      c.disconnect();
    }
  });

  it('a table that wakes on the second try is connected about a second after the first 4404', async () => {
    const { c, statuses } = await connectUnanswered();
    try {
      await refuse('TABLE_NOT_FOUND');
      await tick(1_000);
      expect(subscribes()).toBe(2);
      live()._frame({ type: 'SUBSCRIBED', tableId: TABLE });
      await tick(0);
      expect(statuses.at(-1)).toBe('connected');
    } finally {
      c.disconnect();
    }
  });

  it('a client that HAS connected keeps the slow ladder, exactly as before', async () => {
    const { c } = await connectUnanswered();
    try {
      live()._frame({ type: 'SUBSCRIBED', tableId: TABLE });
      await tick(0);
      await refuse('TABLE_NOT_FOUND');
      await tickWithPings(25_000);
      expect(subscribes()).toBe(1);
      await tickWithPings(5_000);
      expect(subscribes()).toBe(2);
    } finally {
      c.disconnect();
    }
  });
});

describe('B - a wakeable row earns a prompt reconnect, not an obituary', () => {
  it('reconnectNow() cuts a pending missing-table wait short, once, and keeps the ladder slow', async () => {
    const { c } = await connectUnanswered();
    try {
      live()._frame({ type: 'SUBSCRIBED', tableId: TABLE });
      await tick(0);
      await refuse('TABLE_NOT_FOUND'); // slow ladder: next attempt ~30s away
      await tick(2_000);
      expect(subscribes()).toBe(1);

      c.reconnectNow();
      await tick(0);
      expect(subscribes()).toBe(2);

      // No pending wait now: a second call cannot start a second attempt.
      c.reconnectNow();
      await tick(0);
      expect(subscribes()).toBe(2);

      // Still 4404: the ladder resumes at its slow step, not a fast loop.
      await refuse('TABLE_NOT_FOUND');
      await tickWithPings(25_000);
      expect(subscribes()).toBe(2);
      await tickWithPings(5_000);
      expect(subscribes()).toBe(3);
    } finally {
      c.disconnect();
    }
  });

  it('requestSnapshot() is the purchase resync again: it never opens a socket for a missing table', async () => {
    const { c } = await connectUnanswered();
    try {
      live()._frame({ type: 'SUBSCRIBED', tableId: TABLE });
      await tick(0);
      await refuse('TABLE_NOT_FOUND');
      await tick(2_000);

      // TablePage calls this after a confirmed buy-in. With the table missing
      // there is no socket to resync on, and that is all it may conclude.
      c.requestSnapshot();
      await tick(0);
      expect(subscribes()).toBe(1);

      // The slow step it was on still stands, untouched.
      await tickWithPings(25_000);
      expect(subscribes()).toBe(1);
      await tickWithPings(5_000);
      expect(subscribes()).toBe(2);
    } finally {
      c.disconnect();
    }
  });

  it('reconnectNow() only shortens a wait: a live socket, a verdict and a closed client are left alone', async () => {
    // A live table: nothing is waiting, so nothing is started.
    const first = await connectUnanswered();
    try {
      live()._frame({ type: 'SUBSCRIBED', tableId: TABLE });
      await tick(0);
      const sockets = FakeWebSocket.instances.length;
      first.c.reconnectNow();
      await tick(0);
      expect(subscribes()).toBe(1);
      expect(FakeWebSocket.instances).toHaveLength(sockets);
      expect(first.statuses.at(-1)).toBe('connected');

      // A closed client: the owner has moved on.
      first.c.disconnect();
      first.c.reconnectNow();
      await tickWithPings(60_000);
      expect(subscribes()).toBe(1);
    } finally {
      // Always, or a failure here leaves 'online' listeners for the next test.
      first.c.disconnect();
    }
  });

  it('reconnectNow() does not retry an access verdict', async () => {
    const { c, statuses } = await connectUnanswered();
    try {
      await refuse('CLUB_MEMBERSHIP_REQUIRED');
      c.reconnectNow();
      await tickWithPings(60_000);
      expect(subscribes()).toBe(1);
      expect(statuses.at(-1)).toBe('access_refused');
    } finally {
      c.disconnect();
    }
  });

  it("the client's wake rule is the engine's wake rule, row for row", () => {
    const rows = [
      null,
      {},
      { status: 'waiting' },
      { status: 'running', game_type: 'cash' },
      { status: 'ACTIVE', game_type: 'Cash', is_deleted: false, tournament_id: null },
      { status: 'waiting', is_deleted: true },
      { status: 'waiting', tournament_id: 'tour-1' },
      { status: 'closed' },
      { status: 'deleted' },
      { status: 'finished' },
      { status: null },
      { status: 'waiting', game_type: 'tournament' },
      { status: 'waiting', game_type: 'sng' },
      { status: 'waiting', game_type: null },
    ];
    for (const row of rows) {
      expect(mod.isStillWakeableTableRow(row), JSON.stringify(row)).toBe(isWakeableCashTable(row));
    }
    expect(mod.isStillWakeableTableRow({ status: 'waiting', game_type: 'cash' })).toBe(true);
    expect(mod.isStillWakeableTableRow({ status: 'closed', game_type: 'cash' })).toBe(false);
    expect(mod.isStillWakeableTableRow(null)).toBe(false);
    expect(mod.isStillWakeableTableRow(undefined)).toBe(false);
  });

  it('TablePage asks the row before the toast, reports a failed read, and keeps the break check first', () => {
    const page = readFileSync(join(__dirname, '..', 'src/pages/TablePage.tsx'), 'utf8');
    // The 4404 branch of the effect, bounded by its own braces (see
    // tests/helpers/sourceWindow.ts: a window is a structure, never a guess).
    const effect = sliceBlockAfter(page, 'if (engineLastError.code === 4404) {');

    const breakCheck = effect.indexOf('await refreshMaintenanceBreak()');
    const rowRead = effect.indexOf(".from('tables')");
    const verdict = effect.indexOf('isStillWakeableTableRow(tableRow)');
    const toast = effect.indexOf("info?.('This Table Is No Longer Running')");
    expect(breakCheck).toBeGreaterThan(-1);
    expect(rowRead).toBeGreaterThan(breakCheck);
    expect(verdict).toBeGreaterThan(rowRead);
    expect(toast).toBeGreaterThan(verdict);
    // Exactly one obituary, and it is the last thing the branch can do.
    expect(effect.match(/This Table Is No Longer Running'\)/g)).toHaveLength(1);

    // The read: the wake rule's four columns, error bound and reported, maybeSingle.
    expect(effect).toMatch(
      /const \{ data: tableRow, error: tableRowError \} = await supabase\s*\.from\('tables'\)\s*\.select\('id, tournament_id, status, game_type, is_deleted'\)\s*\.eq\('id', askedFor\)\s*\.maybeSingle\(\)/
    );
    expect(effect).not.toMatch(/\.single\(\)/);
    expect(effect).toContain("reportError(tableRowError, 'TablePage.not_found_row_check')");

    // A wakeable row: no toast, counter reset, slot released, prompt reconnect.
    const wakeable = effect.slice(verdict, toast);
    expect(wakeable).toContain('notFoundCountRef.current = 0;');
    expect(wakeable).toContain('tableClosedToastShownRef.current = false;');
    expect(wakeable).toContain('reconnectEngineNow();');
    expect(wakeable).not.toContain('requestEngineSnapshot(');
    expect(wakeable).toContain('return;');
    // And the verb comes from the hook, under its own name.
    expect(page).toMatch(/reconnectNow: reconnectEngineNow,\s*\} = useEngineTableState\(/);

    // A failed read falls through to the toast: today's behaviour.
    const failed = effect.slice(effect.indexOf('if (tableRowError)'), verdict);
    expect(failed).not.toContain('return');
  });
});

describe('D - an access verdict ends in access_refused, and nothing retries it', () => {
  it.each(['CLUB_MEMBERSHIP_REQUIRED', 'OBSERVERS_RESTRICTED'] as const)(
    '%s: terminal status, the code kept, no reconnect scheduled',
    async (code) => {
      const { c, statuses, errors } = await connectUnanswered();
      try {
        const sockets = FakeWebSocket.instances.length;
        await refuse(code);

        expect(statuses.at(-1)).toBe('access_refused');
        expect(c.getAccessRefusal()).toBe(code);
        expect(errors.at(-1)).toEqual({ code: 4400, reason: `subscription refused: ${code}` });
        expect(mod.accessRefusalFromClose(errors.at(-1)?.code, errors.at(-1)?.reason)).toBe(code);

        await tickWithPings(10 * 60_000);
        expect(subscribes()).toBe(1);
        expect(FakeWebSocket.instances).toHaveLength(sockets);
        expect(statuses.at(-1)).toBe('access_refused');
        expect(statuses).not.toContain('reconnecting');
        expect(statuses).not.toContain('failed');
      } finally {
        c.disconnect();
      }
    }
  );

  it('coming back online asks exactly once, silently, and an admission clears the verdict', async () => {
    const { c, statuses } = await connectUnanswered();
    try {
      await refuse('CLUB_MEMBERSHIP_REQUIRED');
      statuses.length = 0;

      window.dispatchEvent(new Event('online'));
      await tick(0);
      expect(subscribes()).toBe(2);
      // The verdict stands until there is an answer: no "Connecting" flash.
      expect(statuses).toEqual([]);

      await refuse('CLUB_MEMBERSHIP_REQUIRED');
      await tickWithPings(60_000);
      expect(subscribes()).toBe(2);
      expect(statuses).toEqual([]);

      window.dispatchEvent(new Event('online'));
      await tick(0);
      live()._frame({ type: 'SUBSCRIBED', tableId: TABLE });
      await tick(0);
      expect(statuses.at(-1)).toBe('connected');
      expect(c.getAccessRefusal()).toBeNull();
    } finally {
      c.disconnect();
    }
  });

  it('every other 4400 refusal keeps the ladder it had', async () => {
    const { c, statuses } = await connectUnanswered();
    try {
      await refuse('SUB_FAILED');
      expect(statuses.at(-1)).toBe('reconnecting');
      expect(c.getAccessRefusal()).toBeNull();
      await tick(1_000);
      expect(subscribes()).toBe(2);
    } finally {
      c.disconnect();
    }
  });

  it('only the two access codes, only on 4400, only behind the mux prefix', () => {
    const f = mod.accessRefusalFromClose;
    expect(f(4400, 'subscription refused: CLUB_MEMBERSHIP_REQUIRED')).toBe(
      'CLUB_MEMBERSHIP_REQUIRED'
    );
    expect(f(4400, 'subscription refused: OBSERVERS_RESTRICTED')).toBe('OBSERVERS_RESTRICTED');
    expect(f(4400, 'subscription refused: SUB_FAILED')).toBeNull();
    expect(f(4400, 'subscription refused: unknown')).toBeNull();
    expect(f(4404, 'subscription refused: CLUB_MEMBERSHIP_REQUIRED')).toBeNull();
    expect(f(4403, 'subscription refused: BANNED')).toBeNull();
    expect(f(4400, 'CLUB_MEMBERSHIP_REQUIRED')).toBeNull();
    expect(f(1006, undefined)).toBeNull();
    expect(f(undefined, undefined)).toBeNull();
  });
});
