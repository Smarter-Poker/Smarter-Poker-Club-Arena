# tests/post-deploy-failures-reach-the-alert-store.law.test.ts

A failed post-deploy verification used to exist only in the Actions UI: the
publish had happened, `post-deploy-e2e.yml` or `deploy-monitoring.yml` went red,
and nothing wrote that fact anywhere the Production Alerts fleet reads, so a bad
release could sit live until a person opened GitHub. This law pins the wiring
that closes that gap: the composite action
`.github/actions/report-post-deploy-failure` exists with its required inputs;
both `post-deploy-e2e.yml` jobs and `deploy-monitoring.yml` call it from a step
whose condition includes `failure()`, with `continue-on-error: true` so the
notifier can never mask or fail the verdict it reports; the sources are exactly
`ci.post-deploy-e2e` and `ci.deploy-monitoring` and the alert names
`PostDeployVerificationFailed` and `MonitoringDeployFailed`, which is what the
fleet's rollback logic matches on; and the action never prints the secret. A
released commit that fails verification is therefore a firing row in
`operational_alert_events` carrying `payload.released_sha` by the fleet's next
fire.
