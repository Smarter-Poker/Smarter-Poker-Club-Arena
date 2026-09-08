/**
 * Tests for the telemetry handlers (Phase U3.5).
 */

import { describe, it, expect, vi } from 'vitest';
import { handleHealth, handleWsMetrics, handleMetrics } from './health.js';
import { mockRes, parseJson } from './_testHelpers.js';

describe('handleHealth', () => {
  function statusCodeFor(status: Record<string, unknown>): number {
    const { res, captured } = mockRes();
    const gameServer = {
      getStatus: vi.fn().mockReturnValue(status),
      getPrometheusMetrics: vi.fn().mockReturnValue(''),
    };
    handleHealth(res, { gameServer });
    expect(parseJson(captured)).toEqual(status);
    return captured.statusCode ?? 0;
  }

  it('returns 200 only for a dealer-ready leader with its worker ready', () => {
    const { res, captured } = mockRes();
    const status = {
      running: true,
      uptime: 42,
      liveness: 'ok',
      status: 'ok',
      dealerPrerequisitesReady: true,
      liveHorseDecision: { phase: 'ready' },
    };
    const gameServer = {
      getStatus: vi.fn().mockReturnValue(status),
      getPrometheusMetrics: vi.fn().mockReturnValue(''),
    };
    handleHealth(res, { gameServer });
    expect(captured.statusCode).toBe(200);
    expect(parseJson(captured)).toEqual(status);
    expect(captured.headers?.['Content-Type']).toBe('application/json');
  });

  it('keeps Caddy off booting, workerless, standby and dead processes', () => {
    const ready = {
      liveness: 'ok',
      status: 'ok',
      dealerPrerequisitesReady: true,
      liveHorseDecision: { phase: 'ready' },
    };
    expect(statusCodeFor({ ...ready, dealerPrerequisitesReady: false })).toBe(503);
    expect(statusCodeFor({ ...ready, liveHorseDecision: { phase: 'starting' } })).toBe(503);
    expect(statusCodeFor({ ...ready, liveness: 'standby' })).toBe(503);
    expect(statusCodeFor({ ...ready, liveness: 'dead' })).toBe(503);
  });
});

describe('handleWsMetrics', () => {
  it('returns 200 with transport counters and the mux breakdown', () => {
    const { res, captured } = mockRes();
    const tableStateHub = { totalSubscribers: vi.fn().mockReturnValue(12) };
    const engineWs = {
      connectionCount: vi.fn().mockReturnValue(7),
      muxStats: vi.fn().mockReturnValue({
        muxSockets: 2,
        singleSockets: 5,
        muxSubscriptions: 6,
        maxSubsOnOneSocket: 4,
      }),
    };
    // 2026-08-24: channel transport + backpressure counters are new — the
    // wallet/tournament/club/lobby socket had zero metrics visibility, which
    // is how the 60s heartbeat kill loop ran unmeasured in production.
    (tableStateHub as Record<string, unknown>).backpressureStats = vi
      .fn()
      .mockReturnValue({ softDropped: 9, hardDropped: 1 });
    const channelHub = {
      connectionCount: vi.fn().mockReturnValue(3),
      userCount: vi.fn().mockReturnValue(2),
      lobbySubscriberCount: vi.fn().mockReturnValue(1),
    };
    handleWsMetrics(res, { tableStateHub, engineWs, channelHub });
    expect(captured.statusCode).toBe(200);
    // 2026-08-23: the mux fields are new. The two original counters cannot
    // tell a client holding four per-table sockets from one holding a single
    // mux socket with four subscriptions, which is the only thing the
    // ca_ws_mux beta changes -- so the beta could never be soaked on evidence.
    expect(parseJson(captured)).toEqual({
      totalSubscribers: 12,
      activeConnections: 7,
      muxSockets: 2,
      singleSockets: 5,
      muxSubscriptions: 6,
      maxSubsOnOneSocket: 4,
      softDropped: 9,
      hardDropped: 1,
      channelSockets: 3,
      channelUsers: 2,
      lobbySubscribers: 1,
    });
  });

  it('still answers when the transport has no muxStats at all', () => {
    // WsMetricsDeps keeps muxStats optional so the structural typing stays
    // minimal, per this handler's design note. A transport without it must
    // report zeroes, never crash the endpoint Prometheus scrapes.
    const { res, captured } = mockRes();
    const tableStateHub = { totalSubscribers: vi.fn().mockReturnValue(1) };
    const engineWs = { connectionCount: vi.fn().mockReturnValue(1) };
    handleWsMetrics(res, { tableStateHub, engineWs });
    expect(captured.statusCode).toBe(200);
    expect(parseJson(captured)).toEqual({
      totalSubscribers: 1,
      activeConnections: 1,
      muxSockets: 0,
      singleSockets: 0,
      muxSubscriptions: 0,
      maxSubsOnOneSocket: 0,
      softDropped: 0,
      hardDropped: 0,
      channelSockets: 0,
      channelUsers: 0,
      lobbySubscribers: 0,
    });
  });
});

describe('handleMetrics', () => {
  it('returns 200 with Prometheus text content-type (NO CORS headers)', () => {
    const { res, captured } = mockRes();
    const body = '# HELP poker_engine_hand_tick_duration_seconds ...';
    const gameServer = {
      getStatus: vi.fn(),
      getPrometheusMetrics: vi.fn().mockReturnValue(body),
    };
    handleMetrics(res, { gameServer });
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toBe(body);
    // Bible V8 §10.4 — Prometheus exposition format, no CORS.
    expect(captured.headers?.['Content-Type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(captured.headers).not.toHaveProperty('Access-Control-Allow-Origin');
  });
});
