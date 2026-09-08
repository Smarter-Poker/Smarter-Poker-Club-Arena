-- Run as postgres only on a disposable clone of the representative stage-one
-- migration rehearsal database. The final AUDIT_TEST_PASS exception is
-- intentional and rolls back both the fixture and every probe object.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = '30000000-0000-0000-0000-000000000001'::uuid)
     OR to_regprocedure(
       'public.fn_complete_tournament_terminal(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION
      'atomic terminal closure rollback probe requires the disposable stage-one rehearsal database';
  END IF;
END;
$fixture_guard$;

-- Clone only structural rehearsal evidence. session_replication_role is used
-- solely while constructing this disposable fixture; the authority itself and
-- the injected failure run with every production trigger enabled.
SET LOCAL session_replication_role = replica;

-- The merged platform-wide strict auto-ledger records its database-owned
-- actor on every bank delta. Production has this system principal; the
-- schema-only rehearsal clone does not, so add only its FK identity here.
INSERT INTO auth.users(id)
VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
  to_jsonb(t) || jsonb_build_object(
    'id','80000000-0000-0000-0000-000000000001',
    'name','Atomic Terminal Closure Rollback Probe',
    'status','RUNNING','ended_at',NULL,'updated_at',now(),
    'payout_structure',jsonb_build_array(
      jsonb_build_object('place',1,'percentage',100)),
    'prize_pool',30,'guaranteed_prize',40,'prize_pool_finalized',false,
    'bounty_pool',5,'bounty_pool_paid',0,'is_bounty',true,
    'is_pko',false,'is_mystery_bounty',true,
    'mystery_bounty_stage','active','mystery_bounty_pool_cents',500
  ))).*
  FROM public.tournaments t
 WHERE t.id = '30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,
  to_jsonb(tp) || jsonb_build_object(
    'id','81000000-0000-0000-0000-000000000001',
    'tournament_id','80000000-0000-0000-0000-000000000001',
    'status','playing','position',NULL,'prize',0,'current_bounty',5,
    'bounty_winnings',0,'mystery_bounty_value',0,
    'eliminated_at',NULL,'elimination_sequence',NULL,
    'table_id','82000000-0000-0000-0000-000000000001','seat_number',1
  ))).*
  FROM public.tournament_players tp
 WHERE tp.tournament_id = '30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_escrow
SELECT (jsonb_populate_record(NULL::public.tournament_escrow,
  to_jsonb(e) || jsonb_build_object(
    'tournament_id','80000000-0000-0000-0000-000000000001',
    'gross_in',37,'fee_entries_in',2,'satellite_fee_in',0,'bounty_in',5,
    'overlay_in',0,'satellite_in',0,'prize_out',0,'bounty_out',0,'fee_out',0,
    'refund_prize',0,'refund_bounty',0,'refund_fee',0,
    'reserve_out',0,'reserve_in',0,
    'prize_balance',30,'bounty_balance',5,'fee_balance',2,
    'closed_at',NULL,'close_note',NULL,
    'opened_from','atomic_terminal_closure_rollback_probe',
    'opened_at',now(),'updated_at',now()
  ))).*
  FROM public.tournament_escrow e
 WHERE e.tournament_id = '30000000-0000-0000-0000-000000000001'::uuid;

UPDATE public.clubs SET chip_treasury=100
 WHERE id='20000000-0000-0000-0000-000000000001'::uuid;
INSERT INTO public.club_wallets(
  club_id,chip_balance,
  period_rake_collected,period_commission_paid,period_bbj_contribution,
  lifetime_rake_collected,lifetime_commission_paid,lifetime_bbj_contribution)
VALUES (
  '20000000-0000-0000-0000-000000000001',100,
  0,0,0,
  0,0,0)
ON CONFLICT (club_id) DO UPDATE
SET chip_balance=EXCLUDED.chip_balance,
    period_rake_collected=EXCLUDED.period_rake_collected,
    period_commission_paid=EXCLUDED.period_commission_paid,
    period_bbj_contribution=EXCLUDED.period_bbj_contribution,
    lifetime_rake_collected=EXCLUDED.lifetime_rake_collected,
    lifetime_commission_paid=EXCLUDED.lifetime_commission_paid,
    lifetime_bbj_contribution=EXCLUDED.lifetime_bbj_contribution;
