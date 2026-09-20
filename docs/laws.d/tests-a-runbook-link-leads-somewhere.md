# tests/a-runbook-link-leads-somewhere.law.test.ts

The runbook is the first thing read by whoever the page wakes up, and on
2026-09-18 nineteen of them were a 404. Every alert pointing at
`https://monitor.smarter.poker/runbooks/<slug>` - EngineDown, PokerTablesFrozen,
SpinPrizeUnpaid and sixteen others - answered `DEPLOYMENT_NOT_FOUND` from
Vercel: `*.smarter.poker` is a wildcard to Vercel, no record sends `monitor` to
cron-01 where `infra/monitoring/Caddyfile` expects to serve it, and no document
existed behind any of the slugs either. `check-monitoring-drift.mjs` had
checked repo-relative runbook targets since 2026-09-11 and skipped `http(s)`
ones on purpose, because a build has no business reaching somebody else's
server - then said "every runbook resolves" anyway, with 21 URLs on 28 rules
outside the word "every". This law holds the half that needs no network: a
runbook link into this repository must name a file that exists, and the drift
check's summary must state what it did not fetch rather than claim it did. The
live fetch is `scripts/ci/check-runbook-links.mjs`, which runs on the box after
the deploy lands. A link into this repository is resolved as a file and never
fetched, because the repository is private and an anonymous GET of a blob URL
answers 404 whether or not the document exists - fetching the two such links
here would have reported both as dead on the first run.
