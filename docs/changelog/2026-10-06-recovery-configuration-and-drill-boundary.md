# Recovery configuration and drill boundary

Seven-day Supabase PITR was enabled through the existing configured identity on
2026-10-06. Independent billing and backup API reads confirmed pitr_7 and
pitr_enabled=true; database startup remained October 4. The add-on is about
$100 per month, prorated hourly. No restore or production restart was performed.

The runbook no longer invents a human-only PITR restriction or recommends an
uncontained production clone. Physical clones can run external scheduled work
at startup; an isolated full restore needs pre-start containment and adequate
capacity. Configuration and backup presence do not certify recovery. The
existing DR posture test now guards these distinctions.
