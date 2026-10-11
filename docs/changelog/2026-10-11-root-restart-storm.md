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

## Alert repair and trigger evidence

Owner relay original migration 20261007000420, lines152-156, picks original title after annotations/event summary, discarding the original notification message. Reserved migration20261011190747 adds nonblank original message before legacy title, with exact live function preimage md5 279c02581cb2d16436f528710046fe3b and explicit refusal on changed/duplicate preimage. No recipient, pager, notification quota, financial writer or scheduled work changes. Source reread: yes. Isolated PostgreSQL17 actual trigger reproduces bad baseline and passes message, blank/null fallback, annotation/event priority, truncation, repeat suppression and second-apply refusal. Retained test runs in existing required accounting shard1.

Diamond full settled-day readback: 6600 entry +3500 bonus =10100 net; 20% burn2020; exactly8080credited, pending0, prizes/inventory0. Statement is correct.

Database interruption trigger identified: cron job477 postgrest-pool-renew-10m fires :02/:12/:22/:32/:42/:52; 18:42:00.380934 run aligns with 18:42:00.400027 schema reload, reinitialized40-connection pool and~32s cache/pool unavailability. It was added after measured database memory exhaustion on Oct3/4. No safe removal before native lifetime/memory bound verification; do not replace a table storm with a whole-database OOM. PostgREST12 docs native pool lifetime1800s is not in-database/reloadable; management API route exposes only limited settings. Existing scheduled renewal preserved while original hand barrier repair removes its proven destructive engine consequence. Host memory file read denied; no claim of current headroom verification.

Full suite first run mixed old imported helper with new validation test during edits:1failed helperboolean case,1271passed,1skipped; final focused validation31passed. Exact committed-tree full suite rerunning. Initial wrong-root test invocation found no tests, corrected to server project and passed.

Final runtime suite:1272filespassed/1existing file skipped;22063testspassed/168existing skips,322.25s. Exact server tree unchanged by current-main Cashier merge e57286dbfb; root TypeScript rechecked after integration and passed. First push refused stale cash-workflow fingerprint caused by added qualification step, plus its matching source contract; preserved prior pin/history and refreshed only workflow bytes/hash with explicit source-only reason,6native-input tests and6accepted-roster contracts pass. No guard weakened. Final normal hook rerun required.

## Remaining storm paths repaired

Base.ts shared isTransientDbError at5925 omitted PGRST001/002/003 and their exact wrapped messages. loadTable strips error codes when it throws, so code-only detection was insufficient. Existing startup five-attempt retry could also exhaust before the observed32s outage. The classifier now recognises only pre-execution API outages, including exact wrapped messages; startup keeps its original read owner for a60s bounded budget for those errors, retains the five-attempt transport bound otherwise, and rechecks current lifecycle authority before each read/backoff. Normal dealing/post-hand retry branches use this shared classifier; no new worker or financial replay path.

Three new regression cases fail on prior source and pass after: pre-execution classification, original startup surviving >30s/eight failed reads, and persistent outage stopping exactly at60s. Permission/schema defects remain refused; original five-attempt transport bound remains tested. Final focused6files/63tests pass. Original add-on source fails exactly its added transient committed-read case; restored source passes, no resolver replay. Source reread yes. Full final runtime suite pending after this additional repair.

Normal initial corrected push passed at5d748c6af8501675a486832414b4ddf72ee8719a and opened PR6667 automatically. Owned PR: https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6667. Final candidate will update that same PR. Provider engine route successful comparator38157276010 f47ad93c; required credential metadata names available. Browser service-settings account displays no organizations for this project; no native lifetime/headroom control exposed there.

Resumption 2026-10-11T19:23:32.889Z: full canonical policies version2.9 and same hashes reread, plus repository references/checkpoint. Candidate3975e00ba4; final full server suite running unchanged; lint zero errors/two pre-existing Base warnings. Disabled existing auto-merge on the older candidate while final source is being qualified; no required check bypass.

Final candidate runtime qualification3975e00ba4:1272filespassed,22067testspassed,oneexistingfile/168existingskipcases,272.54s. Full source inputs unchanged during execution. Both TypeScript compilers passed; final affected lint zero errors/two pre-existing warnings. Owned isolated PostgreSQL cluster stopped after verification.
