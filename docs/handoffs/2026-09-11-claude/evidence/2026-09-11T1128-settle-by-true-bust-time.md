# Workflow evidence: settle-by-true-bust-time

- run: wf_413aaebf-ebf
- finished: 2026-09-11T11:28:27.531Z
- status: completed
- agents: 4
- summary: Implement settle-by-true-bust-time + bounty door stamp/orphan rule on the knockout branch, then adversarially verify

## implementation

**Report: settle now ranks each bust by its hand's commit time (branch `fix/a-bust-is-ranked-by-when-it-happened`, not pushed, not applied)**

All seven functions are rewritten and proved in PostgreSQL 17, and the migration is ready for you to apply. Settle now ranks every bust by the commit time of its hand, read from the knockout witnesses, and both doors stamp that same time. Measured read-only at 09:35 UTC, 8 RUNNING events would pay a different player, 92.54 chips in all.

## 1. Commits (worktree `/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-knockout-code`)

- `8ce8e50ab1` engine: `server/src/tournament/bustOrder.ts` states the F4 decision (engine records in hand-number order for the PKO watermark, its place is provisional, settle decides by commit time, hand-for-hand out of scope). It also adds `knockoutCandidateReadIsComplete` for F9. `TournamentManagerEliminations.ts` reads the generations with `count: 'exact'` and treats a short read as unreadable. Tests: `bustOrder.test.ts` (+4), `TheSweepReachesTheTable.test.ts`.
- `016d393f20` DB: amends the unapplied migration so it is still one migration in one transaction. Also includes the harness (`bootstrap.sql`, `installed.sql`, `probe-helpers.sql`, `source-manifest.json`, scenario 07 rewritten, scenarios 12–25), the law test, `docs/laws.d` and the changelog.
- `6515412c67` merge of origin/main (clean; none of main's migrations redefines or pins these functions).
- `6b0da427b2` fixes main's new `TheSweepAsksIndependentQuestionsTogether.test.ts`. Its fake PostgREST had no `.order()` and returned no count, so it broke once merged with this branch.

## 2. Migration `supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql`

One BEGIN/COMMIT with `lock_timeout 5s` and `statement_timeout 30s`. The header says it must not be applied in minute :50–:03 UTC. No data DML and no backfill: settle reads the witnesses, so rows recorded before the migration are ranked by their hands too.

| function                                      | live md5 (before)                | new md5 (after)                  |
| --------------------------------------------- | -------------------------------- | -------------------------------- |
| fn_settle_tournament_places                   | d0262f4928b12eea1cc5e9175cbf2737 | a451a9a3205185ee4b284ea8d8a44f35 |
| fn_eliminate_player_legacy_candidate_20260907 | f596d731cacf8d7e62a4549204ce73fc | 66de5a1bd9a520a6afdfd36c82c83908 |
| fn_claim_bounty_legacy_candidate_20260907     | 590f0f782e127288f33763bbab8c89f0 | 29e95c342e7ada09715bc7aa1d248c6d |
| fn_eliminate_tournament_player_atomic         | b4937067d9bf337e1466095b9e1d5424 | 66b721eb896d927f2fedb0b9c739d0fb |
| fn_claim_tournament_bounty_elimination        | 876456f79250a307292dc6f2ae1564f3 | a908e937ed1fd193603d383bbfabebc0 |
| fn_normalize_tournament_final_standings       | ad865880f99bc28896bec03c66ae55a9 | 45b06c3f8be02940d130c427d5a32519 |
| fn_ca_tournament_finished_but_not_completed   | e1eebfe28f393f2617c0a1ac93c2583a | 6f153669e4b6b149bfccd36ad575bda8 |

- **Pinned but not replaced:** `fn_ca_latest_committed_knockout_candidate` (0602827901be20bbb6e0dce6ece17f94), `fn_prepare_tournament_place_obligations` (ca0abbc6d297f3009143676261d8cf19), `fn_bounty_obligation_has_complete_marker` (bd29069e8d07bedf84e24e57242c2afe).
- **Preflight:** accepts only the live or the new md5, and also checks owner, ACL, SECURITY DEFINER and config. Evaluated as a read-only SELECT on production at about 09:48 UTC: all 10 checks pass.
- **Postflight:** requires the new md5 plus the same owner, ACL and config.

What changed, by review finding:

- **F1/F2, settle:** each eliminated row's bust time is derived in the same statement. It is the commit time of the hand of the player's latest `eliminated` generation, plus 1 microsecond per earlier rank in that hand (smaller starting stack first, then user id). With no witness it uses `eliminated_at`; with neither it refuses (P0404). Ties go to `elimination_sequence DESC`, then id.
  - `elimination_sequence` still alone decides the winner.
  - The mismatch check and the renumbering use the same order.
  - The place-evidence refusal is kept.
  - One compatibility exception: a COMPLETING event whose places exactly match the recording-order ladder replays as paid. This is `c1f15c30`, the only COMPLETING event, paid 09-08.
  - COMPLETED events are never renumbered.
- **Bounty door stamp:** same stamp and same `knockout_bust_time_unproven` refusal as the non-bounty door.
- **Bounty orphan rule:** same rebuy-leg proof as the non-bounty door, plus the older generation's head must be closed. That means no obligation for its hand or seat, or one that is settled with a complete marker. A generation with a pending obligation stays refused, because collecting that head after the newer claim would pay it against a player recorded under a newer head.
- **F3:** the normalizer's money gate counts only place money: payouts whose source is not a bounty or satellite source, and obligations of kind `place` or `bubble_protection`.
- **F6:** the alarm measures from `GREATEST(max(eliminated_at), max(resolved_at) of eliminated candidates)`, which is the recording time.
- **F7:** event and player ids are removed from all function bodies. The wrong claim that the door would resolve `dca6c345` is corrected.
- **F8:** both write halves refuse when a posted rebuy leg follows the bound generation and a later hand of the event deals the player in.
- **F5:** the header now says `eliminated_at` is a mixed column from here on.

## 3. Tests

- **PG17 probe** (`scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh`, byte-exact live bodies): 25 scenarios.
  - 17 FIXED scenarios fail on the live bodies with a probe assertion (not a script error) and pass after the migration applied twice: 01–03, 05–09, 12, 13, 14, 15, 17, 20, 21, 23, 24.
  - 8 KEPT scenarios pass on both: 04, 10, 11, 16, 18, 19, 22, 25.
  - Your checklist:

| requirement                                  | scenario(s)                                                                     | on live bodies                              |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| (a) late bust is paid its true place         | 12, and settle in 14                                                            | live pays a 30.00; fixed pays b             |
| (b) same-hand busts rank by stack            | 13                                                                              | fails on live                               |
| (c) bounty door stamps the bust time         | 14                                                                              | fails on live                               |
| (d) event already in true order is untouched | 15                                                                              | live renumbers it                           |
| (e) place evidence still refuses             | 16 (KEPT); 17 (FIXED: evidence under a late bust now refuses)                   | 16 refuses on both; 17 pays a 30.00 on live |
| (f) COMPLETED replays unchanged              | 18 (KEPT); 19 (COMPLETING compatibility, KEPT)                                  | pass on both                                |
| (g) F8 rows refused, not mis-stamped         | 20 (all six production shapes, bounty-door variant, rebuy-never-seated control) | live accepts them                           |
| other new cases                              | 21 and 22 bounty orphans, 23 alarm, 24 fail-closed, 25 winner rule              | —                                           |

- Scenario 19 fails if the compatibility clause is removed, so it really tests that clause.
- **Law test** (`tests/a-bust-is-ranked-by-when-it-happened.law.test.ts`): 40/40 pass. It includes a byte check that settle equals its live body outside the ranking block, and the same for the bounty write half and the alarm.
- **Server:** full suite passes (674 files, 9,283 tests); typecheck clean.
- **Root:** 1,388 files pass. 2 fail because `@capacitor/*` packages are missing from the shared local `node_modules` (`nativeStoreAndPush`, `nativeForegroundAndLocalNotifications`); they don't touch this change. The migration version-collision check passes.

## 4. Production measurement (read-only, 09:35 UTC)

8 RUNNING events would pay a different player, 92.54 chips in total:

| event    | kind           | players changed                                                         | chips moved |
| -------- | -------------- | ----------------------------------------------------------------------- | ----------- |
| 9536150e | mystery bounty | 2 (8339a681 goes from 3rd/30.06 to 19th; 5a21988c goes from 4th to 3rd) | 30.06       |
| bee519fa |                | 6                                                                       | 22.46       |
| f922df63 |                | 8                                                                       | 20.56       |
| 313a274b |                | 4                                                                       | 9.78        |
| 7aa16fa7 |                | 19                                                                      | 6.08        |
| 8e16cdb4 |                | 6                                                                       | 2.51        |
| a5aa6984 |                | 2                                                                       | 1.05        |
| d7997aef |                | 2                                                                       | 0.04        |

- For every player whose money moves, the witness hand is their last hand in the event's history and no rebuy leg follows it.
- `fe72385b` and `5aa7eeba` (re-sequenced at 08:38) already match the new order, so nothing moves.
- No RUNNING event has place evidence, and no eliminated row lacks both a witness and a time, so no new refusal fires today.
- Cost: settle's derivation on 7aa16fa7 (381 rows) takes 37 ms warm, 1.6 s cold. The doors add about 10 ms per bust for the rebuy-leg lookup.

## 5. F8-shaped rows (listed, not fixed; all out of the money)

- 798866ae (COMPLETED): 22af2652 (86th), 6d6b3cc2 (85th), 20a40df1 (70th), 45a5e770 (71st)
- 7aa16fa7 (RUNNING): 71efcdb3 (369th)
- a5aa6984 (RUNNING): 55256246 (95th)
- My query also found a seventh: 2e7240ea 2a763abd (COMPLETED 09-08, 4th, prize 0).

## 6. Risks not retired

- **hand_atomic_commits prune (most important).** `sp_prune_hand_history` (cron 117) deletes hand_atomic_commits rows for horse-only hands older than 7 days once their generation is consumed. Settle then falls back to `eliminated_at`, which for pre-migration rows is the recording time. The earliest this can bite is about 2026-09-15 15:00 UTC, and only for events still RUNNING then. Two possible fixes, your call: have the prune keep commit rows referenced by any generation of a non-COMPLETED event, or add the generation's capture time (min `created_at` per hand) as a second witness. Capture time precedes the commit by 1 ms to 6.9 s across about 32k candidates.
- **Bubble protection.** An engine-created bubble obligation for a player whose place moves makes settle refuse ("malformed bubble obligation evidence"). Only 2 such obligations have ever existed; none are in RUNNING events.
- **Hand-for-hand simultaneity** is not modelled.
- **F8 guard depends on hand history.** It needs `hand_history`, which is pruned for horse-only hands after 7 days.
- **Bounty orphan rule** has no production data (no orphans exist today); it is proven only by scenarios 21 and 22.
- **Normalizer and prepare** still rank by `eliminated_at`. They are not called by the server.
- **`a5aa6984 dca6c345`** holds 2,500 chips with no seat and cannot be recorded. If it ever is, it ranks 100th by its 09-09 06:13 hand rather than 2nd; whether its unseated 1.00 rebuy is refunded needs an operator decision.
- **Deploy order.** The engine (b819a7206f + 8ce8e50ab1) must deploy with or before the migration, or PKO watermark order can break.

## 7. Apply sequence (you run it, once, never in a retry loop)

1. Deploy the engine build containing `8ce8e50ab1` (plus `b819a7206f`) first, or together with the migration.
2. Check the time: `m=$(date -u +%-M); [ $m -ge 4 ] && [ $m -le 49 ] || exit 1`
3. Apply:
   `psql "$PROD" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql`
   The file has its own BEGIN/COMMIT, so do not add `-1`. On a 55000 or break-window refusal, read the error and stop.
4. Record history under the file's own version:
   ```
   psql "$PROD" -X -v ON_ERROR_STOP=1 <<'SQL'
   \set content `cat supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql`
   INSERT INTO supabase_migrations.schema_migrations (version,name,statements)
   VALUES ('20260911062048','a_bust_is_ranked_by_when_it_happened',ARRAY[:'content'])
   ON CONFLICT (version) DO NOTHING;
   SQL
   ```
   Don't use MCP `apply_migration`: it records its own timestamp as the version, which won't match the file name.
5. Verify read-only: `SELECT p.oid::regprocedure, md5(p.prosrc), p.proacl FROM pg_proc p WHERE p.proname IN (…7 names…)` should return the "after" md5s above with unchanged ACLs.

## verdicts

```json
[
  "**Verdict: ship-with-fixes.** Nothing I found pays the wrong player or pays twice on today's data. One gap does let the fix silently switch back to recording order, and it is a two-line change before apply (finding 1).\n\n## Checked and holding\n- **Live function bodies:** the md5s match the report's \"before\" column at 09:56 and 10:30 UTC, and every preflight condition holds.\n- **PG17 probe:** I re-ran `scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh`. The 17 FIXED scenarios fail on the live bodies with a probe assertion, and all 25 pass after the migration is applied twice (EXIT=0).\n- **COMPLETED events cannot be renumbered.**\n  - In `fn_settle_tournament_places` the COMPLETED branch skips the ranking block.\n  - `fn_complete_tournament_terminal_pre_seat_guard` returns the stored receipt first, and refuses a COMPLETED event that has no receipt.\n  - Scenario 18 covers the replay.\n- **No new settle refusal fires today.**\n  - No RUNNING event has place evidence (positioned payouts or place obligations).\n  - In RUNNING and COMPLETING events, 0 of 4,930 eliminated rows lack both a witness and a time.\n  - The 39 rows with no witness are all in c1f15c30. Its positions match recording order, so the COMPLETING compatibility clause replays it as paid.\n  - Every eliminated row's witness is its latest generation, and no player has more than one 'eliminated' generation.\n- **No new door refusal fires today.** Of the 8 pending generations in RUNNING events, 7 have no rebuy leg after capture. The eighth is dca6c345, which both the old and new doors refuse as `not_busted` (it has 2,500 chips).\n- **The bounty rebuy path is not caught by the new rebuy-leg (F8) check.** `process_tournament_rebuy` calls `fn_ca_settle_bounty_rebuy_generation_v1`, which calls the bounty write half, before the money core posts that rebuy's own leg.\n- **Rebuy and re-entry legs:** both are posted with category 'rebuy', so the new rules cover re-entries.\n- **Every player whose money moves:** the witness hand is their last hand in hand_history, and no rebuy or re-entry leg comes after it.\n- **F8-shaped rows in RUNNING events:** exactly two, 7aa16fa7 71efcdb3 and a5aa6984 55256246. Both are out of the money under any order: their last hands put their true places at about 58th (39 paid) and about 60th (10 paid).\n- **Spins and SNGs:** 0 moves across 36 RUNNING events.\n- **Candidate read cap (F9):** at most 4 generations per player per event in the last 7 days, so a 40-player chunk reads at most 160 rows.\n- **Other payers:** the server never calls the mid-event bubble payer (`fn_settle_tournament_bubble_protection`). No active path pays from the door's provisional position or prize.\n\n## Recomputed at 10:25 UTC (the 92.54 figure is out of date)\n8 RUNNING events would pay a different player, 67.46 chips in total. 9536150e is gone: it was re-sequenced and COMPLETED at 10:17, paying 5a21988c 3rd (30.06), which is already what the new rule gives. e3ef32fd is new since 09:50.\n\n| event | chips moved | gaps between swapped busts | cause |\n|---|---|---|---|\n| bee519fa | 22.46 | 270 of 271 pairs \u2265 60 s | recorded hours late |\n| f922df63 | 20.56 | all 460 pairs \u2265 1,407 s | recorded hours late |\n| 313a274b | 9.78 | 0.9\u20134.8 s | near-simultaneous busts at different tables |\n| 7aa16fa7 | 6.08 | 34 ms\u201333 s | near-simultaneous busts at different tables |\n| e3ef32fd (PKO) | 4.98 | 5.2\u20135.5 s | near-simultaneous busts at different tables |\n| 8e16cdb4 | 2.51 | 19 ms and 246 ms | near-simultaneous busts at different tables |\n| a5aa6984 | 1.05 | 2.3 s | near-simultaneous busts at different tables |\n| d7997aef | 0.04 | 1.4 s | near-simultaneous busts at different tables |\n\n## Findings\n\n**1. MEDIUM \u2014 Once a witness hand is pruned, settle falls back to recording order.**\n- **Mechanism:**\n  - `sp_prune_hand_history` (cron 117, every 10 minutes) deletes `hand_atomic_commits` rows for hands with `has_human` not true once they are 7 days old. It spares a hand only if a *pending* candidate names it; an 'eliminated' candidate does not protect it.\n  - Settle's subquery uses an inner join to `hand_atomic_commits`. When the commit row is gone it falls back to `eliminated_at`, which for every pre-migration row is the time it was recorded.\n- **Exposure:**\n  - All 4,855 witness hands of RUNNING events have `has_human=false`. The earliest was dealt 09-08 17:53, so pruning can start 09-15 17:53.\n  - 7aa16fa7 has been RUNNING since 09-08 17:00, has dealt no hand since 09-11 02:00, and has 4 live players.\n  - a5aa6984 cannot finish until an operator resolves dca6c345, because two players read 'playing'. Its witness hands become prunable from 09-16 05:50.\n  - The rows that move in both events were recorded in the 09-10 12:46\u201312:49 backlog flush, 11.4 hours late.\n  - For scale, the longest start-to-complete over 7,536 settlements in the last 30 days was 2 days 4 hours.\n- **Also:** a COMPLETING event settled in the new order and retried after its witnesses are pruned would fail the compatibility clause, which only accepts recording order, and would refuse.\n- **Proof (PG17, scratch copy of the fixture):**\n  - Setup: busts d 10:00, c 10:10, a 10:20, b 10:30. a and b are recorded within 5 s; d and c in a 13:00 flush. Then the commit rows for d's and c's hands are deleted.\n  - Fixed bodies pay `1:f:50.00,2:c:30.00,3:d:20.00`, which is the live bug.\n  - Without the delete they pay `2:b:30.00,3:a:20.00`.\n- **Fix (tested):** in both ranking queries in settle, add `k.created_at` to the inner select, change to `LEFT JOIN public.hand_atomic_commits a`, and use `COALESCE(a.committed_at, c.created_at) + <same-hand offset>`. Then update the postflight md5.\n  - Candidate rows are never pruned, and capture comes before commit by 4 ms (median), 241 ms (p99), 6.9 s (max) across 32,482 candidates.\n  - With this change the adversarial scenario pays b and a correctly, and scenarios 01\u201305 and 12\u201325 still pass.\n  - Alternative: have the prune keep hands named by any candidate of a non-COMPLETED event.\n\n**2. LOW \u2014 Satellites and final-table deals still pay by recording order, and the header overclaims.**\n- The engine settles satellites through `fn_settle_satellite_tournament` \u2192 `fn_settle_satellite_tournament_pre_money_path_gate`, which still ranks with `row_number() OVER (ORDER BY tp.elimination_sequence DESC, tp.id ASC)` and awards tickets and the remainder by that order. `fn_settle_tournament_final_table_deal` uses `ORDER BY tp.elimination_sequence DESC NULLS LAST`.\n- The header says \"Every tournament finishes through \u2026 fn_settle_tournament_places\", which is false for these.\n- No money is affected today: none of the 164 satellites completed in the last 48 hours and no RUNNING satellite would award a seat or remainder differently. (01f1a800 swaps 4th and 7th, but its remainder is 0.00.)\n- **Fix:** state the gap in the header and changelog; follow up on the satellite path separately.\n\n**3. LOW \u2014 The report misstates the measurement and its cause.**\n- The current figure is 67.46 chips, not 92.54 (table above).\n- Only bee519fa and f922df63 (43.02 chips) are late recordings in the header's sense.\n- The other 24.44 chips depend on commit-time gaps of 19 ms to 33 s between hands at different tables. The engine records in deal order and settle ranks by completion order, which is the F4 decision working as designed. They are not latency artifacts: capture order agrees with commit order in every swapped pair.\n- Two players who bust in the same hand with equal hand-start stacks are ordered by user id rather than splitting the prize as TDA does. 7aa16fa7 has 3 such pairs in the money: 14th/15th (4.13/3.90), 21st/22nd (2.98/2.88), 38th/39th (1.86/1.84).\n- **Fix:** restate the numbers, and confirm the user-id tiebreak is intended.\n\n**4. LOW \u2014 A `knockout_bust_time_unproven` refusal strands an event silently.**\n- After 3 refusals the sweep skips the player (`BUST_REFUSAL_SKIP_AFTER=3`, `/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-knockout-code/server/src/tournament/TournamentManagerEliminations.ts` around line 1084). The event can then never finish, because two players stay 'playing'.\n- Cron 304's alarm only fires when one or fewer players are alive, so nothing reports it.\n- The live door recorded such a player at the wrong place and the event finished; the new door leaves the event stuck. No such player exists today.\n- 2e7240ea 2a763abd shows the shape: captured 17:42:08, rebuy legs at 17:42:11 and 17:42:14, then 177 more hands up to 19:24:52. Its recorded 4th (unpaid) is correct; its witness hand would place it 24th.\n- **Fix:** raise a financial alert on this refusal reason, or add an operator door.\n\n**5. LOW \u2014 A bounty orphan with no obligation never pays its knocker.**\n- The orphan rule resolves a pending generation that has no obligation, so that head was never collected. On a rebuy the money core sets `current_bounty = COALESCE(current_bounty,0) + v_bounty_head`, so the uncollected head rolls into the next knockout and is paid to that knocker instead.\n- No orphans exist today (0 pending generations with a later generation).\n- **Fix:** document this, or require the head to be zero before resolving.\n\n**6. INFO \u2014 dca6c345 in a5aa6984.**\n- It is 'playing' with 2,500 chips and no seat. Its only generation is hand 8569325 (09-09 06:13:09). A rebuy leg posted at 06:28:26, after its prompt closed at 06:13:39, and it was never dealt another hand.\n- If an operator zeroes its chips, the new door stamps the 06:13 hand and settle ranks it 100th, since none of the 98 eliminated players busted earlier. The live rule would pay it 2nd. The rebuy-leg check does not fire because there is no later hand. Whether to refund its 1.00 rebuy is still an operator call.\n\n**7. INFO (out of scope, not investigated).** 271 rebuy legs were posted less than 10 s after the same player's previous rebuy leg in the same event (55 player-events, 09-06 11:26 to 09-09 05:10). 2a763abd above is one. These may be double charges from the rebuy chain.\n\nThe worktree is untouched (`git status` clean at 6b0da427b2), all production access was read-only SELECTs, and the scratch directory `/tmp/verif-money` has been removed. The migration reviewed is `/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-knockout-code/supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql`.",
  "**Verdict: ship-with-fixes.** The migration is safe to apply as written. The fixes below are a scope correction, operational steps and follow-ups. None of them changes the 7 function bodies unless you decide to widen coverage.\n\n**Findings**\n\n1. **MEDIUM: satellites and final-table deals still pay in recording order, and the header says otherwise.**\n   - Evidence, routing: `fn_complete_tournament_terminal_pre_seat_guard` refuses satellites (\"is a satellite; use its whole-pool authority\"). It sends deal events to `fn_settle_tournament_final_table_deal`. The server settles satellites through `fn_settle_satellite_tournament` (`satelliteSettlementRpc.ts:74`), which calls `fn_settle_satellite_tournament_pre_money_path_gate`.\n   - Evidence, ordering: both of those authorities still renumber by `elimination_sequence DESC` (satellite settle live body L475; deal settle L362, L808, L1675).\n   - Evidence, header: migration header line 27 and changelog line 25 say every tournament finishes through `fn_settle_tournament_places`. That is not true for these two paths.\n   - Live money at stake: satellite **01f1a800**.\n     - It is RUNNING with 2 players left; pool 600.00, ticket 180.00, so 3 seats plus 60.00 remainder to place 4.\n     - Place 4 is 6313dbdb (seq 16320; last hand 8845912 at 09-10 04:18:41, recorded 07:45:58).\n     - 1c1c117c (seq 12689; last hand 8852788 at 05:04:09, recorded 05:04:21) sits 7th.\n     - Neither player rebought. After this migration the 60.00 still goes to 6313dbdb.\n   - Exposure: 14 RUNNING satellites; 1,662 COMPLETED satellites in 7 days (in the last 48h, 11 had more than 3 entrants and none moved a seat or remainder); 2 final-table-deal payouts in 7 days.\n   - Fix: either apply the same bust-time ranking to both authorities (md5 pins plus FIXED scenarios), or state the exclusion in the header and changelog. In either case, re-sequence 01f1a800 by hand before it finishes.\n\n2. **LOW: the new F8 refusal is permanent and cron 304 cannot see it.**\n   - Evidence: once a door returns `knockout_bust_time_unproven`, no newer generation can appear, so it refuses every time.\n   - The engine skips the player after `BUST_REFUSAL_SKIP_AFTER` refusals (`TournamentManagerEliminations.ts` ~L1040-1078). The player stays `playing`, so settle refuses with \"still has N live players\".\n   - The alarm filter is `alive <= 1`, and `alive` counts `playing`/`active`/`registered`, so it never fires.\n   - Nobody would trip it today: the only RUNNING player whose latest generation is pending with a rebuy leg after it is a5aa6984 dca6c345, who holds 2,500 chips.\n   - Fix: page on this refusal reason, or make the alarm count zero-chip, seatless `playing` rows.\n\n3. **LOW: the hand-history prune can remove settle's witness.** The implementer flagged this; I confirmed it.\n   - Evidence: `sp_prune_hand_history` (cron 117) deletes `hand_atomic_commits` and `hand_history` for horse-only hands older than 7 days (`horse_retention_days`=7). It protects only hands with a `state='pending'` candidate, not `eliminated` ones.\n   - After a prune, settle falls back to `eliminated_at`, which is the recording time for rows written before the migration. The F8 guard also loses the hand history it reads.\n   - Oldest RUNNING event: 7aa16fa7, started 09-08 17:00, 4 players left.\n   - Fix: before about 09-15 17:00 UTC, make the prune also keep hands referenced by any candidate of a tournament that is not COMPLETED or CANCELLED.\n\n4. **LOW: there is no reviewed rollback script.** `installed.sql` cannot serve as one, because it also defines other functions and triggers. Fix: prepare a reverse script that restores the 7 live bodies, with a preflight that accepts only the new md5s.\n\n5. **INFO: the report's money table is stale.** 9536150e (the largest item, 30.06) is now COMPLETED. It was re-sequenced first: seq 33065-33087 are in bust order and 5a21988c was paid 3rd. Re-measure right before applying.\n\n6. **INFO: the migration takes brief locks on user tables, not only catalog rows.**\n   - Evidence: in a PG17 fixture, with ACCESS EXCLUSIVE held on the tables, the apply failed after 5s with \"lock timeout\", context \"compilation of PL/pgSQL function fn_settle_tournament_places near line 17\" (a `%ROWTYPE` declaration). It rolled back cleanly and the live md5s were unchanged.\n   - Without contention, `pg_locks` just before COMMIT shows only catalog relations plus `pg_toast_1255`, so no user-table lock is held to the end.\n   - Production event triggers will write rows during the apply: the DDL watchdog log, and a no-op `privileged_function_lock` upsert (all 7 functions are already listed). The GRANT sweep is also a no-op, since no locked function has anon/PUBLIC execute. The XP-ban and retired-RPC guards don't match these names.\n   - No fix needed.\n\n**Checked and fine**\n- **Preflight against production now:**\n  - At 09:56 and 10:31 UTC, the 7 replaced bodies and 3 pinned bodies all match the \"before\" md5s.\n  - All 10 preflight conditions, run as plain SELECTs, pass at 10:06 and 10:31.\n  - The new body md5s computed from the file text match the postflight values.\n- **Diff against the live definitions:**\n  - Headers are byte-identical for all 7: signature, defaults, return type, language, SECURITY DEFINER, `SET` clauses.\n  - Body changes are only where intended (settle 5 hunks, non-bounty write half 3, bounty write half 3, non-bounty door 4, bounty door 4, normalizer 4, alarm 1).\n  - No event or player ids remain inside function bodies.\n- **Attributes:** owner, ACL, secdef, proconfig, volatility, parallel and cost are identical after applying twice to my own fixture, and no new functions appear.\n- **File contents:** outside the function bodies there is only BEGIN, lock_timeout 5s, statement_timeout 30s, the preflight, 7 `CREATE OR REPLACE`, the REVOKE/GRANT restatements, the postflight and COMMIT. No data DML, no table DDL, no probe.\n- **Harness:** 17 FIXED scenarios fail on the live bodies with a probe assertion and pass after applying twice; 8 KEPT scenarios pass on both. My own fixture applied twice cleanly (exit 0 both times).\n- **Schema:** PL/pgSQL does not check column references at CREATE time, so I checked by hand that every table and column the new SQL uses exists in production with compatible types.\n- **No \"more than one row\" error:** `hand_atomic_commits` is unique on `hand_id` and on `hand_number`, so settle's scalar subquery returns at most one row.\n- **Performance on production:**\n  - Settle's ranking query on 7aa16fa7 (381 eliminated, the largest RUNNING event): 21.8 ms warm, all index paths.\n  - The alarm query across 165 RUNNING events: 5.9 ms.\n  - The F8 hand-history lookup: 243 ms cold. It runs only when a rebuy leg follows the bound generation, and a normal rebuy calls the bounty write half before its leg is posted, so ordinary rebuys never reach it.\n- **Production state:**\n  - No RUNNING event has positioned payouts, place or bubble obligations, or an eliminated row with neither a witness nor a time.\n  - c1f15c30 (COMPLETING) matches the recording-order ladder, so it replays as paid.\n  - No orphaned generations in RUNNING or COMPLETING events.\n  - Only 2 eliminated rows have a witness older than their last hand (71efcdb3 369th, 55256246 95th), both out of the money.\n  - Across 32,054 eliminated candidates, `resolved_at` is never earlier than `eliminated_at`, so it is a sound recording time for the alarm.\n  - Busted players never appear in later hand-history rows, so the F8 guard cannot misfire on seated players who are sitting out.\n\nScratch directory `/tmp/vbust` (fixtures, local cluster, captures) has been removed. The worktree is clean at 6b0da427b2."
]
```

## final

Nine of the eleven verifier findings are fixed and committed on `fix/a-bust-is-ranked-by-when-it-happened` (HEAD `57be4f3940`, not pushed, not applied). Two I judge wrong, with evidence below. Satellites and final-table deals I documented rather than changed. The migration is ready for you to apply. Its preflight evaluates true on production (read-only SELECT of its exact conditions, 11:21 UTC).

## 1. Commits (worktree `/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-knockout-code`)

- Earlier: `b819a7206f`, `589f4af08a`, `8ce8e50ab1`, `016d393f20`, `6515412c67` (merge), `6b0da427b2`.
- `08532e4709`: merge of origin/main (`c113fbe7cb`, `0b212622ad`). Clean.
- `95a8c6600d`: third pass on the migration, the probe and its scenarios, the new rollback file, the law test, the laws.d entry and the changelog.
- `0444edf3c6`: comments only, in `bustOrder.ts` and `TournamentManagerEliminations.ts`, so they say what the migration header says.
- `57be4f3940`: merge of origin/main (`80769f9bd8`). Clean; it adds no migrations and touches none of these files.

## 2. Files

- Migration: `supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql`, version `20260911062048`. One BEGIN/COMMIT, lock_timeout 5s, statement_timeout 30s, 7 functions replaced, no data written.
- Rollback (new): `docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql`.
  - Restores the 7 live bodies byte for byte (pg_get_functiondef read at 10:50 UTC).
  - Preflight accepts the migration's result or its own, so a second apply does nothing. Postflight requires the live md5s.

| function                                      | live md5 (preflight)             | new md5 (postflight)                                   |
| --------------------------------------------- | -------------------------------- | ------------------------------------------------------ |
| fn_settle_tournament_places                   | d0262f4928b12eea1cc5e9175cbf2737 | 6181734ff98555ecc04648186f6ebf24                       |
| fn_eliminate_player_legacy_candidate_20260907 | f596d731cacf8d7e62a4549204ce73fc | 97abb184dc27e3c7a333a6160636f473                       |
| fn_claim_bounty_legacy_candidate_20260907     | 590f0f782e127288f33763bbab8c89f0 | ea7b6236b7c5c844dbc16ce2e78d2764                       |
| fn_eliminate_tournament_player_atomic         | b4937067d9bf337e1466095b9e1d5424 | 9447da284f1a3beb6d51dd87151c080f                       |
| fn_claim_tournament_bounty_elimination        | 876456f79250a307292dc6f2ae1564f3 | e099757eb087ef222e2fc92030ececaf                       |
| fn_normalize_tournament_final_standings       | ad865880f99bc28896bec03c66ae55a9 | 45b06c3f8be02940d130c427d5a32519 (unchanged this pass) |
| fn_ca_tournament_finished_but_not_completed   | e1eebfe28f393f2617c0a1ac93c2583a | 6f153669e4b6b149bfccd36ad575bda8 (unchanged this pass) |

Pinned but not replaced: `fn_ca_latest_committed_knockout_candidate` 0602827901be20bbb6e0dce6ece17f94, `fn_prepare_tournament_place_obligations` ca0abbc6d297f3009143676261d8cf19, `fn_bounty_obligation_has_complete_marker` bd29069e8d07bedf84e24e57242c2afe.

## 3. Findings

**Fixed**

- **Pruned witness hand falls back to recording order (V1-1, V2-3).** Confirmed: `sp_prune_hand_history` deletes `hand_atomic_commits` rows for horse-only hands after 7 days and spares only hands a _pending_ generation names. The earliest RUNNING witness hand (09-08 17:53) becomes prunable 09-15 17:53 UTC.
  - Settle now uses a LEFT JOIN. When the commit row is gone, the hand is timed by the earliest `created_at` of that hand's generations.
  - I did not use V1's `c.created_at` (the generation's own capture time). A hand's captures are up to 2.1 s apart and follow stack order in only 545 of 1,313 multi-bust hands, so per-generation capture times would break the same-hand rule. Scenario 26z fails with that version and passes with this one.
  - Across 33,318 generations, capture precedes commit by 4 ms at the median, 236 ms at p99 and 6.9 s at most, and never follows it. No function or cascade deletes generation rows.
