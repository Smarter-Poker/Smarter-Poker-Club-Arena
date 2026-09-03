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
  tableStateHub: {
    totalSubscribers(): number;
    /** Optional — B12 backpressure counters. Climbing softDropped = clients
     *  cannot keep up; any hardDropped = a socket was evicted mid-session. */
    backpressureStats?(): { softDropped: number; hardDropped: number };
  };
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
  /**
   * 2026-08-24: the /ws/channel side — wallet FINANCIAL_UPDATEs, tournament
   * events, club events, lobby updates. This transport was completely
   * invisible in metrics, which is how "the server kills every channel
   * socket at 60s" (see ChannelWebSocketServer heartbeat fix) ran in
   * production with nothing measuring it. channelSockets counts live
   * sockets (a user with 2 tabs counts 2); channelUsers counts distinct
   * users; a healthy platform shows sockets >= users.
   */
  channelHub?: {
    connectionCount(): number;
    userCount(): number;
    lobbySubscriberCount(): number;
  };
}

/** `GET /health` and `GET /` — Hetzner VPS health probe + SHA/status report. */
export function handleHealth(res: ServerResponse, deps: HealthDeps): void {
  const status = deps.gameServer.getStatus() as { liveness?: string };
  /**
   * A STANDBY ANSWERS 503, ON PURPOSE (2026-08-23).
   *
   * Two different consumers read this endpoint and need different answers:
   *
   *   Caddy   an active health check expects 2xx. 503 marks this upstream
   *           down, so every request goes to the leader. That is the whole
   *           failover mechanism -- no routing table, no proxy.
   *   Docker  the container HEALTHCHECK exits non-zero only when liveness is
   *           'dead'. 'standby' is not 'dead', so the container stays healthy
   *           and alive, which it must be in order to take over.
   *
   * The body is unchanged either way, so anything reading the payload (the
   * deploy verifier, /metrics scrapers, an operator) sees the same fields.
   */
  sendJSON(res, status?.liveness === 'standby' ? 503 : 200, status);
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
  const backpressure = deps.tableStateHub.backpressureStats?.() ?? {
    softDropped: 0,
    hardDropped: 0,
  };
  sendJSON(res, 200, {
    totalSubscribers: deps.tableStateHub.totalSubscribers(),
    activeConnections: deps.engineWs.connectionCount(),
    ...mux,
    ...backpressure,
    // 2026-08-24: channel transport visibility — see WsMetricsDeps.channelHub.
    channelSockets: deps.channelHub?.connectionCount() ?? 0,
    channelUsers: deps.channelHub?.userCount() ?? 0,
    lobbySubscribers: deps.channelHub?.lobbySubscriberCount() ?? 0,
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
