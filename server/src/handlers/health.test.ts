/**
 * Tests for the telemetry handlers (Phase U3.5).
 */

import { describe, it, expect, vi } from 'vitest';
import { handleHealth, handleWsMetrics, handleMetrics } from './health.js';
import { mockRes, parseJson } from './_testHelpers.js';

describe('handleHealth', () => {
  it('returns 200 with gameServer.getStatus() payload', () => {
    const { res, captured } = mockRes();
    const status = { running: true, uptime: 42 };
    const gameServer = {
      getStatus: vi.fn().mockReturnValue(status),
      getPrometheusMetrics: vi.fn().mockReturnValue(''),
    };
    handleHealth(res, { gameServer });
    expect(captured.statusCode).toBe(200);
    expect(parseJson(captured)).toEqual(status);
    expect(captured.headers?.['Content-Type']).toBe('application/json');
  });
});

describe('handleWsMetrics', () => {
  it('returns 200 with transport counters', () => {
    const { res, captured } = mockRes();
    const tableStateHub = { totalSubscribers: vi.fn().mockReturnValue(12) };
    const engineWs = { connectionCount: vi.fn().mockReturnValue(7) };
    handleWsMetrics(res, { tableStateHub, engineWs });
    expect(captured.statusCode).toBe(200);
    expect(parseJson(captured)).toEqual({ totalSubscribers: 12, activeConnections: 7 });
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
