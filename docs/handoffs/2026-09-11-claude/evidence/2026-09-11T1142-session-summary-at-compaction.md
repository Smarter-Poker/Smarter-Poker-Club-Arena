# Session state at the 11:42 UTC context compaction (verbatim operator summary)

This is the working summary the orchestrating agent carried across its context compaction at 2026-09-11 11:42 UTC. It records constraints, exact file paths, md5s and open items from the earlier part of the session.

Summary:

1. Primary Request and Intent:
   - Standing mandate from Dan (earlier segments): fix Club Arena engine deploy failures at the root, no watchdogs/crons, publish pushes in order, harden against regression, verify before claiming success. Latest explicit instruction (prior segment): "1, finish up everything thats still pending and not finished OR STILL NEEDS T OBE FIXED, IMPROVED, ENHANCED OR OPTIMIZED STILL... MAKE SURE EVERYTHING WAS UPDATED, PUSHED AND PUBLISHED. go through it all line by line, check for any bugs, stubs, gaps, errors, regressions or wiring issues... DO NOT LEAVE ANYTHING UNFINISHED. FINISH UP ANY AND ALL TASKS THAT ARE STILL LEFT TO DO BEFORE SENDING YOUR SUMMARY REPORT. 2, ONCE YOUR DONE WITH EVERYTHING FROM THE PREVIOUS BUILDS, GO AHEAD AND START THESE: Further improvements worth doing next" — (a) engine finish ranks by true bust time (+Breakfast Turbo ruling), (b) bounty door record-time problem, (c) batch REGISTERING serial count sweep, (d) deploy-pipeline edge cases, (e) flaky CI timing test, (f) one equity worker on 3-core host.
   - Dan: "NO, YOU DECIDE WHATS BEST... STOP ASKING ME" (make operational calls and report).
   - This segment (mid-turn): "THEN YOU MUST FIX THE DEGRADED ENGINE!"
   - Standing security/ops constraints (verbatim where given): never print secrets (tokens/passwords read from ~/Documents/club-arena/.env inside commands only); never set credentials; nothing touches production except me; never --no-verify; never rebase (merge only); never claim success before end-to-end verification; engine restarts ONLY inside the announced :55 maintenance break (CLAUDE.md §13); "There is deliberately no force input: neither a human nor automation may bypass readyForRestart and stop a live table engine."; horses are players (§10.5); DB writes only deliberately; migrations one BEGIN/COMMIT with lock_timeout, never in the :50–:03 UTC window, no DDL probes (CLAUDE.md Production DDL policy; apply detached); freeze blocks money/seat writes :55–:00; money already paid is never clawed back; make-good is house-funded via a future audited door.

2. Key Technical Concepts:
   - Access: Mac via mcp**remote-devices**counselors\_\_host_terminal (<55 s; long jobs via `nohup perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV' bash -c '...' &`; `perl -e 'alarm 50; exec @ARGV'` instead of timeout; `export PATH=/opt/homebrew/bin:$PATH`); psql `/opt/homebrew/bin/psql "host=aws-0-us-west-2.pooler.supabase.com port=5432 dbname=postgres user=postgres.kuklfnapbkmacvwxktbh sslmode=require"` with PGPASSWORD=$SUPABASE_DB_PASSWORD; GitHub API curl with $GITHUB_TOKEN (repo Smarter-Poker/Smarter-Poker-Club-Arena; check-runs API forbidden, use actions/runs?head_sha); SSH `~/.ssh/hetzner_engine_key root@5.161.252.33`; local PG17 `/opt/homebrew/opt/postgresql@17/bin` needs `LC_ALL=en_US.UTF-8`; worktrees under ~/Documents/.agent-trees/club-arena/ (symlink node_modules); archived engine logs /var/log/club-arena-engine/\*.log.gz; workflow journals in cloud at /root/.claude/projects/-home-claude/635ed867-.../subagents/workflows/<run>/journal.jsonl. Agent tool is synchronous (no run_in_background) — use Workflow for background work.
   - /health returns 503 with same body when not routing-ready; Caddy single upstream, no active health check.
   - Deploy train (auto-deploy-hetzner.yml): concurrency 1 running + 1 pending newest; cancelled run's Verdict hands on (workflow_dispatch on main); dedupe same-engine-tree; drain gate; sealed cutover; seal commit; Verdict hand_on with retries.
   - Auto-merge merges after required checks only (full CI not required) — code can land before tests pass; the deploy's server-test step catches it.
   - Seat-exit authority (fn_ca_open/close_tournament_seat_exit_authority), consumer trigger zy_tournament_live_seat_exit_requires_authority absent in production.
   - fn_settle_tournament_places now ranks by bust-hand commit time (LEFT JOIN hand_atomic_commits fallback to earliest candidate created_at, then eliminated_at); elimination_sequence database-owned (zz_stamp_tournament_elimination_sequence); re-sequence by toggling status through 'winner'.
   - Mystery bounty: mode by bust hand vs activation receipt; seed reserves unrecorded heads; activated_at clock_timestamp().
   - Satellites into bounty/PKO/Spin targets refused by settlement authority; now refused at creation.

