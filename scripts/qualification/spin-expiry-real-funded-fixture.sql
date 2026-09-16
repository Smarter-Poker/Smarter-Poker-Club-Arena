-- SOURCE ONLY / UNRUN. Genuine funded preparation for the existing R1/R5/R2
-- Spin expiry qualifiers, inside an admitted, disposable PG17 allocation only.
-- Baseline: notification PG17 0013's successful zero Union-host + real Mint.
-- Current entry/bank/session authority: fifo5-financial-provider-preparation-
-- 20260916 captures and exact entry-provider-supplement.sql. No replacement
-- financial functions, balance seeding, trigger disabling or historical IDs.
--
-- Parent restores exactly THREE synthetic zero principals before real triggers,
-- supplies execution_uuid, ordinary_user_uuid and a fresh v4 tournament_uuid,
-- and installs the pinned current provider/entry supplement. This is not signup.
-- Run from its maintained scripts/qualification path in the staged allocation;
-- the parent supplies the exact four captured store-policy rows under inputs/.
-- All subsequent requests below commit independently. On any failure retain
-- stdout/stderr and the allocation: earlier COMMITs are not rolled back. Unknown
-- commit outcomes must not be retried. Dispose the whole allocation after proof.
-- Parent waits 65 seconds AFTER this script's final COMMIT, then invokes the
-- unchanged expiry qualifier. No sleep/backdating/aging transaction is used here.
-- Session timeouts are settings, not proof that nested function-local timeouts
-- cannot supersede them; the admitted outer allocation deadline remains required.
\set ON_ERROR_STOP on
\if :{?execution_uuid}
\else
  \quit 3
\endif
\if :{?ordinary_user_uuid}
\else
  \quit 3
\endif
\if :{?tournament_uuid}
\else
  \quit 3
\endif

SET statement_timeout='8s';
SET lock_timeout='2s';
SET idle_in_transaction_session_timeout='20s';
SET timezone='UTC';
SET datestyle='ISO,YMD';
SET search_path=public,pg_temp;
BEGIN;
CREATE TEMP TABLE spin_q_inputs AS SELECT
  :'execution_uuid'::uuid execution,
  :'tournament_uuid'::uuid tournament,
  '47965354-0e56-43ef-931c-ddaab82af765'::uuid owner_user,
  :'ordinary_user_uuid'::uuid player1,
  extensions.uuid_generate_v5(:'execution_uuid'::uuid,'spin-player-2') player2,
  extensions.uuid_generate_v5(:'execution_uuid'::uuid,'spin-owner-session') owner_session,
  extensions.uuid_generate_v5(:'execution_uuid'::uuid,'spin-session-1') session1,
  extensions.uuid_generate_v5(:'execution_uuid'::uuid,'spin-session-2') session2,
  extensions.uuid_generate_v5(:'execution_uuid'::uuid,'spin-bank-1') bank1,
  extensions.uuid_generate_v5(:'execution_uuid'::uuid,'spin-bank-2') bank2,
  clock_timestamp() preparation_started_at;
CREATE TEMP TABLE spin_q_calls(stage text PRIMARY KEY,result jsonb NOT NULL);
CREATE TEMP TABLE spin_q_trigger_modes AS
  SELECT tgrelid,tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal;
CREATE FUNCTION pg_temp.spin_q_assert(ok boolean,message text) RETURNS void
LANGUAGE plpgsql AS $$BEGIN
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Spin real funded fixture: %',message;
  END IF;
