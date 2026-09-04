> **SUPERSEDED 2026-09-04. The config files that sat beside this README have
> been deleted; this page is kept as history.**
>
> Every engine-01-specific change described below was folded into the parent
> `infra/monitoring/` configs and IS the live stack: `deploy.sh` symlinks
> `$SRC_DIR/infra/monitoring/$f`, never this directory, and the parent
> `prometheus.yml` already targets `host.docker.internal`. So these copies were
> deployed by nothing while quietly drifting: they had fallen four rule files
> behind the parent (missing all 10 supervisor, 6 tournament and 10 spin
> rules) and were missing the `turn_relay` scrape job, and
> `check-monitoring-drift.mjs` only ever read the parent pair.
>
> A second, unreferenced copy of a config, sitting where an agent will find it,
> is the documented failure mode from `CLAUDE.md` 10.7 - the next reader
> believes it is live and "fixes" the real one to match. The drift check now
> fails if a second `prometheus.yml` appears anywhere under
> `infra/monitoring/`.
>
> The `slo-rules.yml` / `slo-alerts.yml` note below is also out of date: both
> were rewritten on 2026-09-04 against metrics the engine already emits,
> rather than waiting on a blackbox-exporter that is still not deployed.

# Monitoring stack — engine-01 co-located variant

Phase 5.1.3a alternate deploy path. When the originally-planned cron-01
Hetzner host became unreachable (SSH key not provisioned on it, and
monitor.smarter.poker DNS does not resolve to our engine-01 IP), we
co-located the Prometheus + Grafana + AlertManager stack on the existing
engine-01 box and fronted it at `https://engine.smarter.poker/*` via the
same Caddy vhost that already reverse-proxies the game server.

## What's different from the parent `infra/monitoring/` configs

| File                                     | Change                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`                     | Prometheus gains `--web.route-prefix=/` + `extra_hosts: host.docker.internal:host-gateway` so it can scrape the host-networked node_exporter (:9100) and the club-arena-engine container (:8080). AlertManager also gets `--web.route-prefix=/`. GF_SERVER_ROOT_URL / Prom `--web.external-url` retargeted to `engine.smarter.poker`. Retention shrunk to 7d / 1GB (engine-01 is only 40GB disk). |
| `prometheus.yml`                         | Drops the engine_pm2 scrape (engine runs in Docker, not pm2 — no :9256 target). Drops supabase_pg and vercel blackbox jobs (no exporters deployed yet). Retargets node_engine01 + engine_game_server to `host.docker.internal`.                                                                                                                                                                   |
| `alertmanager.yml`                       | Stripped to a null-receiver router until SLACK_ALERT_URL / PAGERDUTY_SERVICE_KEY are set in `.env` — alertmanager v0.27 does not env-substitute config, so the literal `${SLACK_ALERT_URL}` in the parent file fails to load. Restore the parent file once real creds are wired into the stack.                                                                                                   |
| `slo-rules.yml` / `slo-alerts.yml`       | Disabled — rules reference `probe_success{job="vercel_health"}` which is emitted by blackbox-exporter (not deployed in this stack). Re-enable after adding blackbox-exporter to compose.                                                                                                                                                                                                          |
| `Caddyfile` (at /etc/caddy on engine-01) | Extended existing `engine.smarter.poker {}` vhost with handle blocks for `/grafana`, `/prometheus` (basic-auth), `/alertmanager` (basic-auth), `/runbooks/*` (public markdown file_server). `/grafana` uses `handle` not `handle_path` because GF_SERVER_SERVE_FROM_SUB_PATH=true expects the prefix intact.                                                                                      |

## Operator access

- Grafana: https://engine.smarter.poker/grafana/ (admin / see `/opt/smarter-poker-monitoring/.env` on engine-01)
- Prometheus: https://engine.smarter.poker/prometheus/ (basic-auth: monitor / see `/opt/smarter-poker-monitoring/.auth`)
- AlertManager: https://engine.smarter.poker/alertmanager/ (basic-auth: same)
- Runbooks: https://engine.smarter.poker/runbooks/03-engine-down (public, served from /opt/Smarter-Poker-World-Hub/docs/runbooks/)

## Scrape targets (all UP as of 2026-04-20T07:52Z)

- `node_engine01` — host.docker.internal:9100 (node_exporter, network_mode: host)
- `engine_game_server` — host.docker.internal:8080 (CA engine `/metrics`)
- `prometheus` — self-scrape

## Future migration back to dedicated cron-01

When a cron-01 host with real DNS + SSH access exists, the steps are:

1. Point `monitor.smarter.poker` DNS at cron-01 IP (Cloudflare)
2. Run `infra/monitoring/deploy.sh` on cron-01 with the unmodified parent configs
3. Remove the handle blocks from engine-01's Caddyfile
4. `docker compose down` on engine-01 and clean up /opt/smarter-poker-monitoring

The engine-01 stack can co-exist with a future cron-01 stack if both are
wanted — they just scrape engine-01 twice.