3. Files and Code Sections:
   - .github/workflows/auto-deploy-hetzner.yml
     - Branch fix/a-degraded-engine-can-still-be-replaced (#4270, head d62b5e575b, open): dedupe/public PUB/seal-commit re-check/Verdict use `curl -s`; Verify keeps `-sf` with comment "`-f` is deliberate HERE and only here" and message "container not answering 200 yet (still booting, or answering 503: not routing-ready)". Gate/host re-check use Codex #4267 form: `BODY=$(CERT_RESPONSE=$(curl -sS --max-time 10 -w '\n%{http_code}' "$ENGINE_URL/health") && printf '%s' "$CERT_RESPONSE" | python3 -c '... print(body if status in ("200", "503") else "")') || BODY=""`.
     - #4281 merged: new step before drain:
       ```yaml
       - name: Every database function this build calls exists in production
         id: doors
         if: steps.dedupe.outputs.skip != 'true'
         env:
           DATABASE_URL: ${{ secrets.DATABASE_URL }}
           ROLLBACK_REQUESTED: ${{ github.event.inputs.rollback || 'false' }}
         run: |
           npm ls pg >/dev/null 2>&1 || npm i pg@8 --no-save --no-audit --no-fund >/dev/null 2>&1 || true
           node scripts/ci/check-engine-doors-exist.mjs
       ```
   - tests/a-degraded-engine-can-still-be-replaced.law.test.ts (+ docs/laws.d/tests-a-degraded-engine-can-still-be-replaced.md, docs/changelog/2026-09-11-a-degraded-engine-can-still-be-replaced.md): static no-`-f` checks per step, only Verify/ROLLBACK keep -f, host re-check order (set -euo pipefail < 127.0.0.1:8080/health < echo '$MUTATION_MARKER'), behavioral run of drain script against 503 stub (node:http get, spawn).
   - supabase/migrations/20260911081910_a_seat_exit_guard_without_its_consumer_refuses_nothing.sql (#4269 merged; applied 08:22:40): close raises only if
     ```sql
     IF COALESCE(p_require_consumed,true) AND v_remaining<>0
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                     WHERE t.tgrelid='public.table_seats'::regclass
                       AND t.tgname='zy_tournament_live_seat_exit_requires_authority'
                       AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')) THEN
       RAISE EXCEPTION 'tournament seat-exit authority left % live seat(s) unconsumed',v_remaining USING ERRCODE='P0404';
     ```
     plus REVOKE ALL FROM PUBLIC,anon,authenticated,service_role; preflight md5 0811b7a7…/idempotent 319441969e49923b3ee8d65f8f0b1e82. tests/a-seat-exit-guard-needs-its-consumer.law.test.ts, laws.d, changelog.
   - supabase/migrations/20260911090347_the_prize_reprice_door_the_engine_calls_exists.sql (#4279 merged; applied 09:05:09): fn_ca_reprice_unpaid_tournament_place verbatim from 20260910000905 L2129-2243 with HOTFIX EDIT `PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);`; md5 691a3f79a0a36e48f822832d98e12052; preflight uses to_regprocedure.
   - scripts/ci/check-engine-doors-exist.mjs, scripts/ci/engine-doors.allowlist.json ({}), tests/the-engine-ships-only-with-its-doors.law.test.ts, docs/laws.d/tests-the-engine-ships-only-with-its-doors.md, changelog (#4281 merged). Regexes: `RPC_CALL = /\.rpc\(\s*(['"`])([A-Za-z\_][A-Za-z0-9_]_)\1/g`, `RPC_NAME_ASSIGNMENT = /\b\w_[Rr]pc[Nn]ame\w*\s*=\s*([^;\n]+)/g`, `QUOTED_IDENT = /(?<![=!]==?\s*)(['"`])([A-Za-z\_][A-Za-z0-9_]\*)\1/g`; ENGINE_DOORS_LIVE_FIXTURE seam.
   - server/src/engine/equity/EquityWorkerPool.ts: #4266 (mine) + #4275 + #4277 (Codex) + #4285 in main; production pool size max(1, availableParallelism()-2)=1.
   - server/src/tournament/TournamentEliminationScheduler.ts / TournamentManagerEliminations.ts (#4276 merged, ticket-based places); GameServer.ts + decidedRunningBoard.ts (#4274 merged).
   - supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql (branch fix/a-bust-is-ranked-by-when-it-happened, HEAD 57be4f3940, pushed; applied 11:31:54). New md5s: fn_settle_tournament_places 6181734ff98555ecc04648186f6ebf24, fn_eliminate_player_legacy_candidate_20260907 97abb184dc27e3c7a333a6160636f473, fn_claim_bounty_legacy_candidate_20260907 ea7b6236b7c5c844dbc16ce2e78d2764 (then patched by mystery → d10ceaad9c867902c7407f20151f28b7), fn_eliminate_tournament_player_atomic 9447da284f1a3beb6d51dd87151c080f, fn_claim_tournament_bounty_elimination e099757eb087ef222e2fc92030ececaf, fn_normalize_tournament_final_standings 45b06c3f8be02940d130c427d5a32519, fn_ca_tournament_finished_but_not_completed 6f153669e4b6b149bfccd36ad575bda8. Rollback: docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql (will refuse claim function now that mystery patched it). Probe scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh 27 scenarios EXIT=0. Engine: bustOrder.ts, count:'exact' reads.
   - supabase/migrations/20260911094503_a_bust_belongs_to_the_phase_its_hand_was_played_in.sql (branch fix/mystery-bust-phase-by-hand-time, pushed, commits ff140f6c9e, 0dae571650 anchor relax, 0743e4d333 merge, e89a4edfed engine; applied 11:32:25). Anchor o1 changed to `  v_bounty_blocked text := NULL;\n` → adds `  v_activated_at timestamptz;`. Engine change in server/src/tournament/TournamentManagerBase.ts maybeActivateMysteryBounty (before `this.mysteryBountySeeding = true;`):
     ```ts
     const { data: unrecordedRaw, error: unrecordedErr } = await supabase.rpc(
       'fn_mystery_bounty_unrecorded_head_cents',
       { p_tournament_id: this.tournamentId }
     );
     const unrecordedCents =
       unrecordedRaw === null || unrecordedRaw === undefined ? Number.NaN : Number(unrecordedRaw);
     if (unrecordedErr || !Number.isSafeInteger(unrecordedCents) || unrecordedCents < 0) {
       reportError(
         unrecordedErr ??
           new Error(`unrecorded head figure is not whole cents: ${String(unrecordedRaw)}`),
         'Tournament.mystery_bounty_unrecorded_heads_unreadable'
       );
       return;
     }
     if (unrecordedCents > 0) {
       poolCents = mysteryPoolCents(
         poolCentsFromNumeric(fresh.bounty_pool),
         fresh.mystery_bounty_pool_percent,
         fresh.mystery_bounty_regular_pool_percent,
         poolCentsFromNumeric(fresh.bounty_pool_paid ?? 0) + unrecordedCents
       );
     }
     ```
     MysteryActivationCutoff.test.ts: rpc mock dispatches by name, `seedCalls()` helper, 2 new tests; changelog docs/changelog/2026-09-11-a-bust-belongs-to-the-phase-its-hand-was-played-in.md.
   - Rulings applied: ~/tmp-claude/mystery/ruling*5aa7eeba.sql (10:16:33), ruling_9536150e.sql (10:16:55) (source: ~/Documents/.agent-trees/club-arena/mystery-bust-phase-ruling/); re-sequence script ~/tmp-claude/reseq2/body.sql (vars :tid, :via) with commit.sql/dry*\*.sql, backups.
   - supabase/migrations/20260911110907_a_satellite_never_feeds_a_target_its_finish_refuses.sql (branch fix/satellites-never-feed-a-bounty-target, worktree satellite-bounty-target, commits dfc99c2e35, a6cd81594d, NOT pushed; APPLIED 11:38:34 and recorded in schema_migrations): fn_satellite_target_is_deliverable + trigger satellite_feeds_only_a_deliverable_target on tournaments.
   - scripts/deploy/2026-09-11-settle-satellites-into-bounty-targets.sql (+ .checks.sql); my edited copy ~/tmp-claude/sat/ruling_apply.sql with c_expected_settle 14, c_expected_cancel 1, c_expected_in_play 1; c_ref currently `'ruling 2026-09-11 satellites into bounty targets (fix/satellites-never-feed-a-bounty-target)'` — rejected.
   - Breakfast Turbo: /Users/smarter.poker/Documents/.agent-trees/club-arena/c1f15c30-ruling/ruling_c1f15c30.sql (md5 e688d1621e65bf09dcf3165c94bbf9d3), makegood_optional.sql; branch fix/late-status-flip-keeps-paid-ladder 3aaf4ce0c4 (migration 20260911110000), not pushed, not applied.
   - ~/tmp-claude/verify_engine.sh: /health snapshot script.

4. Errors and fixes:
   - Drain gate "/health unreadable" (curl -sf on 503) → body reads (Codex #4267 + my #4270).
   - happy-dom fetch CORS in root tests → node:http get; `// @vitest-environment node` broke setup (window) → removed.
   - Law registry CI failure → added docs/laws.d entries.
   - Pre-push definer check blocked seat-exit migration → added REVOKE; updated schema_migrations.statements.
   - Reprice preflight `::regprocedure` cast failed when function absent → to_regprocedure.
   - PG17 postmaster refused ("multithreaded during startup") → LC_ALL=en_US.UTF-8.
   - pg sslmode=require verify-full failure locally → uselibpqcompat=true&sslmode=require.
   - Doors regex captured 'mini' → negative lookbehind for comparisons; test expectation about bad fixture removed.
   - Reseq toggle via 'playing' refused (pending bounty obligation) → via 'winner'.
   - Mystery anchor o1 0 matches after settle → relaxed to declaration line; composed PG17 test needed chip_ledger stub.
   - Mystery engine test: null data treated as 0 → explicit null/undefined → NaN.
   - #4270 conflicts (workflow with #4267; csp spec) → merged, took Codex hunks/theirs.
   - Agent tool call blocked ~55 min (run_in_background not supported) → use Workflow for long investigations.
   - Satellite ruling failed: incidents UPDATE requires correction_ref format ("migration <name>", "PR #<n>", "chip_ledger <id>", "correction:<key>", "ruling: <decision>", "verified: <evidence>", or "no-change-needed: <why>") → transaction rolled back twice (verified 0 settlements) — NOT yet fixed.

5. Problem Solving:
   - Solved/live: degraded-engine deploy gate; seat-exit finish refusals (08:22); 08:55 deploy (9284d7ec) and 10:55 deploy (c113fbe7, includes #4274/#4276/#4275/#4277/#4279/#4281/#4285); reprice door (09:05); fe72385b, 798866ae, 5aa7eeba, 9536150e completed with correct places; settle-by-bust-time + bounty door + mystery phase migrations applied 11:31–11:32; satellite creation guard applied 11:38; decided sweep cadence ~11 s; equity pool healthy (0 hard timeouts); equity worker count kept at 1 (decision).
   - Observed/open: supabase_timeout bursts (09:18, 10:59) → table lease proof expiry → mass cash table watchdog kills (KillStorm alert); guard triggers on tournaments disabled (zzzz_freeze_finalized_tournament_prize_pool + six others); fn_settle_tournament_places_by_ruling broken for non-satellite events; satellites/final-table deals still rank recording order; 271 rebuy legs within 10 s (possible double charges) uninvestigated; 15 misallocated completed events (~1,437) + mystery make-goods need audited back-pay door; rakeback lapsed_week_unclosed (known, deliberate); settle rollback file now refuses claim function (mystery patched it).

6. All user messages:
   - (Prior segments, preserved) "I WANT YOU TO READ THIS CONVERSATION AND FIX ANY AND ALL ISSUES LAUNCH A SWARM AND FIX THIS NOW..."; "THEY ARE STOPPED... NOW FINISH UP"; "you need to finish this the fuck up!! everyone is waiting on you!!"; "ALSO IF ITS POSSIBLE... i do not want any watch dogs, i want hard coded fixes that solve this problem and prevent it from breaking or regressing, i want any and all pushes to be published in the order that they come in! is that too much of an ask? or is this not the idle way to do this and fix it from happening again? don't just agree with me, if im wrong tell me and fix this at the root cause of the issue and harden it from regressing or breaking again!"; "Please pick up where you left off, complete the task in full and do not claim success until you have verified that everything is 100% accomplished for this task."; "BRO WTF ?! 90 MINUTES LATER AND IT STILL ISN'T DONE?!"; "WORK ON HARD CODE IMPROVEMENTS TO THE PIPELINE, SO WE AREN'T RELYING ON WATCH DOGS, OR CRONS..."; "finish up everything thats still pending ... DO NOT LEAVE ANYTHING UNFINISHED..."; "1" (approving one-time override); "NO, YOU DECIDE WHATS BEST... STOP ASKING ME"; "WHAT IS LEFT TO DO? HOW ELSE CAN THIS BE IMPROVED, ENHANCED OR OPTIMIZED STILL?"; "1, finish up everything thats still pending ... 2, ONCE YOUR DONE WITH EVERYTHING FROM THE PREVIOUS BUILDS, GO AHEAD AND START THESE: Further improvements worth doing next _ The engine's own finish ranks places by when the elimination was recorded, not when the player busted... _ The bounty door has the same record-time problem. _ A REGISTERING pass still takes about 60 seconds because of one serial count sweep, which could be batched. _ Remaining deploy-pipeline edge cases: a pending rollback can be replaced by a newer run, and a workflow-only fix doesn't start a deploy. _ One CI timing test is flaky. _ There is only one equity worker on the 3-core host."
   - This segment: "THEN YOU MUST FIX THE DEGRADED ENGINE!"

7. Pending Tasks:
   - Fix the satellite ruling's c_ref to an accepted format (e.g. `'migration 20260911110907_a_satellite_never_feeds_a_target_its_finish_refuses'` or `'ruling: ...'`), re-run preflight (counts may change), apply ~/tmp-claude/sat/ruling_apply.sql (not in :55–:00 freeze), verify postflight (.checks.sql POSTFLIGHT A–D), confirm atomic_satellite_finish_refused stops; then push branch fix/satellites-never-feed-a-bounty-target (migration already applied) and ensure engine scheduler change ships.
   - Review and apply Breakfast Turbo c1f15c30 ruling (ruling_c1f15c30.sql; outside :50–:03; bots; make-good optional); push fix/late-status-flip-keeps-paid-ladder and apply its migration 20260911110000 after review.
   - Collect remaining stuck-events workflow results (sweep, orphans: 7aa16fa7 chip drift 10,000; a5aa6984 dca6c345/river222) and act.
   - Ensure PRs merge: #4270 (degraded reads), knockout branch PR, mystery branch PR; verify CI; confirm next deploy ships engine follow-ups (bustOrder, mystery activation) and the doors gate passes.
   - Follow-ups to report/possibly fix: lease-timeout kill storms; disabled guard triggers; by_ruling door broken; satellites/final-table ranking; rapid rebuy legs; back-pay door; settle rollback caveat.
   - Final line-by-line review pass, update tasks, send final summary report to Dan.

8. Current Work:
   Applying the ruling for 14 stuck satellites into Sunday Funday High Roller PKO targets (all horses). Migration 20260911110907 (creation guard) applied at 11:38:34. Preflight at 11:39: c_expected_settle 14, c_expected_cancel 1, c_expected_in_play 1, unexpected 0; all 14 rows passed shape checks; loads ≤ 4. Created ~/tmp-claude/sat/ruling_apply.sql with those constants and ran it twice via psql; both runs rolled back with:
   `ERROR: An incident is not resolved until something stops it happening again. Supply correction_ref as one of: "migration <name>", "PR #<n>", "chip_ledger <id>", "correction:<key>", "ruling: <decision>", "verified: <evidence>", or "no-change-needed: <why>". Got "ruling 2026-09-11 satellites into bounty targets (fix/satellites-never-feed-a-bounty-target)".`
   The failing statement is the incidents UPDATE near line 375 using `correction_ref = c_ref` where `c_ref constant text := 'ruling 2026-09-11 satellites into bounty targets (fix/satellites-never-feed-a-bounty-target)';`. Count query confirmed 0 tournament_satellite_settlements rows were written.

9. Optional Next Step:
   Edit c_ref in ~/tmp-claude/sat/ruling_apply.sql (and the branch file scripts/deploy/2026-09-11-settle-satellites-into-bounty-targets.sql) to an accepted format such as `'migration 20260911110907_a_satellite_never_feeds_a_target_its_finish_refuses'`, re-run the preflight (`sed -n '1,63p' ...checks.sql` via psql) to refresh the three counts, then re-apply the ruling once and verify with the POSTFLIGHT checks and engine logs (atomic_satellite_finish_refused should stop). This continues the task in progress: "Proposed ruling (b) ... Order: apply the migration, then run the preflight and paste its counts into the ruling, then the ruling, then deploy the engine."
