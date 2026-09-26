/**
 * Tests for the telemetry handlers (Phase U3.5).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { handleHealth, handleWsMetrics, handleMetrics } from './health.js';
import { mockRes, parseJson } from './_testHelpers.js';
import type { HorseJournalHealth } from '../services/HorseDecisionJournal.js';

describe('handleHealth', () => {
  // 2026-09-26: the default journal source reports every state, including
  // `disabled` when no journal directory is configured, so a body read through
  // the default carries the section. The routing verdict never reads it.
  beforeEach(() => {
    vi.stubEnv('HORSE_DECISION_JOURNAL_DIR', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const withDisabledJournal = (status: Record<string, unknown>) => ({
    ...status,
    horseJournal: expect.objectContaining({ mode: 'disabled', lastFailureReason: null }),
  });
  function statusCodeFor(status: Record<string, unknown>): number {
    const { res, captured } = mockRes();
    const gameServer = {
      getStatus: vi.fn().mockReturnValue(status),
      getPrometheusMetrics: vi.fn().mockReturnValue(''),
    };
    handleHealth(res, { gameServer });
    expect(parseJson(captured)).toEqual(withDisabledJournal(status));
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
    expect(parseJson(captured)).toEqual(withDisabledJournal(status));
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

  it('rejects an invalid scope before rendering any fleet state', () => {
    const { res, captured } = mockRes();
    const gameServer = { getStatus: vi.fn(), getPrometheusMetrics: () => '' };
    handleHealth(res, { gameServer }, new URLSearchParams('liveness_format=mtt'));
    expect(captured.statusCode).toBe(400);
    expect(parseJson(captured)).toEqual({ error: 'invalid_liveness_scope' });
    expect(gameServer.getStatus).not.toHaveBeenCalled();
  });

  it('carries the Horse journal section without letting it move the routing verdict', () => {
    // 2026-09-21: a journal whose catalog filled stopped capturing with nothing
    // on /health to say so. The section is the publisher's cached view; the
    // handler never waits on the journal worker and a failed journal is a
    // diagnostics gap, not a reason to route traffic away from a dealer.
    const { res, captured } = mockRes();
    const status = {
      liveness: 'ok',
      status: 'ok',
      dealerPrerequisitesReady: true,
      liveHorseDecision: { phase: 'ready' },
    };
    const horseJournal: HorseJournalHealth = {
      mode: 'paused',
      lastFailureReason: null,
      pausedReason: 'archive_catalog_capacity',
      pausedSince: '2026-09-25T19:34:05.000Z',
      failedSince: null,
      queued: 16,
      appliedMaxCatalogBytes: 6 * 1024 * 1024 * 1024,
      maxCatalogBytes: 6 * 1024 * 1024 * 1024,
      catalogBytes: 6 * 1024 * 1024 * 1024,
      segments: 500_000,
      maxSegments: 500_000,
      publishedSegments: 499_999,
      pendingSegments: 1,
      retiredSegments: 0,
      retiredRecords: 0,
      compressedBytes: 6_476_021_020,
      maxBytes: 8 * 1024 * 1024 * 1024,
      records: 7_000_000,
      maxRecords: 8_000_000,
      maxRowid: 7_000_000,
      statsAgeMs: 900,
      reportAgeMs: 400,
      capture: 'not running: paused since 2026-09-25T19:34:05.000Z at archive_catalog_capacity',
    };
    const gameServer = {
      getStatus: vi.fn().mockReturnValue(status),
      getPrometheusMetrics: () => '',
    };
    const journal = vi.fn().mockReturnValue(horseJournal);
    handleHealth(res, { gameServer, horseJournal: journal });
    expect(journal).toHaveBeenCalledTimes(1);
    expect(captured.statusCode).toBe(200);
    expect(parseJson(captured)).toEqual({ ...status, horseJournal });
  });

  it('leaves the body untouched when the journal source answers null', () => {
    const { res, captured } = mockRes();
    const status = { liveness: 'standby', status: 'ok' };
    const gameServer = {
      getStatus: vi.fn().mockReturnValue(status),
      getPrometheusMetrics: () => '',
    };
    handleHealth(res, { gameServer, horseJournal: () => null });
    expect(captured.statusCode).toBe(503);
    expect(parseJson(captured)).toEqual(status);
    expect(parseJson(captured)).not.toHaveProperty('horseJournal');
  });

  it('requests the scoped table snapshot without weakening dealer routing readiness', () => {
    const { res, captured } = mockRes();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const status = { liveness: 'standby', tableLiveness: [] };
    const gameServer = {
      getStatus: vi.fn().mockReturnValue(status),
      getPrometheusMetrics: () => '',
    };
    handleHealth(res, { gameServer }, new URLSearchParams({ liveness_table_ids: id }));
    expect(gameServer.getStatus).toHaveBeenCalledTimes(1);
    expect(gameServer.getStatus).toHaveBeenCalledWith({ kind: 'tables', tableIds: [id] });
    expect(captured.statusCode).toBe(503);
    expect(parseJson(captured)).toEqual(withDisabledJournal(status));
  });
});

describe('handleWsMetrics', () => {
  it('returns 200 with transport counters and the mux breakdown', () => {
    const { res, captured } = mockRes();
    const tableStateHub = { totalSubscribers: vi.fn().mockReturnValue(12) };
    const engineWs = {
      connectionCount: vi.fn().mockReturnValue(7),
      connectionAccessStats: () => ({
        completed: 6,
        failed: 1,
        pending: 2,
        oldestPendingMs: 120,
        maxDurationMs: 1500,
        over1200Ms: 1,
      }),
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
      connectionAccess: {
        completed: 6,
        failed: 1,
        pending: 2,
        oldestPendingMs: 120,
        maxDurationMs: 1500,
        over1200Ms: 1,
      },
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
      connectionAccess: null,
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