INSERT INTO public.tournament_bounty_chests
  (id,tournament_id,seq,tier,amount_cents,status)
VALUES
  ('84000000-0000-0000-0000-000000000001',
   '80000000-0000-0000-0000-000000000001',1,'base',500,'available');
INSERT INTO public.rake_records
  (id,club_id,rake_amount,is_tournament,tournament_id,source,metadata)
VALUES
  ('85000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000001',2,true,
   '80000000-0000-0000-0000-000000000001','tournament',
   jsonb_build_object('user_id','10000000-0000-0000-0000-000000000001'));

INSERT INTO public.tables
  (id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
VALUES
  ('82000000-0000-0000-0000-000000000001',
   'Atomic Terminal Closure Rollback Table',
   '80000000-0000-0000-0000-000000000001',
   'running','live',1,'tournament',
   '20000000-0000-0000-0000-000000000001');

INSERT INTO public.table_seats
  (id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,
   is_sitting_out,is_away,sit_out_at,scheduled_leave_hands,club_id)
VALUES
  ('83000000-0000-0000-0000-000000000001',
   '82000000-0000-0000-0000-000000000001',1,
   '10000000-0000-0000-0000-000000000001',35,'active',NULL,true,true,
   true,'2026-09-08 04:59:00+00'::timestamptz,2,
   '20000000-0000-0000-0000-000000000001');

SET LOCAL session_replication_role = origin;

CREATE FUNCTION pg_temp.atomic_terminal_probe_state(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public','pg_temp'
AS $state$
  SELECT jsonb_build_object(
    'tournament',(SELECT to_jsonb(t) FROM public.tournaments t
                   WHERE t.id=p_tournament_id),
    'players',COALESCE((SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.id)
                         FROM public.tournament_players tp
                        WHERE tp.tournament_id=p_tournament_id),'[]'::jsonb),
    'payouts',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)
                         FROM public.tournament_payouts p
                        WHERE p.tournament_id=p_tournament_id),'[]'::jsonb),
    'obligations',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id)
                             FROM public.tournament_obligations o
                            WHERE o.tournament_id=p_tournament_id),'[]'::jsonb),
    'wallet_transactions',COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id)
                                      FROM public.wallet_transactions w
                                     WHERE w.related_entity_id=p_tournament_id),'[]'::jsonb),
    'wallet_keys',COALESCE((SELECT jsonb_agg(to_jsonb(k) ORDER BY k.key)
                             FROM public.wallet_credit_idempotency k
                            WHERE k.key LIKE 'tourney:'||p_tournament_id::text||':%'),'[]'::jsonb),
    'chip_ledger',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id)
                             FROM public.chip_ledger l
                            WHERE l.tournament_id=p_tournament_id
                               OR l.from_entity_id=p_tournament_id
                               OR l.to_entity_id=p_tournament_id),'[]'::jsonb),
    'guarantee_overlays',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.tournament_id)
                                    FROM public.tournament_guarantee_overlays g
                                   WHERE g.tournament_id=p_tournament_id),'[]'::jsonb),
    'union_wallet_transactions',COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id)
                                           FROM public.union_wallet_transactions u
                                          WHERE u.notes LIKE '%'||p_tournament_id::text||'%'),'[]'::jsonb),
    'financial_alerts',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
                                  FROM public.financial_alerts a
                                 WHERE a.source='fn_apply_prize_guarantee'
                                   AND a.context->>'latest_tournament_id'
                                         =p_tournament_id::text),'[]'::jsonb),
    'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
               WHERE e.tournament_id=p_tournament_id),
    'rake_settlement',(SELECT to_jsonb(r)
                         FROM public.tournament_rake_settlements r
                        WHERE r.tournament_id=p_tournament_id),
    'rake_records',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
                              FROM public.rake_records r
                             WHERE r.tournament_id=p_tournament_id),'[]'::jsonb),
    'mystery_chests',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)
                                FROM public.tournament_bounty_chests c
                               WHERE c.tournament_id=p_tournament_id),'[]'::jsonb),
    'mystery_awards',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
                                FROM public.tournament_bounty_awards a
                               WHERE a.tournament_id=p_tournament_id),'[]'::jsonb),
    'mystery_recipients',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
                                    FROM public.tournament_bounty_award_recipients r
                                    JOIN public.tournament_bounty_awards a
                                      ON a.id=r.award_id
                                   WHERE a.tournament_id=p_tournament_id),'[]'::jsonb),
    'receipt',(SELECT to_jsonb(h)
                 FROM public.tournament_terminal_settlements h
                WHERE h.tournament_id=p_tournament_id),
    'tables',COALESCE((SELECT jsonb_agg(to_jsonb(tb) ORDER BY tb.id)
                        FROM public.tables tb
                       WHERE tb.tournament_id=p_tournament_id),'[]'::jsonb),
    'seats',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
                       FROM public.table_seats s
                       JOIN public.tables tb ON tb.id=s.table_id
                      WHERE tb.tournament_id=p_tournament_id),'[]'::jsonb),
    'member_wallets',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.club_id,m.user_id)
                                FROM public.club_members m
                               WHERE m.user_id IN (
                                 SELECT tp.user_id FROM public.tournament_players tp
                                  WHERE tp.tournament_id=p_tournament_id)),'[]'::jsonb),
    'fallback_wallets',COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id)
                                  FROM public.wallets w
                                    WHERE w.user_id IN (
                                   SELECT tp.user_id FROM public.tournament_players tp
                                    WHERE tp.tournament_id=p_tournament_id)),'[]'::jsonb),
    'club',(SELECT to_jsonb(c) FROM public.clubs c
             WHERE c.id='20000000-0000-0000-0000-000000000001'),
    'club_wallet',(SELECT to_jsonb(cw) FROM public.club_wallets cw
                    WHERE cw.club_id='20000000-0000-0000-0000-000000000001'),
    'union_wallets',COALESCE((SELECT jsonb_agg(to_jsonb(uw) ORDER BY uw.id)
                               FROM public.union_wallets uw),'[]'::jsonb),
    'vip_points_carry',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.user_id)
                                  FROM public.vip_points_carry v
                                 WHERE v.user_id IN (SELECT tp.user_id
                                   FROM public.tournament_players tp
                                  WHERE tp.tournament_id=p_tournament_id)),'[]'::jsonb),
    'agent_commissions',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
                                   FROM public.agent_commissions a
                                  WHERE a.user_id IN (SELECT tp.user_id
                                    FROM public.tournament_players tp
                                   WHERE tp.tournament_id=p_tournament_id)),'[]'::jsonb),
    'player_stats',COALESCE((SELECT jsonb_agg(to_jsonb(ps) ORDER BY ps.user_id)
                              FROM public.player_stats ps
                             WHERE ps.user_id IN (SELECT tp.user_id
                               FROM public.tournament_players tp
                              WHERE tp.tournament_id=p_tournament_id)),'[]'::jsonb)
  );