END$$;
DO $admission$
DECLARE q record; relation_name text; occupied boolean;
BEGIN
  SELECT * INTO STRICT q FROM spin_q_inputs;
  PERFORM pg_temp.spin_q_assert(current_user='postgres' AND session_user='postgres'
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
    AND current_database()='qual_spin_expiry_'||replace(q.execution::text,'-','')
    AND current_setting('qualification.execution_uuid',true)=q.execution::text
    AND current_setting('port')='5432' AND inet_server_addr() IS NULL
    AND current_setting('session_replication_role')='origin'
    AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999,
    'exact non-superuser private PG17 allocation required');
  PERFORM pg_temp.spin_q_assert(q.tournament::text ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND (SELECT count(DISTINCT id)=5 FROM unnest(ARRAY[q.execution,q.tournament,
      q.owner_user,q.player1,q.player2]) id), 'distinct fixture and canonical v4 tournament identities');
  PERFORM pg_temp.spin_q_assert((SELECT count(*)=3 FROM auth.users)
    AND (SELECT count(*)=3 FROM public.profiles)
    AND (SELECT count(*)=3 FROM auth.users WHERE id IN(q.owner_user,q.player1,q.player2))
    AND (SELECT count(*)=3 FROM public.profiles WHERE id IN(q.owner_user,q.player1,q.player2)
      AND diamonds IS NOT DISTINCT FROM 0 AND diamond_balance IS NOT DISTINCT FROM 0
      AND is_horse IS FALSE AND role='user') AND NOT EXISTS(SELECT 1 FROM auth.sessions),
    'exact three pre-restored zero synthetic principals, no sessions');
  -- Exact bodies here complement the parent's full owner/ACL/trigger/provider
  -- readback; these hashes alone do not establish that larger authority closure.
  PERFORM pg_temp.spin_q_assert(
    md5(pg_get_functiondef('public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)'::regprocedure))
      ='162eba07a4e75f16ae21e5ca809ee595'
    AND md5(pg_get_functiondef('public.fn_create_seat_first_game_atomic(uuid,jsonb)'::regprocedure))
      ='92cbf5680d78bdbaa4309412b3d19dfd'
    AND md5(pg_get_functiondef('public.fn_take_seat_and_buy_in(uuid,integer)'::regprocedure))
      ='a965493d4837187d433b3cdd40c5da81'
    AND md5(pg_get_functiondef('public.fn_caller_session_is_live()'::regprocedure))
      ='23ffeea99f9d9e76102ecbf6185222c0', 'captured current entry/session/bank endpoints');
  FOREACH relation_name IN ARRAY ARRAY['clubs','unions','union_clubs','union_creators',
    'club_members','chip_ledger','chip_transactions','wallet_transactions','ca_mint_ledger',
    'ca_mint_policy','ca_chip_store_coverage','spin_fill_policy','tournaments','tables',
    'table_seats','tournament_players','tournament_escrow','tournament_refund_entitlements',
    'tournament_refund_tranches','tournament_refund_authorizations','tournament_obligations',
    'tournament_cancellation_receipts','tournament_tickets','spin_bonus_pools',
    'spin_reserve_ledger','spin_draw_receipts','tournament_launch_receipts','hand_history',
    'tournament_spin_cancellation_unwinds','rake_records','wallet_credit_idempotency'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',relation_name) INTO occupied;
    PERFORM pg_temp.spin_q_assert(NOT occupied,'nonempty initial relation: '||relation_name);
  END LOOP;
END $admission$;

-- Exact current chip_treasury/player_wallet/mint/prize_liability policy inputs.
\ir ../../inputs/captured-financial-store-policy.sql
INSERT INTO public.ca_mint_policy(id,per_operation_cap_chips,rolling_24h_cap_chips,
  per_operation_cap_diamonds,rolling_24h_cap_diamonds,note)
VALUES(1,100,100,1,1,'Isolated Spin expiry qualification: one genuine 100-chip Mint');
-- Root-approved private positive policy. Real joined_at values remain untouched.
INSERT INTO public.spin_fill_policy(id,unfilled_timeout_minutes) VALUES(true,1);
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','service_role')::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true),
  set_config('request.jwt.claim.role','service_role',true) FROM spin_q_inputs;
INSERT INTO public.union_creators(user_id,note)
SELECT owner_user,'Isolated real-funded Spin qualification' FROM spin_q_inputs;
INSERT INTO public.unions(id,name,owner_id,slug,chip_balance,rake_wallet,bbj_wallet,promo_wallet,total_rake)
SELECT execution,'Spin expiry qualification '||execution,owner_user,'spin-expiry-'||execution,
  0,0,0,0,0 FROM spin_q_inputs;
-- The proven Union host path has no opening grant; no money is directly seeded.
INSERT INTO public.clubs(id,name,owner_id,is_union,chip_treasury,chip_pool,asset)
SELECT execution,'Spin expiry host '||execution,owner_user,true,0,0,'chips' FROM spin_q_inputs;
INSERT INTO public.union_clubs(union_id,club_id) SELECT execution,execution FROM spin_q_inputs;
SELECT set_config('app.club_membership_source','join_club',true);
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
SELECT q.execution,u.id,'player','active',0 FROM spin_q_inputs q
CROSS JOIN LATERAL (VALUES(q.owner_user),(q.player1),(q.player2)) u(id);
SELECT set_config('app.club_membership_source','',true);
INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after)
SELECT u.session_id,u.user_id,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'
FROM spin_q_inputs q CROSS JOIN LATERAL
  (VALUES(q.owner_session,q.owner_user),(q.session1,q.player1),(q.session2,q.player2)) u(session_id,user_id);
