-- Disposable PostgreSQL rehearsal only. This proves that a five-player chop
-- keeps an already-paid fixed sixth place in the full terminal payout receipt,
-- while deal_shares remains the five live presentation lines. The final PASS
-- exception rolls the complete fixture and all wallet mutations back.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR NOT EXISTS (SELECT 1 FROM public.tournaments
                     WHERE id='30000000-0000-0000-0000-000000000001'::uuid)
     OR to_regprocedure(
       'public.fn_complete_tournament_terminal(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'final-deal replay probe requires the disposable rehearsal database';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id,email,is_sso_user,is_anonymous,created_at,updated_at)
SELECT md5('atomic-deal-user:'||g.i::text)::uuid,
       'atomic-deal-'||g.i||'@example.invalid',false,false,now(),now()
  FROM generate_series(1,6) g(i);

INSERT INTO public.users
SELECT (jsonb_populate_record(NULL::public.users,
         to_jsonb(u)||jsonb_build_object(
           'id',md5('atomic-deal-user:'||g.i::text)::uuid,
           'username','atomic_deal_'||g.i))).*
  FROM public.users u CROSS JOIN generate_series(1,6) g(i)
 WHERE u.id='10000000-0000-0000-0000-000000000002'::uuid;

INSERT INTO public.profiles
SELECT (jsonb_populate_record(NULL::public.profiles,
         to_jsonb(p)||jsonb_build_object(
           'id',md5('atomic-deal-user:'||g.i::text)::uuid,
           'username','atomic_deal_'||g.i))).*
  FROM public.profiles p CROSS JOIN generate_series(1,6) g(i)
 WHERE p.id='10000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.club_members
SELECT (jsonb_populate_record(NULL::public.club_members,
         to_jsonb(m)||jsonb_build_object(
           'user_id',md5('atomic-deal-user:'||g.i::text)::uuid,
           'chip_balance',0,'updated_at',now()))).*
  FROM public.club_members m CROSS JOIN generate_series(1,6) g(i)
 WHERE m.user_id='10000000-0000-0000-0000-000000000001'::uuid
   AND m.club_id='20000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
         to_jsonb(t)||jsonb_build_object(
           'id','87000000-0000-0000-0000-000000000001',
           'name','Atomic Five Player Chop With Fixed Place',
           'status','RUNNING','ended_at',NULL,'updated_at',now(),
           'payout_structure','[{"place":1,"percentage":30},
             {"place":2,"percentage":25},{"place":3,"percentage":20},
             {"place":4,"percentage":10},{"place":5,"percentage":10},
             {"place":6,"percentage":5}]'::jsonb,
           'prize_pool',100,'guaranteed_prize',0,
           'prize_pool_finalized',false,'final_table_deal_enabled',true,
           'table_size',9,'bubble_protection',false,
           'bounty_pool',0,'bounty_pool_paid',0,'is_bounty',false,
           'is_pko',false,'is_mystery_bounty',false,
           'mystery_bounty_stage','pending',
           'mystery_bounty_pool_cents',NULL))).*
  FROM public.tournaments t
 WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,
         to_jsonb(tp)||jsonb_build_object(
           'id',md5('atomic-deal-player:'||g.i::text)::uuid,
           'tournament_id','87000000-0000-0000-0000-000000000001',
           'user_id',md5('atomic-deal-user:'||g.i::text)::uuid,
           'chips',CASE WHEN g.i<=5 THEN g.i*100 ELSE 0 END,
           'status','playing','position',NULL,'prize',0,
           'eliminated_at',NULL,'elimination_sequence',NULL,
           'table_id',CASE WHEN g.i<=5
             THEN '87200000-0000-0000-0000-000000000001' ELSE NULL END,
           'seat_number',CASE WHEN g.i<=5 THEN g.i ELSE NULL END,
           'current_bounty',0,'bounty_winnings',0,
           'mystery_bounty_value',0))).*
  FROM public.tournament_players tp CROSS JOIN generate_series(1,6) g(i)
 WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tournament_escrow
