# tests/no-two-runners-share-a-port.law.test.ts

No two runners share a port: every Playwright surface that starts a server IN CI derives its port from `scripts/ci/e2e-port.mjs` (unique per `RUNNER_NAME`, offsets in tens so 5188 and 5189 can never be mapped onto each other), ci.yml computes the beats preview port rather than writing 4173 down, and no CI-starting config sets `reuseExistingServer: true` - which is the fix the "port is already used" error suggests and would silently run one pull request's specs against another's build