GRANT SELECT ON spin_q_inputs TO service_role,authenticated;
GRANT INSERT ON spin_q_calls TO service_role,authenticated;
SELECT pg_temp.spin_q_assert((SELECT count(*)=1 AND bool_and((chip_treasury=0 AND chip_pool=0) IS TRUE)
  FROM public.clubs) AND (SELECT count(*)=3 AND bool_and(chip_balance IS NOT DISTINCT FROM 0) FROM public.club_members)
  AND NOT EXISTS(SELECT 1 FROM public.chip_ledger) AND NOT EXISTS(SELECT 1 FROM public.ca_mint_ledger),
  'structural setup must not mint, credit or debit anything');
COMMIT;
SELECT pg_temp.spin_q_assert((SELECT count(*)=3 FROM auth.sessions)
  AND (SELECT count(*)=3 FROM spin_q_inputs q CROSS JOIN LATERAL
    (VALUES(q.owner_session,q.owner_user),(q.session1,q.player1),(q.session2,q.player2)) expected(sid,uid)
    JOIN auth.sessions s ON s.id=expected.sid AND s.user_id=expected.uid
    WHERE s.not_after>clock_timestamp() AND s.created_at>=q.preparation_started_at),
  'three committed live sessions belong to their exact synthetic principals');
SELECT jsonb_build_object('stage','structural_setup_committed','execution',execution,
  'tournament',tournament,'club',execution,'owner',owner_user,'players',jsonb_build_array(player1,player2))
FROM spin_q_inputs;

SELECT jsonb_build_object('stage','mint_intent','execution',execution,'idempotency_key','spin-expiry-fixture:'||execution)
FROM spin_q_inputs;
BEGIN;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','service_role')::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true),
  set_config('request.jwt.claim.role','service_role',true) FROM spin_q_inputs;
SET LOCAL ROLE service_role;
INSERT INTO spin_q_calls SELECT 'mint',public.fn_ca_mint('chips','club',execution,100,
  'Isolated Spin expiry qualification','spin-expiry-fixture:'||execution,'admin') FROM spin_q_inputs;
RESET ROLE;
SELECT pg_temp.spin_q_assert((SELECT result->>'ok'='true' AND result->>'replayed'='false'
  AND (result->>'balance_before')::numeric=0 AND (result->>'balance_after')::numeric=100
  FROM spin_q_calls WHERE stage='mint'),'real Mint response');
