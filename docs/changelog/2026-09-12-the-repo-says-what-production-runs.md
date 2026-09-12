# The repo says what production runs

2026-09-12. Repo-only. **No migration was applied, no database object was
changed, and nothing was written to `supabase_migrations.schema_migrations`.**
Every `.sql` file on this branch DESCRIBES DDL production already has. All
database access behind this branch was a read-only session
(`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`).

`supabase/migrations/` and `supabase_migrations.schema_migrations` are supposed
to be two views of one thing. Measured against the ledger as of
2026-09-12 (4478 ledger rows, 2969 files on
`origin/main`, 1127 files in the sibling repo), they are not.

---

## The instance that was already biting

`20260911160817 a_money_writing_function_is_registered_before_it_exists` is in
the ledger and is on no branch of this repo and no branch of the sibling. It
created the only guard on this platform that refuses an unregistered
money-writing function:

```
evtname                     evtevent          evtenabled  function
ab_ca_money_rpc_registered  ddl_command_end   O           fn_ca_money_rpc_registry_guard
```

Two consequences were verified, not assumed.

**A replay of the repo produces a database with no such guard.** The event
trigger exists only in production. Nothing in `origin/main` creates it.

**A law test passes against a file that no longer describes production.**
`tests/oneMovementIsOneLeg.law.test.ts:148` reads a migration FILE out of
`supabase/migrations` and asserts the auto-close list is

```
ARRAY['fn_ca_conservation_sweep','fn_ca_ratchet_watch','fn_bbj_reconcile']
```

Production's live `fn_ca_resolve_cleared_incidents` reads

```
ARRAY['fn_ca_conservation_sweep','fn_ca_ratchet_watch','fn_bbj_reconcile','fn_ca_money_rpc_drift']
```

The fourth detector was added by `20260911160817`. The assertion is a
substring match, so a list that has GROWN still contains the old one and the
test goes green. That is 10.83 exactly — a check nobody can see is not a check
— and 10.84 — the test reads a hand-held copy instead of what the monitor
reads. The mirror on this branch is the file the test should have been reading.

---

## Direction A — applied to production, no file in any repo

**1280 ledger rows have no file**, on `origin/main` or in
`Smarter-Poker-World-Hub`. Matching is by the checker's own semantics
(`indexFrom`/`recordedBy` from `scripts/ci/check-applied-migrations-are-recorded.mjs`):
version stamp OR migration name, each with a leading date stamp stripped from
both sides. Indexing Club-Arena alone would have reported
2080; the sibling repo accounts for the difference, and
counting those would have been an alarm about files that exist.

| window | rows with no file |
| --- | --- |
| 2026-04 | 410 |
| 2026-05 | 89 |
| 2026-06 | 2 |
| 2026-07 | 108 |
| 2026-08 | 530 |
| 2026-09 (live drift) | 140 |
| `manual` (unversioned) | 1 |

The 1139 pre-September rows are the mass this estate has deliberately
not audited — `check-migrations-applied.mjs` calls the old files "history, not
truth". They are reported here and **not** mirrored. The September rows are the
live drift, and they are what this branch closes.

### The 2026-09 drift, ranked by what a rebuild would lack

#### Rank 1 — CRITICAL — 27 migration(s)

A refusal production has and a rebuild would not: an event trigger, a CHECK constraint, or a table trigger that rejects or rewrites a write. A database rebuilt from the repo accepts rows production refuses, silently.

