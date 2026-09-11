# Current terminal authority rehearsal and activation boundary

Current review artifact, 2026-09-11T08:19:21.355781+00:00: SHA256 `62c98c9b9f18e0c9738c3173fc3b345bee9d6ffad72de63653be1a27548a9544`, 275855 bytes. The exact one-pass bundle passed all 138 checks again with source stability and exact rollback in `/tmp/codex-whole-phase-three-iyxtlb6h`. This supersedes the byte hash in the historical rehearsal section below after removing two extra EOF blank lines. The activation remains unapplied: automatic approval review rejected the earlier exact production request; see `2026-09-11-phase-three-activation-approval-status.json`. All 25 corrected preflight source gates passed; the three raw payers already have accepted contracted postimages and owner-only ACLs. No production guard was changed to obtain that result.

The full native Stage B rehearsal passed **138 assertions**, with exact database/catalog rollback and unchanged composing source inputs. This certifies the recorded native scenario, not production activation or whole Phase 3 completion.

- Evidence: [2026-09-11-whole-phase-three-cutover-native.json](2026-09-11-whole-phase-three-cutover-native.json)
- Recorded at: `2026-09-11T06:32:58.601776+00:00`.
- Native output: `/tmp/codex-whole-phase-three-cqhmlk0a`.
- Rehearsed SQL SHA-256: `56cdfe1f175730cc74df049d7188cf2d7aa0da2bef9ae668f8c813f531e8ae31`.

## Exact contract

The live-proved public satellite R3 wrapper (`486d0e6729de8d518d7faf0c253b65d3`) keeps the money-path context and delegates to its current M2 core. The terminal adapter opens an owner-only source capability bound to the backend, transaction and exact source seat-exit token. The manager target extension binds the actual fresh source lease, immutable settlement header, once-published seat cohort, target row preimage and target escrow preimage. Its child authorization is immutable and is cascade-consumed when the source capability closes. Cash and ticket plans with zero seat deliveries create no target authorization.

Only exact planned zero-chip, registered target roster INSERTs are admitted. The live-proved roster trigger recounts the new registration before its award exists; that nested count transition requires the actual planned registration and exact live headcount, with no economic or unrelated-column change. The final M2 aggregate uses the captured preimage and receipts, so the entrant is counted once. Target table/seat writes, unrelated targets or users, altered roster fields, replayed capabilities, forged recounts and another lease generation remain refused. Existing escrow components are preserved while the exact funded increments are proved.

## Verification composition

The passing rehearsal applied the base satellite adapter twice, then the target extension twice, then the strict cutover twice in one outer rollback transaction. It retained the paid final-deal proof and ran the real R3 source-to-target settlement through an actual service-role request, current source lease and the installed pre-request hook. Coverage includes fault-after-money rollback, immutable replay and ambiguity resolution, all terminal guards, 16 active-capability refusal cases, outside-capability refusals, exact nested count and funding transitions, and 29 route checks.

The new production candidate [phase-three-activate-current-terminal-authorities.sql](../../scripts/deploy/phase-three-activate-current-terminal-authorities.sql) contains one BEGIN/COMMIT and the exact base → target extension → strict bodies once each. The exact one-pass file also passed **138 assertions**, with exact rollback and unchanged source inputs, on `2026-09-11T07:04:14.159910+00:00`: [exact activation evidence](2026-09-11-exact-terminal-activation-native.json). The proof ran one outer rollback transaction from `/tmp/codex-whole-phase-three-p892x8in`; its SQL SHA-256 is `5dbdec2e674807281f21e0b829ab2ca465bf502a4c103f8f6fea902844afabca`. The bundle has not been applied to production. The exact existing Realtime subscription catalog lock is acquired before any public DDL in the bundle; the unchanged strict component reacquires the same transaction-held lock harmlessly. Bundle SHA-256: `9e0771e13df999bcf4fc3809865afa53d6b70f2eb947be531c4894dca9e148b0`.

## Route coverage

Manager-only additions are exact seat assignment, unpaid-place repricing, current terminal completion and current satellite settlement. Identified service recovery or the current manager may use engine consensus, played-spin recovery proof and the three ambiguity resolvers. Headerless engine calls are refused. The separate authenticated human proposal and vote routes retain their browser request envelope.

## Remaining activation gates

Production activation is pending the actual engine adoption check and compatibility with the production break-window bootstrap. The earlier engine endpoint returned 404; a subsequent engine rollout has occurred and adoption is being checked separately. The native result explicitly does not certify that bootstrap. No production migration has been reserved or applied for this combined cutover.