COMMIT;
SELECT pg_temp.spin_q_assert((SELECT count(*)=1 AND sum(amount)=100 FROM public.ca_mint_ledger)
  AND (SELECT count(*)=1 FROM public.ca_mint_ledger m JOIN public.chip_ledger l ON l.id=m.chip_ledger_id
    JOIN spin_q_inputs q ON m.holder_id=q.execution JOIN spin_q_calls c ON c.stage='mint'
    WHERE m.op_id='spin-expiry-fixture:'||q.execution AND m.action='mint' AND m.asset='chips'
      AND m.holder_type='club' AND m.amount=100 AND m.balance_before=0 AND m.balance_after=100
      AND l.id=(c.result->>'ledger_id')::uuid AND l.idempotency_key='mint:'||m.op_id
      AND l.category='mint' AND l.from_type='issuance_reserve' AND l.to_type='club_treasury'
      AND l.to_entity_id=q.execution AND l.status='posted' AND l.amount=100)
  AND (SELECT count(*)=1 AND sum(amount)=100 AND bool_and((status='posted') IS TRUE) FROM public.chip_ledger)
  AND (SELECT count(*)=1 FROM public.chip_transactions c JOIN spin_q_inputs q ON c.club_id=q.execution
    WHERE c.transaction_type='treasury_mint' AND c.from_user_id=q.owner_user
      AND c.to_user_id IS NULL AND c.amount=100 AND c.balance_after=100)
  AND (SELECT count(*)=1 FROM public.chip_transactions)
  AND (SELECT chip_treasury=100 FROM public.clubs)
  AND (SELECT count(*)=3 AND bool_and(chip_balance IS NOT DISTINCT FROM 0) FROM public.club_members),
  'committed real issuance and still-empty wallets');
SELECT jsonb_build_object('stage','mint_committed','receipt',result) FROM spin_q_calls WHERE stage='mint';

-- Read-only assertion over an actual bank request, never a replacement writer.
CREATE FUNCTION pg_temp.spin_q_bank_receipt(stage_name text,recipient uuid,operation uuid,remaining numeric)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE response jsonb; q record;
BEGIN
  SELECT * INTO STRICT q FROM spin_q_inputs;
  SELECT result INTO STRICT response FROM spin_q_calls WHERE stage=stage_name;
  PERFORM pg_temp.spin_q_assert(response->>'success'='true' AND response->>'replayed'='false'
    AND response->>'op_id'=operation::text AND response->>'destination'='player_wallet'
    AND (response->>'amount')::numeric=1 AND (response->>'bank_before')::numeric=remaining+1
    AND (response->>'bank_after')::numeric=remaining AND (response->>'recipient_balance_after')::numeric=1,
    stage_name||' fresh response');
  PERFORM pg_temp.spin_q_assert((SELECT count(*)=1 FROM public.chip_transactions
    WHERE id=(response->>'transaction_id')::uuid AND club_id=q.execution
      AND from_user_id=q.owner_user AND to_user_id=recipient AND amount=1
      AND transaction_type='club_bank_send' AND metadata->>'op_id'=operation::text
      AND metadata->>'destination'='player_wallet' AND balance_after=remaining)
    AND (SELECT count(*)=1 FROM public.chip_transactions WHERE metadata->>'op_id'=operation::text)
    AND (SELECT count(*)=1 FROM public.chip_ledger WHERE correlation_id=operation
      AND idempotency_key='club_bank_send:'||operation AND club_id=q.execution
      AND from_type='club_treasury' AND from_entity_id=q.execution
      AND to_type='player_wallet' AND to_entity_id=recipient AND category='club_bank_send'
      AND status='posted' AND amount=1)
    AND (SELECT count(*)=1 FROM public.chip_ledger WHERE correlation_id=operation)
    AND (SELECT chip_treasury=remaining FROM public.clubs WHERE id=q.execution)
    AND (SELECT chip_balance=1 FROM public.club_members WHERE club_id=q.execution AND user_id=recipient),
    stage_name||' committed transaction, exact journal and wallet');
END$$;

