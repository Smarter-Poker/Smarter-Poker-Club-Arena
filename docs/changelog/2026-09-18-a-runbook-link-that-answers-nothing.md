# A runbook link that answers nothing

Nineteen alerts point at `https://monitor.smarter.poker/runbooks/<slug>`. Every
one of those URLs answers `404 DEPLOYMENT_NOT_FOUND` from Vercel, and has for
as long as anybody can measure. `*.smarter.poker` is a wildcard pointed at
Vercel, no DNS record sends `monitor` to cron-01 where
`infra/monitoring/Caddyfile` has always expected to serve it, and no document
exists behind any of the nineteen slugs either. The links were aspirational in
both directions at once.

`EngineDown`, `PokerTablesFrozen`, `SpinPrizeUnpaid`, `TournamentUnpaid` and
fifteen others carry one. The runbook is the first thing read by whoever the
page wakes up.

`check-monitoring-drift.mjs` has checked repo-relative runbook targets since
2026-09-11, when 23 alerts were found pointing at three changelog files nobody
wrote. It skipped `http(s)` targets deliberately and for a good reason - a
build has no business reaching somebody else's server during a pull request -
and then its summary line said "every runbook resolves" anyway. Twenty-one URLs
on twenty-eight rules were outside the word "every". That is 10.86 exactly: a
signal answering a question it had not asked.

Two changes, split along the line the original reasoning drew.

`check-monitoring-drift.mjs` still fetches nothing. It now says what it did not
fetch, and how many, and it checks the one thing a build can: that an
`http(s)` runbook host is a hostname this repository's own Caddyfiles serve, so
a target no vhost answers for is caught without a request.

`check-runbook-links.mjs` does the fetching, as its own command wired into
`deploy-monitoring.yml` beside the check that reads the running rules. It is
separate rather than folded into `check-alert-rules-match.mjs` for a reason
worth recording: that script's unit test replaces `curl` with an offline
fixture answering Prometheus and Alertmanager, and a second caller passing
different arguments broke it on the first push. The gate caught it. A check
that has to break its neighbour's test seam in order to exist is not worth
having. A link into this
repository is resolved as a file and never fetched: the repository is private,
so an anonymous GET of a blob URL answers 404 whether or not the document
exists, and both of the ones here do exist. Fetching them would have produced
two confident false reports on the first run.

The nineteen are reported, not repaired. Fixing them means either a DNS record
for `monitor` plus documents behind the slugs, or repointing each rule at a
runbook that exists; both need somebody who knows what a responder should
actually do about an unpaid spin prize at three in the morning. A guessed
runbook is worse than a dead one.

Pinned by `tests/a-runbook-link-leads-somewhere.law.test.ts`, which fails on a
link into this repository that names no file, and asserts the drift check's
summary against what it prints rather than what its comments say.

Note: the post-deploy verification step in `deploy-monitoring.yml` will fail
while those nineteen stand. The deploy itself lands first - this step verifies
by reading afterwards - so rules still ship; the run goes red until the links
lead somewhere.