| version | name | bytes | status |
| --- | --- | ---: | --- |
| 20260903191338 | `one_ladder_one_count_for_every_club_and_union` | 15078 | mirrored here |
| 20260904081210 | `owners_and_co_owners_hold_a_player_wallet_admins_never` | 7070 | mirrored here |
| 20260904110252 | `the_noop_trigger_that_broke_settlement_is_removed` | 4718 | mirrored here |
| 20260905160815 | `the_felt_colour_column_holds_only_felt_colours` | 2178 | mirrored here |
| 20260906235959 | `video_reels_integrity_foundation` | 186134 | mirrored here |
| 20260907233813 | `the_bridge_rate_is_a_row_and_the_ledger_learns_the_wheel` | 21020 | mirrored here |
| 20260907233833 | `the_diamond_wheel` | 61532 | mirrored here |
| 20260907235112 | `the_ledger_learns_the_word_wheel_prize` | 3383 | mirrored here |
| 20260908004858 | `the_wheel_opens_with_a_seeded_diamond_float` | 17355 | mirrored here |
| 20260908010225 | `the_ledger_learns_plinko_and_crash_prizes` | 3237 | mirrored here |
| 20260908010241 | `plinko_and_crash_the_two_alternates_to_the_wheel` | 85191 | mirrored here |
| 20260908161356 | `training_attempt_decision_delivery_authority_phase6_pr_a` | 84096 | mirrored here |
| 20260908162116 | `training_solver_artifact_catalog_phase6_exact` | 30846 | mirrored here |
| 20260908162122 | `training_streak_out_of_order_completion_phase6_exact` | 30638 | mirrored here |
| 20260908162128 | `training_solver_spot_security_hardening_phase6_exact` | 62287 | mirrored here |
| 20260908233111 | `all_in_equity_coverage_is_witnessed_at_runout` | 3112 | mirrored here |
| 20260909213023 | `the_daily_bonus_keeps_its_own_books` | 22171 | mirrored here |
| 20260909223448 | `tournament_launch_supply_version_zero_is_explicit` | 3899 | mirrored here |
| 20260909232718 | `ca_a_terminal_stamp_is_not_a_reporting_change` | 6468 | mirrored here |
| 20260909233948 | `ca_a_move_to_a_closed_table_is_cancelled_not_thrown` | 4130 | mirrored here |
| 20260909234101 | `the_wheel_gives_a_free_spin_a_day` | 20967 | mirrored here |
| 20260909235604 | `a_registrant_the_launch_cannot_seat_is_released_with_an_exac` | 4476 | mirrored here |
| 20260910125453 | `phase_three_versioned_final_deal_expansion` | 45658 | mirrored here |
| 20260911151623 | `a_diamond_transfer_names_both_sides_and_never_burns_what_it_` | 24848 | mirrored here |
| 20260911160817 | `a_money_writing_function_is_registered_before_it_exists` | 17856 | mirrored here |
| 20260911161027 | `the_supply_meter_counts_the_tickets_it_issued` | 28431 | mirrored here |
| 20260911230657 | `an_arena_table_is_governed_by_the_diamond_boundary_not_a_cluster` | 1280 | mirrored here |

#### Rank 2 — HIGH — 25 migration(s)

A money-path function body, or a trigger whose behaviour is not a refusal. A rebuild gets an older body or none, so the arithmetic differs from production.

| version | name | bytes | status |
| --- | --- | ---: | --- |
| 20260903013806 | `financial_alerts_clear_themselves_when_settled` | 6901 | mirrored here |
| 20260903023530 | `chip_supply_snapshot_is_incremental` | 5460 | mirrored here |
| 20260904110947 | `settlement_health_is_on_a_gauge` | 2766 | mirrored here |
| 20260904182824 | `money_alerts_resolve_themselves_and_the_backlog_is_visible` | 6077 | mirrored here |
| 20260904182847 | `every_trigger_on_a_money_table_is_declared` | 4190 | mirrored here |
| 20260905000730 | `the_club_message_has_one_rule_and_one_door` | 16578 | mirrored here |
| 20260905103832 | `a_horse_is_stamped_on_its_seat_trigger` | 650 | mirrored here |
| 20260906013826 | `the_balancer_carries_the_rested_games_forward` | 5581 | mirrored here |
| 20260906021005 | `leaderboard_settlement_follows_published_period` | 5350 | mirrored here |
| 20260907081603 | `marketplace_phase8_lifetime_vip_unlimited_digital_benefits` | 54796 | mirrored here |
| 20260907193146 | `rakeback_a_club_cannot_pay_is_somebody_told` | 7994 | mirrored here |
| 20260908001056 | `the_wheel_clears_its_autoskip_after_the_prize_leg` | 20359 | mirrored here |
| 20260908002718 | `spin_winner_topups_respect_the_drawn_payout_share` | 7189 | mirrored here |
| 20260909220613 | `tournament_chip_supply_rpc_names_are_sealed_until_activation` | 5327 | mirrored here |
| 20260909225435 | `ca_the_spin_wallet_mover_journals_the_union_leg` | 4049 | mirrored here |
| 20260909230222 | `the_games_have_a_floor` | 5123 | mirrored here |
| 20260910183806 | `the_floor_remembers_the_week` | 6309 | mirrored here |
| 20260910192951 | `the_games_belong_to_the_host` | 105252 | mirrored here |
| 20260910223856 | `the_bank_backs_the_promo_wallet` | 93916 | mirrored here |
| 20260911042849 | `the_promo_funding_button_is_safe_to_press_twice` | 10481 | mirrored here |
| 20260912044158 | `a_function_audited_as_moving_no_money_is_not_undeclared` | 2536 | mirrored here |
| 20260912044609 | `the_supply_meter_counts_the_pending_addon_float` | 16057 | mirrored here |
| 20260912044823 | `the_rake_rollup_stale_check_counts_both_legs` | 2673 | mirrored here |
| 20260912050353 | `a_money_adjacent_post_hand_failure_is_not_info` | 5893 | mirrored here |
| 20260912061157 | `the_felt_may_not_grow_past_what_was_bought_in` | 17414 | mirrored here |