SELECT jsonb_build_object('stage','bank1_intent','execution',execution,'operation',bank1,'recipient',player1)
FROM spin_q_inputs;
BEGIN;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','authenticated','session_id',owner_session)::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true),set_config('request.jwt.claim.role','authenticated',true)
FROM spin_q_inputs;
SET LOCAL ROLE authenticated;
SELECT pg_temp.spin_q_assert(auth.uid()=(SELECT owner_user FROM spin_q_inputs)
  AND auth.role()='authenticated' AND public.fn_caller_session_is_live()
  AND NOT public.fn_caller_is_engine(),'bank1 genuine authenticated owner session');
INSERT INTO spin_q_calls SELECT 'bank1',public.fn_club_bank_send(execution,player1,1,'player_wallet',
  'Isolated Spin expiry paid-entry capital',bank1) FROM spin_q_inputs;
RESET ROLE;
COMMIT;
SELECT pg_temp.spin_q_bank_receipt('bank1',player1,bank1,99) FROM spin_q_inputs;
SELECT jsonb_build_object('stage','bank1_committed','receipt',result) FROM spin_q_calls WHERE stage='bank1';

SELECT jsonb_build_object('stage','bank2_intent','execution',execution,'operation',bank2,'recipient',player2)
FROM spin_q_inputs;
BEGIN;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','authenticated','session_id',owner_session)::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true),set_config('request.jwt.claim.role','authenticated',true)
FROM spin_q_inputs;
SET LOCAL ROLE authenticated;
SELECT pg_temp.spin_q_assert(auth.uid()=(SELECT owner_user FROM spin_q_inputs)
  AND auth.role()='authenticated' AND public.fn_caller_session_is_live()
  AND NOT public.fn_caller_is_engine(),'bank2 genuine authenticated owner session');
INSERT INTO spin_q_calls SELECT 'bank2',public.fn_club_bank_send(execution,player2,1,'player_wallet',
  'Isolated Spin expiry paid-entry capital',bank2) FROM spin_q_inputs;
RESET ROLE;
COMMIT;
SELECT pg_temp.spin_q_bank_receipt('bank2',player2,bank2,98) FROM spin_q_inputs;
SELECT pg_temp.spin_q_assert((SELECT count(*)=3 AND sum(amount)=102 FROM public.chip_ledger)
  AND (SELECT count(*)=3 AND sum(amount)=102 FROM public.chip_transactions)
  AND (SELECT count(*)=3 AND sum(chip_balance)=2 FROM public.club_members),
  'one Mint and exactly two genuine bank transfers');
SELECT jsonb_build_object('stage','bank2_committed','receipt',result) FROM spin_q_calls WHERE stage='bank2';

SELECT jsonb_build_object('stage','creator_intent','execution',execution,'tournament',tournament) FROM spin_q_inputs;
BEGIN;
CREATE TEMP TABLE spin_q_create_config AS SELECT jsonb_build_object(
  'club_id',execution,'union_id',NULL,'name','Spin expiry qualification '||execution,
  'game_type','NLH','variant','spin','tournament_type','SPIN','buy_in_amount',1,'buy_in_fee',0,
  'guaranteed_prize',0,'starting_chips',1000,'max_players',3,'min_players',3,'table_size',3,
  'current_players',0,'status','REGISTERING',
  'blind_structure',jsonb_build_array(jsonb_build_object('level',1,'smallBlind',10,'bigBlind',20,'ante',0,'duration',180)),
  'payout_structure',jsonb_build_array(jsonb_build_object('place',1,'percentage',100)),
  'start_time',clock_timestamp()+interval '1 day','late_reg_levels',0,'late_reg_mins',0,
  'satellite_target_id',NULL,'satellite_seats',NULL,'short_description',NULL,
  'spin_multiplier',NULL,'spin_locked_tiers',NULL) config FROM spin_q_inputs;
GRANT SELECT ON spin_q_create_config TO service_role;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','service_role')::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true),set_config('request.jwt.claim.role','service_role',true)
FROM spin_q_inputs;
SET LOCAL ROLE service_role;
INSERT INTO spin_q_calls SELECT 'create',public.fn_create_seat_first_game_atomic(q.tournament,c.config)
FROM spin_q_inputs q CROSS JOIN spin_q_create_config c;
RESET ROLE;
SELECT pg_temp.spin_q_assert((SELECT result->>'ok'='true' AND result->>'replayed'='false'
  AND result->'tournament'->>'id'=(SELECT tournament::text FROM spin_q_inputs)
  AND result->>'table_id' IS NOT NULL FROM spin_q_calls WHERE stage='create'),'canonical fresh creator response');
