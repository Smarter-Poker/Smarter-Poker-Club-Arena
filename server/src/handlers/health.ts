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
  const status = deps.gameServer.getStatus() as {
    liveness?: string;
    status?: string;
    dealerPrerequisitesReady?: boolean;
    liveHorseDecision?: { phase?: string };
  };
  /**
   * ONLY A DEALER-READY LEADER ANSWERS 200 (2026-09-08).
   *
   * Caddy uses this HTTP code to choose the process that receives table and
   * socket traffic. The listener opens before leadership, worker hydration and
   * table discovery complete. Advertising 200 during that interval routed a
   * browser to a leader whose SUBSCRIBE was waiting on the unpublished dealer
   * gate, so the browser's handshake expired and displayed a reconnect loop.
   *
   * Docker reads the JSON body rather than the HTTP code and deliberately
   * keeps a standby alive. Its separate 300-second startup grace also keeps a
   * hydrating leader alive. This code therefore expresses routing readiness,
   * while `liveness` remains the process-survival verdict.
   *
   * The body is unchanged either way, so anything reading the payload (the
   * deploy verifier, /metrics scrapers, an operator) sees the same fields.
   */
  const dealerReady =
    status?.liveness === 'ok' &&
    status?.status === 'ok' &&
    status?.dealerPrerequisitesReady === true &&
    status?.liveHorseDecision?.phase === 'ready';
  sendJSON(res, dealerReady ? 200 : 503, status);
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
    /* Drop any family the always-on text already carries (2026-09-09). Some
       instruments moved to `alwaysOnRegistry` because an alert reads them,
       and the default registry still declares its own of the same name -
       emitting both would give Prometheus one metric name with two HELP/TYPE
       headers, which it rejects for the whole scrape. */
    const already = new Set(
      body
        .split('\n')
        .filter((l) => l.startsWith('# TYPE '))
        .map((l) => l.split(' ')[2])
    );
    const gated = metricsRegistry
      .renderPrometheus()
      .split('\n')
      .reduce<{ out: string[]; skip: boolean }>(
        (acc, line) => {
          if (line.startsWith('# HELP ') || line.startsWith('# TYPE ')) {
            acc.skip = already.has(line.split(' ')[2]);
          } else if (line && !line.startsWith('#')) {
            const name = line.split(/[{ ]/)[0];
            if (already.has(name)) acc.skip = true;
          }
          if (!acc.skip) acc.out.push(line);
          return acc;
        },
        { out: [], skip: false }
      ).out;
    body += '\n' + gated.join('\n');
  }
  // Note: original index.ts does NOT attach CORS_HEADERS to /metrics — keep it
  // that way for byte-identical behavior. Prometheus scrapers don't need CORS.
  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
  });
  res.end(body);
}
