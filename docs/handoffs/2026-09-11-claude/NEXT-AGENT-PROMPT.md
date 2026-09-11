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
3. Execute section 7 (pick-up checklist) in order. Step 1 comes first: verify that the 12:55 UTC cutover to main `4895030e22` (#4270, #4293, #4295) actually happened, and that the horse lane is healthy:
   - `inFlightJobs` ≤ 4
   - `oldestQueuedAgeMs` in the tens of ms
   - `expiredJobs` flat
     If the lane is still at capacity, follow §6.1.
4. The ordered tournament work in §6.4 is safety-critical. Apply the 7 re-sequences BEFORE the wake script and BEFORE merging `backup/claude-2026-09-11/a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw`.
5. Merges to main are blocked. Since 12:20:32 UTC the required check `Stage B Release Freeze` has been part of the `main protection` ruleset, and no workflow emits it. Ask Dan before merging #4292, #4296 or #4299. Never bypass the freeze.
6. §8 is the horse-brain/engine separation design. Present it to Dan with costs. Build it only after he approves.
7. Report to Dan in plain language with numbers. Make operational calls yourself, and tell him when he is wrong.

Raw evidence for every claim is in `docs/handoffs/2026-09-11-claude/evidence/`.
