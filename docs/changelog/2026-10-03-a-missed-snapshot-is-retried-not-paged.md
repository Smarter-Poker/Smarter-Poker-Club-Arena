# A missed snapshot is retried, not paged (2026-10-03)

Migration `20261003220245`. Incident `f991dee1-6c53-4311-bfb7-3f91964b06b7`.

## What happened

- 19:35:02 UTC: `fn_ca_diamond_health_watch` filed `DR0:health_critical` (ca_diamond_incidents 874553): "Trial balance is incomplete: require one known comparison for each of the five reconciling accounts". `fn_ca_diamond_incident_pages` turned it into a critical, `unknown` drift incident that holds the launch gate red three ways.
- Cause: `ca-diamond-snapshot-hourly` (job 201, minute 10) has no 19:10 run at all; the database restarted 19:07-19:12. `fn_ca_diamond_trial_balance()` measures from the first snapshot at or after `now() - 75 minutes` (18:20 at 19:35); the newest was 18:10, so four reconciling accounts returned a NULL difference and the health report read `unknown`, which the watch files as critical.
- Not a timeout, not stats or cache, not an unlogged table, not a ledger gap.

## The books balance

`fn_ca_diamond_trial_balance('2026-10-03 18:09')`, one comparison from the 18:10 snapshot across the gap to 21:59:

| account | balance moved | register moved | difference |
|---|---|---|---|
| player_diamonds | 4260 | 4260 | 0.00 |
| fixture_accounts | 4315 | 4315 | 0.00 |
| diamond_house | 0 | 0 | 0 |
| register | | | 0.00 |
| total | 4260 | 4260 | 0.00 |

Snapshots at 18:10, 20:10 and 21:10 each have `unexplained = 0`. The 21:35 health reading has trial balance ok, money identity ok and deploy gate 0 unexplained, and the watch auto-resolved its DR0 row then.

## What changed

1. `fn_ca_diamond_health`: the trial balance reaches back to the newest stored snapshot when it is older than 75 minutes; with a fresh snapshot the argument equals the old default.
2. `fn_ca_diamond_health_watch`: a `critical` area files critical at once, as before. An area that reads `unknown` for the first time (not unknown or critical on the previous reading, at most three hours old) files at `warning`: recorded, auto-resolved, not paged. If it is still unknown on the next hourly tick, it files critical.

Both edited by exact substitution against pinned preimages; owner, security, settings and grants unmoved.