#### Rank 3 — MEDIUM — 21 migration(s)

Tables, RLS and policies, or GRANT/REVOKE alone. A rebuild is more permissive, or is missing storage the code writes to.

| version | name | bytes | status |
| --- | --- | ---: | --- |
| 20260903011302 | `horse_flag_rpcs_state_their_audience` | 3012 | mirrored here |
| 20260904185338 | `a_retired_cron_job_stops_being_stale_forever` | 4646 | mirrored here |
| 20260904220519 | `sentry_event_budget` | 5449 | mirrored here |
| 20260905005906 | `audit_diagnostics_are_not_anon_surface` | 1078 | mirrored here |
| 20260905085612 | `the_dead_horse_schema_leaves_public` | 8943 | mirrored here |
| 20260905085723 | `a_materialized_view_cannot_enforce_rls` | 3442 | mirrored here |
| 20260905161853 | `create_ops_rollback_20260905` | 2195 | mirrored here |
| 20260905162517 | `create_ops_perf_snapshots` | 1656 | mirrored here |
| 20260905170112 | `ops_capture_archive_ddl_before_drop` | 856 | mirrored here |
| 20260905180056 | `capture_and_remove_bomb_multi_winner_repair_job` | 1006 | mirrored here |
| 20260905201913 | `fn_horse_daily_play_add_is_not_browser_callable` | 90 | mirrored here |
| 20260905202805 | `sp_prune_horse_hand_reviews_stays_daemon_only` | 173 | mirrored here |
| 20260905210156 | `ca_horse_tournament_card_needs_an_account` | 181 | mirrored here |
| 20260906122535 | `a_new_way_for_a_horse_to_post_is_off_until_dan_approves_it` | 3213 | mirrored here |
| 20260908034354 | `the_phrase_ledger_remembers_what_was_said_at_a_table` | 1791 | mirrored here |
| 20260908162134 | `training_solver_worker_signed_ingestion_phase6_exact` | 45234 | mirrored here |
| 20260909180615 | `maintenance_ownership_fits_process_lifetime` | 68108 | mirrored here |
| 20260910184842 | `daily_bonus_open_day_restates_service_role_only_acl` | 1688 | mirrored here |
| 20260911004421 | `the_games_grants_say_what_they_mean` | 6207 | mirrored here |
| 20260911152137 | `a_tournament_chip_grant_cannot_mint_grants` | 2416 | mirrored here |
| 20260912061735 | `the_felt_register_is_read_only_and_the_incident_is_closed` | 7707 | mirrored here |

#### Rank 4 — LOW — 41 migration(s)

A detector, gauge, view or index. A rebuild is blind where production can see, but it is not wrong.

