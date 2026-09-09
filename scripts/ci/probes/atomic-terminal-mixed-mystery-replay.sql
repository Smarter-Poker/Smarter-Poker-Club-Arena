-- Disposable PostgreSQL rehearsal only. This represents one long-running
-- mystery event crossing the 2026-09-02 obligation cutover: one 5-chip chest
-- was paid by the legacy mb wallet key and one by the cumulative obligation.
-- The terminal transaction must accept only their exact 10-chip partition,
-- then return a byte-identical replay without moving money. The final PASS
-- exception rolls back the fixture and all terminal writes.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid)
     OR to_regprocedure(
       'public.fn_complete_tournament_terminal(uuid,uuid,text)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION
      'mixed mystery replay probe requires the disposable stage-one rehearsal database';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id)
VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
         to_jsonb(t)||jsonb_build_object(
           'id','88000000-0000-0000-0000-000000000001',
           'name','Atomic Mixed Era Mystery Evidence',
           'status','RUNNING','ended_at',NULL,'updated_at',now(),
           'payout_structure',jsonb_build_array(
             jsonb_build_object('place',1,'percentage',100)),
           'prize_pool',10,'guaranteed_prize',0,
           'prize_pool_finalized',false,'bubble_protection',false,
           'bounty_pool',10,'bounty_pool_paid',10,
           'is_bounty',true,'is_pko',false,'is_mystery_bounty',true,
           'mystery_bounty_stage','complete',
           'mystery_bounty_pool_cents',1000))).*
  FROM public.tournaments t
 WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,
         to_jsonb(tp)||jsonb_build_object(
           'id','88100000-0000-0000-0000-000000000001',
           'tournament_id','88000000-0000-0000-0000-000000000001',
           'status','playing','position',NULL,'prize',0,'chips',100,
           'current_bounty',0,'bounty_winnings',10,
           'bounties_collected',2,'mystery_bounty_value',0,
           'eliminated_at',NULL,'elimination_sequence',NULL,
           'table_id','88200000-0000-0000-0000-000000000001',
           'seat_number',1))).*
  FROM public.tournament_players tp
 WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_escrow