- **A permanent refusal strands the event silently (V1-4, V2-2).** Both write halves (the played-on-after-a-rebuy refusal) and both doors (`unresolved_knockout_generation_chain`) now write one critical `financial_alerts` row per player. Source is `knockout_door.payout_blocked_by_unrecordable_bust`; it is deduped on open alerts. The incident trigger files it as `settlement_error` and never fails the insert. No player has either shape today, so nothing fires on apply.
- **Bounty orphan with no obligation pays the next knocker (V1-5).** Confirmed: the money core sets `current_bounty = COALESCE(current_bounty,0) + head` on a rebuy. The bounty door now resolves an older generation only if its own obligation exists and is settled with its complete marker; a head no obligation names stays refused and raises the alert. There are no orphans anywhere today.
- **Header claimed satellites and deals were covered (V1-2, V2-1).** The header, `bustOrder.ts` and the changelog now say both keep their own recording-order authorities, with the measurement.
- **No rollback script (V2-4).** Added. The probe applies it twice over the migrated database, checks every body against its captured live md5, then applies the migration again. The law test checks every rollback body equals the captured live body.
- **Numbers and causes in the old report (V1-3, V2-5).** Re-measured; see section 5.

**Judged wrong, or not changed in code**

- **V2-1's "60.00 at stake in `01f1a800`" is wrong.** The satellite function computes ticket cost as target buy-in plus fee: 180 + 20 = 200. Its 600.00 pool buys three seats with 0.00 left over. Only 4th and 7th swap, and no money moves, so re-sequencing it is optional.
- **Satellite and deal authorities: documented, not rewritten.** Measured read-only: no RUNNING satellite would award differently, nor would any of the 159 satellites completed in the prior 48 hours. One deal event settled in 7 days (09-06). Rewriting 1,346- and 1,758-line authorities that settle about 230 satellites a day belongs in its own reviewed migration.
- **User-id tiebreak for equal stacks (V1-3).** This follows your F4 decision, and the header says so. TDA would split the prize instead. Today that affects three in-the-money pairs in `7aa16fa7`: 14th/15th (4.13/3.90), 21st/22nd (2.98/2.88), 38th/39th (1.86/1.84).
- **Protecting witness hands in the prune (V1/V2 alternative).** Not needed for settle given the fallback. The played-on guard's dependence on `hand_history` is listed under risks.
- **Locks (V2-6).** No change needed.