| version | name | bytes | status |
| --- | --- | ---: | --- |
| 20260903031147 | `player_search_no_count_and_own_seat` | 20066 | mirrored here |
| 20260903073351 | `the_union_branch_belongs_to_production_not_to_every_club_rpc` | 3225 | mirrored here |
| 20260903184634 | `union_active_players_is_the_sum_of_its_clubs` | 2605 | mirrored here |
| 20260904031919 | `the_horses_stop_writing_what_nobody_reads` | 5202 | already on an in-flight branch |
| 20260904032904 | `horses_are_players_revert_the_two_gates_i_should_not_have_written` | 5921 | mirrored here |
| 20260904184236 | `the_cron_fleet_is_on_a_gauge` | 2820 | mirrored here |
| 20260904203012 | `union_creation_check_asks_who_is_calling` | 2138 | mirrored here |
| 20260905074151 | `a_claimed_night_that_produced_nothing_is_loud` | 2628 | mirrored here |
| 20260905084008 | `a_night_that_never_claimed_is_louder_than_a_hollow_one` | 3613 | mirrored here |
| 20260905085430 | `the_borrowed_name_guard_reads_the_live_roster` | 4488 | mirrored here |
| 20260905103820 | `a_horse_is_stamped_on_its_seat_functions` | 1936 | mirrored here |
| 20260905162114 | `add_index_drop_tracking` | 1181 | mirrored here |
| 20260905162416 | `harden_ops_rollback_helper` | 1133 | mirrored here |
| 20260905172107 | `create_ops_incident_triage_views` | 3138 | mirrored here |
| 20260905172144 | `tighten_incident_triage_canonicalisation` | 1398 | mirrored here |
| 20260905172225 | `fix_cron_health_window_consistency_v2` | 1230 | mirrored here |
| 20260905180235 | `add_bomb_pot_award_gap_check` | 1208 | mirrored here |
| 20260906093726 | `every_tag_carries_its_own_ev` | 9067 | mirrored here |
| 20260906093746 | `tag_ev_title_typo` | 2624 | mirrored here |
| 20260906093926 | `the_ev_ranking_pairs_every_mirror` | 3576 | mirrored here |
| 20260906095757 | `a_breather_that_never_ends_is_a_stranded_seat` | 5274 | mirrored here |
| 20260906095835 | `restore_the_seat_clock_and_append_the_breather` | 2693 | mirrored here |
| 20260906101306 | `a_behaviour_needs_a_stage_to_happen_on` | 5376 | mirrored here |
| 20260906101342 | `the_stage_check_joins_the_nightly_audit` | 4526 | mirrored here |
| 20260906101519 | `the_stage_check_cannot_invent_a_receipt` | 5741 | mirrored here |
| 20260906101611 | `the_stage_check_judges_only_the_stage` | 4530 | mirrored here |
| 20260906141230 | `a_player_export_forgets_horses_when_entitlement_does` | 4765 | mirrored here |
| 20260906160809 | `a_cloned_table_joins_its_game_as_a_feeder_never_as_a_second_main_one` | 4793 | mirrored here |
| 20260908001349 | `the_profile_guard_admits_the_wheel_and_the_metrics_take_a_nu` | 10185 | mirrored here |
| 20260908125235 | `a_player_may_belong_to_ten_clubs` | 10328 | mirrored here |
| 20260908155252 | `hand_projection_takes_post_commit_lock_first` | 10361 | mirrored here |
| 20260908161349 | `training_cache_event_idempotent_replay_phase6_pr_a_exact` | 8568 | mirrored here |
| 20260908233129 | `daily_mission_users_do_not_share_one_long_transaction` | 15085 | mirrored here |
| 20260909222044 | `paid_spin_launch_reads_owner_only_entitlements_through_one_door` | 5972 | mirrored here |
| 20260909224349 | `tournament_launch_supply_version_is_manager_only` | 6057 | mirrored here |
| 20260909235312 | `a_registrant_the_launch_cannot_seat_is_released_with_an_exac` | 5570 | mirrored here |
| 20260909235623 | `the_wheel_remembers_its_free_spins` | 5637 | mirrored here |
| 20260910170952 | `an_incident_closes_when_the_check_says_zero_not_when_the_clock_says_so` | 6485 | already on an in-flight branch |
| 20260910235243 | `the_wheel_doors_ask_who_is_calling` | 4049 | mirrored here |
| 20260911003328 | `the_welcome_spin_keeps_its_own_books` | 34873 | mirrored here |
| 20260911161415 | `a_broken_debugger_is_not_a_seat_stack_mismatch` | 4829 | mirrored here |

#### Rank 5 — INFORMATIONAL — 27 migration(s)

DML or data repair only. Nothing structural is absent from a rebuild.