SELECT (jsonb_populate_record(NULL::public.tournament_escrow,
         to_jsonb(e)||jsonb_build_object(
           'tournament_id','88000000-0000-0000-0000-000000000001',
           'gross_in',20,'fee_entries_in',0,'satellite_fee_in',0,
           'bounty_in',10,'overlay_in',0,'satellite_in',0,
           'prize_out',0,'bounty_out',10,'fee_out',0,
           'refund_prize',0,'refund_bounty',0,'refund_fee',0,
           'reserve_out',0,'reserve_in',0,
           'prize_balance',10,'bounty_balance',0,'fee_balance',0,
           'closed_at',NULL,'close_note',NULL,
           'opened_from','atomic_terminal_mixed_mystery_probe',
           'opened_at',now(),'updated_at',now()))).*
  FROM public.tournament_escrow e
 WHERE e.tournament_id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tables
  (id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
VALUES
  ('88200000-0000-0000-0000-000000000001',
   'Atomic Mixed Era Mystery Table',
   '88000000-0000-0000-0000-000000000001',
   'running','live',1,'tournament',
   '20000000-0000-0000-0000-000000000001');

INSERT INTO public.table_seats
  (id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,
   is_sitting_out,club_id)
VALUES
  ('88300000-0000-0000-0000-000000000001',
   '88200000-0000-0000-0000-000000000001',1,
   '10000000-0000-0000-0000-000000000001',100,
   'active',NULL,false,false,
   '20000000-0000-0000-0000-000000000001');

INSERT INTO public.tournament_bounty_chests
  (id,tournament_id,seq,tier,amount_cents,status,award_id)
VALUES
  ('88400000-0000-0000-0000-000000000001',
   '88000000-0000-0000-0000-000000000001',1,'base',500,'paid',
   '88500000-0000-0000-0000-000000000001'),
  ('88400000-0000-0000-0000-000000000002',
   '88000000-0000-0000-0000-000000000001',2,'base',500,'paid',
   '88500000-0000-0000-0000-000000000002');

INSERT INTO public.tournament_bounty_awards
  (id,tournament_id,chest_id,eliminated_user_id,amount_cents,tier,
   status,op_id,reserved_at,revealed_at,paid_at)
VALUES
  ('88500000-0000-0000-0000-000000000001',
   '88000000-0000-0000-0000-000000000001',
   '88400000-0000-0000-0000-000000000001',
   '88510000-0000-0000-0000-000000000001',500,'base','completed',
   '88520000-0000-0000-0000-000000000001',now(),now(),now()),
  ('88500000-0000-0000-0000-000000000002',
   '88000000-0000-0000-0000-000000000001',
   '88400000-0000-0000-0000-000000000002',
   '88510000-0000-0000-0000-000000000002',500,'base','completed',
   '88520000-0000-0000-0000-000000000002',now(),now(),now());

INSERT INTO public.tournament_bounty_award_recipients
  (id,award_id,user_id,amount_cents,is_designated_revealer,paid_at)
VALUES
  ('88600000-0000-0000-0000-000000000001',
   '88500000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',500,true,now()),
  ('88600000-0000-0000-0000-000000000002',
   '88500000-0000-0000-0000-000000000002',
   '10000000-0000-0000-0000-000000000001',500,true,now());

INSERT INTO public.tournament_bounties
  (id,tournament_id,eliminated_player_id,collector_player_id,
   bounty_amount,is_mystery_revealed)
VALUES
  ('88700000-0000-0000-0000-000000000001',
   '88000000-0000-0000-0000-000000000001',
   '88510000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',5,true),
  ('88700000-0000-0000-0000-000000000002',
   '88000000-0000-0000-0000-000000000001',
   '88510000-0000-0000-0000-000000000002',
   '10000000-0000-0000-0000-000000000001',5,true);

INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
VALUES
  ('mb:88500000-0000-0000-0000-000000000001:10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',5),
  ('tourney:88000000-0000-0000-0000-000000000001:obl:88800000-0000-0000-0000-000000000001:0',
   '10000000-0000-0000-0000-000000000001',5);

INSERT INTO public.tournament_obligations
  (id,tournament_id,kind,place,user_id,amount_owed,amount_paid,source,
   settled_at)
VALUES
  ('88800000-0000-0000-0000-000000000001',
   '88000000-0000-0000-0000-000000000001','mystery_bounty',NULL,
   '10000000-0000-0000-0000-000000000001',5,5,
   'fn_mystery_bounty_pay',now());

INSERT INTO public.wallet_transactions
  (id,user_id,wallet_type,amount,type,category,description,
   related_entity_id,balance_after)
VALUES
  ('88900000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001','PLAYER',5,'credit','bounty',
   'Legacy mystery chest',
   '88000000-0000-0000-0000-000000000001',5),
  ('88900000-0000-0000-0000-000000000002',
   '10000000-0000-0000-0000-000000000001','PLAYER',5,'credit','bounty',
   'Obligation mystery chest',
   '88000000-0000-0000-0000-000000000001',10);

SET LOCAL session_replication_role=origin;

CREATE FUNCTION pg_temp.atomic_mixed_mystery_state()
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
AS $state$
  SELECT jsonb_build_object(
    'tournament',(SELECT to_jsonb(t) FROM public.tournaments t
      WHERE t.id='88000000-0000-0000-0000-000000000001'),
    'players',(SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.id)
      FROM public.tournament_players tp
      WHERE tp.tournament_id='88000000-0000-0000-0000-000000000001'),
    'payouts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)
      FROM public.tournament_payouts p
      WHERE p.tournament_id='88000000-0000-0000-0000-000000000001'),
    'obligations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id)
      FROM public.tournament_obligations o
      WHERE o.tournament_id='88000000-0000-0000-0000-000000000001'),
    'wallet_transactions',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id)
      FROM public.wallet_transactions w
      WHERE w.related_entity_id='88000000-0000-0000-0000-000000000001'),
    'wallet_keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY k.key)
      FROM public.wallet_credit_idempotency k
      WHERE k.key LIKE '%88000000-0000-0000-0000-000000000001%'
         OR k.key LIKE 'mb:88500000-0000-0000-0000-000000000001:%'),
    'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
      WHERE e.tournament_id='88000000-0000-0000-0000-000000000001'),
    'receipt',(SELECT to_jsonb(h) FROM public.tournament_terminal_settlements h
      WHERE h.tournament_id='88000000-0000-0000-0000-000000000001'),
    'table',(SELECT to_jsonb(tb) FROM public.tables tb
      WHERE tb.id='88200000-0000-0000-0000-000000000001'),
    'seat',(SELECT to_jsonb(s) FROM public.table_seats s
      WHERE s.id='88300000-0000-0000-0000-000000000001'),
    'member_wallet',(SELECT to_jsonb(m) FROM public.club_members m
      WHERE m.club_id='20000000-0000-0000-0000-000000000001'
        AND m.user_id='10000000-0000-0000-0000-000000000001'));