## 4. Tests

- **PG17 probe:** 27 scenarios, EXIT=0 on the final committed state.
  - 19 FIXED fail on the live bodies on a probe assertion: 01–03, 05–09, 12–15, 17, 20, 21, 23, 24, 26, 27.
  - 8 KEPT pass on both: 04, 10, 11, 16, 18, 19, 22, 25.
  - All 27 pass after the migration applied twice; the rollback phase passes.
  - New: 26 (a pruned witness keeps its place: prune before the finish, prune then re-enter the settlement, and one hand captured out of stack order) and 27 (the chain refusal alerts at both doors, repeats add nothing, a closed alert is raised again).
  - Changed: 20 now checks the played-on alerts; 21 keeps only the collected-head case; 22 adds the no-obligation refusal.
- **Law test:** 47/47. Two deliberate mutations (inner JOIN, removing the dedupe) each fail it.
- **Server:** 676 files, 9,301 tests passed; tsc clean.
- **Root:** 1,390 files passed. 2 fail because `@capacitor/app` is not installed in the shared `node_modules` (native notification tests); they don't touch this change.

## 5. Production measurement (read-only, 11:22 UTC)

Ladders come from each event's real `fn_ca_tournament_place_amounts`, run on a local PG17 copy of its pool, structure and field. Eight RUNNING events would pay a different player, 67.46 in all:

