-- 20261007151627_drained_registrants_return_to_their_events_and_the_three_unf.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE FIFTY ENTRIES THE 15:33 DRAIN TOOK OUT OF EVENTS THAT NEVER STARTED
-- (CLAUDE.md 10.9: the reasoning lives here, not only in the SQL)
--
-- WHAT HAPPENED (read from rows, 2026-10-07 15:07-15:35 UTC)
--
-- At 15:33:04 UTC on 2026-10-06 a foreign psql session ran the patterned-
-- identity force drain under session_replication_role = replica:
--     UPDATE public.tournament_players SET status = 'eliminated' ... cohort 'horse'
-- Replica mode switched off zz_stamp_tournament_elimination_sequence (fixed
-- going forward by 20261007132903, ENABLE ALWAYS, PR #6424) and every guard
-- trigger, including a_player_is_not_eliminated_from_a_game_that_never_started.
-- Besides the four running Spins #6424 settled, it removed 50 paid entries
-- from five events that had not started, and 3 rows in three events
-- cancelled on 2026-08-28 (below). Every one of the 50 is still funded:
--
--   73ff3bdc Wednesday Feature   MTT, 18+2, start 2026-10-08 02:00   30 entries
--   28515bbb Six-Card Feature    MTT, 18+2, start 2026-10-09 02:00   16 entries
--     each: one satellite_seat or tournament_ticket refund entitlement of
--     20.00 (18.00 prize + 2.00 fee), no tranche, no ticket returned, no
--     obligation, no credit; chips 0, no table; the pool and fee caches still
--     count them (5,850.00 / 650.00 for 325 entitlements; 3,438.00 / 382.00
--     for 191) and equal the escrow banks. Only the roster row changed.
--   2f906cbc 50 Chip Spin PLO4       seat-first, 2 of 3 seats, 50.00 each
--   0801e005 NLH Heads-Up 20         seat-first, 1 of 2 seats, 19.00 + 1.00
--   4ddcf172 PLO4 Heads-Up 2 Turbo   seat-first, 1 of 2 seats, 1.90 + 0.10
--     each: one wallet_charge entitlement and one tournament_buyin debit, no
--     credit; the chair was closed at 15:33:04 holding its full starting
--     stack (300 / 300 / 1000 / 300); no hand, draw, launch or payout; the
--     boards had been open 1 to 2 minutes and never filled.
--
-- The 38 identities are horses (10.5: settled exactly as people). They were
-- benched at 15:07 and their profiles closed at 15:41 on 2026-10-06, but the
-- fleet has kept seating them: 9,690 seats in the last 24 hours, 74 live as
-- this was written. That is reported separately; it is not decided here.
--
-- THE DECISIONS
--
-- 1. Wednesday Feature and Six-Card Feature: the entry is returned. The
--    witness is the money: the entitlement, the escrow bank and the pool all
--    still say these players are entered, and none of them asked to leave.
--    A person whose paid registration a platform defect removed gets it back,
--    and so does a horse. Refunding instead would decide for 46 entrants a
--    withdrawal nobody chose. The row goes back to exactly what it was:
--    status 'registered', eliminated_at NULL (the stamp trigger keeps the
--    sequence NULL). No money moves; the pool is unchanged because it never
--    lost them. trg_sync_tournament_current_players republishes the count.
--    Each row is written under the registration door's own lock order
--    (fn_ca_lock_tournament_seat_acquisition, the tournament settlement lane,
--    the shared 530090 gate) with every row trigger live.
--
--    The four-table limit (fn_enforce_booking_game_cap) treats this as a new
--    claim and refuses it while the entrant is in four games, as it would a
--    person. These identities hold four Spins at a time almost continuously,
--    so this takes each entrant's own table-cap lock first (the lock every
--    seat and booking door takes, so no new game can start for them), then
--    waits, holding nothing else, up to 240 s for a running game to end. If
--    one is still at four games it aborts with nothing written.
--
-- 2. The three seat-first boards are cancelled with every entry refunded in
--    full, through atomic_cancel_tournament (the platform's cancellation
--    authority, the same call fn_spin_expire_unfilled makes), as the service
--    role, as 20261002014954 did for four unfilled heads-up satellites.
--    The evidence: a seat-first board is paid when you sit and starts only
--    when it fills; the platform's rule for one that does not fill is that
--    the seat gets its chips back (spin_fill_policy, 30 minutes,
--    20260831060000 "a seat that waits forever gets its chips back"). These
--    seats were bought 24 hours ago and the boards never filled. Unlike the
--    four Spins in #6424, nothing was drawn or dealt, so cancelling undoes no
--    result. Starting them instead would mean reviving a closed chair on an
--    unstarted board, and the only door that seats a player there is a paid
--    buy-in, which would charge the entry twice. Heads-up boards have no
--    expiry sweep of their own; the same seat-first rule is applied to them
--    rather than a new one invented. The authority refunds every entitlement
--    whatever the roster status says, so the drained flag changes nothing in
--    the money: 122.00 back to the entrants' own club wallets (50.00 x 2,
--    20.00, 2.00), fees reversed (1.00 + 0.10), escrow closed at zero.
--
-- 3. Not touched: edd8525d PLO4 Heads-Up 20, d1c6131c NLH Heads-Up 1 and
--    3aa67ff3 Tuesday Bounty Hunt were cancelled on 2026-08-28 and each of
--    their drained entrants was refunded then (one credit per debit). The
--    drain changed only a stale status flag in an event that is over; there
--    is no money to settle and no evidence of the exact prior flag.
--
-- Nobody is paid twice (each refund goes through the entitlement's own
-- tranche, once; restored entries are not re-charged). Nothing is taken back.
-- Proved in a self-aborting DO block against production at 15:32 UTC on
-- 2026-10-07: 46 restored (Wednesday 297 -> 327, Six-Card 175 -> 191), 3
-- boards cancelled, 122.00 refunded, no unsequenced elimination left in an
-- open event, register_drifts 0, diamond difference 0.00; rolled back.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

