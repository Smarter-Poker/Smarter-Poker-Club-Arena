-- @live-proof: NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','smarter_private') AND p.prosrc ~* 'errcode\s*=\s*''(40001|serialization_failure)''' AND p.oid <> ALL (ARRAY['public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)','public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)','public.fn_lock_tournament_launch_proof_parents(uuid[])','public.fn_refuse_new_entries_while_frozen()','public.fn_serialize_entry_statement()','public.fn_settle_final_table_deal_atomic(uuid)','public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)','public.fn_settle_tournament_places_atomic(uuid,text)','public.fn_union_pnl_original_frame()']::regprocedure[]))
-- @live-proof: md5(pg_get_functiondef('public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)'::regprocedure)) = 'd446c24e2a40221b54c88375d590c61c'
--
-- POSTGREST NEVER RERUNS A REFUSAL (2026-10-12).
--
-- PostgREST 14 (production runs 14.5 and 14.18) re-runs a request whose
-- transaction ends in SQLSTATE 40001, on the same pooled connection, with no
-- backoff and no limit; Supabase documents it as fixed only in PostgREST 16.
-- A custom serialization failure that the same request meets again therefore
-- never returns: on 2026-10-11 one ticket door refusal ran 22,401 times from
-- 10 backends for 40 minutes, on 2026-10-06 one settlement refusal ran for ten
-- and a half hours (#6326), and on 2026-10-11 an idempotency conflict ran
-- 26,264 times in four minutes before its lane moved it to PT409.
--
-- After 20261007071300, 20261011185301 and 20261012031813 the catalog still
-- held 186 custom 40001 raise sites in 99 functions of public and
-- smarter_private. Each was read for what raises it and who reaches it:
--
--   33 sites are a busy lane, a try-lock, a lease held by another live
--     owner or a request still in flight. They become 55P03, the code
--     20261011185301 gave F06_RETRY_CANONICAL_LANE. Every engine and SQL
--     caller that treated them as transient already lists 55P03.
--   138 sites are refusals a re-run of the same request cannot change: a
--     caller's stale expected version, a replay with different input, a
--     compare-and-set on rows this transaction already locked, a lost claim,
--     an invariant checked after the transaction's own write, a time fence.
--     They become 55000, the code 20261007071300 and 20261011185301 chose.
--   15 sites in 9 functions keep 40001, each for a stated reason:
--     ten are caught inside their own function and returned as a result,
--     one is returned inside the hand commit envelope whose engine retry
--     reads 40001, and four clear by themselves on the next run (the launch
--     proof NOWAIT, the entry boundary try-lock in two triggers, and a double
--     week rollover) where the caller has no retry of its own.
--
-- One caller matched the old code: fn_park_stopped_time_bank_custody waited
-- for F06_RETIRED_CLAIM_BUSY by catching SQLSTATE 40001; it now catches 55P03.
-- Every message text is unchanged, so every caller that matches a message
-- (abandonedGenerationDoor, the retained hand door, the prize wizard) reads
-- the same words. The full inventory with each reason is
-- tests/fixtures/postgrest-never-reruns-a-refusal/inventory.json.
--
-- Only the SQLSTATE literal of each listed RAISE changes. Predicates, locks,
-- messages, money, owner, security, configuration and ACL are identical and
-- re-checked. An unknown preimage refuses before anything changes; an
-- applied postimage is skipped, so a replay is a no-op.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $install$
DECLARE
  c_old_code constant text := chr(39) || '400' || '01' || chr(39);
  c_old_name constant text := chr(39) || 'serialization_failure' || chr(39);
  r record; f record;
  d text; n text; v_old text; v_new text; v_found integer;
  owner_before oid; security_before boolean; config_before text[]; acl_before aclitem[];
  v_changed integer := 0; v_sites integer := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
  ('public.apply_venue_directory_enrichment(integer,timestamp with time zone,text,text,text,text,text,text,numeric,text,uuid)','eda927276175a356d1641a73f34476a5','ed8b0871c480bc9b9b64f83293f46365'),
  ('public.atomic_cancel_tournament(uuid,uuid)','8990d936e34696a23ea3d8e7497a2354','6dc3aa555dc5f3c192ddfd1cba793854'),
  ('public.ca_rake_export_start(text,uuid,date,date,uuid,text,text,uuid)','7e139d27040e4c8cdc4534691847ee7a','51731baa72494ff10571b964de6b5612'),
  ('public.complete_rights_cleared_youtube_transcode(text,uuid,text,text,text)','eea513ad2a5b1e26fd860c13b7d1c4f3','ee14c54ea4bad2e3b3152cab3f15b655'),
  ('public.fn_bag_tournament_stage(uuid,uuid,integer,jsonb)','ee005371821e015fd0b7d44ea1c90392','a42fe7dacd8bf25d300c1025d32f9ef6'),
  ('public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid)','acbb83c13660c3eda2d9f52fec0c7bd5','c0ce5801145ef931030bb77838c92259'),
  ('public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text)','a0718c687780f7cf3ce36f50c558f456','4d8cd831ec6b85fd2e3b993b24b3156b'),
  ('public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)','0fe132756ddf22122c91aa0d7fd323cd','c83851e8368aac76fd055357943041a7'),
  ('public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)','5a2839b0a3e84f650c12428c079d47d7','3ff792b3f779e235815c9eb3d1d9f8ac'),
  ('public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)','4333dc1291933bf9296956903952ea6b','49cdcb82f78a26a875c5abf7e17381a0'),
  ('public.fn_ca_escrow_on_wallet_tx()','8a0be491c87f37224f9dee7cfd274085','ff49b681d06f7d9ca57e846ae4578acb'),
  ('public.fn_ca_legacy_period_maturity()','d257e983e33d19f2d7778fd3bdb897f7','58507b44f4896debdd7b4237c9588719'),
  ('public.fn_ca_legacy_round3_wallet_receipt()','c5ba8ac20552a67af4265b764a75a7ad','f05849a487f106564c8e52250be3ab45'),
  ('public.fn_ca_operator_cancel_tournament(uuid,uuid,text,uuid,text)','1927a3eb5af1d2de59a3daef7b721177','ee036eed9400f9e266d410a0e19588bc'),
  ('public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)','9ff346ac60f760311d884c6d63d9001d','2077904b2bfc2c99287ad824548b3e92'),
  ('public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb)','f3b97df5f9dbe82088189763f03ae34a','818dc6b73fdf3f0e298d25b8f963e3fa'),
  ('public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)','b9df97fa4e796726443bffd8d51da248','65a45db8a381c5f43209bd6e46ea8c34'),
  ('public.fn_ca_resume_hand_submission(uuid,text,uuid)','6b3647f39b1c188cf23771face25fa25','ae0691448b3aed5902574d4ffdb2d05c'),
  ('public.fn_ca_resume_original_paid_tournament_entry(uuid,jsonb)','aa9e6ff9fb7994fff85c2d3a86978bfa','313a3447d93ec34b8720205a4d3b8a33'),
  ('public.fn_ca_retain_hand_submission(jsonb)','20fdb0a14573226812367b4b870b8f7c','b83fdc6e573d848e1e466da24ea70420'),
  ('public.fn_ca_return_excess_start_overlay_locked(uuid)','d187a09b271d9ccf36e6edbc158f7094','ca324d38e724edc2101cdbf05583482b'),
  ('public.fn_ca_set_emergency_stop(text,boolean,bigint,text,uuid,uuid,text)','fc973a68bc794873a91291b3b3368f4e','61bc6990d0151de90987d7a03cea4fcd'),
  ('public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)','0286145366f00c7cad0a996f05630851','482d74d36d7106e6bdeea75e0a1d955c'),
  ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])','5e7011f4b49ff7225568296946ea1d6c','e8986b5b177c88acbde1ac80fe7e029f'),
  ('public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)','3fc3f147808ab3ecc50982f5b6968bff','2d7adf316b2651ce9df7530a4008e8c0'),
  ('public.fn_cash_seat_move_execute(uuid)','1e7d08bb8c9f692d591e9bf86de591c1','58ce12d8f57a25b764612ec36d8a261d'),
  ('public.fn_cashier_lock_authority(uuid,uuid,uuid,uuid)','ba11343070357678bcca91249244394e','81396069c84c077f15aafa68a1f84e91'),
  ('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)','b560eb4c685afe1081f5a6aea4aca363','b571e67c5c8b81cb70899304a1883c63'),
  ('public.fn_claim_final_table_transition(uuid,uuid)','dbe29d9f61cab35558aa63a3524bc563','4820af283e291b1dbfb82b277fad8ea0'),
  ('public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)','9eb078e5860e9bdd8c0afcdbffc02504','0d41f8a87720d3b9f94b0b1b0d800900'),
  ('public.fn_claim_tournament_finish(uuid,uuid,text)','9c60ce0e2be89a658fb361713ba6400b','cbbf49b045bdf1f9709fedf434e28a87'),
  ('public.fn_close_settlement_period(uuid)','aec326f869a7290ec8debc8846983166','3fbefd5632532831f0cd9a2eaf272ae3'),
  ('public.fn_club_set_member_status(uuid,uuid,text,text)','a5b8ebb02ec409735eabea10c578b9ef','a9d607f3c41ed17bba6ea80a11a90dde'),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)','2140901e5d1fd6d86eeda141ab9d1df6','5e3596c0b102b1bd159ebecf7b4115ec'),
  ('public.fn_complete_first_archived_spin(uuid,text)','32f359acc03301fedae8a76a9def4003','4e0d3b1b171662eb44d82b57e957440b'),
  ('public.fn_complete_sep8_spin_original_standings(uuid,jsonb)','cd41aca6c4880be5cfbc0e8d89e04ae0','9065bdb5a692a50d8070c3e9e194e40f'),
  ('public.fn_complete_stage_resume(uuid,uuid,uuid)','aa93dcbbcf2f56278da3d6e245469bc1','0fa0227713ff61bea4a19c7f0734aaa1'),
  ('public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)','b06a1fa871c02cce520e0516f54aa3ab','013cd1a21763361a6d02ec246191667f'),
  ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)','957c8e14e0cb6d622e6214b352571606','6f526acdf5150c7f7ec8d83b5b069519'),
  ('public.fn_credit_maintenance_thaw_targets(timestamp with time zone,numeric)','8825756620dbe026db2132175794983f','15fa15e8bf3ffe340dc2b29d336a800b'),
  ('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)','5086f465475086bb869b31ed78ea96f2','3c91100d1331ffb2a5710f5a2eeec60a'),
  ('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)','a5585b9d7fb061f12c29f1262a5a1b6c','4f39ac5ff068867c42e07f3418205e82'),
  ('public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)','b52cdcc558491016ae36bc4dd672bc8c','2a283449d8d35abd505949e51edac399'),
  ('public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)','c8327c88c20ba6c30d66995ed5bb872e','86c5c915446b59060f8e8baf0eb62004'),
  ('public.fn_f06_abort_successor_unsettled_hand(uuid,jsonb)','3d8695093433344cef51d4d158658c77','2bb2e28458244c405c10963ba84c231e'),
  ('public.fn_f06_abort_unsettled_generation(uuid,jsonb)','1dc974b3a2815763ae8dcea6428300b6','51bb407bdc34384cd09cbf495e640027'),
  ('public.fn_f06_abort_unsettled_hand(uuid,jsonb)','b9107a9215ace3a1ba3a1fa501e67be1','399a784f001ccf306baf3e58ea4b20fa'),
  ('public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)','feca3b09bede187fa292c4c4689928d9','16c1809cfccad655bf029213c5fa46ed'),
  ('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)','4f20f5a2f6d7249578931bc877869981','b444940b36edffeb5691ed138e6137f7'),
  ('public.fn_f06_void_stranded_mixed_original(uuid)','1dd182cf7e6813c59cf82204da332576','c8c97e9e8f309856c1b9836bebdb138f'),
  ('public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)','9d0b9f99635e6eb793e919c3e66eaa85','4280a0ab23a8b01473b0e664c2bade97'),
  ('public.fn_join_club(uuid)','dcaa667c0b05e967c93ded88e5bc4994','ca1bdbb859127e65be013b2946fca2f1'),
  ('public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)','1adbc87ee53a885ba9a161560aab9c55','319af66018c7e1cd0781fc1a35c28219'),
  ('public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)','98b1fd9614a037de8d9991e35a3f7d77','d446c24e2a40221b54c88375d590c61c'),
  ('public.fn_patch_account_settings(uuid,uuid,jsonb,text)','d2702732a88764db4edf10b2ae317d72','f3fbebe60b38957c9505f348dd8b5e2c'),
  ('public.fn_patch_table_appearance(uuid,uuid,text,jsonb)','0969c73adf0ee0694bf1163d62ae4dd6','65063a89737f0943772a9ea43e273e6f'),
  ('public.fn_poker_diamond_tournament_cancel(uuid,uuid)','8101d272ad5a512a5cf05720046c7e87','a9d0b32431f404f31c8a64d75e1be372'),
  ('public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)','6e3a82f7b5bf8e1f10d44e34fe214117','88113c3aab85f3e48cfd8debf6e86de1'),
  ('public.fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean)','3e3f2beda130c83136f8513581b5d2a7','77039018be0f7df02e9fd7a95d5fccf3'),
  ('public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)','29dcd44b8e4fcb2d2db60568acd58cba','c2a22e10d243018259c782b17973b910'),
  ('public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)','6a0e2272ad4e8d9bf7d413d960d1da6a','e63be2814e7a32620b7e529d92d3c1c7'),
  ('public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)','03e41b8e160b8c392adae1fec55bff3a','058f765455a186b402b3a9a06a9a9b52'),
  ('public.fn_remove_settled_club_member(uuid,uuid)','cd55db1f12e08f0b2de97fb0503e5712','acdfe7bc5b3138c9c188cdf1e8e24f22'),
  ('public.fn_resolve_satellite_settlement_outcome(uuid,uuid)','027bc2f36747c4b5db5b728988bcebeb','340b06dc703f230ab2e7fc0dff174c41'),
  ('public.fn_retire_settled_club(uuid,text,text)','6f51f29641763723ee2d793a36528fa3','2c6890c42f1a0b446856b2702c7b46b5'),
  ('public.fn_retire_settled_club_core_20260906(uuid,text,text)','bffb2c74ace20d6568b69ab6ed4598fe','a283c2b2e30e3651886004dabf308098'),
  ('public.fn_save_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,uuid)','6561793946be4db5cc5e4c770d669b11','68c3aed2a9601f3d7e05d8331bc8b25e'),
  ('public.fn_seat_stage_entitlement(uuid,uuid,uuid,uuid,uuid,integer)','2441b713073c4c3ff82f3774c7e67e5a','cfa6cb600f4822885e48894da3b2572d'),
  ('public.fn_set_capability_readiness(text,text,text,bigint,jsonb)','385a5b7932f2c43f197c0ffb05346ec3','1f6098803a0b1374ab1a0485561ce97e'),
  ('public.fn_set_interface_theme(uuid,uuid,text)','ff62f272a83db682555a03bf2a4a545d','5b73bef7bb580a77d7c7cbb015668c7c'),
  ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)','ce500062c299282152df54364da70a1a','384887d62082eec9a0d61a9d49d955a2'),
  ('public.fn_settle_tournament_places(uuid,uuid)','4479a983181c829b6c8bf5c05c98cd38','94a75e2105a11dfdf06d3be01d69bb4a'),
  ('public.fn_settle_tournament_places_by_ruling(uuid,text,text)','fabd7442821c29c87a0fc248e8cc0f44','a9b6dfc201180950a275196d46c7e17a'),
  ('public.fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)','5e696c31a3f1af7a95f34fd91d6915d4','10e0da6995df7d2be3cd33683954ceaa'),
  ('public.fn_stamp_tournament_terminal_evidence_markers()','eeec4e4610901fe4b44b0b8f270d1ef7','14c900bb427e28b265172e38b274afa7'),
  ('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)','215c019d293a9082a13dfb6de2151f77','c17d6b72cd9df59e07b94029b705d23d'),
  ('public.resolve_venue_location_integrity(integer,timestamp with time zone,text,text,text,double precision,double precision,text,uuid,text,text)','d8393cd4043f5ebbe9193f6299ac9c0c','7fc8d6e3a0877b667967e19e4168b960'),
  ('public.retire_duplicate_poker_venue(integer,integer,timestamp with time zone,text,uuid)','84188d8ceccd1d9477b703f34f4c3294','e715166043623d629cb36f38c3f41f6b'),
  ('smarter_private.f06_dispose_dead_origin(uuid)','4426342c0ded8e776ef36d1fc6d8c245','fb6c97ec370401c601a2d50dda8895f6'),
  ('smarter_private.f06_hand_dispatch_guard(uuid,bigint)','fa3b6cc670788a490c42f324ecf74a76','efdb53d70cf631bd3179354e5caf1ec1'),
  ('smarter_private.f06_historical_loss_bank_proof(uuid,jsonb,jsonb)','6944a7882e317e0cc6d4c288c35949cc','f91fdade22a4eb686edb35de1d47d0f2'),
  ('smarter_private.f06_historical_loss_pending(uuid,jsonb,boolean)','3cf57cef8248878ca91f1b99add950dd','3515bf8ca79ca54323f994b5db1ea7bf'),
  ('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)','269b7f20c326e04788c003f2a8b081ad','f478f6d3cf842dd703a939851f66a86e'),
  ('smarter_private.f06_retired_origin_begin(jsonb)','5ea96d25a6b7262f3618dc763cd21d5b','a53dbf9b77fefce0c1fd55c97e33073d'),
  ('smarter_private.f06_retired_origin_lock(uuid)','cd9ee5827729c77153aa33de252d15ab','4cb4a1612313b536195bc0151c1240d3'),
  ('smarter_private.f06_retired_origin_snapshot(jsonb)','f1dc5d4b2a952ebb783e6ae66b844b94','fe8c2a0856fae31b9673c4de41615a49'),
  ('smarter_private.f06_void_retired_mixed_custody_event(uuid,text)','85f453588cbf1300d7ac5279da548d9d','136f37af859dea2e4da40c05ace6a68f'),
  ('smarter_private.spin_archived_first_launch_witness(uuid,timestamp with time zone)','cf629f10b7ba704d6a3432b3f5281785','191dbb6e21047416440e684b5cc37242'),
  ('smarter_private.spin_archived_first_preimage()','0852d54a147762e0f1e8c0e8996132f5','45d10ea5f28b0cad00b59b3509a025c9'),
  ('smarter_private.spin_archived_first_standings(uuid,uuid)','268eb783e2ae723896acd222e80c57af','ca9a6ff65f04096dbe67df385369e569'),
  ('public.trivia_paid_skip_adopt_legacy_v1(uuid,uuid)','2100df31fdd3ec3646cbcbe24a3a6cde','c23a428480a39263b367ed5cb10b3700')
  ) AS pins(signature, preimage, postimage) LOOP
    d := pg_get_functiondef(r.signature::regprocedure);
    IF md5(d) = r.postimage THEN
      RAISE NOTICE 'RERUN_REFUSAL already applied: %', r.signature;
      CONTINUE;
    END IF;
    IF md5(d) <> r.preimage THEN
      RAISE EXCEPTION 'RERUN_REFUSAL_PREIMAGE_CHANGED: %', r.signature;
    END IF;
    SELECT proowner, prosecdef, proconfig, proacl
      INTO owner_before, security_before, config_before, acl_before
      FROM pg_catalog.pg_proc WHERE oid = r.signature::regprocedure;
    n := d;
    FOR f IN SELECT * FROM (VALUES
  ('public.apply_venue_directory_enrichment(integer,timestamp with time zone,text,text,text,text,text,text,numeric,text,uuid)',$q$RAISE EXCEPTION 'venue revision changed' USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.atomic_cancel_tournament(uuid,uuid)',$q$RAISE EXCEPTION 'Spin % reserve vanished during contribution reversal',p_tournament_id
        USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.atomic_cancel_tournament(uuid,uuid)',$q$RAISE EXCEPTION 'Spin % reserve vanished during draw reversal',p_tournament_id
          USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.atomic_cancel_tournament(uuid,uuid)',$q$RAISE EXCEPTION 'tournament % did not close every table',p_tournament_id
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.atomic_cancel_tournament(uuid,uuid)',$q$RAISE EXCEPTION 'tournament % lost its cancellation lifecycle claim',
      p_tournament_id USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.atomic_cancel_tournament(uuid,uuid)',$q$RAISE EXCEPTION 'tournament % lost its exact-zero escrow close',p_tournament_id
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.ca_rake_export_start(text,uuid,date,date,uuid,text,text,uuid)',$q$RAISE EXCEPTION
      'Rake Snapshot export changed while it was being prepared'
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.complete_rights_cleared_youtube_transcode(text,uuid,text,text,text)',$q$RAISE EXCEPTION USING
      ERRCODE = <<C>>$q$,'55000',2),
  ('public.fn_bag_tournament_stage(uuid,uuid,integer,jsonb)',$q$RAISE EXCEPTION 'MULTI_DAY_BAG_SEAT_COUNT_CHANGED: % vacated, % expected', v_rows, v_seats USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid)',$q$RAISE EXCEPTION 'tournament launch receipt changed during lease adoption'
          USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text)',$q$RAISE EXCEPTION 'tournament launch receipt changed during lease adoption'
          USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)',$q$RAISE EXCEPTION 'tournament roster changed during seat assignment'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)',$q$RAISE EXCEPTION 'tournament table vanished during seat assignment'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)',$q$RAISE EXCEPTION 'vacated tournament seat changed during assignment'
          USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)',$q$RAISE EXCEPTION 'chosen tournament table lost its legal chair'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)',$q$RAISE EXCEPTION 'HAND_DISPOSAL_TABLE_BUSY' USING ERRCODE = <<C>>$q$,'55P03',1),
  ('public.fn_ca_escrow_on_wallet_tx()',$q$RAISE EXCEPTION 'exact refund authorization was not consumed once'
          USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_legacy_period_maturity()',$q$RAISE EXCEPTION 'Legacy period payment requires a closed earning period' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_legacy_round3_wallet_receipt()',$q$RAISE EXCEPTION 'Legacy period payment requires a closed earning period' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_operator_cancel_tournament(uuid,uuid,text,uuid,text)',$q$RAISE EXCEPTION 'tournament_review_changed' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)',$q$RAISE EXCEPTION 'Exact tournament funding wallet changed during debit'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)',$q$RAISE EXCEPTION 'Locked tournament roster changed during chip grant'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)',$q$RAISE EXCEPTION 'Tournament vanished during chip-purchase pool booking'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb)',$q$RAISE EXCEPTION 'owner_fee_operation_replayed_with_different_events' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)',$q$RAISE EXCEPTION 'tournament prize changed from expected % to %',
      p_expected_prize,v_current_prize USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)',$q$RAISE EXCEPTION 'tournament prize compare-and-set lost its locked row'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_resume_hand_submission(uuid,text,uuid)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_ca_resume_hand_submission(uuid,text,uuid)',$q$RAISE EXCEPTION 'HAND_SUBMISSION_ADMISSION_CHANGED: %',r USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_ca_resume_original_paid_tournament_entry(uuid,jsonb)',$q$RAISE EXCEPTION 'ORIGINAL_PAID_CANDIDATE_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_retain_hand_submission(jsonb)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_ca_return_excess_start_overlay_locked(uuid)',$q$RAISE EXCEPTION 'excess overlay return did not credit its bank exactly'
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_set_emergency_stop(text,boolean,bigint,text,uuid,uuid,text)',$q$RAISE EXCEPTION 'stop_version_changed' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)',$q$RAISE EXCEPTION 'Atomic mystery-bounty rebuy award changed before reveal'
          USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)',$q$RAISE EXCEPTION 'Atomic mystery-bounty rebuy chest changed before reveal'
          USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)',$q$RAISE EXCEPTION 'Bounty rebuy old head changed before retirement'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',$q$RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',$q$RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',$q$RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',$q$RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',$q$RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',$q$RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',$q$RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',$q$RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)',$q$RAISE EXCEPTION 'registration % tournament cache changed',v_reg.id
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)',$q$RAISE EXCEPTION 'registration % was not deleted after settlement',v_reg.id
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_cash_seat_move_execute(uuid)',$q$RAISE EXCEPTION 'SEAT_MOVE_PARTNER_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_cashier_lock_authority(uuid,uuid,uuid,uuid)',$q$RAISE EXCEPTION 'cashier_authority_changed_during_lock' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)',$q$RAISE EXCEPTION 'bounty elimination CAS missed after locked claim'
      USING ERRCODE=<<S>>$q$,'55000',1),
  ('public.fn_claim_final_table_transition(uuid,uuid)',$q$RAISE EXCEPTION 'FINAL_TABLE_CLAIM_CORRUPT: an untriggered tournament already has another owner'
        USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)',$q$RAISE EXCEPTION
        'a bought-back knockout generation changed while the bounty claim committed'
        USING ERRCODE=<<S>>$q$,'55000',1),
  ('public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)',$q$RAISE EXCEPTION
        'bounty knockout generation changed while claim committed'
        USING ERRCODE=<<S>>$q$,'55000',1),
  ('public.fn_claim_tournament_finish(uuid,uuid,text)',$q$RAISE EXCEPTION 'finish claim CAS changed % rows for tournament %',
        v_rows, p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_close_settlement_period(uuid)',$q$RAISE EXCEPTION 'Rakeback period scope changed during admission' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_club_set_member_status(uuid,uuid,text,text)',$q$RAISE EXCEPTION 'membership changed during status change' USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_CREDIT_EVIDENCE_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_EVENT_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_FEE_CHARGE_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_FUNDING_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_LATER_AUTHORITY_OR_HAND_STATE' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_MANAGER_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_OBLIGATIONS_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_ORIGINAL_RANK_LOST' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_ORIGINAL_ROSTER_OR_ENTRY_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_PAID_EVIDENCE_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_PHYSICAL_ROSTER_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_REPLAY_MISMATCH' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_breakfast_original_witness(uuid,jsonb)',$q$RAISE EXCEPTION 'BREAKFAST_ZERO_SEAT_EXIT_LOST' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_first_archived_spin(uuid,text)',$q$RAISE EXCEPTION 'ARCHIVED_SPIN_COMPETING_OWNER' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_first_archived_spin(uuid,text)',$q$RAISE EXCEPTION 'ARCHIVED_SPIN_LATER_AUTHORITY' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_first_archived_spin(uuid,text)',$q$RAISE EXCEPTION 'ARCHIVED_SPIN_REPLAY_MISMATCH' USING ERRCODE=<<C>>$q$,'55000',2),
  ('public.fn_complete_sep8_spin_original_standings(uuid,jsonb)',$q$RAISE EXCEPTION 'SPIN_ORIGINAL_EXPECTED_OR_MANAGER_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_sep8_spin_original_standings(uuid,jsonb)',$q$RAISE EXCEPTION 'SPIN_ORIGINAL_LATER_AUTHORITY' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_sep8_spin_original_standings(uuid,jsonb)',$q$RAISE EXCEPTION 'SPIN_ORIGINAL_PREIMAGE_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_sep8_spin_original_standings(uuid,jsonb)',$q$RAISE EXCEPTION 'SPIN_ORIGINAL_REPLAY_MISMATCH' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_complete_stage_resume(uuid,uuid,uuid)',$q$RAISE EXCEPTION 'MULTI_DAY_RESUME_STATUS_NOT_ACKNOWLEDGED' USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)',$q$RAISE EXCEPTION 'tournament launch status changed inside its completion transaction'
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',$q$RAISE EXCEPTION 'club % changed union while tournament % claimed terminal banks',
        v_t.club_id,p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',$q$RAISE EXCEPTION 'tournament % did not durably release every seat and close every table',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',$q$RAISE EXCEPTION 'tournament % lost its exact zero escrow close',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',$q$RAISE EXCEPTION 'tournament % lost its terminal lifecycle claim',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_credit_maintenance_thaw_targets(timestamp with time zone,numeric)',$q$RAISE EXCEPTION 'MAINTENANCE_THAW_TARGET_CHANGED: % moved %, receipted %',
        v_step, v_moved, v_marked
        USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)',$q$RAISE EXCEPTION 'zero-stack elimination CAS changed % rows',v_changed
      USING ERRCODE=<<S>>$q$,'55000',1),
  ('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',$q$RAISE EXCEPTION 'a bought-back knockout generation changed while elimination committed'
        USING ERRCODE=<<S>>$q$,'55000',1),
  ('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',$q$RAISE EXCEPTION 'knockout generation changed while elimination committed'
        USING ERRCODE=<<S>>$q$,'55000',1),
  ('public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)',$q$RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE = <<C>>$q$,'55P03',1),
  ('public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE = <<C>>$q$,'55P03',1),
  ('public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)',$q$RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_f06_abort_successor_unsettled_hand(uuid,jsonb)',$q$RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_f06_abort_successor_unsettled_hand(uuid,jsonb)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_f06_abort_unsettled_generation(uuid,jsonb)',$q$RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_f06_abort_unsettled_generation(uuid,jsonb)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_f06_abort_unsettled_hand(uuid,jsonb)',$q$RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_f06_abort_unsettled_hand(uuid,jsonb)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)',$q$RAISE EXCEPTION 'F06_RETRY_MAINTENANCE_LANE' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_f06_void_stranded_mixed_original(uuid)',$q$RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE = <<C>>$q$,'55P03',1),
  ('public.fn_f06_void_stranded_mixed_original(uuid)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE = <<C>>$q$,'55P03',1),
  ('public.fn_f06_void_stranded_mixed_original(uuid)',$q$RAISE EXCEPTION 'F06_STRANDED_EVENT_OWNED' USING ERRCODE = <<C>>$q$,'55P03',1),
  ('public.fn_f06_void_stranded_mixed_original(uuid)',$q$RAISE EXCEPTION 'F06_STRANDED_PERMIT_CLAIM_LOST' USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_f06_void_stranded_mixed_original(uuid)',$q$RAISE EXCEPTION 'F06_STRANDED_SNAPSHOT_CLAIM_LOST' USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('public.fn_join_club(uuid)',$q$RAISE EXCEPTION 'membership lifecycle changed during rejoin' USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)',$q$RAISE EXCEPTION 'tournament move could not reuse destination seat'
          USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)',$q$RAISE EXCEPTION 'tournament move lost its locked roster row'
        USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)',$q$RAISE EXCEPTION 'tournament move lost its locked source seat'
        USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)',$q$EXCEPTION WHEN SQLSTATE <<C>> THEN$q$,'55P03',1),
  ('public.fn_patch_account_settings(uuid,uuid,jsonb,text)',$q$RAISE EXCEPTION 'Mutation is still in progress; retry with the same mutation id'
        USING ERRCODE = <<C>>$q$,'55P03',1),
  ('public.fn_patch_table_appearance(uuid,uuid,text,jsonb)',$q$RAISE EXCEPTION 'Mutation is still in progress; retry with the same mutation id'
        USING ERRCODE = <<C>>$q$,'55P03',1),
  ('public.fn_poker_diamond_tournament_cancel(uuid,uuid)',$q$RAISE EXCEPTION 'tournament % did not close every table', p_tournament_id USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_poker_diamond_tournament_cancel(uuid,uuid)',$q$RAISE EXCEPTION 'tournament % lost its cancellation lifecycle claim', p_tournament_id USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)',$q$RAISE EXCEPTION 'tournament vanished during unregistration' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean)',$q$RAISE EXCEPTION 'Leaderboard Prize Setup Changed In Another Session'
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)',$q$RAISE EXCEPTION 'Tournament blind publication was not fully acknowledged' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)',$q$RAISE EXCEPTION 'Tournament blind transition does not follow its committed level'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)',$q$RAISE EXCEPTION
      'Tournament registration identity changed after its atomic debit; retry the complete transaction'
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)',$q$RAISE EXCEPTION
      'Tournament roster cache changed during registration'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)',$q$RAISE EXCEPTION
      'Horse tournament registration identity changed after its atomic debit; retry the complete transaction'
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)',$q$RAISE EXCEPTION
      'Tournament roster cache changed during horse registration'
      USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_remove_settled_club_member(uuid,uuid)',$q$RAISE EXCEPTION 'membership changed during departure' USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_resolve_satellite_settlement_outcome(uuid,uuid)',$q$RAISE EXCEPTION 'satellite % target changed while outcome acquired locks',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_retire_settled_club(uuid,text,text)',$q$RAISE EXCEPTION 'CLUB_OPENING_GRANT_CHANGED_DURING_RETIREMENT' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.fn_retire_settled_club_core_20260906(uuid,text,text)',$q$RAISE EXCEPTION 'club lifecycle changed during retirement' USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_save_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,uuid)',$q$RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_LOST: save refused'
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_seat_stage_entitlement(uuid,uuid,uuid,uuid,uuid,integer)',$q$RAISE EXCEPTION 'vacated tournament seat changed during stage seating' USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_set_capability_readiness(text,text,text,bigint,jsonb)',$q$RAISE EXCEPTION 'CAPABILITY_REVISION_STALE: % expected revision %, current %',
      p_capability_id, p_expected_revision, v_row.revision USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_set_interface_theme(uuid,uuid,text)',$q$RAISE EXCEPTION 'Mutation is still in progress; retry with the same mutation id'
        USING ERRCODE = <<C>>$q$,'55P03',1),
  ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',$q$RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',$q$RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',$q$RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',$q$RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',$q$RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',$q$RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',$q$RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',$q$RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_tournament_places(uuid,uuid)',$q$RAISE EXCEPTION 'tournament % lost its RUNNING finish claim',
          p_tournament_id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_tournament_places_by_ruling(uuid,text,text)',$q$RAISE EXCEPTION 'the COMPLETING claim was lost before the ruling could complete the event'
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)',$q$RAISE EXCEPTION 'exact refund obligation did not close at %',v_total
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)',$q$RAISE EXCEPTION 'exact source wallet changed during refund'
      USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.fn_stamp_tournament_terminal_evidence_markers()',$q$RAISE EXCEPTION 'terminal tournament % did not stamp every mutable evidence row',
      NEW.id USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',$q$RAISE EXCEPTION 'Add-on live table changed after its atomic-table lock'
        USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',$q$RAISE EXCEPTION 'exact knockout generation did not close with its purchase'
        USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',$q$RAISE EXCEPTION 'rebuy could not advance the live seat generation'
          USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.resolve_venue_location_integrity(integer,timestamp with time zone,text,text,text,double precision,double precision,text,uuid,text,text)',$q$RAISE EXCEPTION 'venue revision changed' USING ERRCODE = <<C>>$q$,'55000',1),
  ('public.retire_duplicate_poker_venue(integer,integer,timestamp with time zone,text,uuid)',$q$RAISE EXCEPTION 'venue revision changed' USING ERRCODE = <<C>>$q$,'55000',1),
  ('smarter_private.f06_dispose_dead_origin(uuid)',$q$RAISE EXCEPTION 'F06_STRANDED_EVENT_OWNED' USING ERRCODE = <<C>>$q$,'55P03',1),
  ('smarter_private.f06_hand_dispatch_guard(uuid,bigint)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('smarter_private.f06_historical_loss_bank_proof(uuid,jsonb,jsonb)',$q$RAISE EXCEPTION 'F06_HISTORICAL_LOSS_ALLOWANCE_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('smarter_private.f06_historical_loss_pending(uuid,jsonb,boolean)',$q$RAISE EXCEPTION 'F06_HISTORICAL_LOSS_ALLOWANCE_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)',$q$RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('smarter_private.f06_retired_origin_begin(jsonb)',$q$RAISE EXCEPTION 'F06_RETRY_MAINTENANCE_LANE' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('smarter_private.f06_retired_origin_lock(uuid)',$q$RAISE EXCEPTION 'F06_RETIRED_CLAIM_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('smarter_private.f06_retired_origin_snapshot(jsonb)',$q$RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('smarter_private.f06_retired_origin_snapshot(jsonb)',$q$RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE=<<C>>$q$,'55P03',1),
  ('smarter_private.f06_void_retired_mixed_custody_event(uuid,text)',$q$RAISE EXCEPTION 'F06_VOID_BUST_NOT_RECORDED' USING ERRCODE = <<C>>$q$,'55000',1),
  ('smarter_private.f06_void_retired_mixed_custody_event(uuid,text)',$q$RAISE EXCEPTION 'F06_VOID_CLAIM_LOST' USING ERRCODE = <<C>>$q$,'55000',1),
  ('smarter_private.f06_void_retired_mixed_custody_event(uuid,text)',$q$RAISE EXCEPTION 'F06_VOID_ESCROW_CLOSE_LOST' USING ERRCODE = <<C>>$q$,'55000',1),
  ('smarter_private.f06_void_retired_mixed_custody_event(uuid,text)',$q$RAISE EXCEPTION 'F06_VOID_LEASE_NOT_RELEASED' USING ERRCODE = <<C>>$q$,'55000',1),
  ('smarter_private.f06_void_retired_mixed_custody_event(uuid,text)',$q$RAISE EXCEPTION 'F06_VOID_LIFECYCLE_CLAIM_LOST' USING ERRCODE = <<C>>$q$,'55000',1),
  ('smarter_private.f06_void_retired_mixed_custody_event(uuid,text)',$q$RAISE EXCEPTION 'F06_VOID_OVERLAY_SOURCE_CHANGED' USING ERRCODE = <<C>>$q$,'55000',1),
  ('smarter_private.f06_void_retired_mixed_custody_event(uuid,text)',$q$RAISE EXCEPTION 'F06_VOID_TABLES_NOT_CLOSED' USING ERRCODE = <<C>>$q$,'55000',1),
  ('smarter_private.spin_archived_first_launch_witness(uuid,timestamp with time zone)',$q$RAISE EXCEPTION 'ARCHIVED_SPIN_FIRST_HAND_IDENTITY' USING ERRCODE=<<C>>$q$,'55000',1),
  ('smarter_private.spin_archived_first_launch_witness(uuid,timestamp with time zone)',$q$RAISE EXCEPTION 'ARCHIVED_SPIN_LAUNCH_AUTHORITY_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('smarter_private.spin_archived_first_preimage()',$q$RAISE EXCEPTION 'ARCHIVED_SPIN_PREIMAGE_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('smarter_private.spin_archived_first_standings(uuid,uuid)',$q$RAISE EXCEPTION 'ARCHIVED_SPIN_RECORDED_PLACE_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('smarter_private.spin_archived_first_standings(uuid,uuid)',$q$RAISE EXCEPTION 'ARCHIVED_SPIN_ROSTER_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('smarter_private.spin_archived_first_standings(uuid,uuid)',$q$RAISE EXCEPTION 'ARCHIVED_SPIN_ROSTER_CLOSURE_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('smarter_private.spin_archived_first_standings(uuid,uuid)',$q$RAISE EXCEPTION 'ARCHIVED_SPIN_WINNER_CHANGED' USING ERRCODE=<<C>>$q$,'55000',1),
  ('public.trivia_paid_skip_adopt_legacy_v1(uuid,uuid)',$q$RAISE EXCEPTION 'legacy paid-skip answer binding changed concurrently'
                        USING ERRCODE=<<S>>$q$,'55000',1)
    ) AS sites(signature, fragment, new_code, expected)
    WHERE sites.signature = r.signature LOOP
      v_old := replace(replace(f.fragment, '<<C>>', c_old_code), '<<S>>', c_old_name);
      v_new := replace(replace(f.fragment, '<<C>>', quote_literal(f.new_code)),
                       '<<S>>', quote_literal(f.new_code));
      v_found := (length(n) - length(replace(n, v_old, ''))) / length(v_old);
      IF v_found <> f.expected THEN
        RAISE EXCEPTION 'RERUN_REFUSAL_SITE_COUNT_CHANGED: % has % of %, expected %',
          r.signature, v_found, left(v_old, 80), f.expected;
      END IF;
      n := replace(n, v_old, v_new);
      v_sites := v_sites + f.expected;
    END LOOP;
    IF md5(n) <> r.postimage THEN
      RAISE EXCEPTION 'RERUN_REFUSAL_POSTIMAGE_CHANGED: %', r.signature;
    END IF;
    EXECUTE n;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
                    WHERE oid = r.signature::regprocedure
                      AND proowner = owner_before AND prosecdef = security_before
                      AND proconfig IS NOT DISTINCT FROM config_before
                      AND proacl IS NOT DISTINCT FROM acl_before)
       OR md5(pg_get_functiondef(r.signature::regprocedure)) <> r.postimage THEN
      RAISE EXCEPTION 'RERUN_REFUSAL_METADATA_CHANGED: %', r.signature;
    END IF;
    v_changed := v_changed + 1;
  END LOOP;
  IF v_changed NOT IN (0, 91) OR (v_changed = 91 AND v_sites <> 172) THEN
    RAISE EXCEPTION 'RERUN_REFUSAL_RESULT_CHANGED: % functions, % sites', v_changed, v_sites;
  END IF;
END $install$;
DO $prove$
DECLARE v_left text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_left
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'smarter_private')
     AND p.prosrc ~* ('errcode\s*=\s*' || chr(39) || '(400' || '01|serialization_failure)' || chr(39))
     AND p.oid <> ALL (ARRAY[
    'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
    'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)',
    'public.fn_lock_tournament_launch_proof_parents(uuid[])',
    'public.fn_refuse_new_entries_while_frozen()',
    'public.fn_serialize_entry_statement()',
    'public.fn_settle_final_table_deal_atomic(uuid)',
    'public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)',
    'public.fn_settle_tournament_places_atomic(uuid,text)',
    'public.fn_union_pnl_original_frame()']::regprocedure[]);
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'RERUN_REFUSAL_RESULT_CHANGED: unreviewed serialization failures in %', v_left;
  END IF;
END $prove$;
COMMIT;