| event          | chips moved | why the orders differ                                    |
| -------------- | ----------- | -------------------------------------------------------- |
| bee519fa       | 22.46       | recorded late: 270 of 271 swapped pairs are ≥ 60 s apart |
| f922df63       | 20.56       | recorded late: all 460 pairs ≥ 1,407 s apart             |
| 313a274b       | 9.78        | busts 0.9–4.8 s apart                                    |
| 7aa16fa7       | 6.08        | busts 34 ms–33 s apart                                   |
| e3ef32fd (PKO) | 4.98        | busts 5.2–5.5 s apart                                    |
| 8e16cdb4       | 2.51        | busts 19 ms and 0.2 s apart                              |
| a5aa6984       | 1.05        | busts 2.3 s apart                                        |
| d7997aef       | 0.04        | busts 1.4 s apart                                        |

- Only the first two (43.02) are late recordings. The other 24.44 is the decided rule working as designed: the engine records in deal order and the finish ranks by commit order.
- `9536150e` was re-sequenced and completed at 10:17, paying the player the new rule would.
- No witness commit is pruned yet, so the fallback changes nothing today.
- No RUNNING event carries place or bubble evidence, and no eliminated row lacks both a witness and a time.
- `c1f15c30`, the only COMPLETING event: all 39 positions match its recording order, so it replays as paid.

