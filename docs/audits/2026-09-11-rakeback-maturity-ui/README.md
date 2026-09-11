# Coordinated Legacy Rakeback Repair And UI

This is a concrete dormant release package. It combines UI commit `92a43636e6b8da408fade162780c3d0478d73084` with exactly 36 files from the standalone legacy repair directory at `988db864469e0d2543b969fc0032c4d8eb7b9fa3`. No full captured-source SQL, migration wiring or capability change is imported. `integration-manifest.json` records every copied backend hash and the five reviewed UI input hashes.

The UI includes closed-UTC period readiness, global eligible-club discovery independent of its twelve recent history rows, daily UTC rediscovery, honest recent/rate/estimate labels, response validation, queued refresh recovery, account/attempt fencing and the existing Supabase-aware retry path. Its 44 focused component cases and independent peer review are preserved in the adjacent rakeback-discovery audit. The original eight-case and 25-case checkpoints remain separately pinned historical observations.

The backend includes inclusive UTC maturity, paid wallet-pointer integrity and shared per-period duplicate prevention for direct claims and Round3. It retains club funding for direct claims, assigned-agent funding and aggregate-per-player shortfall behavior for Round3. The exact atomic entrypoint is `../2026-09-11-legacy-rakeback-maturity/00-apply-legacy-repair.sql`, SHA256 `a55e792f12040799a20fcf6d54969059efecaea3869c3aa148191fe1b083c4c7`. The 01 and 02 source files must not be applied independently. Its 22 native groups, first-install overlap evidence, current admission readback and peer review are imported unchanged; they were not rerun by this integration lane.

## Required Publication Order

1. Recheck and preserve current owner/schema/ACL identities and all admission prerequisites documented by the standalone package.
2. Apply its exact atomic 00 entrypoint through the normal database release process.
3. Read back replacement function bodies, guards, triggers and ACLs against expected-runtime.json and the native evidence.
4. Publish this coordinated UI only after that backend readback succeeds.

The UI sends only the existing club identifier. A frontend filter cannot prevent an old backend from paying open periods in that same club. Rolling old claims can encounter 40P01; the candidate UI now uses the existing retryFetch utility with two retries, scoped to the initiating account and attempt. Uncertain transport replies refresh authoritative data without asserting that money did or did not move.

## Review Limits

The integration base remains `1579ac7c1483523ebea0aaa7ad1c215fdf1dc701`. The timestamped main comparison and successful mechanical UI merge tree are in the manifest. No changed candidate runtime or imported backend path overlaps that main snapshot; package.json only added the art:matte script. This is source compatibility, not combined latest-main runtime or CI acceptance.

No SQL was applied, production money RPC called, capability activated, PR created or UI published by this lane. The backend native fixture is not the entire current production trigger catalogue; the current append-only guard difference and bounded admission observations retain the payer's stated limits. Component tests do not establish production HTTP/RLS acceptance or a real committed lost-response payment. Calendar maturity does not establish common producer/bank finality.

After standalone adoption, the later full captured c12 payer package must be explicitly rebased and reproved against the new owners. Its existing original-owner gates cannot be bypassed, and the broader captured-source accounting candidates are not part of this independent package. Engine adoption and sustained health remain separate release evidence owned by the release coordinator.
