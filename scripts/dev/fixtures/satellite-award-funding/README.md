# Installed satellite award funding fixture

This overlay executes the current installed satellite award helper with the existing registration funding runtime. Source entries are paid through its real registration, wallet, entitlement and ledger authorities. The manifest pins captured bodies before the prospective correction is applied.

The overlay adds 13 installed functions and seven selected actual triggers, replacing the base fixture's older roster-count trigger. It includes a captured nullable rake terminal marker and three empty terminal-receipt table shapes needed by read-only guards. These are explicitly limited fixture shapes, not a terminal settlement implementation or the full production schema.

Caller after entry/cancellation runner integration:

```bash
python3 scripts/dev/probe-tournament-registration-funding-pg17.py --satellite-awards-only
```

The module expects the CLI-created candidate migration `20260910043237_satellite_seats_count_once_and_keep_the_funded_prize.sql` in `supabase/migrations`. It uses PostgreSQL 17 through the existing runtime and no additional dependency installation. The candidate changes future award counters, version 2 fee allocation and empty direct-bounty aggregation. It does not rewrite historical rows, but future reader calculations can change for existing events.

For eight-group observed results, exact baseline failures and production/upper-delivery limits, see `docs/audits/2026-09-10-phase3-satellite-award-funding-evidence.md`.