COMMIT;
CREATE TEMP TABLE spin_q_table AS SELECT (result->>'table_id')::uuid id FROM spin_q_calls WHERE stage='create';
GRANT SELECT ON spin_q_table TO authenticated;
SELECT pg_temp.spin_q_assert((SELECT count(*)=1 FROM public.tournaments t JOIN spin_q_inputs q ON t.id=q.tournament
  WHERE t.club_id=q.execution AND t.union_id IS NULL AND t.variant='spin' AND t.status='REGISTERING'
    AND t.started_at IS NULL AND t.max_players=3 AND t.buy_in_amount=1 AND t.buy_in_fee=0)
  AND (SELECT count(*)=1 FROM public.tournaments)
  AND (SELECT count(*)=1 FROM public.tables b JOIN spin_q_table x ON b.id=x.id
    WHERE b.tournament_id=(SELECT tournament FROM spin_q_inputs) AND b.status='waiting' AND b.max_players=3)
  AND (SELECT count(*)=1 FROM public.tables)
  AND public.fn_poker_diamond_tournament((SELECT tournament FROM spin_q_inputs)) IS FALSE,
  'committed single ordinary-chip parent/table pair');
SELECT jsonb_build_object('stage','creator_committed','receipt',result) FROM spin_q_calls WHERE stage='create';

