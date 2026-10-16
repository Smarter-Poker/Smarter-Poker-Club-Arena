# tests/the-commission-evidence-check-reads-only-what-is-unaccrued.law.test.ts

The commission evidence check reads only what is unaccrued (2026-10-16): fn_assert_cash_commission_period finds the week's cash rake records with no accrued batch first, in a MATERIALIZED CTE, and only those pay for the ghost-twin, membership and launch predicates; it had taken 77.9 s per call (twice per union attempt) on 606,825 records inside job 272's 240 s tick, and every condition and the refusal are unchanged.