Current M2 itself requires target cached pools to equal their existing escrow balances before delivery. This rehearsal does not claim successful admission for targets with earlier paid liabilities, and the target extension does not change that admission contract.

## Source SHA-256 values for the exact activation-bundle rehearsal

| Source                                                                                                 | SHA-256                                                            |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `docs/audits/2026-09-10-native-current-money-authorities.json`                                         | `9cd8238b83ce94da5ff74d90a193028fb3a2aac891d2cfaac40aaeca76fe0f8b` |
| `docs/audits/2026-09-10-native-current-seat-authority.json`                                            | `0fae11af62bf824820b386611c4478b82ca24a0747f297ab123993ec7c10c536` |
| `docs/audits/2026-09-10-native-current-settlement-lane.json`                                           | `654dfc198ff4fcc58b93f8a4b70b0c5ef191b3e04b830b7df0d3b8133312aeef` |
| `scripts/ci/probes/atomic-terminal-final-deal-replay.sql`                                              | `54fe5a01d7f7c2afde6e1f64f413c2098ef0e3b02179d081e18dd1fa8869c0d9` |
| `scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql`                                              | `207ab33a49fbe2951553df90f0c298241181578c617f69714b6062d8d53dfdba` |
| `scripts/ci/probes/existing-ticket-current-redemption-native.sql`                                      | `28b94e1cb392a3655c763f9afbd2d872efc22d9629ec9a57119a40a6401c7e0f` |
| `scripts/ci/probes/final-deal-current-terminal-native.sql`                                             | `8be0add8344d7b3916a94cbc0b0522497996b96d7a945196f3854b41b3fd9d8f` |
| `scripts/ci/probes/phase-three-current-manager-routes.sql`                                             | `cb489fec5c13a5904d4dd0dc826f35d91144e19902c7712cec8ec1ac93980f8e` |
| `scripts/ci/probes/satellite-cancel-current-native.sql`                                                | `ec5c0c77435c1a1eec085db1001fcb41fc65ba7cfdb7b7f52229d7e67add9531` |
| `scripts/ci/probes/satellite-full-terminal-native.sql`                                                 | `1e82cf186cc71570ebbca8f615360d0be620cf69a67b70899e52be55667c9ac8` |
| `scripts/ci/probes/satellite-manager-target-negative-native.sql`                                       | `c2449d23b78997315d44bb4aa12b593a1f6873d0e4cb0d42084f90c404457aab` |
| `scripts/ci/probes/stage-b-cash-payers-native.sql`                                                     | `95accf94fb2c38745b35490d5906527b91a020d5622e9867b0ed03f37069581c` |
| `scripts/ci/probes/versioned-final-deal-native.sql`                                                    | `a7f3bda59622d6a5e4b523b3d60e86beaf59abb25e2b9ae3df07413e9ce34c9b` |
| `scripts/ci/rehearse-existing-ticket-current.py`                                                       | `1ac6576c72154b7bec47b7ac6ea3c1e0f69c6964610fed936dbf4be5e0c83f3c` |
| `scripts/ci/rehearse-final-deal-current-terminal.py`                                                   | `43cdefa38c7a699840c7767b22622560caad4911a2b9e6d3b999ce133e655756` |
| `scripts/ci/rehearse-satellite-cancel-current.py`                                                      | `6530882d7dec13eca29bbce6af1feea927f6bc6a1cdd8b07494a6e35c1d32470` |
| `scripts/ci/rehearse-satellite-full-terminal.py`                                                       | `8562a73099c3c0103eae31e6b3574fb8a677c5afd4a08f26b8b7e3cce8911ad1` |
| `scripts/ci/rehearse-stage-b-cash-payers.py`                                                           | `4990134f6353cdfe7d6509570602617b3db96cf58d5d0ba471a9cf112b3fb6d4` |
| `scripts/ci/rehearse-whole-phase-three-cutover.py`                                                     | `044eb726b80082bfc78bff1195169d28e916441bde6e3815ca2e52b62502a4a3` |
| `scripts/ci/satellite-stage-b-manager-probe.py`                                                        | `0d3ac40c3b7814e74d7a249c969e686b1a310574883b7b6565c3ece933eddb20` |
| `scripts/deploy/2026-09-10-restore-rake-attribution-retries.sql`                                       | `f912f858c7f35004bfc2447fdf70329afc8a52029970e052c85c8e106fc83f2c` |
| `scripts/deploy/phase-three-activate-current-terminal-authorities.sql`                                 | `9e0771e13df999bcf4fc3809865afa53d6b70f2eb947be531c4894dca9e148b0` |
| `scripts/deploy/phase-three-activate-versioned-final-deal.sql`                                         | `e29ca9f4a2e48a70d1d618d2bd62685fb750a56b244aa444f36a0e3b98d1a972` |
| `scripts/deploy/phase-three-cancellation-origin-cash.sql`                                              | `84f2d79130e27bd687c848a45bb65bf5b63ac2ebf0d4e9bf360dc1ec19cd284a` |
| `scripts/deploy/phase-three-current-satellite-terminal.sql`                                            | `a6444cab844a6e2da87600ee4443c3349e0f2d6c988b5a3198a356bc5a333d2f` |
| `scripts/deploy/phase-three-final-deal-terminal-v2.sql`                                                | `b4af55173b825be5ecf48c6c3bbcca1e828493cdafc47becf00d73ad3186c871` |
| `scripts/deploy/phase-three-satellite-manager-target-scope.sql`                                        | `bc6e6ea0af0f2475a6f4cd3f3bfbe4732aa69bb583152f5468adf57530cdc775` |
| `scripts/deploy/phase-three-strict-tournament-cutover.sql`                                             | `2862c27eae420c623a3ccc9ccc086245d208fc48dad3c0e97f2a5b0da1c6dabc` |
| `scripts/deploy/phase-three-versioned-final-deal.sql`                                                  | `6a122c52afea42df937c9f41e6845c49362d783beb1fdcd375a6b8aa402ab636` |
| `scripts/dev/build-versioned-final-deal-probe.py`                                                      | `e75bb5e19be5ff787caa8cda53782f3ca62cee06007b53af1167a68e6e171a8e` |
| `supabase/migrations/20260905203123_phase_6_1_a_settlement_outside_the_platform_needs_an_approve.sql`  | `8afe66ec6b85a5ba50f02bddc9420f1c47d0d8e9d68024bbd29c4482c8add6fa` |
| `supabase/migrations/20260906233722_a_cap_counts_entries_not_the_seats_filled_right_now.sql`           | `0e66deca80157a34105d1f1cae569b52f07cbe2e74c07caf46fa11a53ba3ecac` |
| `supabase/migrations/20260908011408_tournament_settlement_rejects_invalid_amounts_and_places.sql`      | `9aba493ff9029b3a7d4cd4d40e9652f8bd5e07a38a867a3bbc41c9857ef3e141` |
| `supabase/migrations/20260908042900_tournament_leases_have_fencing_generations.sql`                    | `7ced5fc19e7dad590da5fa07da02252c2dc50887b5bfbf0e2e1dfc0dd017ca3a` |
| `supabase/migrations/20260908043200_tournament_manager_requests_carry_lease_authority.sql`             | `2cbcab5f263e8ca02b16f6c47ebbd7f6d47eb783d81c5939133c1e39b5d306f4` |
| `supabase/migrations/20260908221010_lease_heartbeats_skip_busy_generations.sql`                        | `1d0707357aa629f2aa6b15416f74ab9317238ce80a29837be7355bf41e7b22ac` |
| `supabase/migrations/20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql`        | `3a2af49bcaf13fdca72a4b89e2d6b38ee9c125f4d8b09aa8626c36e593aebc1f` |
| `supabase/migrations/20260909014444_tournament_cancellation_commits_one_stored_receipt.sql`            | `ca4124bfda0faf242981653a72321fc9952ebfad59d6561be511a3ec1b1a04b7` |
| `supabase/migrations/20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql`  | `59395e0e803d7c94dcbe2e35414bb6d5f97f6f674a67e9b1e30b9822a3c9c04d` |
| `supabase/migrations/20260909014545_tournament_seat_exits_stay_inside_tournament_authority.sql`        | `27cf35a8b9cb3c7322265b755d0ec42f0d3feceb12dd4917e14589375b4c7036` |
| `supabase/migrations/20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql`           | `1b265f8bdf0e435770a3f968faf5542f2c96c06849c2329fe3aeb6e7efcf25e1` |
| `supabase/migrations/20260909043000_tournament_terminal_roots_are_db_first_hardened.sql`               | `af23b09dd963122cf09072d8b240093b588d57cd91a272f7179c9efcc5b2e9bc` |
| `supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql`                 | `ce14eccd72c0589fd4feae70fe1395a11347d1c0812de15090a7b48337d08882` |
| `supabase/migrations/20260909210701_tournament_registration_retains_original_operation_receipt.sql`    | `09f7ee2683a076a3a30a4468080f2b61f8b49229e799849d2e0e955c3cd3c098` |
| `supabase/migrations/20260909222303_satellite_unregister_returns_its_funded_cash.sql`                  | `aa58b97563d4541c9a44a1d60ce3fc2883fe03d227c9df825e9d4f8929dbc907` |
| `supabase/migrations/20260909232326_the_exact_refund_authority_is_a_money_path_r3_recognises.sql`      | `d2f6f06ee5518e803a650d1438293ca878952e508d48efd863deca7262aee66b` |
| `supabase/migrations/20260910000905_final_tournament_roster_seat_authority_after_scheduler_fence.sql`  | `908d9e9d415e43b697e4321a025bbf8d0330b0ab2d327c2a33165fd315269275` |
| `supabase/migrations/20260910012633_tournament_entry_receipts_use_the_charged_club_wallet.sql`         | `08bc3f0012fb887d2cc2157430685a110254ae248d8b97889b640ee9db497e4f` |
| `supabase/migrations/20260910020626_the_host_club_is_in_its_own_union.sql`                             | `4e078b55a44bbc3e516d4a0da73ce39453b4dc6950225d98e02d2a8d6c0412e9` |
| `supabase/migrations/20260910023919_the_entry_is_charged_to_the_wallet_the_entry_is_stamped_with.sql`  | `0da3ff95884121df67a9410c8535338c2afd32679288f1868f921d689df2c2e5` |
| `supabase/migrations/20260910035245_the_settlement_lane_is_per_tournament_not_platform_wide.sql`       | `d07cbe35f62ef4a18e29779c812526c27420da4a82c891c0bf2f136b9e6a31fe` |
| `supabase/migrations/20260910063559_a_busy_manager_keeps_its_lease.sql`                                | `2e95299dd7693a09ee310a4086b2dcdf16f0f942582007bdede0c4c81024e07d` |
| `supabase/migrations/20260910064305_a_union_ticket_is_issued_at_the_club_the_winner_plays_from.sql`    | `cb0b9260f8e250d479cb82a62a74ecbdea28b826a75adb105d34f444ee2be7cb` |
| `supabase/migrations/20260910171843_started_tournaments_resume_or_settle_instead_of_cancelling.sql`    | `85e02d3f2350b4c1c7229ab2b58e789b3b8651869c0c3834a3318d7547b10bf6` |
| `supabase/migrations/20260910171924_satellite_seats_count_once_and_keep_the_funded_prize.sql`          | `9a00bc662f729d5a6db25c4f10a5ceeb45509b230e35f48252620fe9dcef3fc3` |
| `supabase/migrations/20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql` | `bc620a6b093ab9769615427168763bc35aaed44e60ee190202470dfcef0f744b` |
| `supabase/migrations/20260910190537_late_entry_uses_canonical_capacity_and_charged_wallet_receip.sql`  | `e7d8e53de468e504d4c22c1ed9f701f22cb3adb3a3fdafda3ab2dbe5dadec5ed` |

