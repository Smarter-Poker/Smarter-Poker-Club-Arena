# Union Money Report Access And Read-Only Behavior

Migration 20260907210849 closes a verified missing authorization gate on the authenticated-callable SECURITY DEFINER fn_union_money_report. Explicit union requests require the existing union report or overseer permission helper; a default request selects only an authorized union. Open alerts are filtered by their stored union_id.

The report no longer calls fn_union_treasury_selftest, which scans all unions and maintains checkpoints and financial alerts. It returns selftest.checked=false and healthy=null rather than claiming a check passed. The existing engine diagnostic path remains available.

Original-function pg_temp reproduction admitted an unrelated caller. Candidate and installed-function probes reject unauthorized union access, allow the authorized union, filter other union/global alerts and omit global self-test execution. Permission helpers were stubbed for branch testing; live helper definitions and grants were inspected. No production balances or records were modified by testing. No current app caller was found in this repository; external artifact consumers must honor checked=false.

This correction does not validate the report's projected pricing or establish end-to-end financial conservation.
