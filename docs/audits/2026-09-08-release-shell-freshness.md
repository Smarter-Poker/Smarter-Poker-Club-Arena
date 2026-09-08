# A Healthy Origin Must Not Serve Yesterday's Bug On The First Reload

## Reproduction And Verification

During the production verification of PR 3719 on 2026-09-08, a page reload still
loaded index-Ww1oGtVr-v6.js and showed Game Full for the running, full 100 Chip
Deep Stack Spin PLO6. The database confirmed RUNNING. The published origin and
public route subsequently served index-n7Q0QOfu-v6.js. A second reload adopted
that bundle, displayed Watch, and opened the live three-player table. Observed
hands advanced from 8142026 to 8142537 without a paid entry or seat purchase.
PR 3719 is functionally verified on the current bundle.

The shell response allowed max-age=0, s-maxage=60, stale-while-revalidate=86400,
and stale-if-error=86400. A healthy cache could therefore serve a day-old shell
on the first visit while refreshing in the background. Build-info.json was
fresh, so checking that file alone overstated what this browser had adopted.

## Change And Operational Boundaries

Reduce the healthy stale-while-revalidate allowance to 60 seconds. The shared
fresh allowance remains 60 seconds, so the configured healthy cache-age budget
is at most two minutes. Preserve stale-if-error=86400 for real origin failures,
immutable hashed chunks, additive asset retention, and uncacheable build info.
This does not force a mid-hand reload or update an already-open page in place.
It does not change World Hub's accepted immutable-asset edge policy.

The origin deployment script also copied onto the live Caddyfile before it
validated, contrary to the prior changelog's claim. It now uploads a unique
staged candidate, validates that exact file with the caddyfile adapter, then
atomically renames and reloads it. Validation failure removes the candidate
and leaves the live file untouched. The dry run remains read-only.

## Validation And Publishing

Four tests exercise failed validation, successful ordering, dry-run behavior,
and the cache policy. Bash syntax validation passed. The actual Caddy binary
on estate-ci-1 accepted the candidate from stdin with `Valid configuration`.
The deployed config was first checked read-only and matched the repository.

Publish through the normal branch/autopilot process, then use the documented
infra/ca-origin/deploy-origin-config.sh path on Hetzner and check live headers.
A merged source change alone does not reload the origin configuration.

## Deployment Correction

The first staged deployment at 12:27:41 UTC failed: mktemp had created the
candidate with mode 0600 owned by root. Root's validation succeeded, but the
service running as caddy could not read the installed file. The reload and
fallback restart failed. This was a regression introduced by this change.

The live file was corrected to 0644 and Caddy started successfully at
12:28:36 UTC. Public origin checks then returned HTTP 200. The script now sets
0644 before the atomic rename. Its success test executes chmod and rename on
real temporary files starting at 0600, and checks the installed mode, rather
than merely mocking a successful remote command. All four tests pass.

Origin HTML now returns stale-while-revalidate=60. The public World Hub route
still returns 86400 because two explicit Club Arena shell header rules in
World Hub's vercel.json override the origin. Those rules require a matching
change; the origin-only deployment does not close public shell freshness.