| version | name | bytes | status |
| --- | --- | ---: | --- |
| 20260903213000 | `a_dead_session_moves_no_money` | 0 | ledger row has no statements - unrecoverable |
| 20260903214500 | `an_update_that_changes_nothing_is_not_written` | 0 | ledger row has no statements - unrecoverable |
| 20260904190352 | `declare_the_issuance_leg_trigger` | 1935 | mirrored here |
| 20260904192858 | `retire_venue_tournaments` | 1967 | mirrored here |
| 20260905085527 | `a_guard_resolves_its_own_tables` | 4912 | mirrored here |
| 20260905161915 | `realtime_replica_identity_default_unsubscribed` | 812 | mirrored here |
| 20260905162259 | `name_the_dead_mirrors_so_nobody_revives_them` | 3460 | mirrored here |
| 20260905162352 | `hand_history_rit_pot_awards` | 1749 | mirrored here |
| 20260905172924 | `drop_redundant_hand_history_rit_pot_awards` | 1680 | mirrored here |
| 20260906101725 | `seeded_clips_answer_to_the_names_in_the_registry` | 2407 | mirrored here |
| 20260906121010 | `twelve_more_channels_each_one_resolved_first` | 3208 | mirrored here |
| 20260906121253 | `five_more_resolved_channels_and_the_honest_count` | 2809 | mirrored here |
| 20260906123105 | `no_two_horses_share_a_name` | 3659 | mirrored here |
| 20260907000000 | `20260907000000_video_reels_batch_storage_proof.sql` | 0 | ledger row has no statements - unrecoverable |
| 20260908161534 | `hand_settlement_targets_exact_seat_generation` | 26027 | mirrored here |
| 20260908233950 | `observer_card_visibility_is_explicit` | 1942 | mirrored here |
| 20260909012215 | `retire_the_stranded_half_chips_on_the_felt` | 2522 | mirrored here |
| 20260909035821 | `status_follows_lifecycle_without_stealing_the_row_count` | 3001 | mirrored here |
| 20260909193244 | `anyone_with_diamonds_may_play` | 3017 | mirrored here |
| 20260909222347 | `paid_spin_entitlement_reader_uses_a_lockable_transaction` | 3281 | mirrored here |
| 20260909233558 | `ca_the_maintenance_kind_is_the_prefix_the_writer_uses` | 1850 | mirrored here |
| 20260909235426 | `a_registrant_the_launch_cannot_seat_is_released_with_an_exac` | 3093 | mirrored here |
| 20260909235709 | `a_registrant_the_launch_cannot_seat_is_released_with_an_exac` | 1674 | mirrored here |
| 20260910130319 | `restore_rake_attribution_retries` | 8151 | mirrored here |
| 20260911151934 | `the_register_correction_is_the_drift_the_next_snapshot_sees` | 4286 | mirrored here |
| 20260912050321 | `the_ladder_is_the_one_the_money_was_paid_by` | 4015 | mirrored here |
| manual | `training_api_indexes.sql` | 0 | version is not a 14-digit stamp |

---

## What is on this branch

**135 mirror files**, one per recoverable gap, each named for
the version the ledger already holds. Every body is
`array_to_string(statements, E'\n')` from the ledger row — **recovered, not
reconstructed**. All 135 were read back after writing and
compared byte-for-byte against the ledger; all 135 match. The
only text added is the header, and every fact in a header comes from the
ledger row or from the body below it.

No existing migration file is modified, renamed or deleted.

### What could NOT be reconstructed, and why

| version | name | why not |
| --- | --- | --- |
| 20260903213000 | `a_dead_session_moves_no_money` | ledger row has no statements - unrecoverable |
| 20260903214500 | `an_update_that_changes_nothing_is_not_written` | ledger row has no statements - unrecoverable |
| 20260904031919 | `the_horses_stop_writing_what_nobody_reads` | already on an in-flight branch |
| 20260907000000 | `20260907000000_video_reels_batch_storage_proof.sql` | ledger row has no statements - unrecoverable |
| 20260910170952 | `an_incident_closes_when_the_check_says_zero_not_when_the_clock_says_so` | already on an in-flight branch |
| manual | `training_api_indexes.sql` | version is not a 14-digit stamp |

