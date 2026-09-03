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

import { useSystemHealth } from '../hooks/useSystemHealth';

export default function HealthCheckPage() {
  const { health } = useSystemHealth();

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
        <pre>{'{ "Status": "Checking..." }'}</pre>
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
      <pre
        id="health-json"
        data-status={health.status}
        style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', maxWidth: '100%' }}
      >
        {JSON.stringify(health, null, 2)}
      </pre>
    </div>
  );
}