## 6. Remaining risks

- Satellites and final-table deals still pay recording order. No money is affected today; they need a follow-up migration.
- Equal-stack busts in one hand go by user id, not the TDA split. Hand-for-hand simultaneity is not modelled.
- The played-on guard reads `hand_history`, which is pruned after 7 days. In an event older than that, such a player would be stamped at the old generation, and no alert would fire.
- In the week-old window the prune can mix commit-timed and capture-timed hands. That can misorder two busts only if they are within about 6.9 s of each other and straddle the prune cutoff.
- The alerts make a stuck event visible; an operator still has to rule on the player. That now includes bounty orphans with no obligation.
- `a5aa6984` `dca6c345` holds 2,500 chips with no seat, so the event cannot finish. If an operator zeroes it, the door records it 100th at its 09-09 06:13 hand. Whether to refund its 1.00 rebuy is your call.
- Bubble protection: if a player whose place moves has an engine-created bubble obligation, settle refuses. None exist in RUNNING events.
- The normalizer and the place prepare still rank by `eliminated_at`; the server does not call them.
- Not investigated: since 09-08 15:03, 22 rebuy legs were posted within 10 s of the same player's previous leg in the same event, with no bust captured between them. That is 5 events and 142.00, the last at 09-09 05:10, and may be double charges.
- Engine (`b819a7206f`, `8ce8e50ab1`) must deploy with or before the migration. It calls no new RPC, so the new deploy gate is unaffected.

