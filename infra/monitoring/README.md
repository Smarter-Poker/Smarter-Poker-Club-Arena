# smarter.poker monitoring stack — Phase 5.1.3

Prometheus + AlertManager + Grafana, containerised for deployment to the
Hetzner `cron-01` host. Scrapes `engine-01` (poker engine pm2 + node_exporter),
cron-01 itself, and Supabase (via postgres_exporter sidecar). Alerts route
through PagerDuty (critical) and Slack (warning/info).

## Files

- `docker-compose.yml` — the full stack, bound to 127.0.0.1 so only Caddy can
  reach it (Caddy provides TLS + basic-auth at `monitor.smarter.poker`)
- `prometheus.yml` — scrape config
- `alert-rules.yml` — 16 alert rules across engine, cron, database, Vercel,
  and host-level concerns
- `alertmanager.yml` — routing tree + PagerDuty inhibit rules
- `.env.example` — template for secrets (Grafana admin pw, Slack webhook,
  PagerDuty service key)
- `grafana-provisioning/` — auto-registers the Prometheus datasource and
  mounts the `grafana-dashboards/` folder as a dashboard provider
- `grafana-dashboards/` — three seed dashboards (engine, postgres, cron)

## First deploy on cron-01

```bash
# as root on cron-01
git clone https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git \
  /opt/smarter-poker-monitoring-src
cd /opt/smarter-poker-monitoring-src/infra/monitoring
cp .env.example .env
$EDITOR .env                                # fill in secrets

# Engine must also install node_exporter + pm2-metrics — see ENGINE-SETUP.md
docker compose up -d

# Sanity
docker compose ps
curl -s http://localhost:9090/-/ready       # Prometheus
curl -s http://localhost:3001/api/health    # Grafana
curl -s http://localhost:9093/-/ready       # AlertManager
```

## Engine-side setup (engine-01)

Install `node_exporter` (system) and the `pm2-metrics` pm2 module so the
stack has something to scrape. Detailed steps in `ENGINE-SETUP.md`; short
version:

```bash
# on engine-01
apt-get install -y prometheus-node-exporter   # binds :9100
pm2 install @pm2/io                            # enables pm2 metrics
# then add to the pm2 app file:
#   tracing: { enabled: true }, io: true
# and expose :9256 via:
pm2 set pm2-metrics:http-port 9256
pm2 restart all --update-env
```

Custom engine metrics (`poker_engine_hands_played_total`, `active_tables`,
`seated_players`) are exposed by a Prometheus client already wired in
`CA/src/engine/metrics.js` — verify with `curl localhost:9256/metrics`.

## Adding a new alert

1. Edit `alert-rules.yml`, add a rule to the appropriate group.
2. `docker compose exec prometheus kill -HUP 1` — Prometheus hot-reloads.
3. Visit `https://monitor.smarter.poker/prometheus/alerts` to confirm.

## Silencing during deploys

```bash
amtool --alertmanager.url=http://localhost:9093 silence add \
  'alertname=~".*"' component=engine \
  --duration=15m --comment "deploy $(git rev-parse --short HEAD)"
```

Our deploy script (`club-arena/deploy-production.sh`) should call this
before starting the engine restart to avoid paging oncall on the 30s
`up == 0` window.

## Retention

Prometheus keeps 15 days locally in the `prometheus-data` volume. If we ever
need long-term metrics for capacity planning, point a Thanos sidecar at the
same volume and ship to R2 — don't increase local retention, disk I/O on
cron-01 is more valuable for other cron work.
