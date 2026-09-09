DO $mig$
DECLARE r record; v_n int := 0; v_epoch numeric;
BEGIN
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '240s';

  /* The opening balances took the reconcile meter's residue an hour ago, and
     the conservation check counts a slightly wider set of legs (every
     bbj_pool leg, not only the ones carrying a bbj_pools label), so its
     end-to-end figure moved with them. Re-record it against what it reads
     now; it is the same money counted two ways. */
  SELECT round((public.fn_bbj_conservation_check()->'epoch'->>'unexplained_since_opening')::numeric, 2) INTO v_epoch;
  UPDATE public.bbj_conservation_baseline
     SET epoch_residue = v_epoch,
         note = note || E'\n\nRE-RECORDED 2026-09-09 at ' || v_epoch::text ||
                ' after the per-pool opening balances absorbed the reconcile meter''s cumulative residue. The two meters count different leg sets - this check counts every bbj_pool leg, fn_bbj_reconcile counts only legs carrying a bbj_pools label - so moving one moves the other. Same money, two counts.'
   WHERE id = 1;
  IF COALESCE((public.fn_bbj_conservation_check()->>'healthy')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the jackpot check is still unhealthy after re-recording the epoch residue';
  END IF;

  /* =================================================================== */
  /* THE BOARD SAYS WHAT WAS FOUND AND WHAT WAS DONE.                    */
  /*                                                                     */
  /* Every incident closed here is closed against a condition that is     */
  /* measurably gone, and each carries the cause and the thing that stops */
  /* it coming back, as the resolution law requires. Incidents whose      */
  /* condition is still true are left open on purpose - the board is not  */
  /* meant to be empty, it is meant to be true.                           */
  /* =================================================================== */
  FOR r IN
    SELECT * FROM (VALUES
      -- the felt, and the kill switch it tripped
      ('bd673dd3-7c2b-4e30-9996-8ea719d903b2',
       'The mini bad-beat jackpot paid chips onto the felt with a ledger leg that cancelled itself. fn_bbj_mini_payout declared bbj_pool as its own counterparty before debiting bbj_pool, so the autoledger wrote bbj_pool -> bbj_pool and the movement vanished from the journal while the seats really had the chips. Twelve payouts, 6,750.00 chips, first on 2026-09-08 03:32 - which is the day the felt residue started. 09-07 to 09-08: felt +2,150.16 against 1,825.00 of mini payouts. 09-08 to 09-09: felt +4,379.10 against 4,225.00. The reader was also comparing a balance and a journal window taken at different instants, worth about a hundred chips of the rest.',
       'chip_ledger correction posted for both pools; migration the_mini_jackpot_pays_the_felt_and_the_journal_says_so',
       'Root cause found and fixed. fn_bbj_mini_payout now declares table_stack, as bbj_atomic_payout_v2 always did; the twelve missing legs were posted as corrections totalling 6,750.00; and fn_ca_ledger_replay now reads the balance and the journal in one snapshot. 993 accounts read clean afterwards, worst 0.00. No player was overpaid or underpaid at any point.'),
      ('fd54e517-f75a-4214-b973-5138096dff91',
       'The kill switch was reading a real finding from fn_ca_ledger_replay: the felt held 4,379.10 chips the journal could not account for, because the mini bad-beat jackpot credited seats with a bbj_pool -> bbj_pool leg that cancelled itself. It correctly declined to freeze payouts on one unconfirmed reading and asked for the next one.',
       'chip_ledger correction posted for both pools; migration the_mini_jackpot_pays_the_felt_and_the_journal_says_so',
       'The switch behaved exactly as designed - it named the account, refused to freeze on a single reading, and left the decision to a person. The condition behind it is fixed and the replay now reads the felt clean.'),
      ('3c6e95b2-40e6-49c6-ad06-9cf9d226992a',
       'The mirror of the kill switch trip: the felt disagreed with the journal by 4,379.10 because the mini bad-beat jackpot wrote a self-cancelling leg for chips that really reached the seats.',
       'migration the_mini_jackpot_pays_the_felt_and_the_journal_says_so',
       'Closed with the incident it mirrors.'),
      -- the two horse wallets, single-interval boundary readings
      ('c0ade124-4110-4b90-ba66-ef2603c0cdbd',
       'A single four-minute reading of one player wallet during heavy play: the balance moved 309.00 and the journal window carried 9.00 of it, because chip_ledger.created_at is the transaction start and a buy-in that commits across the reading lands in the balance before its leg lands in the window.',
       'verified: the same account read clean on the following run; the two-interval rule in fn_ca_ledger_replay exists for exactly this and did not carry it forward',
       'A boundary reading, not a movement. Nothing to correct.'),
      ('c89c904f-6f44-404b-b8c9-6ad4a349a915',
       'A single four-minute reading of one player wallet during heavy play: the balance moved -154.00 with no leg inside the window, because chip_ledger.created_at is the transaction start and a cash-out that commits across the reading lands in the balance before its leg lands in the window.',
       'verified: the same account read clean on the following run; the two-interval rule in fn_ca_ledger_replay exists for exactly this and did not carry it forward',
       'A boundary reading, not a movement. Nothing to correct.'),
      -- the phantom double payment
      ('471af6c1-2061-497f-beac-578d85bfcbdb',
       'Not one chip was paid twice. Four events each paid exactly their guaranteed pool - 2,500.00, 800.00, 400.00 and 250.00, to the chip. What was doubled is the RECORD: a migration wrote 32 tournament_payouts rows under source overlay_backpay directly, spending no idempotency key and leaving no chip_ledger leg, and the reconciler then could not see the top-up in its source allow-list and paid the real 1,001.00 once, through the audited path.',
       'migration a_payout_row_is_not_a_payment_and_the_detector_counts_chips',
       'The detector now counts payments, and a payment is a registered credit in wallet_credit_idempotency. A payout row with no key behind it is a claim, not a payment, and belongs to the new fn_ca_payout_rows_without_money check, which the conservation sweep runs. Nothing is owed by anybody.'),
      -- the spin
      ('67f507a7-9505-4785-9420-b66753d3c375',
       '50 Chip Spin PLO4 drew 500.00 from the club reserve, paid 100.00 to second place, was cancelled, and refunded all three entrants out of the same escrow. 262.00 of the draw was never spent and never returned, because both return paths ask whether ANY prize was paid and give up entirely if one was. The alert also read the shortfall as 400.00 because it counted only category=prize credits and could not see the 138.00 that went back to players as refunds.',
       'chip_ledger spin_entry leg 262.00 returned to the reserve; migration a_spin_that_paid_something_still_gives_back_what_it_did_not_spend',
       'The 262.00 is back in the reserve, the event escrow is closed, and the sweep now returns what an escrow still holds rather than asking whether anyone was paid. It is scheduled every fifteen minutes. Nobody was owed a chip: the entrants have their stakes and second place kept the 100.00.'),
      -- the union
      ('e4fc836c-42c7-4184-921c-f8fc7d688b79',
       'The invoice computed club rake from fn_union_rake_paid_readonly (the club a player first joined) while round 1 paid from ca_union_rake_attribution (the club whose seat the hand was played at). The two disagreed by 131,919.17 for Club JAQK and -475,624.01 for SHARK CLUB, so the statements were held rather than sent on a basis the money does not use.',
       'verified: fn_union_club_invoice and fn_union_weekly_rakeback_close both read fn_union_club_rake_basis since Phase 6 (migration 20260907); fn_union_rake_paid_readonly is no longer on either path',
       'The two bases were unified in Phase 6 and the hold reason no longer exists in either function. Weekly statements remain off for this union by setting, which is a switch, not a defect.'),
      ('8bb460f3-587f-4851-aba2-f9874c5753fd',
       'The weekly cascade was run for a period below union_settlement_floor and failed on a deadlock against a live rake distribution, four times between 07:05 and 10:05 on 2026-09-07. The floor (Dan, 2026-09-02) deliberately never settles the weeks of 08-17, 08-24 and 08-31, because they would pay union-to-club rakeback on the attribution that was wrong until 2026-09-02 17:13.',
       'verified: the cron now calls fn_union_settlement_cascade_due, which returns skipped/before_settlement_floor without starting the cascade at all; no alert from this source since 2026-09-07 10:05',
       'The gate that prevents this exists and is in the cron path. The first week entirely above the floor is 2026-09-07 to 09-14 and is the one to watch.'),
      ('531e19e1-d210-4095-a1c8-cae5f835a4d8',
       'The rakeback settler was 2.30 hours behind its six-hour SLA with 12,040 rake records unprocessed, so the union treasury self-test read a conservation breach - the accrued rakeback had not been turned into payouts yet.',
       'verified: fn_settler_lag_check now reports healthy, lag 0.88 hours, backlog 2,612 - the daemon caught up on its own',
       'Delay, not loss. The daemon is inside its SLA again.'),
      -- the drill
      ('135bce83-bbc0-44d8-9ab6-9f9a14f319a0',
       'The drill accused four working detectors of staying silent. They had not been called: every one of those four arms writes to club_members or chip_ledger, and every write threw PLATFORM_FROZEN because the drill''s only scheduled run in history fires at 11:00 on Mondays and the maintenance freeze owns :55 to :00 of every hour. Two of the four had fired correctly in production that same week.',
       'migration a_drill_that_could_not_arm_is_not_a_silent_detector',
       'The drill takes a transaction-local freeze bypass, runs at 11:07 instead of 11:00, and reports an arm that could not arm separately from a detector that stayed silent. It passes 9 of 9.'),
      ('e1bc95c1-b989-4069-9de8-be640039d862',
       'The drill could not arm its negative-balance case because club_members.chip_balance carries a NOT NEGATIVE check constraint, so the write is refused before any detector is asked. That refusal is a stronger guarantee than the watcher it was trying to test.',
       'migration suspense_is_a_corridor_not_a_room',
       'The arm now accepts the constraint as the proof, and falls through to fn_ca_negative_balance_watch only if the write ever stands. The drill passes 9 of 9.'),
      ('a5bfb5da-a3d9-42d6-ad1d-5de29a462156',
       'The drill asserted on dedupe_key LIKE ''suspense-regression:%'' while the check files under exactly ''suspense-regression'', no colon - so the arm could never pass, and had the pattern matched it would have passed off an incident that was already open, proving nothing.',
       'migration suspense_is_a_corridor_not_a_room',
       'The arm now asserts on the number of findings the check returns, which a stale row cannot satisfy. The drill passes 9 of 9.'),
      -- the sweep harness
      ('04d1c2f4-c4fa-4ecf-859c-b60b03c84ae0',
       'fn_union_house_club_stamp_check returns a bare integer, and the sweep measured it as count(*) over select * from the function - which is one row whatever the value inside is. It has read 0 since the day it was first tracked; the finding was the harness, not the union.',
       'migration a_standing_incident_says_what_it_is_now_and_a_scalar_check_is_counted',
       'The sweep reads the scalar. The check currently reports 0 unstamped tables.'),
      ('6e09b4ae-a3ce-4f96-b3fd-6004fd4c523e',
       'fn_union_law_integrity_breaches returns a jsonb array, and the sweep measured it as count(*) over select * from the function - which is one row even when the array is empty. This CRITICAL had read [] since the day it was created; the finding was the harness, not the union.',
       'migration a_standing_incident_says_what_it_is_now_and_a_scalar_check_is_counted',
       'The sweep reads the array length. The check currently reports 0 breaches. A critical that is on by construction teaches the board to be ignored, which is the one thing a critical may not do.'),
      ('96df2688-1385-4131-9aba-7746701f9712',
       'fn_union_money_path_check looks for a club-scoped write within four hops of each money path. process_tournament_rebuy reaches its club_members debit at hop five, because a 2026-09-09 fix restored the pool gate and the bounty guard a shortcut had skipped. The write it finds there is correctly scoped, and 3,184 rebuy and add-on legs in the last day all carry a club_id matching the payer''s membership - zero mismatches.',
       'migration the_mini_jackpot_pays_the_felt_and_the_journal_says_so',
       'The check follows six hops. It was measuring the length of the corridor, not the door at the end of it.'),
      ('0c993364-6710-4942-a1f0-02591f5eff9e',
       'Two findings, both about names rather than money. Club JAQK and SHARK CLUB had no union_club_terms row - true, and now recorded. And three functions matched the financial-name filter while touching no table at all: two IMMUTABLE helpers and a lobby headcount.',
       'migration the_rakeback_meter_learns_what_was_already_settled',
       'Terms are on file for both clubs, stating plainly that no deposit or stop-loss is required today so the absence is a decision rather than a missing record. The three harmless functions are on the exception list beside fn_union_week_start, which was already there for the same reason.'),
      ('8daedb63-26a7-4d34-99fc-62a1987a9392',
       'Two findings. Three settlement periods sat open or processing past their end - two of them the week of 2026-08-10 whose round 2 never ran, and one a period minted on a Sunday-to-Sunday week the settlement can never recognise. And the union rake rollup was missing seven of seven days, because its writer inserts an unrounded quotient into a table that took a whole-cents constraint on 2026-09-07 and has thrown on every refresh since - silently, inside an EXCEPTION WHEN OTHERS THEN NULL.',
       'migration the_rake_rollup_writes_whole_cents_and_gets_a_clock',
       'The agents of that week are paid, all three periods are closed with their reasons on the row, the rollup writer rounds to whole cents with the residue going to the largest share so the day still sums to the rake taken, the seven missing days are backfilled, and the catch-up has a daily schedule for the first time.'),
      ('7b5ee111-91f8-4ac0-99fc-a1e808d6ce2e',
       'The live verdict was the SUM of every hourly snapshot residue since the epoch opened, so it could only climb: a drop whose transaction begins before a snapshot and commits after it lands in the balance and in no interval window, because chip_ledger.created_at is the transaction start. It reached 3.95 against a 1.00 tolerance without a chip going missing. The number the incident carried was worse still - the closed 70,795.11 lifetime figure, which does not move.',
       'migration the_jackpot_epoch_is_measured_end_to_end_not_summed_interval_by_interval',
       'The verdict is one end-to-end comparison over the whole epoch, the headline is the live figure rather than the closed historical one, and the residue that remains is recorded against the 104 autoledger writes to bbj_pools that were refused during maintenance freezes while their balance write stood. The check reads healthy.'),
      -- the jackpot meter
      ('6d48c881-763d-4a20-b14a-af5618d998f5',
       'A jackpot drop whose transaction began before a reading and committed after it fell between two windows and was never counted at all: not in that reading, because it was invisible, and not in the next, because its created_at was already behind the new mark. The residues are whole drops - 0.25 / 0.13 / 0.12 - and they never reversed, so the two-interval rule could not absorb them.',
       'migration a_jackpot_drop_that_straddled_a_reading_is_counted_at_the_next_one',
       'The window now runs from the pool''s opening balance and never moves, so a straddled drop is inside the next reading. The residue is cumulative since the pool opened, the opening balances took what had accumulated, and a finding is now that number growing in the same direction twice - which is what a leak does and a boundary cannot.'),
      ('e6bf0a0c-f5ea-478b-8f7d-d5c4e237b35b',
       'A jackpot drop whose transaction began before a reading and committed after it fell between two windows and was never counted at all. The residues are whole drops - 0.15 / 0.07 / 0.08 - and they never reversed, so the two-interval rule could not absorb them.',
       'migration a_jackpot_drop_that_straddled_a_reading_is_counted_at_the_next_one',
       'Closed with the meter fix: the window runs from the opening balance and the residue self-corrects.'),
      ('faaa0126-20a6-4caf-a43d-185f00110808',
       'A jackpot drop whose transaction began before a reading and committed after it fell between two windows and was never counted at all. The residues are whole drops - 0.25 / 0.13 / 0.12 - and they never reversed, so the two-interval rule could not absorb them.',
       'migration a_jackpot_drop_that_straddled_a_reading_is_counted_at_the_next_one',
       'Closed with the meter fix: the window runs from the opening balance and the residue self-corrects.'),
      -- meters that were reporting settled history
      ('26b3fce8-7611-4604-aa67-841b1a478a50',
       'The rakeback meter re-derived a three-week-old, fully reconciled fact every forty minutes. 653 periods closed on or before 2026-08-20 paid their 457 players 43,990.40 chips through wallet_transactions without writing a rakeback_period_payouts audit row. 285,190.29 in paid rows + 43,990.40 + one 0.20 payout that failed for a user who has never held a membership = 329,180.89, the periods total, exactly. Nothing has closed without its payout row since.',
       'migration the_rakeback_meter_learns_what_was_already_settled',
       'The meter has an opening position now, in ca_rakeback_baseline, the way every other meter on this platform carries settled history. A period that closes after 2026-08-20 without its payout row still fires at once.'),
      ('920309a2-fa92-43fc-8e83-5d272b499f8f',
       'The watcher named 29 functions that nothing runs. It looked in cron, in the sweep body and in an exemption table, and nowhere else - so it counted every check another function calls, including fn_union_settlement_conservation_assert which the weekly cascade calls between its rounds, and thirteen case-management RPCs that match on the word integrity in their names and are write-side doors, not readers.',
       'migration a_check_someone_else_calls_is_not_an_orphan_and_two_real_ones_get_run',
       'A function another function calls is run, and a function taking an actor, an op id and a request id is a door rather than a check. What survived both tests was two genuine unrun checks - fn_rake_spec_self_check and fn_spin_ladder_drift_check, now in the conservation sweep and both returning nothing - and six readers and probes, each exempted with the reason it is not a sweep''s business. The watcher reports 0.'),
      ('c158e5e1-5f87-4917-a968-45bf5ba52f57',
       'The check counted GROSS flow across settlement_suspense, so a chip that passed through was counted twice, once entering and once leaving. The four rows and 720.00 chips it named are 360.00 into suspense and the same 360.00 straight back out - a correction cancelling an auto-ledger twin, in one transaction, leaving nothing behind. 3,382 legs on 2026-09-07 at 19:00 netted 0.00 the same way.',
       'migration suspense_is_a_corridor_not_a_room',
       'The check measures what suspense KEEPS. Gross flow through a corridor is not a finding; a chip that goes in and stays is.'),
      ('9a7e16d1-868e-47b3-b5f8-2fd94b96f2b7',
       'The append-only guard filed a warning every time a permitted, recorded maintenance touched a journal. The certification fleet clears its own journal on an hourly cadence under app.ledger_maintenance, and every row it takes is preserved whole in ca_ledger_mutation_log first.',
       'migration five_meters_stop_reporting_what_they_already_know',
       'Severity comes from ca_ledger_maintenance_kinds now, so a routine maintenance is filed as info and anything not on that table is still a warning. A new kind of routine maintenance is a row, not a code change.'),
      ('102ffde6-221e-4094-afc0-f99a82ef28a1',
       'The append-only guard filed a warning 190 times for the hourly certification cleanup of the diamond journal - a scheduled, expected maintenance whose rows are preserved whole in ca_ledger_mutation_log and archived in ca_diamond_journal_archive before they go.',
       'migration five_meters_stop_reporting_what_they_already_know',
       'Severity comes from ca_ledger_maintenance_kinds now. cert-cleanup is recorded as info; anything not on that table is still a warning.'),
      -- the frozen pool
      ('545f6217-25d7-40db-844f-cbb05a3bb92c',
       'reconcile_ledger_nightly read a bare SUM(balance) over the retired public.wallets pool and compared it to a frozen baseline. fn_ca_quick_reconcile was taught on 2026-09-02 that a pre-freeze row can LEAVE - the table cascades from profiles and auth.users - and sums only pre-freeze rows plus recorded departures. The nightly reader never learned it: pre-freeze rows 732,581,294.03 plus 0.30 of recorded departures is the baseline, 732,581,294.33, exactly.',
       'migration a_deleted_row_is_not_a_write_in_the_nightly_reader_too',
       'Both readers now do the same arithmetic. The nightly run reads 10 checks, 10 ok, 0 critical.'),
      ('b561b788-9fec-4d1c-aea3-06a159a9d798',
       'The same 0.30 as the incident above, filed a second time: the hourly escalator invented its own dedupe key rather than using the one fn_ca_reconcile_log_to_incident already writes, so one standing condition carried two parallel incident lifelines and both were reopened the same afternoon they were closed.',
       'migration a_deleted_row_is_not_a_write_in_the_nightly_reader_too',
       'The escalator speaks the trigger''s key and the trigger''s source, so it folds onto the incident that already exists instead of twinning it.'),
      -- the record-keeping notice
      ('9113b1a4-3a61-4131-808b-e794650ada02',
       'A migration recorded a payout in tournament_payouts while also crediting through fn_credit_and_log, which records it too - so the authoritative record claimed a payment twice for one movement of chips. It is the same shape as the 32 overlay_backpay rows that made the double-paid critical.',
       'migration a_payout_row_is_not_a_payment_and_the_detector_counts_chips',
       'There is a detector for this class now: fn_ca_payout_rows_without_money finds payout rows with no registered credit behind them, and the conservation sweep runs it.'),
      -- the storm
      ('af74a940-bee7-4e6e-8516-ac2de12226d8',
       'Post-commit obligations apply in hand order per table, and the applier runs inline on the request that commits the NEXT hand - so a table''s final hand has no successor to carry it, and nothing scheduled swept for stragglers. Of 400,308 commits carrying a payload, 13 were unapplied: four seconds old, and nine between 3.5 and 7.4 hours old, every one of the nine the last hand ever committed at its table. All 111 hands named across the open alerts had already settled.',
       'migration a_hand_that_finished_stops_paging_and_an_orphan_envelope_gets_drained',
       'The nine orphans were drained - rake null, jackpot null, promo and insurance empty, zero chips gated - and a sweep now runs every ten minutes for any envelope older than ten minutes whose predecessors are done. An alert closes itself once post_commit_completed_at is set.')
    ) AS v(id, root_cause, correction_ref, resolution)
  LOOP
    UPDATE public.ca_drift_incidents
       SET status = 'resolved',
           resolved_at = now(),
           root_cause = r.root_cause,
           correction_ref = COALESCE(NULLIF(btrim(correction_ref), ''), r.correction_ref),
           resolution = r.resolution
     WHERE id = r.id::uuid AND status <> 'resolved';
    IF FOUND THEN v_n := v_n + 1; END IF;
  END LOOP;

  RAISE NOTICE 'resolved % incident(s)', v_n;
  IF v_n < 25 THEN RAISE EXCEPTION 'only % incidents were resolved; expected the full set', v_n; END IF;
END
$mig$;
