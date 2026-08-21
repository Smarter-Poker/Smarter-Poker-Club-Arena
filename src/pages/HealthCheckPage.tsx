/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HEALTH CHECK PAGE — System readiness endpoint for uptime monitoring
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lightweight page that pings Supabase and reports system status.
 * Use with external monitors (UptimeRobot, Pingdom, etc.) pointed at:
 *   https://smarter.poker/hub/club-arena/health
 *
 * Returns a simple JSON-like status visible in the DOM so headless monitors
 * can scrape it. No AuthGuard — must be publicly accessible.
 */

import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  supabase: 'ok' | 'error';
  latencyMs: number;
  timestamp: string;
  version: string;
}

export default function HealthCheckPage() {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const start = performance.now();

    (async () => {
      let supabaseStatus: 'ok' | 'error' = 'error';
      try {
        // Lightweight query: count 0 rows from a small table
        const { error } = await supabase
          .from('settlement_periods')
          .select('id', { count: 'exact', head: true })
          .limit(1);
        if (!error) supabaseStatus = 'ok';
      } catch (e) {
        reportError(e, 'HealthCheckPage.async');
        supabaseStatus = 'error';
      }

      if (cancelled) return;

      const latencyMs = Math.round(performance.now() - start);
      setHealth({
        status: supabaseStatus === 'ok' ? 'ok' : 'degraded',
        supabase: supabaseStatus,
        latencyMs,
        timestamp: new Date().toISOString(),
        version: import.meta.env.VITE_APP_VERSION || '1.0.0',
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!health) {
    return (
      <div
        style={{
          padding: 40,
          fontFamily: 'monospace',
          color: '#aaa',
          background: '#111',
          minHeight: '100vh',
        }}
      >
        <pre>{'{ "status": "checking..." }'}</pre>
      </div>
    );
  }

  const color =
    health.status === 'ok' ? '#31A24C' : health.status === 'degraded' ? '#F5A623' : '#FA383E';

  return (
    <div
      style={{
        padding: 40,
        fontFamily: 'monospace',
        color: '#ccc',
        background: '#111',
        minHeight: '100vh',
      }}
    >
      <h1 style={{ color, fontSize: '1.2rem', marginBottom: 16 }}>
        Smarter.Poker - {health.status.toUpperCase()}
      </h1>
      <pre id="health-json" data-status={health.status}>
        {JSON.stringify(health, null, 2)}
      </pre>
    </div>
  );
}
