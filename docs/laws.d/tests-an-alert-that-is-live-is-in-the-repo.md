# tests/an-alert-that-is-live-is-in-the-repo.law.test.ts

An alert that is live is in the repo: every Prometheus group alerting on engine-01 is versioned under infra/monitoring/ (deploy.sh symlinks these over the live files, so a group missing here is one a deploy would silently delete); the settlement and money-health groups recovered from the box on 2026-09-05 keep all nine of their money alerts
