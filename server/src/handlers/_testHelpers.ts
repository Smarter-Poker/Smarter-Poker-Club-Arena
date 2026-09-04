/**
 * Shared test utilities for handler tests (Phase U3.5).
 *
 * Underscore prefix keeps this file out of vitest's `*.test.ts` include glob —
 * it's a support module, not a test file.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { vi } from 'vitest';

/** Capture of a `res.writeHead` + `res.end` pair. */
export interface Captured {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  ended: boolean;
}

/** Build a ServerResponse mock that records whatever the handler writes. */
export function mockRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { ended: false };
  const res = {
    writeHead(statusCode: number, headers?: Record<string, string>) {
      captured.statusCode = statusCode;
      captured.headers = headers ?? {};
      return this;
    },
    end(body?: string) {
      captured.body = body;
      captured.ended = true;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

/** Build an IncomingMessage mock with headers + streamed body. */
export function mockReq(
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): IncomingMessage {
  const { method = 'POST', url = '/', headers = {}, body = '' } = opts;
  const listeners: Record<string, Array<(arg: unknown) => void>> = {};
  const req = {
    method,
    url,
    headers,
    on(event: string, cb: (arg: unknown) => void) {
      (listeners[event] ||= []).push(cb);
      return this;
    },
    destroy() {
      /* no-op */
    },
  } as unknown as IncomingMessage;
  // Queue a microtask to fire 'data' + 'end' the way readBody expects.
  queueMicrotask(() => {
    if (body) listeners.data?.forEach((cb) => cb(Buffer.from(body)));
    listeners.end?.forEach((cb) => cb(undefined));
  });
  return req;
}

/** Parse captured JSON body (for handlers that use sendJSON). */
export function parseJson(captured: Captured): unknown {
  if (captured.body === undefined) return undefined;
  return JSON.parse(captured.body);
}

/** Build a fake engine implementing any subset of ServerTableEngine methods. */
export function mockEngine(overrides: Record<string, unknown> = {}): unknown {
  return {
    // Common methods — overridden as needed per handler test.
    handlePlayerAction: vi.fn().mockReturnValue({ success: true }),
    recordActionPerformance: vi.fn(),
    activateTimeBank: vi.fn().mockReturnValue({ success: true }),
    heartbeat: vi.fn().mockReturnValue({ ok: true }),
    setPreAction: vi.fn().mockReturnValue({ success: true }),
    addChips: vi.fn().mockReturnValue({ success: true }),
    leaveTable: vi.fn().mockReturnValue({ success: true }),
    sitOut: vi.fn().mockReturnValue({ success: true }),
    toggleStraddle: vi.fn().mockReturnValue({ success: true }),
    respondToRIT: vi.fn().mockReturnValue({ success: true }),
    respondToInsurance: vi.fn().mockReturnValue({ success: true }),
    previewInsurance: vi.fn().mockReturnValue({ cost: 100 }),
    showHand: vi.fn().mockReturnValue({ success: true }),
    submitDiscard: vi.fn().mockReturnValue({ success: true }),
    adminPause: vi.fn().mockReturnValue({ paused: true }),
    adminResume: vi.fn().mockReturnValue({ resumed: true }),
    postBBToEnter: vi.fn().mockReturnValue({ posted: true }),
    getPlayerActions: vi.fn().mockReturnValue({ canAct: true, actions: [] }),
    getTableState: vi.fn().mockReturnValue({ table_id: 't1', stage: 'preflop', players: [] }),
    ...overrides,
  };
}

/**
 * Build a fake gameServer.getTableEngine map. Returns `any` so the stub
 * satisfies every handler's narrow structural `*Deps.gameServer` shape
 * without per-test casts. Only used in tests — production `createRouter`
 * ties to the real (typed) `GameServer` class.
 */

export function mockGameServer(engine: unknown, tableId = 't1'): any {
  return {
    getTableEngine(id: string) {
      return id === tableId ? engine : undefined;
    },
  };
}