$state$;

DO $live_marker_guard$
DECLARE
  v_table_id constant uuid :=
    '82000000-0000-0000-0000-000000000001';
  v_forged_table_id constant uuid :=
    '82000000-0000-0000-0000-000000000002';
  v_before jsonb;
  v_after jsonb;
  v_player_before jsonb;
  v_player_after jsonb;
  v_update_caught boolean := false;
  v_insert_caught boolean := false;
  v_child_marker_caught boolean := false;
BEGIN
  SELECT to_jsonb(tb) INTO v_before
    FROM public.tables tb WHERE tb.id=v_table_id;
  BEGIN
    UPDATE public.tables
       SET status='closed',lifecycle='closed',current_players=0,
           terminal_closed_at='2026-09-08 12:00:00+00'::timestamptz
     WHERE id=v_table_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_update_caught := true;
  END;
  SELECT to_jsonb(tb) INTO v_after
    FROM public.tables tb WHERE tb.id=v_table_id;
  IF NOT v_update_caught OR v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      'FAIL live table accepted a caller-supplied terminal marker through a forged closed update';
  END IF;

  SELECT to_jsonb(tp) INTO v_player_before
    FROM public.tournament_players tp
   WHERE tp.id='81000000-0000-0000-0000-000000000001'::uuid;
  BEGIN
    UPDATE public.tournament_players
       SET terminal_closed_at='2026-09-08 12:00:00+00'::timestamptz
     WHERE id='81000000-0000-0000-0000-000000000001'::uuid;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_child_marker_caught := true;
  END;
  SELECT to_jsonb(tp) INTO v_player_after
    FROM public.tournament_players tp
   WHERE tp.id='81000000-0000-0000-0000-000000000001'::uuid;
  IF NOT v_child_marker_caught
     OR v_player_after IS DISTINCT FROM v_player_before THEN
    RAISE EXCEPTION
      'FAIL live tournament player accepted a caller-supplied terminal marker';
  END IF;

  BEGIN
    INSERT INTO public.tables
      (id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,
       terminal_closed_at)
    VALUES
      (v_forged_table_id,'Forged Terminal Marker Table',
       '80000000-0000-0000-0000-000000000001','closed','closed',0,
       'tournament','20000000-0000-0000-0000-000000000001',
       '2026-09-08 12:00:00+00'::timestamptz);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_insert_caught := true;
  END;
  IF NOT v_insert_caught
     OR EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id=v_forged_table_id)
     OR (SELECT to_jsonb(tb) FROM public.tables tb WHERE tb.id=v_table_id)
          IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      'FAIL live tournament accepted a forged terminal-marker table or changed its original table';
  END IF;
