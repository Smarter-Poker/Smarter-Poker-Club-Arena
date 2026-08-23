/**
 * Read-only telemetry handlers — `GET /health`, `GET /`, `GET /metrics`, `GET /ws-metrics`.
 *
 * Extracted from `server/src/index.ts` in Phase U3.1 (2026-04-23) as the first
 * three routes of the index-monolith split. Byte-identical responses preserved.
 *
 * These handlers do not mutate engine state. They are safe to call at any time
 * and are the scraper targets for Prometheus + Hetzner uptime monitoring.
 */

import type { ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
// ── ADDITIVE (#5): shared engine metrics registry — appended to /metrics ONLY when
// ENGINE_METRICS === 'on'. With the flag unset the response is byte-identical to before.
import { metricsRegistry, ENGINE_METRICS_ENABLED } from '../observability/engineInstruments.js';

// Minimal structural typing so handlers don't need to import the GameServer
// class (which lives in `index.ts`) nor the transport classes. Anything that
// exposes the right methods satisfies the shape.

export interface HealthDeps {
  gameServer: { getStatus(): unknown; getPrometheusMetrics(): string };
}

export interface WsMetricsDeps {
  tableStateHub: { totalSubscribers(): number };
  engineWs: {
    connectionCount(): number;
    /** Optional so the structural typing above stays minimal, per this file's
     *  design note — a transport without it simply reports zeroes. */
    muxStats?(): {
      muxSockets: number;
      singleSockets: number;
      muxSubscriptions: number;
      maxSubsOnOneSocket: number;
    };
  };
}

/** `GET /health` and `GET /` — Hetzner VPS health probe + SHA/status report. */
export function handleHealth(res: ServerResponse, deps: HealthDeps): void {
  sendJSON(res, 200, deps.gameServer.getStatus());
}

/**
 * `GET /ws-metrics` — Phase 1.1 PR-2 observability.
 *
 * Public endpoint (no auth). Exposes counts only, no payloads. Used by
 * Prometheus + Grafana to track the authoritative WebSocket transport.
 */
export function handleWsMetrics(res: ServerResponse, deps: WsMetricsDeps): void {
  // 2026-08-23: the mux breakdown. Without it these two numbers cannot tell a
  // client holding four per-table sockets from one holding a single mux socket
  // with four subscriptions, which is the only thing the ca_ws_mux beta
  // changes — so the beta could never be soaked on evidence.
  const mux = deps.engineWs.muxStats?.() ?? {
    muxSockets: 0,
    singleSockets: 0,
    muxSubscriptions: 0,
    maxSubsOnOneSocket: 0,
  };
  sendJSON(res, 200, {
    totalSubscribers: deps.tableStateHub.totalSubscribers(),
    activeConnections: deps.engineWs.connectionCount(),
    ...mux,
  });
}

/**
 * `GET /metrics` — Bible V8 §10.4: Prometheus text exposition format.
 *
 * Scraped by Prometheus → Grafana dashboards for engine observability.
 * NOT JSON — emits text/plain with the Prometheus exposition content-type.
 */
export function handleMetrics(res: ServerResponse, deps: HealthDeps): void {
  let body = deps.gameServer.getPrometheusMetrics();
  // ADDITIVE (#5): when ENGINE_METRICS is enabled, append the shared engine
  // registry's exposition text. Default OFF keeps the response byte-for-byte
  // identical to the pre-wiring behavior.
  if (ENGINE_METRICS_ENABLED) {
    body += '\n' + metricsRegistry.renderPrometheus();
  }
  // Note: original index.ts does NOT attach CORS_HEADERS to /metrics — keep it
  // that way for byte-identical behavior. Prometheus scrapers don't need CORS.
  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
  });
  res.end(body);
}
