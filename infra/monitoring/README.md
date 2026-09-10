# Club Arena Monitoring On Hetzner

Prometheus, Alertmanager, and Grafana run on the Club Arena Hetzner estate.
This directory is owned and published by the
`Deploy Monitoring (on infra/monitoring changes)` workflow in the Club Arena
repository. World Hub, Vercel, a workstation, and an unreviewed host checkout
are not monitoring publishers.

## Release Contract

- A reviewed merge to Club Arena `main` that changes this directory triggers
  `.github/workflows/deploy-monitoring.yml`.
- A recovery dispatch must include one full commit SHA already contained in
  Club Arena `main`.
- The workflow checks out that exact SHA, stamps the shipped payload, copies it
  to the Hetzner host, and invokes `deploy.sh` with the same SHA.
- `deploy.sh` rejects an unstamped source tree, a mismatched SHA, missing
  runtime credentials, and placeholder Caddy configuration.
- The workflow reads Prometheus back after deployment and fails if the active
  rules differ from this repository. It does not retry, force-recreate, clone,
  reset, or repair the host behind the release gate.

The GitHub Actions release credentials are
`HETZNER_HOST`, `HETZNER_HOST_KEY`, and `HETZNER_SSH_PRIVATE_KEY`. Their values
belong only in Club Arena repository secrets. Do not put them in `.env`, a
Markdown file, World Hub, or a local shell script.

## Runtime Configuration

The workflow preserves credential-bearing files already provisioned on the
Hetzner host:

- `/opt/smarter-poker-monitoring/.env`
- `/opt/smarter-poker-monitoring/cron_secret`
- `/opt/smarter-poker-monitoring/resend_key`
- `/etc/caddy/Caddyfile`

They are host runtime state, not deploy payloads. If any prerequisite is absent
or still contains a placeholder, the release fails closed. Provisioning or
rotating those values is a separate credential-management operation; it must
never be hidden inside a code deployment.

## Repository Files

- `docker-compose.yml` defines the monitoring services and bind mounts.
- `prometheus.yml` declares scrape targets and every loaded rule file.
- `alertmanager.yml` declares alert routing.
- `alert-rules.yml`, `engine-freeze-rules.yml`, `recovery-rules.yml`,
  `tournament-rules.yml`, `spin-rules.yml`, `slo-rules.yml`, and
  `slo-alerts.yml` contain the loaded rules.
- `grafana-provisioning/` and `grafana-dashboards/` define Grafana state.
- `deploy.sh` is a workflow-only Hetzner payload. It is not a manual installer.
- `ENGINE-SETUP.md` documents the metrics exporters consumed by this stack.

## Changing Monitoring

Change the repository declaration, run the monitoring contract tests, and use
the normal Club Arena pull-request path. After merge, require the workflow to
finish successfully and verify the live Prometheus rule set. A local compose
run, a copied file, a manual reload, or a green build without read-back is not
a published monitoring change.

Prometheus retains 15 days locally in its managed volume. Capacity or retention
changes follow the same reviewed release path.