END;
$live_marker_guard$;

CREATE FUNCTION pg_temp.reject_atomic_terminal_table_close()
RETURNS trigger
LANGUAGE plpgsql
AS $failure$
BEGIN
  IF NEW.id = '82000000-0000-0000-0000-000000000001'::uuid
     AND lower(COALESCE(NEW.status::text,'')) = 'closed' THEN
    RAISE EXCEPTION 'injected terminal table closure write failure'
      USING ERRCODE = 'ZX901';
  END IF;
  RETURN NEW;
END;
$failure$;

CREATE TRIGGER zz_probe_reject_atomic_terminal_table_close
  BEFORE UPDATE OF status,lifecycle,current_players,terminal_closed_at
  ON public.tables
  FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_atomic_terminal_table_close();

DO $probe$
DECLARE
  v_tournament_id constant uuid :=
    '80000000-0000-0000-0000-000000000001';
  v_winner_id constant uuid :=
    '10000000-0000-0000-0000-000000000001';
  v_before jsonb;
  v_after jsonb;
  v_injected boolean := false;
BEGIN
  v_before := pg_temp.atomic_terminal_probe_state(v_tournament_id);
  BEGIN
    PERFORM public.fn_complete_tournament_terminal(
      v_tournament_id,v_winner_id,'places');
  EXCEPTION WHEN SQLSTATE 'ZX901' THEN
    v_injected := true;
  END;
  v_after := pg_temp.atomic_terminal_probe_state(v_tournament_id);

  IF NOT v_injected THEN
    RAISE EXCEPTION 'FAIL injected closure write did not abort terminal completion';
  END IF;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      'FAIL closure error retained an overlay, cash, mystery, bounty, attributed-rake, status, escrow, table, seat, wallet or receipt mutation';
  END IF;
END;
$probe$;

DROP TRIGGER zz_probe_reject_atomic_terminal_table_close ON public.tables;

DO $success_and_replay$
DECLARE
  v_tournament_id constant uuid :=
    '80000000-0000-0000-0000-000000000001';
  v_winner_id constant uuid :=
    '10000000-0000-0000-0000-000000000001';
  v_first jsonb;
  v_replay jsonb;
  v_after_first jsonb;
  v_after_replay jsonb;
  v_table_before jsonb;
  v_table_after jsonb;
  v_null_players_caught boolean := false;
  v_marker_change_caught boolean := false;
  v_table_id_change_caught boolean := false;
  v_overlay_change_caught boolean := false;
  v_overlay_before jsonb;
  v_overlay_after jsonb;
  v_completed_at timestamptz;
