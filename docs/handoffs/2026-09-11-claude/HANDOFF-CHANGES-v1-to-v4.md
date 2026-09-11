# Club Arena handoff — everything that changed since the 12:33 UTC version (v1 → v4)

**For the agent that received the handoff at or after 12:33 UTC on 2026-09-11. Read this first, then the v4 handoff (`2026-09-11-club-arena-handoff.md`).** Where the two conflict, v4 wins.

## Versions

| Version | Time (UTC) | Where                                                                      | What it added                                                                                                                                          |
| ------- | ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v1      | 12:33      | sent in chat; commit `27ddc47114`                                          | the original handoff                                                                                                                                   |
| v2      | ~12:38     | merged to main in #4299 (`d427d258d0`)                                     | orphans findings, the merge freeze, the two-agent reconciliation                                                                                       |
| v3      | ~13:08     | sent in chat; branch `docs/claude-handoff-2026-09-11-final` (`ee7277c572`) | live deploy verification, the flaky test, lease Option B. The branch copy missed two late edits (timeline row, §6.1 verified numbers); v4 carries them |
| **v4**  | ~13:25     | branch `docs/claude-handoff-2026-09-11-v4` plus this file                  | **all decisions made (§10)** and prompt fixes                                                                                                          |

Exact text diffs: `git diff 27ddc47114 origin/docs/claude-handoff-2026-09-11-v4 -- docs/handoffs/2026-09-11-claude/`.

---

## A. Already done since v1. Do NOT redo these.