The exact activation evidence contains the identical before/after maps for all 57 sources. The earlier component-repetition evidence retains its original 56-file source map and SQL identity.

## Read-only production preflight review

This is a first-activation preview of the prepared source and admission gates. It returns identities and booleans only. It has not been executed against production by this reviewer. A preview cannot replace the bundle's exact table/constraint/default/trigger/ACL gates or its transaction-held locks.

Before the bundle, the current M2 core is `83bf8b297d07bbae671707f24afec271`, readiness is `993e6e1de9edba2fe235d86ff6c243c9`, and the satellite completion guard is `517504ed4bae5ac000d6c47a6f5cb0d9`. Inside the same transaction, the base adapter changes the core to `0e2066fafe3c4e1fceb96db9937b3140`, then the child changes it to `c5ba0595fc5363ecc94243b003a3d326`; strict checks that final core, readiness `0388659818612493c16b02048dae5b3f`, and guard `f218a7d769971c064cb11043fa6b45ce`. The public R3 wrapper, receipt reader and resolver remain unchanged. Do not require these newly created postimages before running the combined transaction.

```sql
WITH expected(identity, body_md5) AS (VALUES
 ('public.fn_settle_satellite_tournament(uuid,uuid)','486d0e6729de8d518d7faf0c253b65d3'),
 ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)','83bf8b297d07bbae671707f24afec271'),
 ('public.fn_ca_satellite_settlement_receipt(uuid,uuid)','381b3e0691a2b9303693653f5110d568'),
 ('public.fn_resolve_satellite_settlement_outcome(uuid,uuid)','c332627d5d8c7c9ac951392c95c53551'),
 ('public.fn_tournament_finish_readiness(uuid,uuid)','993e6e1de9edba2fe235d86ff6c243c9'),
 ('public.trg_guard_atomic_satellite_completion()','517504ed4bae5ac000d6c47a6f5cb0d9'),
 ('public.fn_sync_tournament_current_players()','ecb120c2c6a4ecee6c2e04d4c9b5ebc7'),
 ('smarter_private.fn_smarter_data_api_pre_request()','ab227471f29f2944ebd64909622b6af7'),
 ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)','d1b5100c2b9f92bec5fd1680b0b4f230'),
 ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)','5e6c99545e07c21efcb50e5cb3441c14'),
 ('public.fn_mystery_bounty_reveal(uuid,uuid,boolean)','5578ec53c8a531eeba47d448ae9af1b1'),
 ('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)','260c94b41d7f2bb021a88a546a1714ac'),
 ('public.fn_complete_tournament_terminal(uuid,uuid,text)','96a61ea5e16560735bcb70b355aa79ab'),
 ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)','90f7506df2f1a94fe22952714fcd9f85'),
 ('public.fn_ca_tournament_terminal_receipt(uuid,uuid)','bb4b0e1d1c758943fca29f9a83d064e4'),
 ('public.fn_settle_tournament_final_table_deal(uuid)','b1941b2e55dade307ecd74068ab3e500'),
 ('public.fn_guard_tournament_completing_claim()','82078938fd926c94a0ab778acd77dd61'),
 ('public.trg_lock_atomic_final_table_deal_status()','ddc5e3121ed9cc73d41525e6c1ba6c34'),
 ('public.fn_guard_tournament_completed_certificate()','d994347e1b76c936ce13361d73f94fd2'),
 ('public.trg_atomic_final_table_deal_completion_guard()','9f5f5fefa77ae93bfeffc9f414a63a0d'),
 ('public.trg_freeze_atomic_final_table_deal_obligation()','d338c5278ef1247ff0f4a7c4ba774cc5'),
 ('public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)','ebabbaf0456d80335aaa2e04471d0ab6'),
 ('public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)','329237bd65214e17d4ca3298f363f248|3585ddbfdb0a197243d5e6eefb6b670f'),
 ('public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)','3a5a0f079b7884a5bd2e6bfe6a15ccb7|f1fc7a0bf480b1034f0f1d9cba3b4d0b'),
 ('public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)','58e2768644b692f23a9a071a8a5d1ee8|852e35483b67c1fc59b6347b51c79cb8')
)
SELECT e.identity, EXISTS(SELECT 1 FROM pg_proc p
 WHERE p.oid=to_regprocedure(e.identity) AND md5(p.prosrc)=ANY(string_to_array(e.body_md5,'|'))
 AND p.proowner='postgres'::regrole AND p.prosecdef) AS exact_first_activation_source
FROM expected e ORDER BY e.identity;

SELECT
 NOT EXISTS(SELECT 1 FROM public.engine_tournament_leases
  WHERE protocol_version=1 AND heartbeat_at>=clock_timestamp()-interval '30 seconds')
  AS no_fresh_protocol_one_manager,
 NOT EXISTS(SELECT 1 FROM public.tournament_table_origins o
  WHERE o.origin_kind='capacity' AND NOT EXISTS(
   SELECT 1 FROM public.tournament_capacity_table_receipts c
   WHERE c.table_id=o.table_id AND c.tournament_id=o.tournament_id))
  AS every_capacity_origin_has_receipt,
 NOT EXISTS(SELECT 1 FROM public.tournaments t
  WHERE upper(COALESCE(t.status,'')) IN ('RUNNING','COMPLETING') AND (
   EXISTS(SELECT 1 FROM public.tournament_final_table_deal_batches b WHERE b.tournament_id=t.id)
   OR EXISTS(SELECT 1 FROM public.tournament_final_table_deal_receipts r WHERE r.tournament_id=t.id)
   OR EXISTS(SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id=t.id AND o.kind='final_table_deal')
   OR EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id=t.id AND p.source='final_table_deal')))
  AS no_active_legacy_final_deal,
 to_regprocedure('public.fn_create_seat_first_game_atomic(uuid,jsonb)') IS NOT NULL
 AND to_regprocedure('public.fn_repair_seat_first_games(integer)') IS NULL
 AND to_regprocedure('public.fn_repair_seat_first_games_before_maintenance_gate(integer)') IS NULL
  AS seat_first_retirement_present,
 (SELECT count(*)=7 AND bool_and(tgenabled='D') FROM pg_trigger
  WHERE tgrelid='public.tournaments'::regclass AND NOT tgisinternal AND tgname=ANY(ARRAY[
   'aa_guard_tournament_completing_claim','aaa_guard_atomic_satellite_completion',
   'zzzz_freeze_finalized_tournament_prize_pool','zzzz_tournament_pool_finalization_window_guard',
   'zzzz_tournaments_atomic_place_completion_guard','zzzzz_tournaments_atomic_final_table_deal_completion_guard',
   'zzzzzz_tournaments_financial_certificate'])) AS seven_guards_in_first_stage_a_state;
```