Three ledger rows carry a NULL `statements` array: the SQL that ran was never
recorded, and it is not in the repo either. They are **not** invented here. The
live objects could be re-derived from `pg_proc`/`pg_trigger`, but a body
re-derived from the catalogue is not the migration that ran — it has lost the
DML, the ordering and the author's reasoning — and writing one would be
inventing history this branch cannot evidence. What each of them named is all
that is known:

- `20260903213000 a_dead_session_moves_no_money`
- `20260903214500 an_update_that_changes_nothing_is_not_written`
- `20260907000000 video_reels_batch_storage_proof` (its ledger `name` is itself a filename)
- `manual training_api_indexes.sql` (no version stamp at all; cannot be ordered in a replay)

Two more were found in the ledger, absent from `origin/main`, and **left
alone** because they are already committed on somebody else's unmerged branch:

| version | name | branch |
| --- | --- | --- |
| 20260904031919 | `the_horses_stop_writing_what_nobody_reads` | `fix/the-horses-stop-writing-what-nobody-reads` |
| 20260910170952 | `an_incident_closes_when_the_check_says_zero_not_when_the_clock_says_so` | `fix/an-incident-closes-when-the-check-says-zero` |

---

## Direction B — a file in the repo, no ledger row

Reported only. **Nothing on this branch applies anything.**

359 files on `origin/main` carry a version
the ledger does not hold. They are two different things:

**32 are version drift, not unapplied work.** The migration ran;
only the number, or the tail of the name, moved. The ledger stamps the clock at
apply time, and the `name` column truncates, so the file and the row drifted
apart. Examples:

- `20260831b_vip_points_fractional_accrual.sql` → ledger row `20260831100610 20260831b_vip_points_fractional_accrual_no_rake_earns_nothing`
- `20260903150000_the_union_branch_belongs_to_production.sql` → ledger row `20260903073351 the_union_branch_belongs_to_production_not_to_every_club_rpc`
- `20260906160550_a_cloned_table_joins_its_game_as_a_feeder_never_as_a_second_.sql` → ledger row `20260906160809 a_cloned_table_joins_its_game_as_a_feeder_never_as_a_second_main_one`
- `20260911230621_an_arena_table_is_governed_by_the_diamond_boundary_not_a_clu.sql` → ledger row `20260911230657 an_arena_table_is_governed_by_the_diamond_boundary_not_a_cluster`

**327 have no ledger row under any name.** These are files the
repo believes in that production may never have run:

| window | files with no ledger row |
| --- | --- |
| 2026-01 | 49 |
| 2026-02 | 3 |
| 2026-03 | 51 |
| 2026-04 | 15 |
| 2026-07 | 12 |
| 2026-08 | 156 |
| 2026-09 | 29 |
| legacy 3-digit sequence files (`001_`…`013_`) | 12 |

The 29 from September are the ones worth a decision now —
either they ran under a stamp nothing recorded, or they are a feature the code
believes in and the database has never heard of:

- `20260901040000_new_club_opening_bank.sql`
- `20260901072500_club_tagline_is_its_own_field.sql`
- `20260901073000_club_opening_setup_wizard.sql`
- `20260901074000_leaderboard_promo_first_overlay_waterfall.sql`
- `20260901075500_repair_pre_trigger_opening_bank.sql`
- `20260901090000_club_card_human_realtime_stats.sql`
- `20260901104500_rake_repair_stops_timing_out.sql`
- `20260901150000_chip_ledger_chain_seq_needs_an_index.sql`
- `20260902011805_v30_batch_floor_is_25_and_the_repo_says_so.sql`
- `20260902020000_settlement_correctness_stops_timing_out.sql`
- `20260902070000_new_club_checklist_scope.sql`
- `20260903091000_the_snapshot_returns_the_commission_total.sql`
- `20260903102000_a_club_admin_may_open_an_agent_in_their_own_club.sql`
- `20260903130000_one_panel_names_a_person_one_way.sql`
- `20260905103622_a_horse_is_stamped_on_its_seat_and_the_felt_can_see_it.sql`
- `20260906022137_leaderboard_settlement_follows_the_published_period.sql`
- `20260906153742_bbj_unclaimed_shares_is_service_role_only.sql`
- `20260907101200_the_audit_tells_a_retired_lane_from_a_silent_one_and_does_no.sql`
- `20260908022524_satellite_replay_preserves_admission_postconditions.sql`
- `20260908124528_diamond_engine_spend_report_is_private_by_construction.sql`
- `20260908132643_the_spin_that_drew_a_prize_and_paid_nobody.sql`
- `20260909012046_retire_the_six_stranded_half_chips_on_the_felt.sql`
- `20260909070610_the_bounty_evidence_read_stops_at_the_seat.sql`
- `20260909170000_a_player_the_felt_has_lost_is_out_of_the_event.sql`
- `20260909170500_a_chair_held_with_nothing_on_it_is_proved_twice_then_released.sql`
- `20260909171500_a_result_the_chronology_cannot_certify_is_settled_by_a_ruling.sql`
- `20260909172000_the_six_am_freeroll_is_finished_and_its_last_two_places_are_paid.sql`
- `20260909182236_bounty_rebuy_settles_the_old_head_before_the_new_generation.sql`
- `20260912051908_the_conservation_delta_sees_a_ticket_as_the_seat_it_is.sql`

