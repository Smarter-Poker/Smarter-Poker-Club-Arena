# Restart storm and money-check root repair checkpoint

Owner: this Codex task. Scope: screenshot restart storm, Money Check Failed, and verification of Diamond Spins statement. No unrelated release or product phase.

Owned checkout: /Volumes/SmarterWork/agent-work/root-restart-storm-20261011/club-arena
Branch: codex/root-restart-storm-20261011
Base: 75ce9632bb

Read canonical four policies, storage guide, repository AGENTS/CLAUDE/AGENT-PLAYBOOK, publishing, deploy paths, historical restart programme/handoff, nested operating rules. Policy 2.9 receipt 2026-10-11T18:58:22.202Z, manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b; owner b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; operating a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; hardening d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; index adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555.

Acceptance: identify and repair actual kill causes; retain committed-hand/stack/lease invariants; no double financial effects; regression checks execute; protected merge, exact engine publication and sustained live kill/read proof; identify exact money-check cause and settle through authorized idempotent path if needed; verify statement accounting.

Baseline: serving f47ad93ce25b54e98d4c8c0a952a87f1482aff99. Health killsInWindow 181. Two-hour durable records: 283 post_commit_stack_refresh_failed plus 283 duplicate post_hand_settlement_failed, 73 tournament zombies, 56 consecutive loop errors, 51 start_load_table failures, 36 lease expiries. Current code kills on a single postcommit read failure and counts nested termination twice. PostgREST schema-cache failures observed in financial alerts; engine event loop was healthy at sample.

Money-check: current absent-tournament-player finding (Coffee Break Freeroll PLO4, 7aace408-a355-4187-b9f6-93424840e721), plus settler lag warning. Neither zero discrepancy nor health OK proves resolution. Diamond statement arithmetic 10100-2020=8080; ledger verification pending.

Status: investigation, no fixes deployed or claimed. Authenticated GitHub and Supabase reads available. SSD verified mounted with free space. Private dependencies installing. No production writes performed.

## Implemented engine repair

Settlement.ts original stack read near 2860 and Seating.ts pending add-on read near 665 previously terminated on one unavailable read after the financial receipt. Both now keep the original request barrier and bounded read-only continuation for transient transport/schema-cache failures. They never replay settlement/add-on effects; loss of authority discards late results, permission/malformed truth fails closed, sustained failure still terminates. Base.ts killForRestart now rejects repeated terminal calls before diagnostic/recovery event emission. First cause remains authoritative. Source reread: yes.

Regression: original source fails the new real postHandTasks test on PGRST002 and teardown test on two recorded deaths; repaired source passes all 40 focused tests. Server and root TypeScript passed; affected lint zero errors (8 pre-existing warnings). Full server suite pending. Private locked dependencies prepared on SSD.

Readback: screenshot tournament completed 18:14:04 UTC, escrow closed with exact zero, 182 gross in = 12.80 fee +169.20 prize out. Current absent-player detector returned no rows. Incident still open; existing resolver requires two subsequent detector runs, so absence now alone is not a safe general closure. Diamond credited transaction c60e21d9-8117-4cbc-8051-3ec8eed4c274 is a single 8080 diamond transfer with exact daily reference, arithmetic verified; burn/source readback remains pending.

Resumption policy reader 2026-10-11T19:04:58.749Z same version2.9/hashes.