SELECT (jsonb_populate_record(NULL::public.tournament_escrow,
         to_jsonb(e)||jsonb_build_object(
           'tournament_id','87000000-0000-0000-0000-000000000001',
           'gross_in',100,'fee_entries_in',0,'satellite_fee_in',0,
           'bounty_in',0,'overlay_in',0,'satellite_in',0,
           'prize_out',5,'bounty_out',0,'fee_out',0,
           'refund_prize',0,'refund_bounty',0,'refund_fee',0,
           'reserve_out',0,'reserve_in',0,
           'prize_balance',95,'bounty_balance',0,'fee_balance',0,
           'closed_at',NULL,'close_note',NULL,
           'opened_from','atomic_terminal_final_deal_probe',
           'opened_at',now(),'updated_at',now()))).*
  FROM public.tournament_escrow e
 WHERE e.tournament_id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tables
  (id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
VALUES
  ('87200000-0000-0000-0000-000000000001','Atomic Five Player Deal',
   '87000000-0000-0000-0000-000000000001','running','live',5,
   'tournament','20000000-0000-0000-0000-000000000001');

INSERT INTO public.table_seats
  (id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,
   is_sitting_out,club_id)
SELECT md5('atomic-deal-seat:'||g.i::text)::uuid,
       '87200000-0000-0000-0000-000000000001',g.i,
       md5('atomic-deal-user:'||g.i::text)::uuid,g.i*100,
       'active',NULL,false,false,
       '20000000-0000-0000-0000-000000000001'
  FROM generate_series(1,5) g(i);

INSERT INTO public.tournament_deal_votes(tournament_id,user_id)
SELECT '87000000-0000-0000-0000-000000000001',
       md5('atomic-deal-user:'||g.i::text)::uuid
  FROM generate_series(1,5) g(i);

INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
VALUES ('atomic-deal-fixed-place-6',
        md5('atomic-deal-user:6')::uuid,5);
INSERT INTO public.tournament_payouts
  (tournament_id,user_id,"position",amount,source,idempotency_key)
VALUES
  ('87000000-0000-0000-0000-000000000001',
   md5('atomic-deal-user:6')::uuid,6,5,'structure',
   'atomic-deal-fixed-place-6');
INSERT INTO public.tournament_obligations
  (id,tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
VALUES
  ('87400000-0000-0000-0000-000000000001',
   '87000000-0000-0000-0000-000000000001','place',6,
   md5('atomic-deal-user:6')::uuid,5,5,'engine.fixed_probe',now());
INSERT INTO public.wallet_transactions
  (id,user_id,wallet_type,amount,type,category,description,
   related_entity_id,balance_after)
VALUES
  ('87500000-0000-0000-0000-000000000001',
   md5('atomic-deal-user:6')::uuid,'PLAYER',5,'credit','prize',
   'Prior fixed place','87000000-0000-0000-0000-000000000001',5);

SET LOCAL session_replication_role=origin;

-- Use the production transition trigger for the already-earned sixth place.
-- Its sequence is therefore earlier than every live player the deal closes,
-- exactly matching a real event instead of inventing a conflicting fixture
-- sequence while replication triggers are disabled.
UPDATE public.tournament_players
   SET status='eliminated',position=6,prize=5,
       eliminated_at=now()-interval '1 minute'
 WHERE tournament_id='87000000-0000-0000-0000-000000000001'::uuid
   AND user_id=md5('atomic-deal-user:6')::uuid;

CREATE FUNCTION pg_temp.atomic_deal_state()
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
AS $state$
  SELECT jsonb_build_object(
    'tournament',(SELECT to_jsonb(t) FROM public.tournaments t
                   WHERE t.id='87000000-0000-0000-0000-000000000001'),
    'players',(SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.user_id)
                 FROM public.tournament_players tp
                WHERE tp.tournament_id='87000000-0000-0000-0000-000000000001'),
    'payouts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)
                 FROM public.tournament_payouts p
                WHERE p.tournament_id='87000000-0000-0000-0000-000000000001'),
    'obligations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id)
                     FROM public.tournament_obligations o
                    WHERE o.tournament_id='87000000-0000-0000-0000-000000000001'),
    'wallets',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.user_id)
                 FROM public.club_members m
                WHERE m.user_id IN (SELECT tp.user_id
                  FROM public.tournament_players tp
                 WHERE tp.tournament_id='87000000-0000-0000-0000-000000000001')),
    'receipt',(SELECT to_jsonb(h) FROM public.tournament_terminal_settlements h
                WHERE h.tournament_id='87000000-0000-0000-0000-000000000001'),
    'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
               WHERE e.tournament_id='87000000-0000-0000-0000-000000000001'),
    'table',(SELECT to_jsonb(tb) FROM public.tables tb
              WHERE tb.id='87200000-0000-0000-0000-000000000001'),
    'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
               FROM public.table_seats s
              WHERE s.table_id='87200000-0000-0000-0000-000000000001'));
$state$;

DO $probe$
DECLARE
  v_first jsonb;
  v_second jsonb;
  v_before_replay jsonb;
  v_after_replay jsonb;
BEGIN
  v_first := public.fn_complete_tournament_terminal(
    '87000000-0000-0000-0000-000000000001',NULL,'final_table_deal');
  IF jsonb_array_length(v_first->'payouts') <> 6
     OR jsonb_array_length(v_first->'deal_shares') <> 5
     OR (SELECT sum((p->>'amount')::numeric)
           FROM jsonb_array_elements(v_first->'payouts') p) <> 100
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_first->'payouts') p
                     WHERE (p->>'place')::integer=6
                       AND (p->>'amount')::numeric=5)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_first->'deal_shares') p
                 WHERE (p->>'place')::integer=6) THEN
    RAISE EXCEPTION 'FAIL full payout lines and live deal shares diverged: %',v_first;
  END IF;
  v_before_replay := pg_temp.atomic_deal_state();
  v_second := public.fn_complete_tournament_terminal(
    '87000000-0000-0000-0000-000000000001',NULL,'final_table_deal');
  v_after_replay := pg_temp.atomic_deal_state();
  IF v_second IS DISTINCT FROM v_first
     OR v_second::text IS DISTINCT FROM v_first::text
     OR v_after_replay IS DISTINCT FROM v_before_replay THEN
    RAISE EXCEPTION 'FAIL final-deal replay changed receipt bytes or durable state';
  END IF;
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: five live deal shares, prior fixed place, full 100 cash total and immutable byte-identical replay verified; fixture rolled back';
END;
$probe$;
