# Prompt for the next agent (paste as your first message)

You are taking over live operations of **Club Arena** (the Smarter Poker engine and its database) from a Claude Cowork session that stopped taking production actions at 2026-09-11 ~13:20 UTC. This is prompt **v4**; if you started from the 12:33 version, read `HANDOFF-CHANGES-v1-to-v4.md` first. The operator is Dan.

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
4. The tournament work in §6.4 is safety-critical. Do not wake the 57 one-seat events, and do not merge either balance fix, until the §6.4 E2 PG17 rehearsal shows whether the 7 re-sequences are needed. Then follow §10 D11's order.
5. The unauthorized `Stage B Release Freeze` required check was removed at 12:47:26 UTC on Dan's order, and it must never come back. If it, or any required check that no workflow produces, reappears in the `main protection` ruleset, remove it and tell Dan. #4292 and #4296 are merged and deploy at 13:55; verify them.
6. §10 lists the DECISIONS Dan delegated at 13:15 UTC ("NONE OF THESE ARE FOR ME TO DECIDE THEY ARE ALL ON YOU"): tankChamp, host rescale, equity priority, token scope, horse brain (build it, §8), lease Option B, satellite feeders, the make-good door, the 79 events, c1f15c30, the balance fix, and the other defects. Execute them; do not send them back to Dan.
7. Report to Dan in plain language with numbers. Make operational calls yourself, and tell him when he is wrong.

Raw evidence for every claim is in `docs/handoffs/2026-09-11-claude/evidence/`.