The target INSERT default-row comparison is the exact SELECT predicate in `DO $target_insert_defaults$` of `phase-three-satellite-manager-target-scope.sql`; root already recorded its production boolean as true at 06:05. The recount source, exact AFTER INSERT/DELETE/UPDATE trigger shape, function configuration and service-only ACL must also still match that file's preflight. Existing adapter or child helpers, if present, must have their exact owner-only bodies/configuration/ACLs; existing capability tables must have the exact gated columns and constraints. Their absence is expected for a first installation and is not permission to substitute another implementation.

Additional embedded gates retain all protocol-2 launch/table/hand authority identities, exact-seat markers, private cash payer ownership, canonical batch contracts, retired legacy doors, and the seven coordinated financial guards. The strict postflight checks request hook `c43a9c75d3d4c1e4945c908d16e3b5d6`, the exact target helpers, owner-only capabilities, all guard activations and legacy retirement before commit.

Activation order is: confirm deployed engine ancestry and health plus the actual production DDL/bootstrap contract; preserve the approved source hashes; reserve the migration through the normal tool; apply this exact bundle once in one transaction, acquiring the Realtime global lock first; verify its postimages, ACLs and enabled guards; then activate versioned consent separately after its own native proof and compatible client/engine adoption. The lease query is only a protocol freshness gate. It does not prove the running engine build, a healthy equity worker, or bootstrap compatibility. Consent activation is not part of this bundle.

