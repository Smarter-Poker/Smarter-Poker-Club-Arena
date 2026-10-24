# The Attested Rosters Catch Up (2026-10-22)

Three red signals on `main`, each with one honest repair.

## Cron Health: 137 -> 139 active jobs

Read live from `fn_ca_cron_health('24 hours')` at 2026-10-22T19:40Z.

- Added `ca-writer-lock-sentinel-5s` (migration 20261022030326, CLAUDE.md section 2 rule 9).
- Added `ca-bust-backlog-page-2m` (applied migration 20261022172522, PR #7718).
- Moved `ca-freeze-mark-pre` / `ca-freeze-mark-post` to the daily 04:00 Chicago
  maintenance (20261021174252), and `sp-daily-metrics-snapshot` widened to 5-12 UTC.

`docs/attestation/cron-roster.tsv` and `ACTIVE_JOBS` in
`tests/the-scheduled-work-roster-is-pinned.law.test.ts` move together.

## Ledger attestation: three days anchored (issue #7680)

2026-10-19, 2026-10-20 and 2026-10-21 appended to
`docs/attestation/chip-ledger-days.tsv` exactly as `ca_ledger_day_manifests`
holds them. No anchored day changed its sha; no restatements exist for them.

## Applied Migrations Are Recorded: the drift count

The issue step counted `^[0-9]{14}` but the script indents each version, so the
count was always 0, and `grep -c ... || echo "?"` appended a second line on a
zero count. That is why issue #6782 is titled "(~0\n?)". The count now matches
the indented lines and falls back to `?` only when the log is unreadable.