BEGIN
  v_first := public.fn_complete_tournament_terminal(
    v_tournament_id,v_winner_id,'places');
  SELECT t.ended_at INTO v_completed_at
    FROM public.tournaments t WHERE t.id=v_tournament_id;
  v_after_first := pg_temp.atomic_terminal_probe_state(v_tournament_id);

  SELECT to_jsonb(tb) INTO v_table_before
    FROM public.tables tb
   WHERE tb.id='82000000-0000-0000-0000-000000000001'::uuid;
  BEGIN
    UPDATE public.tables SET current_players=NULL
     WHERE id='82000000-0000-0000-0000-000000000001'::uuid;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_null_players_caught := true;
  END;
  SELECT to_jsonb(tb) INTO v_table_after
    FROM public.tables tb
   WHERE tb.id='82000000-0000-0000-0000-000000000001'::uuid;
  IF NOT v_null_players_caught OR v_table_after IS DISTINCT FROM v_table_before THEN
    RAISE EXCEPTION
      'FAIL terminal table current_players changed from exact zero to NULL';
  END IF;

  BEGIN
    UPDATE public.tables
       SET terminal_closed_at=terminal_closed_at + interval '1 second'
     WHERE id='82000000-0000-0000-0000-000000000001'::uuid;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_marker_change_caught := true;
  END;
  SELECT to_jsonb(tb) INTO v_table_after
    FROM public.tables tb
   WHERE tb.id='82000000-0000-0000-0000-000000000001'::uuid;
  IF NOT v_marker_change_caught OR v_table_after IS DISTINCT FROM v_table_before THEN
    RAISE EXCEPTION
      'FAIL terminal table marker changed after successful completion';
  END IF;

  BEGIN
    UPDATE public.tables
       SET id='82000000-0000-0000-0000-000000000099'::uuid
     WHERE id='82000000-0000-0000-0000-000000000001'::uuid;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_table_id_change_caught := true;
  END;
  SELECT to_jsonb(tb) INTO v_table_after
    FROM public.tables tb
   WHERE tb.id='82000000-0000-0000-0000-000000000001'::uuid;
  IF NOT v_table_id_change_caught OR v_table_after IS DISTINCT FROM v_table_before
     OR EXISTS (SELECT 1 FROM public.tables tb
                 WHERE tb.id='82000000-0000-0000-0000-000000000099'::uuid) THEN
    RAISE EXCEPTION
      'FAIL terminal table identity changed after successful completion';
  END IF;

  SELECT to_jsonb(g) INTO v_overlay_before
    FROM public.tournament_guarantee_overlays g
   WHERE g.tournament_id=v_tournament_id;
  BEGIN
    UPDATE public.tournament_guarantee_overlays
       SET amount=amount + 1
     WHERE tournament_id=v_tournament_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_overlay_change_caught := true;
  END;
  SELECT to_jsonb(g) INTO v_overlay_after
    FROM public.tournament_guarantee_overlays g
   WHERE g.tournament_id=v_tournament_id;
  IF NOT v_overlay_change_caught
     OR v_overlay_after IS DISTINCT FROM v_overlay_before THEN
    RAISE EXCEPTION
      'FAIL terminal guarantee evidence changed after successful completion';
  END IF;

  v_replay := public.fn_complete_tournament_terminal(
    v_tournament_id,v_winner_id,'places');
  v_after_replay := pg_temp.atomic_terminal_probe_state(v_tournament_id);

  IF v_first IS DISTINCT FROM v_replay
     OR v_first::text IS DISTINCT FROM v_replay::text
     OR v_after_first IS DISTINCT FROM v_after_replay THEN
    RAISE EXCEPTION
      'FAIL positive-overlay terminal replay changed its receipt or durable state';
  END IF;
  IF COALESCE((v_first->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_first->>'fully_settled')::boolean,false) IS NOT TRUE
     OR v_first->>'status' <> 'COMPLETED'
     OR (v_first->>'cash_payout_total')::numeric IS DISTINCT FROM 40::numeric
     OR (v_first->>'bounty_payout_total')::numeric IS DISTINCT FROM 5::numeric
     OR (v_first->>'source_seat_count')::integer IS DISTINCT FROM 1
     OR (v_first->>'released_seat_count')::integer IS DISTINCT FROM 1
     OR v_first->'table_closure'->'source_seat_ids' IS DISTINCT FROM
          '["83000000-0000-0000-0000-000000000001"]'::jsonb
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
       WHERE s.id='83000000-0000-0000-0000-000000000001'::uuid
          AND s.left_at=(SELECT t.ended_at FROM public.tournaments t
                         WHERE t.id=v_tournament_id)
          AND s.terminal_closed_at IS NOT DISTINCT FROM v_completed_at
          AND s.status IS NOT DISTINCT FROM 'left'
          AND s.leave_pending IS FALSE
          AND s.is_sitting_out IS FALSE
          AND s.is_away IS FALSE
          AND s.sit_out_at IS NULL
          AND s.scheduled_leave_hands IS NULL)
     OR (v_first->'rake'->>'amount')::numeric IS DISTINCT FROM 2::numeric
     OR COALESCE((v_first->'rake'->>'attributed')::boolean,false) IS NOT TRUE
     OR (v_first->'mystery_bounty'->>'pool_cents')::bigint IS DISTINCT FROM 500::bigint
     OR COALESCE((v_first->'mystery_bounty'->>'balanced')::boolean,false)
          IS NOT TRUE
     OR EXISTS (
       SELECT 1 FROM public.tournament_escrow e
        WHERE e.tournament_id=v_tournament_id
          AND (e.overlay_in IS DISTINCT FROM 10::numeric
            OR e.prize_out IS DISTINCT FROM 40::numeric
            OR e.bounty_out IS DISTINCT FROM 5::numeric
            OR e.fee_out IS DISTINCT FROM 2::numeric
            OR e.prize_balance IS DISTINCT FROM 0::numeric
            OR e.bounty_balance IS DISTINCT FROM 0::numeric
            OR e.fee_balance IS DISTINCT FROM 0::numeric
            OR e.closed_at IS NULL))
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_guarantee_overlays g
        WHERE g.tournament_id=v_tournament_id
          AND g.amount=10 AND g.pool_before=30 AND g.pool_after=40
          AND g.bank_type='club'
          AND g.bank_entity_id='20000000-0000-0000-0000-000000000001'::uuid)
     OR EXISTS (SELECT 1 FROM public.tournament_players x
                 WHERE x.tournament_id=v_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=v_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=v_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=v_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=v_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=v_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=v_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=v_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=v_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=v_tournament_id
          AND r.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=v_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=v_tournament_id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_completed_at)
     OR (SELECT c.chip_treasury FROM public.clubs c
          WHERE c.id='20000000-0000-0000-0000-000000000001'::uuid)
          IS DISTINCT FROM 92::numeric
     OR EXISTS (SELECT 1 FROM public.club_wallets cw
          WHERE cw.club_id='20000000-0000-0000-0000-000000000001'::uuid
          AND (cw.chip_balance IS DISTINCT FROM 100::numeric
            OR cw.period_rake_collected IS DISTINCT FROM 2::numeric
            OR cw.lifetime_rake_collected IS DISTINCT FROM 2::numeric)) THEN
    RAISE EXCEPTION
      'FAIL positive overlay, cash, mystery bounty, rake or escrow conservation proof is incomplete: %',
      v_first;
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: injected table closure failure rolled back the 10-chip guarantee overlay and bank journal, 40-chip cash settlement, active mystery payout, bounty, 2-chip attributed rake, status, escrow, table, seat, wallets and receipt state exactly; live forged table and child markers were refused at 55000 with exact state preserved; after successful completion, every mutable child carried the exact close marker, zero current_players could not become NULL and the terminal marker could not change; every source seat identity was frozen and every occupancy flag closed; the successful path conserved all rails and its second call returned a byte-identical receipt with zero durable mutation; fixture and probe objects rolled back';
END;
$success_and_replay$;