1. **The 12:55 deploy of `4895030e22` (#4270, #4293, #4295) went out and is verified.**
   - The first run, `34598480706`, failed at 12:34:40 on a flaky test, and the train handed on to run **`34599636898` → success**.
   - Horse lane at 13:04 UTC, ~277 tables: queue 0-15, oldest ≤ 92 ms, **0 expired**, ~78 jobs/s, average hand 20.7 s.
   - At 12:45 on the old build it was: queue 265-269, oldest 7.6 s, ~258 expired/min, 32 jobs/s, 38.8 s hands.
2. **#4292 (`5a7abc7706`) and #4296 (`6d7b08515c`) are MERGED.** v1 said to wait for CI and merge; don't. They deploy in the **13:55 break**, together with Codex's #4291 and #4294 (also merged, not ours). Verify that deploy.
3. **The merge freeze** (not in v1):
   - At 12:20:32 the required check `Stage B Release Freeze` was added to the `main protection` ruleset (history version 49408418, shared Smarter-Poker account). Nothing produces it, so all merges were blocked.
   - Dan: never authorized, remove globally, never allow back. It was removed at 12:47:26 (version 49411053).
   - Guard: law test on `fix/no-merge-gate-without-a-producer` (`b3338e8cfe`, **PR #4301**, auto-merge).
4. **#4299 (the handoff) merged to main,** but it holds v2. The v4 branch supersedes it.
5. **The satellite ruling applied at 12:11.** v1 already said so; unchanged.

## B. Instructions in v1 that are now WRONG. Replace them.

1. **Lease fix (§6.2):**
   - v1 said to give heartbeats a 4.5 s per-attempt deadline. **Do not ship that alone.** It regresses a slow-but-alive database: with every heartbeat taking ~6 s, every attempt is cut and every dealer expires.
   - **Ship Option B, hedged heartbeats:** start a new heartbeat every 5 s even while an older one is pending, at most 3 in flight; each answer applies its own proof, and the greatest deadline is kept.
   - If you already started Option A, switch to B.
2. **Stuck tournaments** (§6.4, checklist step 5, prompt item 4):
   - v1 said to apply the 7 re-sequences (94 toggles), then the wake script, then a PR from the sweep branch.
   - **Now:**
     1. First run the E2 rehearsal on PG17. The orphans agent showed that live `fn_settle_tournament_places` re-ranks by true bust time when no prize money has moved.
     2. Then R1 for a5aa6984.
     3. Then the 7aa16fa7 ruling with tankChamp at his true bust (D1).
     4. Then the wakes.
     5. Ship the orphans agent's fix (`backup/claude-2026-09-11/freeze-deferred-balance-redrive`), not the sweep branch, by default (D11).
   - If you already applied the re-sequences, no harm (they only move players to true order); continue from step 2.
3. **c1f15c30:**
   - v1 said to pick between two scripts. **Now:** migration `20260911110000`, then `ruling_c1f15c30.sql` (md5 `e688d1621e65bf09dcf3165c94bbf9d3`) as the whole file.
   - **No re-sequence.** The completion door refuses once settled place evidence exists.
   - Record the 121.45 make-good with `makegood_optional.sql`, not waived (D10).
4. **The 79 REGISTERING events:** v1 said to get Dan's OK on the policy. **Now:** the D9 policy, in batches of 10 or fewer, each rehearsed.
5. **Host upgrade:** v1 said not to do it without Dan. **Now:** D2, rescale engine-01 `cpx21` → `ccx23`, gated on a timed rehearsal (3 minutes or less), in a quiet no-deploy break after `readyForRestart`.
6. **Horse brain (§8):** v1 said it needs Dan's approval. **Now: build it** (D5). The box is a `ccx23` in `ash` on a private network, provisioned at shadow-mode time.
7. **Make-good door:** v1 said to design it with Dan. **Now:** build it on `ca_manual_adjustments` 'proposed' rows (D8).
8. **Rollback drill:** v1 said "when Dan allows". **Now:** no production drill (D12 context, §6.5).
9. **Prompt item 6** (v1: present the design to Dan) is replaced: execute §10.

## C. New information v1 did not have (details in v4)

- **Orphans report (§6.4 E):**
  - 7aa16fa7 +10,000 chips: 145,000 created minus 135,000 lost; tankChamp +115,000 from a deleted repair re-seat.
  - a5aa6984 +2,500.
  - **31.00 owed** for undelivered rebuys (`MAKEGOOD_undelivered_rebuy_legs_readonly.sql`).
  - river222: refund, not honour.
  - Rulings R1/R2/R3 are in `~/Documents/.agent-trees/club-arena/freeze-deferred-balance-redrive/docs/changelog/2026-09-11-freeroll-rulings-7aa16fa7-a5aa6984/`. R1 is rehearsed through final settlement: 99.30 paid in true order.
  - That agent ran a full-schema `pg_dump` holding ACCESS SHARE locks on ~1,366 tables for ~4 minutes. Nothing waited.
- **E2:** the two agents disagree about the re-sequences. **E3:** there are two competing balance fixes.
- **F2:** PKOs `3f19bd70` (66 entrants) and `a21c0cb6` (155) have bounty pools of 2,310.00 and 5,425.00 holding **no money**; bounties unpaid.
- **Decisions D1-D12 (§10)** cover:
  - tankChamp → 36th (1.94), true bust at hand 8775892
  - the host rescale
  - equity-worker priority
  - token scope (agents cannot change credentials; until the token is reissued, check the ruleset every session)
  - the horse brain
  - lease Option B
  - satellite feeders stay refused
  - the make-good door
  - the 79 events
  - c1f15c30
  - the balance fix
  - re-enable all 7 disabled guard triggers after rehearsal
  - retire `fn_settle_tournament_places_by_ruling` for non-satellite use
  - bust-time ranking for satellites and final-table deals
  - investigate the 271 rebuy legs
  - de-flake `CryptoRandom.test.ts`
- **Hetzner facts:**
  - engine-01 is `cpx21` (3 shared vCPU / 4 GB) in `ash`, id 132435945, €37.49/mo gross
  - `ccx23` in `ash` is €102.99/mo
  - token in `.env` as `HETZNER_API_TOKEN` (never print)
- **Deploy train behaviour:** a failed run's Verdict hands on with a fresh `workflow_dispatch` (seen at 12:34:43).
- **Flaky deploy-blocking test:** `server/src/engine/CryptoRandom.test.ts` "deals the ace of spades to a uniform position".
- **Lane capacity is still the ceiling:** host ~83-87% CPU, 12.7% idle at 13:03.
- **This Cowork session stopped taking production actions at ~13:20 UTC.** You are the sole operator.

## D. Unchanged from v1

- rules of engagement (§4)
- access and tooling (§5)
- the PR ledger through #4295
- migrations and rulings applied (§3.2, §3.3)
- the horse/engine anatomy (§1.2)
- the evidence folder