$state$;

DO $probe$
DECLARE
  v_event constant uuid := '88000000-0000-0000-0000-000000000001';
  v_winner constant uuid := '10000000-0000-0000-0000-000000000001';
  v_obligation_key constant text :=
    'tourney:88000000-0000-0000-0000-000000000001:obl:88800000-0000-0000-0000-000000000001:0';
  v_evidence jsonb;
  v_first jsonb;
  v_replay jsonb;
  v_before_replay jsonb;
  v_after_replay jsonb;
  v_gap_refused boolean := false;
BEGIN
  -- Removing either era's exact key must make the proof fail. The nested
  -- exception rolls this destructive probe mutation back before completion.
  BEGIN
    PERFORM set_config('session_replication_role','replica',true);
    DELETE FROM public.wallet_credit_idempotency k
     WHERE k.key = v_obligation_key;
    PERFORM set_config('session_replication_role','origin',true);
    PERFORM public.fn_ca_mystery_bounty_completion_evidence(v_event,v_winner);
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_gap_refused := true;
  END;
  PERFORM set_config('session_replication_role','origin',true);
  IF NOT v_gap_refused OR NOT EXISTS (
    SELECT 1 FROM public.wallet_credit_idempotency k
     WHERE k.key = v_obligation_key
  ) THEN
    RAISE EXCEPTION 'FAIL a missing mixed-era mystery credit key was accepted or not restored';
  END IF;

  v_evidence := public.fn_ca_mystery_bounty_completion_evidence(
    v_event,v_winner);
  IF v_evidence->>'evidence_mode' IS DISTINCT FROM 'mixed'
     OR (v_evidence->>'pool_cents')::bigint <> 1000
     OR (v_evidence->>'legacy_credit_cents')::bigint <> 500
     OR (v_evidence->>'obligation_cents')::bigint <> 500
     OR (v_evidence->>'completed_award_cents')::bigint <> 1000
     OR (v_evidence->>'void_chest_cents')::bigint <> 0 THEN
    RAISE EXCEPTION 'FAIL mixed-era mystery evidence was not exact: %',v_evidence;
  END IF;

  v_first := public.fn_complete_tournament_terminal(
    v_event,v_winner,'places');
  v_before_replay := pg_temp.atomic_mixed_mystery_state();
  v_replay := public.fn_complete_tournament_terminal(
    v_event,v_winner,'places');
  v_after_replay := pg_temp.atomic_mixed_mystery_state();

  IF v_first IS DISTINCT FROM v_replay
     OR v_first::text IS DISTINCT FROM v_replay::text
     OR v_after_replay IS DISTINCT FROM v_before_replay
     OR v_first->'mystery_bounty'->'payment_evidence'
          IS DISTINCT FROM v_evidence
     OR v_first->>'status' IS DISTINCT FROM 'COMPLETED'
     OR v_first->>'fully_settled' IS DISTINCT FROM 'true'
     OR (v_first->>'bounty_payout_total')::numeric <> 10
     OR (v_first->>'cash_payout_total')::numeric <> 10 THEN
    RAISE EXCEPTION
      'FAIL mixed-era mystery terminal completion or immutable replay diverged: first %, replay %',
      v_first,v_replay;
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: exact pre-cutover mystery key plus post-cutover obligation partition, missing-key refusal, terminal close and byte-identical replay verified; fixture rolled back';
END;
$probe$;
