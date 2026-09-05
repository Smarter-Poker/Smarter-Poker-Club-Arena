# smarter.poker monitoring stack — Phase 5.1.3 / 5.1.3a

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
- `slo-rules.yml` / `slo-alerts.yml` — Phase 5.1.5 SLO recording rules + burn alerts
- `Caddyfile` — TLS + basic-auth reverse proxy at monitor.smarter.poker (Phase 5.1.3a)
- `deploy.sh` — one-shot idempotent deploy script (Phase 5.1.3a)
- `.env.example` — template for secrets (Grafana admin pw, Slack webhook,
  PagerDuty service key)
- `grafana-provisioning/` — auto-registers the Prometheus datasource and
  mounts the `grafana-dashboards/` folder as a dashboard provider
- `grafana-dashboards/` — four seed dashboards (engine, postgres, cron, slo)

## First deploy on cron-01 (Phase 5.1.3a — one-shot)

```bash
# as root on cron-01 — single pipe'd install
curl -fsSL https://raw.githubusercontent.com/Smarter-Poker/Smarter-Poker-Club-Arena/main/infra/monitoring/deploy.sh | sudo bash
```

The script will:

1. Verify docker / docker compose / git / caddy are installed
2. Clone (or fast-forward) the club-arena + world-hub repos under `/opt/`
3. Symlink stack config into `/opt/smarter-poker-monitoring/`
4. Copy the Caddyfile to `/etc/caddy/Caddyfile` (backing up any existing)
5. Seed `.env` from `.env.example` on first run (edit after)
6. `docker compose up -d` and run health checks

After first run, you still need two manual touches:

- Edit `/opt/smarter-poker-monitoring/.env` with real credentials
- Generate a basic-auth hash (`caddy hash-password --plaintext 'pw'`) and replace
  the two `REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT` placeholders in
  `/etc/caddy/Caddyfile`, then `systemctl reload caddy`

Re-running `deploy.sh` is safe and will pick up any repo updates without
clobbering those local edits.

## Manual deploy (historic — use deploy.sh instead)

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

## Secret files (not in git, and the stack will not start without them)

`docker-compose.yml` bind-mounts these by path. Docker's behaviour when a
bind-mount source is missing is to silently create a **directory** at that path,
so the container starts and then fails to read its own credentials — or refuses
to start at all — with an error that does not mention the real problem. On a
rebuilt host, create them before `docker compose up`:

| file         | what it is                                                                                                                           | how to create                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `resend_key` | Resend SMTP API key, read by Alertmanager via `smtp_auth_password_file`. Without it every alert is generated and then fails to send. | `printf '%s' "$RESEND_API_KEY" > resend_key && chmod 600 resend_key` (see `resend_key.example`) |
| `.env`       | Grafana admin password and friends                                                                                                   | `cp .env.example .env && $EDITOR .env`                                                          |

There is no newline in `resend_key` on purpose — Alertmanager sends the file
contents verbatim as the SMTP password, and a trailing newline fails auth.

## The 3am pager (2026-09-04)

Six alerts carry the label `page: sms` (pinned by
`tests/the-pager-list-is-exactly-six.test.ts`). Alertmanager posts them to
`https://smarter.poker/api/internal/alertmanager-page`, which texts the phone
`deploy-monitor.js` already pages. Everything else goes to email only.

The receiver authenticates with the World Hub `CRON_SECRET`, read from
**`cron_secret`** beside this README - a plain file, mode 600, no trailing
newline, mounted read-only into the Alertmanager container next to
`resend_key`. It is gitignored; `cron_secret.example` is the placeholder.
`deploy.sh` refuses to run if it is missing or empty, because a pager that
silently fails every notification is worse than none. On a rebuilt host, write
it BEFORE `docker compose up` or Docker will create a directory at that path
and Alertmanager will fail without naming the cause.

Route: `page="sms"` -> `pager-sms` with `continue: true`, `repeat_interval 4h`.