## 7. Apply sequence (you run it, once, never in a retry loop)

1. Deploy the engine build from this branch first, or together with the migration.
2. Apply, detached, within minutes :04–:45 UTC:

```
cd /Users/smarter.poker/Documents/.agent-trees/club-arena/claude-knockout-code
set -a; . ~/Documents/club-arena/.env >/dev/null 2>&1; set +a; export PGPASSWORD="$SUPABASE_DB_PASSWORD"
PROD="host=aws-0-us-west-2.pooler.supabase.com port=5432 dbname=postgres user=postgres.kuklfnapbkmacvwxktbh sslmode=require"
m=$(date -u +%-M); [ "$m" -ge 4 ] && [ "$m" -le 45 ] || { echo "outside window"; exit 1; }
nohup perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV' bash -c "/opt/homebrew/bin/psql \"$PROD\" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql > /tmp/bust-apply.log 2>&1; echo EXIT=\$? >> /tmp/bust-apply.log" >/dev/null 2>&1 &
```

The file has its own BEGIN/COMMIT, so do not add `-1`. Poll `/tmp/bust-apply.log` for `EXIT=0`. On a 55000, lock timeout or break-window refusal, read it and stop. 3. Record history under the file's own version:

```
/opt/homebrew/bin/psql "$PROD" -X -v ON_ERROR_STOP=1 <<'SQL'
\set content `cat supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql`
INSERT INTO supabase_migrations.schema_migrations (version,name,statements)
VALUES ('20260911062048','a_bust_is_ranked_by_when_it_happened',ARRAY[:'content'])
ON CONFLICT (version) DO NOTHING;
SQL
```

4. Verify read-only: `SELECT p.oid::regprocedure, md5(p.prosrc), p.proacl FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN (the 7 names)` should return the "new md5" column above with unchanged ACLs. Then watch `financial_alerts` for source `knockout_door.payout_blocked_by_unrecordable_bust`; none are expected.
5. Rollback, only if needed: same window and detached form, with `-f docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql`. It writes no data.

The local scratch cluster and my `/tmp/bfx` directory, which held exported production rows, are deleted. The worktree is clean at `57be4f3940`.
