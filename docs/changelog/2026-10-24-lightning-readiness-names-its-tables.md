# Lightning Readiness Names Its Service-Only Tables

`fn_lightning_rollout_readiness` reported `seven_tables` as `count(*) = 7` of lightning\_\* tables that service_role reads directly. The Midway fill work added an eighth with the same service-only posture (`lightning_horse_fill`), so the invariant has read false since 2026-10-23 and every Lightning cluster's readiness answered NO_GO on a security check that is satisfied. Post-deploy Client browser verification failed on it (run 40132784246).

Production read 2026-10-24: eight such tables, all service_role SELECT, none granted to anon, authenticated or PUBLIC. `20261024224758` now compares the exact set of eight names, still false on any public grant or an unnamed ninth table. The output key stays `seven_tables` for the operator client. Proven in a rolled-back production probe: false before, true after, every other invariant unchanged.