DO $drained$
DECLARE
  v_reason text;
  v_n integer;
  v_gate jsonb;
  v_receipt jsonb;
  r record;
  b record;
  v_mtt_restored integer := 0;
  v_boards_cancelled integer := 0;
  v_refunded numeric := 0;
  v_i integer;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'DRAINED_ENTRIES_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
  IF public.fn_platform_frozen() OR public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'DRAINED_ENTRIES_FROZEN: the platform is frozen; apply after the thaw' USING ERRCODE = '55000';
  END IF;

  -- The cancellation authority is the body read on 2026-10-07.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.atomic_cancel_tournament(uuid,uuid)'::regprocedure
       AND md5(p.prosrc) = '2abe4ca1c89c79ade998fe7f6b0de082'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.proconfig::text = '{"search_path=public, extensions, pg_temp",statement_timeout=120s}'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'DRAINED_ENTRIES_AUTHORITY_CHANGED: atomic_cancel_tournament is not the body read'
      USING ERRCODE = '40001';
  END IF;

  CREATE TEMP TABLE _drained_mtt (tid uuid, pid uuid, uid uuid, kind text) ON COMMIT DROP;
  INSERT INTO _drained_mtt VALUES
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', 'bba6eb23-0694-45e3-a011-13813e018a12', '00000000-0000-0000-0000-000000000003', 'tournament_ticket'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', '36dd0aae-a5eb-4dda-bdd9-ecab1cfdd015', '00000000-0000-0000-0000-000000000007', 'tournament_ticket'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', '1ee29008-a029-4af5-a4b0-cc0a96fbfd85', '00000000-0000-0000-0000-000000000009', 'satellite_seat'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', '231212e5-8e82-4963-a77d-1e305120d7be', '00000000-0000-0000-0000-000000000010', 'tournament_ticket'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', 'c386d06c-eb8b-4e49-b839-741fc301f04f', '00000000-0000-0000-0000-000000000011', 'tournament_ticket'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', '85b90017-4e79-4959-a657-9282f9d631f6', '00000000-0000-0000-0000-000000000014', 'tournament_ticket'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', '830d3f8e-93dc-4518-b46e-ac3be0d0c0b6', '00000000-0000-0000-0000-000000000015', 'satellite_seat'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', '4c0ff90b-8abe-48dc-afe8-72587c1874be', '00000000-0000-0000-0000-000000000016', 'tournament_ticket'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', 'e9c7f122-6ec6-4e24-a0bf-28e57d5ee637', '00000000-0000-0000-0000-000000000038', 'satellite_seat'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', 'ec816fe4-ae60-4621-b15c-8c8cd745579e', '00000000-0000-0000-0000-000000000039', 'satellite_seat'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', 'e9fef910-51ff-441d-b2d0-4a7d25736e85', '00000000-0000-0000-0000-000000000060', 'satellite_seat'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', 'b04e576f-15ec-46ef-934a-d3c48a56fdc1', '00000000-0000-0000-0000-000000000087', 'satellite_seat'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', '23cc9d5e-8c37-403c-873e-6cf2ad479916', 'face0000-0000-0000-0000-000000000002', 'satellite_seat'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', 'cbaa80b2-4205-4f05-b988-870d956f3150', 'face0000-0000-0000-0000-000000000003', 'satellite_seat'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', '84d89d04-4785-4e2e-b6a1-731fb0f8924f', 'face0000-0000-0000-0000-000000000005', 'tournament_ticket'),
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d', '368be015-e165-4535-80dc-311c675d236a', 'face0000-0000-0000-0000-000000000006', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '1549c72d-e67c-428f-b7d2-7d6018124306', '00000000-0000-0000-0000-000000000006', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'a433029c-d081-4cbc-9792-8a6c0b4f1923', '00000000-0000-0000-0000-000000000007', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '91ce93ad-9528-4ed6-a7f7-cfb1c93e7e01', '00000000-0000-0000-0000-000000000010', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '6369389c-7009-4420-8577-1d9c616b9c32', '00000000-0000-0000-0000-000000000011', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '3601f16c-f1bc-49ab-8635-5e60f4ce7b37', '00000000-0000-0000-0000-000000000014', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'b1965c6c-41d5-449c-a676-bff79a9d397f', '00000000-0000-0000-0000-000000000015', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '2a9d74c0-1b43-48f3-9a0e-d2c217abf4bc', '00000000-0000-0000-0000-000000000016', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '3f79dbef-e3bf-4dc4-a891-04f70955e1c1', '00000000-0000-0000-0000-000000000017', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'c0d04a56-c3fc-4fdc-86fb-e17fae774740', '00000000-0000-0000-0000-000000000020', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'cec0cc68-6760-42a9-a452-22f75b024be9', '00000000-0000-0000-0000-000000000023', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '26f861fb-96c0-4c72-b4ed-f9f5cd4e46d0', '00000000-0000-0000-0000-000000000024', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '63eb41f8-4338-46cf-baa3-34844bcc3bd8', '00000000-0000-0000-0000-000000000028', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'a2bbbc0a-09c0-490d-825f-14079d8dc347', '00000000-0000-0000-0000-000000000029', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '7d3404f4-dfed-4c63-bc07-31b5c29fbe73', '00000000-0000-0000-0000-000000000031', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '67e372a9-898f-4403-8f21-099fc8f50aa6', '00000000-0000-0000-0000-000000000033', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'd996ea72-73e6-4c34-91be-5eaa7c90719f', '00000000-0000-0000-0000-000000000035', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'f078bdd2-6d9e-483c-83b3-abe243e62902', '00000000-0000-0000-0000-000000000038', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '91f95c71-0fe8-4ba4-b04c-65f0fd81f9c7', '00000000-0000-0000-0000-000000000039', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'b1819469-4666-4fb9-b6db-86c12e2e38a2', '00000000-0000-0000-0000-000000000040', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '03614683-cc20-434a-b39b-e581fadcfbb6', '00000000-0000-0000-0000-000000000042', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '18e6add9-8efe-4040-8f64-e91229b1f39f', '00000000-0000-0000-0000-000000000044', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '6e67c1c2-fca6-4f58-8680-5a5e3f1472c4', '00000000-0000-0000-0000-000000000045', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'c4a43f24-8d17-45d8-827f-923a6558f655', '00000000-0000-0000-0000-000000000048', 'tournament_ticket'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '08d6046b-6a06-4cab-a1ed-3895b52e0ea4', '00000000-0000-0000-0000-000000000051', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'b2046f23-5f79-43a4-ba7d-c9874a3823e4', '00000000-0000-0000-0000-000000000060', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '260dec92-2346-47c1-a42c-f35aafb3ca7f', '00000000-0000-0000-0000-000000000087', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '71f5c875-0c16-4797-a0f6-a981a829b554', 'face0000-0000-0000-0000-000000000001', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'f0238452-b55e-4fd0-ac47-cf1d463ca824', 'face0000-0000-0000-0000-000000000002', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', '4769e7ea-8b08-42f7-bf68-3adfb8a88ee5', 'face0000-0000-0000-0000-000000000003', 'satellite_seat'),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0', 'a05861c0-83fa-4979-a79f-5b19df350b47', 'face0000-0000-0000-0000-00000000000a', 'satellite_seat')
  ;
  IF (SELECT count(*) FROM _drained_mtt) <> 46
     OR (SELECT count(*) FROM _drained_mtt WHERE tid = '73ff3bdc-4732-4d8e-9379-94833c038ef0') <> 30
     OR (SELECT count(*) FROM _drained_mtt WHERE tid = '28515bbb-0ed9-4626-9345-83f2ef80b37d') <> 16
     OR (SELECT md5(string_agg(pid::text, ',' ORDER BY pid)) FROM _drained_mtt) <> 'c3648e54a210adc995dedfe485e2194a' THEN
    RAISE EXCEPTION 'DRAINED_ENTRIES_SET_CHANGED';
  END IF;

  -- =====================================================================
  -- PART 1. Wednesday Feature and Six-Card Feature: the 46 paid entries
  -- return to 'registered'.
  -- =====================================================================
  -- The two events, as they stand. Both keep registering while this is
  -- written, so the counts are relations, not constants: every roster row
  -- holds exactly one funded entitlement, the pool and fee caches equal the
  -- escrow banks, the drained rows are exactly the 46 above, and nothing has
  -- launched, refunded or paid.
  FOR b IN SELECT * FROM (VALUES
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d'::uuid, '2026-10-09 02:00:00+00'::timestamptz, 16),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0'::uuid, '2026-10-08 02:00:00+00'::timestamptz, 30)
    ) v(tid, start_at, drained) ORDER BY tid
  LOOP
    IF NOT EXISTS (
         SELECT 1 FROM public.tournaments t
           JOIN public.tournament_escrow e ON e.tournament_id = t.id
          WHERE t.id = b.tid AND t.status = 'REGISTERING' AND t.started_at IS NULL
            AND t.ended_at IS NULL AND t.start_time = b.start_at
            AND t.tournament_type = 'MTT' AND t.variant = 'freezeout'
            AND t.buy_in_amount = 18.00 AND t.buy_in_fee = 2.00
            AND t.prize_pool = e.prize_balance AND t.total_rake = e.fee_balance
            AND COALESCE(t.bounty_pool, 0) = 0 AND e.bounty_balance = 0
            AND e.enforced AND e.closed_at IS NULL
            AND e.prize_out = 0 AND e.fee_out = 0 AND e.refund_prize = 0 AND e.refund_fee = 0
            AND t.current_players = (SELECT count(*) FROM public.tournament_players tp
                                      WHERE tp.tournament_id = b.tid AND tp.status = 'registered'))
       OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts x WHERE x.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts x WHERE x.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.tournament_refund_tranches x WHERE x.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = b.tid
                   AND tp.status NOT IN ('registered', 'eliminated'))
       OR (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = b.tid AND tp.status = 'eliminated') <> b.drained
       OR (SELECT count(*) FROM public.tournament_refund_entitlements x WHERE x.tournament_id = b.tid)
          <> (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = b.tid) THEN
      RAISE EXCEPTION 'DRAINED_ENTRIES_MTT_PREIMAGE: % is not the event read on 2026-10-07', b.tid USING ERRCODE = '40001';
    END IF;
  END LOOP;

  -- Each entry: removed by the 15:33 drain, never refunded, still funded.
  SELECT count(*) INTO v_n
    FROM _drained_mtt d
    JOIN public.tournament_players tp
      ON tp.id = d.pid AND tp.tournament_id = d.tid AND tp.user_id = d.uid
     AND tp.status = 'eliminated' AND tp.elimination_sequence IS NULL
     AND tp.position IS NULL AND COALESCE(tp.chips, 0) = 0 AND COALESCE(tp.prize, 0) = 0
     AND tp.table_id IS NULL
     AND tp.eliminated_at >= '2026-10-06 15:33:04+00' AND tp.eliminated_at < '2026-10-06 15:33:08+00'
    JOIN smarter_private.patterned_identity_retirements pr
      ON pr.old_id = d.uid AND pr.cohort = 'horse'
   WHERE (SELECT count(*) FROM public.tournament_refund_entitlements e
           WHERE e.tournament_id = d.tid AND e.user_id = d.uid) = 1
     AND EXISTS (SELECT 1 FROM public.tournament_refund_entitlements e
           WHERE e.tournament_id = d.tid AND e.user_id = d.uid AND e.entitlement_kind = d.kind
             AND e.gross = 20.00 AND e.refund_prize = 18.00 AND e.refund_fee = 2.00
             AND e.refund_bounty = 0
             AND NOT EXISTS (SELECT 1 FROM public.tournament_tickets k WHERE k.source_refund_entitlement_id = e.id))
     AND NOT EXISTS (SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id = d.tid AND o.user_id = d.uid)
     AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions w
           WHERE w.related_entity_id = d.tid AND w.user_id = d.uid AND w.type = 'credit');
  IF v_n <> 46 THEN
    RAISE EXCEPTION 'DRAINED_ENTRIES_ENTRY_PREIMAGE: % of 46 entries match the read', v_n USING ERRCODE = '40001';
  END IF;

  -- The four-table limit (fn_enforce_booking_game_cap) treats a return to
  -- 'registered' as a new claim and refuses it while the entrant is in four
  -- games, exactly as it refuses a person. These identities are seated in
  -- Spins and heads-up games minute to minute (measured 2026-10-07: four of
  -- the 38 held four games at every instant across a 45 s probe), so a window
  -- never opens by itself. Take each entrant's own table-cap lock, the one
  -- every seat and booking door takes, so no NEW game can start for them,
  -- and wait (bounded) for a game already running to end. Nothing else is
  -- held while waiting: no settlement lane, no event row.
  FOR r IN SELECT DISTINCT uid FROM _drained_mtt ORDER BY uid LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || r.uid::text, 0));
  END LOOP;
  FOR v_i IN 1..240 LOOP
    SELECT count(*) INTO v_n
      FROM (SELECT DISTINCT uid FROM _drained_mtt) u
     WHERE public.fn_concurrent_game_load(u.uid, NULL, NULL, NULL) >= 4;
    EXIT WHEN v_n = 0;
    PERFORM pg_sleep(1);
  END LOOP;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'DRAINED_ENTRIES_AT_TABLE_LIMIT: % entrants are still in four games; nothing was written', v_n
      USING ERRCODE = '55000';
  END IF;

  -- The registration door's own lock order, per entrant, then the row.
  FOR r IN SELECT * FROM _drained_mtt ORDER BY tid, uid LOOP
    v_gate := public.fn_ca_lock_tournament_seat_acquisition(r.tid, NULL, r.uid);
    IF COALESCE((v_gate->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'DRAINED_ENTRIES_SEAT_DOOR_REFUSED % %: %', r.tid, r.uid, v_gate USING ERRCODE = '55000';
    END IF;
    PERFORM public.fn_ca_lock_settlement_lane_for_tournament(r.tid);
    PERFORM pg_advisory_xact_lock_shared(530090, 1);

    UPDATE public.tournament_players
       SET status = 'registered', eliminated_at = NULL
     WHERE id = r.pid AND tournament_id = r.tid AND user_id = r.uid
       AND status = 'eliminated' AND elimination_sequence IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'DRAINED_ENTRIES_ROSTER_RACE % %', r.tid, r.pid USING ERRCODE = '40001';
    END IF;
    v_mtt_restored := v_mtt_restored + 1;
  END LOOP;

  -- Both events: every roster row registered, the count published by
  -- trg_sync_tournament_current_players, the pool and escrow untouched.
  FOR b IN SELECT * FROM (VALUES
      ('28515bbb-0ed9-4626-9345-83f2ef80b37d'::uuid),
      ('73ff3bdc-4732-4d8e-9379-94833c038ef0'::uuid)
    ) v(tid)
  LOOP
    IF NOT EXISTS (
         SELECT 1 FROM public.tournaments t
           JOIN public.tournament_escrow e ON e.tournament_id = t.id
          WHERE t.id = b.tid AND t.status = 'REGISTERING'
            AND t.prize_pool = e.prize_balance AND t.total_rake = e.fee_balance
            AND t.current_players = (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = b.tid))
       OR EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = b.tid
                     AND (tp.status <> 'registered' OR tp.eliminated_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'DRAINED_ENTRIES_MTT_POSTIMAGE: %', b.tid;
    END IF;
  END LOOP;

  -- =====================================================================
  -- PART 2. The three unfilled seat-first boards are cancelled through the
  -- platform's cancellation authority, which refunds every entry in full.
  -- =====================================================================
  CREATE TEMP TABLE _drained_board (tid uuid, pid uuid, uid uuid, seat uuid, gross numeric, prize numeric, fee numeric, stack numeric) ON COMMIT DROP;
  INSERT INTO _drained_board VALUES
    ('0801e005-74cb-4dc3-aa69-63bc83c1926f', 'd2d3946a-9a0a-4327-bfeb-e4c5a59b44bd', '00000000-0000-0000-0000-000000000017', '662c4f81-cda6-49ab-bbfb-0c17e32f903b', 20.00, 19.00, 1.00, 1000),
    ('2f906cbc-c0bc-4b74-bd5b-b20bc049a644', '0334c337-bd18-4d7b-bb9d-6ca2f2edd01d', '00000000-0000-0000-0000-000000000087', '17c791a3-ece7-49ab-bfa2-82b96a8c1e13', 50.00, 50.00, 0.00, 300),
    ('2f906cbc-c0bc-4b74-bd5b-b20bc049a644', '5c13c033-d5e6-4655-b00b-49f67d555289', '00000000-0000-0000-0000-000000000042', 'e7a04197-5ceb-47ac-91da-81f8e74df380', 50.00, 50.00, 0.00, 300),
    ('4ddcf172-2360-4e4a-b4aa-3fb017e2628e', 'a7cc0a36-bc73-4f4c-96c8-dd9a38ca7f4e', '00000000-0000-0000-0000-000000000004', '80528da4-fb59-451a-a6f5-10f9dedabf8d', 2.00, 1.90, 0.10, 300);

  FOR b IN SELECT d.tid, count(*) AS entrants, sum(d.gross) AS gross, sum(d.prize) AS prize, sum(d.fee) AS fee
             FROM _drained_board d GROUP BY d.tid ORDER BY d.tid
  LOOP
    IF NOT EXISTS (
         SELECT 1 FROM public.tournaments t
           JOIN public.tournament_escrow e ON e.tournament_id = t.id
          WHERE t.id = b.tid AND t.status = 'REGISTERING' AND t.started_at IS NULL AND t.ended_at IS NULL
            AND t.variant IN ('spin', 'sng') AND t.start_time < '2026-10-06 15:36:00+00'
            AND COALESCE(t.spin_multiplier, 0) = 0
            AND t.prize_pool = b.prize AND t.total_rake = b.fee AND COALESCE(t.bounty_pool, 0) = 0
            AND e.enforced AND e.closed_at IS NULL AND e.gross_in = b.gross
            AND e.prize_balance = b.prize AND e.fee_balance = b.fee AND e.bounty_balance = 0)
       OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts x WHERE x.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts x WHERE x.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.spin_draw_receipts x WHERE x.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.tournament_payouts x WHERE x.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.tournament_obligations x WHERE x.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.tournament_refund_tranches x WHERE x.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.hand_history h WHERE h.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.tables tb JOIN public.hand_history h ON h.table_id = tb.id WHERE tb.tournament_id = b.tid)
       OR EXISTS (SELECT 1 FROM public.tables tb JOIN public.table_seats s ON s.table_id = tb.id
                   WHERE tb.tournament_id = b.tid AND s.left_at IS NULL)
       OR (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = b.tid) <> b.entrants
       OR (SELECT count(*) FROM public.tournament_refund_entitlements x WHERE x.tournament_id = b.tid) <> b.entrants THEN
      RAISE EXCEPTION 'DRAINED_ENTRIES_BOARD_PREIMAGE: % is not the board read on 2026-10-07', b.tid USING ERRCODE = '40001';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n
    FROM _drained_board d
    JOIN public.tournament_players tp
      ON tp.id = d.pid AND tp.tournament_id = d.tid AND tp.user_id = d.uid
     AND tp.status = 'eliminated' AND tp.elimination_sequence IS NULL AND tp.position IS NULL
     AND tp.chips = d.stack
     AND tp.eliminated_at >= '2026-10-06 15:33:04+00' AND tp.eliminated_at < '2026-10-06 15:33:08+00'
    JOIN public.table_seats s
      ON s.id = d.seat AND s.user_id = d.uid AND s.stack = d.stack AND s.status = 'left'
     AND s.left_at >= '2026-10-06 15:33:04+00' AND s.left_at < '2026-10-06 15:33:05+00'
    JOIN public.tournament_refund_entitlements e
      ON e.tournament_id = d.tid AND e.user_id = d.uid AND e.entitlement_kind = 'wallet_charge'
     AND e.gross = d.gross AND e.refund_prize = d.prize AND e.refund_fee = d.fee AND e.refund_bounty = 0
    JOIN smarter_private.patterned_identity_retirements pr
      ON pr.old_id = d.uid AND pr.cohort = 'horse'
   WHERE (SELECT count(*) FROM public.wallet_transactions w
           WHERE w.related_entity_id = d.tid AND w.user_id = d.uid
             AND w.type = 'debit' AND w.category = 'tournament_buyin' AND w.amount = d.gross) = 1
     AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions w
           WHERE w.related_entity_id = d.tid AND w.user_id = d.uid AND w.type = 'credit');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'DRAINED_ENTRIES_BOARD_ENTRY_PREIMAGE: % of 4 entries match the read', v_n USING ERRCODE = '40001';
  END IF;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  FOR b IN SELECT d.tid, sum(d.gross) AS gross, sum(d.fee) AS fee
             FROM _drained_board d GROUP BY d.tid ORDER BY d.tid
  LOOP
    v_receipt := public.atomic_cancel_tournament(b.tid, NULL);
    IF COALESCE((v_receipt->>'ok')::boolean, false) IS NOT TRUE
       OR (v_receipt->>'total_refunded')::numeric IS DISTINCT FROM b.gross
       OR (v_receipt->>'fees_reversed')::numeric IS DISTINCT FROM b.fee THEN
      RAISE EXCEPTION 'DRAINED_ENTRIES_CANCEL_RECEIPT: % returned %', b.tid, v_receipt;
    END IF;
    v_boards_cancelled := v_boards_cancelled + 1;
    v_refunded := v_refunded + b.gross;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT count(*) INTO v_n
    FROM public.tournaments t
    JOIN public.tournament_escrow e ON e.tournament_id = t.id
    JOIN public.tournament_cancellation_receipts c ON c.tournament_id = t.id
   WHERE t.id IN (SELECT DISTINCT tid FROM _drained_board)
     AND t.status = 'CANCELLED' AND t.ended_at IS NOT NULL
     AND t.prize_pool = 0 AND t.total_rake = 0
     AND e.prize_balance = 0 AND e.fee_balance = 0 AND e.bounty_balance = 0
     AND e.closed_at IS NOT NULL AND c.total_rake_after = 0;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'DRAINED_ENTRIES_BOARD_POSTIMAGE: % of 3 boards closed at exact zero', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM _drained_board d
   WHERE (SELECT count(*) FROM public.tournament_refund_tranches tr
           WHERE tr.tournament_id = d.tid AND tr.user_id = d.uid AND tr.amount_paid_now = d.gross) = 1
     AND (SELECT round(COALESCE(sum(w.amount), 0), 2) FROM public.wallet_transactions w
           WHERE w.related_entity_id = d.tid AND w.user_id = d.uid
             AND w.type = 'credit' AND lower(w.category) IN ('refund', 'tournament_refund')) = d.gross;
  IF v_n <> 4 OR v_refunded <> 122.00 THEN
    RAISE EXCEPTION 'DRAINED_ENTRIES_BOARD_POSTIMAGE: % of 4 entrants refunded exactly (% of 122.00)', v_n, v_refunded;
  END IF;

  -- Nothing the 15:33 drain left eliminated without a stamp remains in an
  -- event that has not reached a terminal state.
  SELECT count(*) INTO v_n
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE tp.status = 'eliminated' AND tp.elimination_sequence IS NULL
     AND upper(t.status) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'DRAINED_ENTRIES_UNSEQUENCED_REMAIN: % rows', v_n;
  END IF;

  RAISE NOTICE 'DRAINED_ENTRIES_SETTLED: % entries returned (Wednesday Feature 30, Six-Card Feature 16); % boards cancelled; % refunded', v_mtt_restored, v_boards_cancelled, v_refunded;
END
$drained$;

-- @live-proof: NOT EXISTS (SELECT 1 FROM public.tournament_players tp JOIN public.tournaments t ON t.id = tp.tournament_id WHERE tp.status = 'eliminated' AND tp.elimination_sequence IS NULL AND upper(t.status) NOT IN ('COMPLETED','CANCELLED','CANCELED'))
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id IN ('73ff3bdc-4732-4d8e-9379-94833c038ef0','28515bbb-0ed9-4626-9345-83f2ef80b37d') AND status = 'eliminated' AND elimination_sequence IS NULL)
-- @live-proof: (SELECT count(*) FROM public.tournaments t JOIN public.tournament_cancellation_receipts c ON c.tournament_id = t.id WHERE t.id IN ('0801e005-74cb-4dc3-aa69-63bc83c1926f','2f906cbc-c0bc-4b74-bd5b-b20bc049a644','4ddcf172-2360-4e4a-b4aa-3fb017e2628e') AND t.status = 'CANCELLED') = 3

COMMIT;