Note on version keys: the comparison keys on the FULL leading digit run of a
filename, not a 14-digit prefix. `scripts/reserve-migration-version.sh` falls
back to `date -u +%Y%m%d%H%M` plus four random digits when it cannot get a
clean stamp, and the estate's older files carry 8-, 11- and 12-digit stamps
(`20260408001`, `202605161001`). Truncating to 14 would have mismatched the
57 files that carry an 11- or 12-digit stamp, and every 8-digit one besides.

---

## How to reproduce both directions

```bash
# Direction A, with the estate's own matcher (sibling repo included):
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GH_TOKEN=... \
  node scripts/ci/check-applied-migrations-are-recorded.mjs --since 20260901000000 --json
```

```sql
-- Direction B, read-only:
SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;
-- diff against:  git ls-tree -r --name-only origin/main supabase/migrations/ \
--                  | sed 's|.*/||' | sed -E 's/^([0-9]+)_.*/\1/' | sort -u
```

The ledger moves while you read it: it held 4,477 rows at the start of this
audit and 4478 by the end. Any count here is a reading, not a
constant.

---

## Five of these were archived elsewhere on the same day, and that is worth a decision

`#4421` (merged onto `main` while this audit was running) recovered five of the
same versions - `20260912044158`, `20260912044609`, `20260912044823`,
`20260912050321`, `20260912050353` - and put them under
`docs/audits/installed-migrations/20260912-pr4392/`, stating that "the archive
deliberately sits outside the forward-migration directory" because two of the
bodies carry a completed ladder correction and a replacement job schedule.

**The two recoveries agree.** Compared byte-for-byte, each pair is identical
except that the copies here end with a newline and the archived ones do not.
Two independent reads of `schema_migrations.statements` returning the same
bytes is the best corroboration either set could have.

**The placement is the open question, and it is not cosmetic.** A file under
`docs/audits/` is not read by anything that rebuilds or checks:

- `scripts/ci/check-applied-migrations-are-recorded.mjs` indexes
  `supabase/migrations` plus the sibling repo. It still reports those five as
  applied-with-no-file, because from its point of view they are.
- A Midway Union master reset replays `supabase/migrations`. A database rebuilt
  after `#4421` still would not have what those five installed.

The estate's existing answer to the re-run hazard is not a different directory -
it is the `-- BACKFILLED` first line, which
`scripts/ci/check-migrations-applied.mjs` reads to exempt the file, plus the
rule that a mirror carries the version the ledger already holds so a replay runs
it once, in the order it ran. 557 files on `main` already work that way, and
`docs/changelog/2026-09-05-the-migration-ledger-matches-the-database.md` is
where that was written down.

This branch follows the older convention because it is the one that closes the
drift a rebuild would suffer. The duplication is flagged rather than resolved:
whoever reviews this should decide which location is the estate's answer, and
delete the other five. Nothing here modifies or removes `#4421`'s archive.

---

## Applying one of these files by hand is the hazard

A mirror is not a change request and it is not work waiting to be done. It
carries the version the ledger already holds so that a rebuild replays it once,
in the order it ran. 79 of the
135 bodies on this branch contain DML against live rows —
re-running one repeats a live data change nobody asked this bookkeeping branch
to make. Every header says so.
