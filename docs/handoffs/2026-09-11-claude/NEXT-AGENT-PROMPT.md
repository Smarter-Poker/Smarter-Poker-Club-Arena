# Prompt for the next agent (paste as your first message)

You are taking over live operations of **Club Arena** (the Smarter Poker engine and its database) from a Claude Cowork session that ended 2026-09-11 ~12:40 UTC. The operator is Dan.

1. Read `docs/handoffs/2026-09-11-claude/2026-09-11-club-arena-handoff.md` from start to finish. It is in the repo on `main` once the docs PR merges, on branch `docs/claude-handoff-2026-09-11`, and in `~/Documents/club-arena-work/handoffs/2026-09-11-claude/` on the Mac. Read CLAUDE.md as well.
2. Obey section 4 (rules of engagement) with no exceptions:
   - never print secrets
   - never `--no-verify`, never rebase, never force
   - migrations only outside :50-:03 UTC, as one transaction with lock_timeout
   - no money or seat writes :55-:00
   - engine restarts only through the deploy train in the :55 break
   - never claim success without end-to-end production evidence
3. Execute section 7 (pick-up checklist) in order. The 12:55 cutover to `4895030e` (#4270, #4293, #4295) was verified at 13:04 UTC: queue 0-15, 0 expired, ~78 jobs/s, hands 20.7 s. Keep checking that the horse lane stays healthy under load:
   - `inFlightJobs` ≤ 4
   - `oldestQueuedAgeMs` in the tens of ms
   - `expiredJobs` flat
     If the lane is still at capacity, follow §6.1.
4. The ordered tournament work in §6.4 is safety-critical. Apply the 7 re-sequences BEFORE the wake script and BEFORE merging `backup/claude-2026-09-11/a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw`.
5. The unauthorized `Stage B Release Freeze` required check was removed at 12:47:26 UTC on Dan's order, and it must never come back. If it, or any required check that no workflow produces, reappears in the `main protection` ruleset, remove it and tell Dan. #4292 and #4296 are merged and deploy at 13:55; verify them.
6. §8 is the horse-brain/engine separation design. Present it to Dan with costs. Build it only after he approves.
7. Report to Dan in plain language with numbers. Make operational calls yourself, and tell him when he is wrong.

Raw evidence for every claim is in `docs/handoffs/2026-09-11-claude/evidence/`.
