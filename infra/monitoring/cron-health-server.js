#!/usr/bin/env node
/**
 * cron-01 health server — Phase 5.1.4
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Runs as a tiny Node HTTP server on cron-01:4002. Systemd keeps it up.
 * Prometheus blackbox_exporter hits GET /health every 60s to verify the
 * cron host is alive and to read the last-run timestamp for each timer.
 *
 * Response shape (master plan §8.1.4):
 *   {
 *     status: 'ok' | 'degraded',
 *     version: '<git sha>',
 *     uptime: <seconds>,
 *     timerLastRun: {
 *       'hard-stop.timer': { lastRunUnix: 1745109600, ageSec: 42 },
 *       'scheduled-table-opener.timer': { ... },
 *       ...
 *     }
 *   }
 *
 * We read systemd timer state via `systemctl show <unit> -p LastTriggerUSec`
 * so there's no need to wire the individual cron scripts to report back.
 * If `systemctl` isn't available (e.g. local smoke test) we fall back to
 * a stubbed response so the endpoint still returns 200.
 *
 * Deploy as /opt/cron-health/cron-health-server.js and wire with:
 *   [Unit]
 *   Description=cron-01 health endpoint (smarter.poker)
 *   After=network.target
 *
 *   [Service]
 *   ExecStart=/usr/bin/node /opt/cron-health/cron-health-server.js
 *   Restart=always
 *   User=smarter-poker
 *
 *   [Install]
 *   WantedBy=multi-user.target
 * ═══════════════════════════════════════════════════════════════════════════
 */

const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const PORT = Number(process.env.CRON_HEALTH_PORT || 4002);
const START_TIME = Date.now();
const VERSION = process.env.GIT_COMMIT_SHA?.substring(0, 8) || 'local';

// Timer units we track. Add to this list when we wire new Hetzner cron jobs.
const TRACKED_TIMERS = [
    'hard-stop.timer',
    'scheduled-table-opener.timer',
    'nightly-ledger-reconciliation.timer',
    'venue-review-prompts.timer',
    'anti-collusion-scan.timer',
];

async function getTimerLastRun(unit) {
    try {
        const { stdout } = await execFileP('systemctl', [
            'show',
            unit,
            '-p', 'LastTriggerUSec',
            '-p', 'NextElapseUSecRealtime',
        ], { timeout: 2000 });
        // systemctl output:  LastTriggerUSec=Sun 2026-04-20 05:00:01 UTC
        const lastLine = stdout.split('\n').find(l => l.startsWith('LastTriggerUSec='));
        if (!lastLine) return { status: 'unknown' };
        const dateStr = lastLine.replace('LastTriggerUSec=', '').trim();
        if (!dateStr || dateStr === 'n/a') return { status: 'never-run' };
        const lastRunMs = Date.parse(dateStr);
        if (isNaN(lastRunMs)) return { status: 'parse-error', raw: dateStr };
        return {
            status: 'ok',
            lastRunUnix: Math.floor(lastRunMs / 1000),
            ageSec: Math.floor((Date.now() - lastRunMs) / 1000),
        };
    } catch (err) {
        return { status: 'error', error: err?.message || 'systemctl failed' };
    }
}

async function buildHealth() {
    const results = await Promise.all(
        TRACKED_TIMERS.map(async (unit) => [unit, await getTimerLastRun(unit)])
    );
    const timerLastRun = Object.fromEntries(results);

    // Top-level status is 'degraded' if any tracked timer is in an error
    // state (can't be read, parse error) — not based on staleness, since
    // freshness thresholds are enforced by Prometheus alert rules, not here.
    const anyErrored = Object.values(timerLastRun).some(
        (r) => r.status === 'error' || r.status === 'parse-error'
    );

    return {
        status: anyErrored ? 'degraded' : 'ok',
        service: 'cron-01',
        version: VERSION,
        uptime: Math.floor((Date.now() - START_TIME) / 1000),
        timestamp: new Date().toISOString(),
        timerLastRun,
    };
}

const server = http.createServer(async (req, res) => {
    // Only serve /health and /metrics; anything else gets a plain 404 so we
    // don't expose a surface for casual probing.
    if (req.url === '/health' || req.url === '/') {
        try {
            const payload = await buildHealth();
            res.writeHead(payload.status === 'ok' ? 200 : 503, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify(payload));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error: e.message }));
        }
        return;
    }

    if (req.url === '/metrics') {
        // Prometheus text-format exposition of timer lag metrics.
        // Scraped via scrape_config job `cron_timers` (add to prometheus.yml).
        try {
            const h = await buildHealth();
            const lines = [
                '# HELP cron_last_run_timestamp UNIX time of last timer fire',
                '# TYPE cron_last_run_timestamp gauge',
            ];
            for (const [unit, info] of Object.entries(h.timerLastRun)) {
                if (info.lastRunUnix != null) {
                    lines.push(`cron_last_run_timestamp{job_name="${unit}"} ${info.lastRunUnix}`);
                }
            }
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
            res.end(lines.join('\n') + '\n');
        } catch (e) {
            res.writeHead(500);
            res.end(`# error ${e.message}\n`);
        }
        return;
    }

    res.writeHead(404);
    res.end('not found\n');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[cron-health] listening on 127.0.0.1:${PORT}`);
});

// Graceful shutdown — systemd sends SIGTERM, don't leave sockets half-open.
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
        console.log(`[cron-health] ${sig} received, shutting down`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    });
}
