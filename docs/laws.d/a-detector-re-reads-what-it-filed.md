# tests/a-detector-re-reads-what-it-filed.law.test.ts

`fn_ca_escrow_vs_counter_check` re-reads every incident it holds open on every run and closes, through `fn_ca_escrow_incident_closes_when_the_leg_lands`, only an event that balances 0.00/0.00/0.00 now, naming the leg that landed late; an unregistration's fee reversal is attribution, not escrow money (`20260906145058`, `20260906145706`). Detector bookkeeping, never a sweep, never a chip moved (Dan, 2026-09-06).