## Runner drift review at 07:49 UTC

The exact rehearsal recorded runner SHA-256 `044eb726b80082bfc78bff1195169d28e916441bde6e3815ca2e52b62502a4a3`. A later disk read found `a063950285fa5f4de4eadaafb8c4b248788c96210e75cc3b9ffa429048f5b57b`, with mtime `2026-09-11T07:49:45.047980+00:00`. This reviewer did not make that edit. No source mutation occurs when importing this module; its executable main is guarded.

Read-only comparison isolated exactly one difference: the optional bootstrap branch now reads two dynamically named production DDL-guard fixture files, checks two fixed hashes, adds their native migration-history receipts, and then composes the requested bootstrap. Replacing just this block in memory by the previous single bootstrap-composition line reconstructs the recorded `044eb726` hash exactly. With no bootstrap argument, the new branch executes no SQL. All other 56 inputs of the exact-bundle rehearsal still match; retained SQL remains `5dbdec2e674807281f21e0b829ab2ca465bf502a4c103f8f6fea902844afabca`, and the production bundle remains `9e0771e13df999bcf4fc3809865afa53d6b70f2eb947be531c4894dca9e148b0`.

The historical no-bootstrap 138-assertion proof therefore retains its exact SQL and production-source identity. The dynamic bootstrap behavior remains unproved. The source scanner does not discover those dynamically constructed filenames, so any future bootstrap proof must explicitly include them in before/after fingerprints as well as its existing fixed-byte checks. Neither unknown bootstrap fixture was opened or executed by this reviewer. The source was preserved for the coordinator to resolve provenance and integration.

The cash-payer preview accepts each exact before or already-contracted after identity, matching the bundle. These three private leaves can already be contracted while the complete Stage B remains unapplied. Their postgres SECURITY DEFINER, `search_path=public`, and owner-only EXECUTE checks remain mandatory.