-- The per-seat observation binds the genuine purchase, not merely an RPC flag.
CREATE FUNCTION pg_temp.spin_q_paid_receipt(stage_name text,player uuid,seat_no integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE response jsonb; q record; table_id_value uuid;
BEGIN
  SELECT * INTO STRICT q FROM spin_q_inputs;
  SELECT id INTO STRICT table_id_value FROM spin_q_table;
  SELECT result INTO STRICT response FROM spin_q_calls WHERE stage=stage_name;
  PERFORM pg_temp.spin_q_assert(response->>'ok'='true' AND response->>'table_id'=table_id_value::text
    AND (response->>'seat_number')::integer=seat_no AND (response->>'stack')::numeric=1000
    AND response->>'seat_reserved'='true' AND (response->>'seats_taken')::integer=seat_no
    AND (response->>'seats_needed')::integer=3 AND response->>'starts_now'='false'
    AND (response->>'cost')::numeric=1 AND response->>'asset'='chips',stage_name||' fresh paid-seat response');
  PERFORM pg_temp.spin_q_assert((SELECT count(*)=1 FROM public.table_seats s WHERE s.table_id=table_id_value
      AND s.user_id=player AND s.seat_number=seat_no AND s.stack=1000 AND s.left_at IS NULL
      AND s.joined_at>=q.preparation_started_at AND s.joined_at<=clock_timestamp())
    AND (SELECT count(*)=1 FROM public.tournament_players WHERE tournament_id=q.tournament AND user_id=player)
    AND (SELECT chip_balance=0 FROM public.club_members WHERE club_id=q.execution AND user_id=player)
    AND (SELECT count(*)=1 FROM public.tournament_refund_entitlements e JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      WHERE e.tournament_id=q.tournament AND e.user_id=player AND e.entitlement_kind='wallet_charge'
        AND e.registration_id IS NULL AND e.charge_category='tournament_buyin'
        AND e.refund_wallet_club_id=q.execution AND e.gross=1 AND e.refund_prize=1
        AND e.refund_bounty=0 AND e.refund_fee=0 AND l.tournament_id=q.tournament
        AND l.club_id=q.execution AND l.from_type='player_wallet' AND l.from_entity_id=player
        AND l.to_type='prize_liability' AND l.to_entity_id=q.tournament
        AND l.category='tournament_buyin' AND l.status='posted' AND l.amount=1)
    AND (SELECT count(*)=1 FROM public.wallet_transactions WHERE user_id=player
      AND related_entity_id=q.tournament AND wallet_type='PLAYER' AND type='debit'
      AND category='tournament_buyin' AND amount=1 AND balance_after=0),
    stage_name||' committed seat, roster, wallet debit and paid entitlement');
END$$;

SELECT jsonb_build_object('stage','seat1_intent','execution',execution,'user',player1,'session',session1,
  'table',(SELECT id FROM spin_q_table),'seat',1) FROM spin_q_inputs;
BEGIN;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',player1,'role','authenticated','session_id',session1)::text,true),
  set_config('request.jwt.claim.sub',player1::text,true),set_config('request.jwt.claim.role','authenticated',true)
FROM spin_q_inputs;
SET LOCAL ROLE authenticated;
SELECT pg_temp.spin_q_assert(auth.uid()=(SELECT player1 FROM spin_q_inputs) AND auth.role()='authenticated'
  AND public.fn_caller_session_is_live() AND NOT public.fn_caller_is_engine(),'seat1 actual authenticated live session');
INSERT INTO spin_q_calls SELECT 'seat1',public.fn_take_seat_and_buy_in(id,1) FROM spin_q_table;
RESET ROLE;
COMMIT;
SELECT pg_temp.spin_q_paid_receipt('seat1',player1,1) FROM spin_q_inputs;
SELECT jsonb_build_object('stage','seat1_committed','receipt',result) FROM spin_q_calls WHERE stage='seat1';

SELECT jsonb_build_object('stage','seat2_intent','execution',execution,'user',player2,'session',session2,
  'table',(SELECT id FROM spin_q_table),'seat',2) FROM spin_q_inputs;
BEGIN;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',player2,'role','authenticated','session_id',session2)::text,true),
  set_config('request.jwt.claim.sub',player2::text,true),set_config('request.jwt.claim.role','authenticated',true)
FROM spin_q_inputs;
SET LOCAL ROLE authenticated;
SELECT pg_temp.spin_q_assert(auth.uid()=(SELECT player2 FROM spin_q_inputs) AND auth.role()='authenticated'
  AND public.fn_caller_session_is_live() AND NOT public.fn_caller_is_engine(),'seat2 actual authenticated live session');
INSERT INTO spin_q_calls SELECT 'seat2',public.fn_take_seat_and_buy_in(id,2) FROM spin_q_table;
RESET ROLE;
COMMIT;
SELECT pg_temp.spin_q_paid_receipt('seat2',player2,2) FROM spin_q_inputs;
SELECT jsonb_build_object('stage','seat2_committed','receipt',result) FROM spin_q_calls WHERE stage='seat2';

-- Independent committed state, after all deferred financial guards have run.
BEGIN READ ONLY;
SELECT pg_temp.spin_q_assert((SELECT count(*)=1 AND bool_and((id AND unfilled_timeout_minutes=1) IS TRUE)
  FROM public.spin_fill_policy) AND (SELECT count(*)=2 FROM public.table_seats)
  AND (SELECT count(*)=2 FROM public.tournament_players)
  AND (SELECT count(*)=2 AND count(DISTINCT user_id)=2 AND count(DISTINCT source_ledger_id)=2
    FROM public.tournament_refund_entitlements)
  AND (SELECT count(*)=2 FROM public.wallet_transactions)
  AND (SELECT count(*)=5 AND bool_and((status='posted') IS TRUE) FROM public.chip_ledger)
  AND (SELECT count(*)=5 FROM public.chip_transactions)
  AND (SELECT count(*)=2 AND count(DISTINCT c.from_user_id)=2 FROM public.chip_transactions c
    CROSS JOIN spin_q_inputs q WHERE c.club_id=q.execution AND c.from_user_id IN(q.player1,q.player2)
      AND c.transaction_type='tournament_buyin' AND c.amount=1)
  AND (SELECT count(*)=3 AND bool_and(chip_balance IS NOT DISTINCT FROM 0) FROM public.club_members)
  AND (SELECT chip_treasury=98 AND chip_pool=0 FROM public.clubs)
  AND (SELECT status='REGISTERING' AND started_at IS NULL AND current_players=2 AND prize_pool=2
    AND bounty_pool=0 AND total_rake=0 AND COALESCE(spin_multiplier,0)=0 FROM public.tournaments)
  AND (SELECT status='waiting' AND current_players=2 FROM public.tables),
  'exact supported two-paid-seat topology and committed conservation');
SELECT pg_temp.spin_q_assert((SELECT count(*)=1 AND bool_and((enforced AND closed_at IS NULL
  AND terminal_closed_at IS NULL AND gross_in=2 AND prize_balance=2 AND bounty_balance=0 AND fee_balance=0
  AND fee_entries_in=0 AND satellite_fee_in=0 AND bounty_in=0 AND overlay_in=0 AND satellite_in=0
  AND prize_out=0 AND bounty_out=0 AND fee_out=0 AND refund_prize=0 AND refund_bounty=0 AND refund_fee=0
  AND reserve_out=0 AND reserve_in=0) IS TRUE) FROM public.tournament_escrow),
  'exact open ordinary wallet-charge escrow; 98 treasury + 2 prize liability = 100 Mint');
DO $no_history$
DECLARE relation_name text; occupied boolean;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['tournament_refund_tranches','tournament_refund_authorizations',
    'tournament_obligations','tournament_cancellation_receipts','tournament_tickets',
    'spin_reserve_ledger','spin_draw_receipts','tournament_launch_receipts','hand_history',
    'tournament_spin_cancellation_unwinds','rake_records','wallet_credit_idempotency'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',relation_name) INTO occupied;
    PERFORM pg_temp.spin_q_assert(NOT occupied,'unexpected history: '||relation_name);
  END LOOP;
  PERFORM pg_temp.spin_q_assert(NOT EXISTS(
    (SELECT tgrelid,tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal
     EXCEPT SELECT * FROM spin_q_trigger_modes)
    UNION ALL (SELECT * FROM spin_q_trigger_modes
     EXCEPT SELECT tgrelid,tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal)),
    'all original trigger identities/enabled states preserved, including captured disabled modes');
END $no_history$;
SELECT jsonb_build_object('stage','funded_fixture_committed_observation','execution',q.execution,
  'tournament',q.tournament,'club',q.execution,'owner',q.owner_user,
  'players',jsonb_build_array(q.player1,q.player2),'table',(SELECT id FROM spin_q_table),
  'preparation_started_at',q.preparation_started_at,'observed_at',clock_timestamp(),
  'policy_minutes',1,'required_wait_after_final_commit_seconds',65,
  'age_eligibility_proven',false,'financial_business_qualification_passed',false,
  'request_receipts',(SELECT jsonb_object_agg(stage,result ORDER BY stage) FROM spin_q_calls),
  'seats',(SELECT jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'seat_number',seat_number,
    'joined_at',joined_at,'left_at',left_at,'stack',stack) ORDER BY seat_number) FROM public.table_seats),
  'entitlements',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.tournament_refund_entitlements e),
  'source_journals',(SELECT jsonb_agg(jsonb_build_object('id',id,'category',category,'status',status,
    'amount',amount,'from_type',from_type,'from_entity_id',from_entity_id,'to_type',to_type,
    'to_entity_id',to_entity_id,'idempotency_key',idempotency_key,'correlation_id',correlation_id)
    ORDER BY id) FROM public.chip_ledger),
  'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e)) FROM spin_q_inputs q;
COMMIT;
SELECT jsonb_build_object('stage','fixture_final_commit_observed','execution',execution,
  'tournament',tournament,'observed_at',clock_timestamp(),'required_wait_seconds',65,
  'next','parent finite natural-aging wait, then unchanged admitted expiry qualifier') FROM spin_q_inputs;
