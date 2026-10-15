-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='f24bac9808f16258b30ee227427dabcc' AND md5(pg_get_functiondef('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)'::regprocedure))='8a625319f1aeeef9446feabff82262ef' AND (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid='public.accounting_close_partials'::regclass AND c.conname='accounting_close_partials_kind_check') LIKE '%''pnl_flows_window''::text%')
-- 20261015061812_the_week_s_original_flows_are_proved_two_hours_at_a_time.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- After 20261015021138 the original week (union fade0000, 2026-10-05 ->
-- 2026-10-12) committed its closing boundary at 02:38:56 UTC (attempt 76) and
-- then made no progress: every job 272 visit from 02:40 to 06:09 UTC (26 in a
-- row) was cancelled by the 240 s statement timeout and rolled back.
--
-- Measured read-only on production, 2026-10-15:
--   * The opening and closing boundaries, the 84 earned-plan windows and the
--     earned plan are all cached for this generation; the next uncached step
--     of fn_union_pnl_evidence_report is the week's original money flows
--     (fn_union_pnl_original_flow_evidence over the whole week): 814,510
--     flows, 1.1 GB of rows, 162 s for that one statement on its own, with
--     2.0 GB of temporary files (1,073,741,824 + 1,006,069,532 bytes).
--   * Every cancelled visit (02:44, 04:09, ..., 06:09) died holding exactly
--     those two temporary files: it was inside the flow proof.
--   * Before the flow proof an attempt spends about 17 s (cash source
--     refusals 14 s, boundary and window cache reads, hand counts), and the
--     tick first selects scopes (40 s in its cursor form) and visits the
--     Deep Stack Society scope (finished at 06:05:44 in the 06:05 tick).
--     The 06:05 tick's union attempt therefore began about 60 s into the
--     240 s statement and was still in the flow proof when it was cancelled.
--   * The flows are the one whole-week step with no chunking: the boundaries
--     are each one statement of about 2 minutes, the earned plan is proved
--     two hours at a time, but the flows had to be proved, aggregated into a
--     190 MB certificate and written within one attempt, so the attempt that
--     reached them could never commit.
--
-- The fix is where the wrong unit of work was chosen. The flow proof derives
-- each flow's evidence from that flow's own row (its receipts, frames, seat
-- events and entitlements) and from the week's bounds; nothing in it depends
-- on which other flows are proved alongside it. So
-- smarter_private.union_pnl_original_flow_evidence_window is the week proof
-- with one added predicate (the flow's recognized_at inside one plan window)
-- and without the two whole-week return families, which stay whole-week.
-- fn_accounting_union_earned_plan_advance, which the report already calls
-- right after the opening boundary, now proves the week's flows window by
-- window after the earned-plan windows (partials kind 'pnl_flows_window', the
-- same 12 h freshness, a window that found a problem re-proved after 1 h like
-- the report's problem steps), and once every window is fresh assembles the
-- windows' flows and the two return families into the certificate the report
-- reads ('pnl_flows' or 'pnl_flows_problem', through
-- smarter_private.inventory_basis_cache_write, for the same generation), in an
-- attempt of its own. The report then reads that certificate exactly as it
-- reads one it proved itself.
--
-- Production, read-only, 2026-10-15: the 84 windows plus the two return
-- families give the same rows as the whole-week proof (count, multiset hash
-- and invalid count; see the changelog).
--
-- The windowing runs only while the report and the week proof are the
-- reviewed definitions (exact md5 checked on every call), so the window proof
-- can never drift from the proof it partitions; otherwise the advance returns
-- true and the report proves the week itself, as before. Every proving loop
-- also stops a minute before the statement's own timeout, not only 120 s
-- after the attempt began, because an attempt can begin late in its tick.
--
-- Nothing is paid, cleared or rewritten: partials and certificates are the
-- close's own caches, and the money rounds are unchanged.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'flow_windows_operator_refused' USING ERRCODE='42501';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'flow_windows_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'flow_windows_freeze_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'flow_windows_reader_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015061812') THEN RAISE EXCEPTION 'flow_windows_history_replay';END IF;
END $guard$;

DO $preimage$BEGIN
 IF md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'42d6add347b1b942aa79c95d0ec169c7' THEN RAISE EXCEPTION 'flow_windows_advance_preimage_refused';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'09745f78c6cc2ae57f403419020fd1ab' THEN RAISE EXCEPTION 'flow_windows_week_proof_preimage_refused';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'edecfc5273ee4c96b608baa0ea863578' THEN RAISE EXCEPTION 'flow_windows_report_preimage_refused';END IF;
 IF to_regprocedure('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)') IS NOT NULL THEN RAISE EXCEPTION 'flow_windows_window_proof_exists';END IF;
 IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid='public.accounting_close_partials'::regclass AND c.conname='accounting_close_partials_kind_check')
  IS DISTINCT FROM $c$CHECK ((kind = ANY (ARRAY['earned_plan_window'::text, 'round2_union_window'::text, 'round2_club_window'::text, 'round3_union_window'::text, 'round3_club_window'::text, 'round3_union_plan'::text, 'round3_club_plan'::text])))$c$ THEN RAISE EXCEPTION 'flow_windows_partial_kinds_preimage_refused';END IF;
END $preimage$;

ALTER TABLE public.accounting_close_partials DROP CONSTRAINT accounting_close_partials_kind_check,
 ADD CONSTRAINT accounting_close_partials_kind_check CHECK (kind = ANY (ARRAY['earned_plan_window'::text, 'round2_union_window'::text, 'round2_club_window'::text, 'round3_union_window'::text, 'round3_club_window'::text, 'round3_union_plan'::text, 'round3_club_plan'::text, 'pnl_flows_window'::text]));

-- The week proof of public.fn_union_pnl_original_flow_evidence (md5
-- 09745f78c6cc2ae57f403419020fd1ab), byte for byte, with exactly two changes:
-- the originals predicate on p_window_start and p_window_end, and without the
-- week proof's two closing UNION ALL return families, which the advance adds
-- once for the week.
CREATE FUNCTION smarter_private.union_pnl_original_flow_evidence_window(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_window_start timestamp with time zone, p_window_end timestamp with time zone)
 RETURNS TABLE(ledger_id uuid, club_id uuid, user_id uuid, buyins numeric, cashouts numeric, kind text, valid boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH originals AS MATERIALIZED (
  SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id
  FROM public.union_pnl_original_flows q WHERE q.game_scope->>'game_union_id'=p_union_id::text
   AND q.recognized_at>=p_start AND q.recognized_at<p_end
   AND q.recognized_at>=p_window_start AND q.recognized_at<p_window_end
 ), rf_original_keys AS MATERIALIZED (
  SELECT DISTINCT q.transaction_id,(q.l->>'table_id')::uuid table_id,
   (q.l->>'club_id')::uuid club_id,(q.l->>'to_entity_id')::uuid user_id,(q.l->>'amount')::numeric amount
  FROM originals q
  WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
   AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
 ), rf_original_matches AS MATERIALIZED (
  SELECT k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount,count(*) refunds,
   min(o.funding_club_id::text)::uuid club,min(o.user_id::text)::uuid player
  FROM rf_original_keys k
  JOIN public.cash_funding_application_receipts a ON a.transaction_id=k.transaction_id
   AND a.refunded>0 AND a.refunded=k.amount
  JOIN public.cash_participant_funding_receipts o ON o.id=a.funding_receipt_id
  WHERE a.pending_addon_id IS NOT DISTINCT FROM o.pending_addon_id AND a.original_occupancy_id=o.occupancy_id
   AND o.table_id=k.table_id AND o.account_type='player_wallet' AND o.account_entity_id=k.user_id
   AND o.funding_club_id=k.club_id AND o.user_id=k.user_id
  GROUP BY k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount
 ), matched AS (
  SELECT q.*,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user,mv.moved_club,mv.moved_user,
   COALESCE(rf.refunds,0) refunds,rf.club refund_club,rf.player refund_user,te.refund_ent,te.refund_ent_user,te.refund_ent_club,late.n late_count,late.club late_club,late.player late_user,late.delta late_delta
  FROM originals q
  LEFT JOIN LATERAL (
   SELECT count(*) n,min(p.club_id::text)::uuid club,min(p.user_id::text)::uuid player,min(p.delta) delta
   FROM (SELECT q.ledger_id WHERE q.tournament_id IS NULL
    AND q.l->>'category'='settlement' AND q.l->>'idempotency_key' LIKE 'late_seat_settle:%' OFFSET 0) eligible
   CROSS JOIN LATERAL public.fn_union_pnl_prove_late_settlement(eligible.ledger_id) p
  ) late ON true
  -- One-time filter (20261001): a probe only for the flows that can match.
  LEFT JOIN LATERAL (SELECT f.* FROM public.cash_participant_funding_receipts f
   WHERE q.tournament_id IS NULL AND f.source_ledger_id=q.ledger_id OFFSET 0) f ON true
  LEFT JOIN LATERAL (SELECT e.* FROM public.tournament_participant_funding_receipts e
   WHERE q.tournament_id IS NOT NULL AND e.ledger_id=q.ledger_id AND e.asset='chips' AND q.tournament_id=e.tournament_id OFFSET 0) e ON true
  -- fn_union_pnl_tournament_returns(q.tournament_id,NULL,p_start,p_end) for
  -- this flow's ledger only: its two branches verbatim, keyed by the ledger.
  LEFT JOIN LATERAL (
   SELECT c.ledger_id,c.tournament_id,c.user_id,c.credited_club_id,c.amount
   FROM public.tournament_accounting_credit_receipts c
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
   WHERE q.tournament_id IS NOT NULL AND c.ledger_id=q.ledger_id AND c.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
   UNION ALL
   SELECT t.credit_ledger_id,t.tournament_id,t.user_id,t.source_wallet_club_id,t.amount_paid_now
   FROM public.tournament_refund_tranches t
   JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=t.entitlement_id
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=t.transaction_id
   WHERE q.tournament_id IS NOT NULL AND t.credit_ledger_id=q.ledger_id AND t.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
    AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c2 WHERE c2.ledger_id=t.credit_ledger_id)
  ) c ON true
  LEFT JOIN LATERAL (
   SELECT count(DISTINCT (r.funding_club_id,r.user_id)) owners,min(r.funding_club_id::text)::uuid funding_club_id,min(r.user_id::text)::uuid user_id
   FROM public.cash_participant_funding_receipts r
   WHERE r.table_id=(q.l->>'table_id')::uuid AND r.operation_kind='buyin'
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid
    AND r.funding_club_id=(q.l->>'club_id')::uuid
    AND (EXISTS(SELECT 1 FROM public.union_pnl_inventory_events i WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats'
      AND COALESCE(i.after_row,i.before_row)->>'occupancy_id'=r.occupancy_id::text
      AND COALESCE(i.after_row,i.before_row)->>'table_id'=r.table_id::text)
     OR EXISTS(SELECT 1 FROM public.cash_funding_application_receipts a JOIN public.cash_participant_funding_receipts original ON original.id=a.funding_receipt_id
       WHERE a.transaction_id=q.transaction_id AND original.occupancy_id=r.occupancy_id AND a.refunded=(q.l->>'amount')::numeric))
  ) ret ON true
  -- A seat cashed out after it arrived by a table move holds chips whose
  -- original buy-in is on the source occupancy, not this one. The occupancy
  -- the cash-out vacated (its seat row in the same original transaction,
  -- carrying exactly the cashed-out stack) is traced through its move receipts
  -- by fn_cash_original_funding_lineage, the proof the boundaries and hands
  -- already use; the owner is its one original buy-in's club and player.
  LEFT JOIN LATERAL (
   SELECT CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.club END moved_club,
    CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.player END moved_user
   FROM (SELECT min(i.before_row::text)::jsonb seat,count(*) n FROM public.union_pnl_inventory_events i
     WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
      AND ret.owners IS DISTINCT FROM 1
      AND i.transaction_id=q.transaction_id AND i.source_name='table_seats' AND i.before_row->>'table_id'=q.l->>'table_id'
      AND i.before_row->>'user_id'=q.l->>'to_entity_id' AND i.before_row->'left_at'='null'::jsonb
      AND i.after_row->>'left_at' IS NOT NULL) s
   CROSS JOIN LATERAL (SELECT public.fn_cash_original_funding_lineage((s.seat->>'user_id')::uuid,(s.seat->>'table_id')::uuid,(s.seat->>'id')::uuid,
     (s.seat->>'occupancy_id')::uuid,(s.seat->>'joined_at')::timestamptz,q.recognized_at,false) v) lin
   CROSS JOIN LATERAL (SELECT count(*) receipts,count(*) FILTER(WHERE r.operation_kind='buyin') buyins,count(DISTINCT r.funding_club_id) clubs,
     count(DISTINCT r.user_id) users,min(r.funding_club_id::text)::uuid club,min(r.user_id::text)::uuid player
    FROM jsonb_array_elements(lin.v->'funding_receipts') ref JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid) own
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet' AND ret.owners IS DISTINCT FROM 1
    AND s.n=1 AND public.fn_pnl_evidence_cents(s.seat->'stack') IS NOT DISTINCT FROM (q.l->>'amount')::numeric
  ) mv ON true
  -- A pending add-on returned unapplied is a refund of this player's own
  -- escrowed chips. Its wallet credit can carry no refund category: it runs
  -- inside the hand's post-commit obligations, after atomic_distribute_rake
  -- has declared that transaction's ledger context, so the audit labels it
  -- player_funding under the rake settlement. The application receipt
  -- written in the same transaction proves it: exactly one refund of this
  -- amount from a funding receipt of this player, club and table.
  LEFT JOIN LATERAL (
   SELECT r.refunds,r.club,r.player FROM rf_original_matches r
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
    AND r.transaction_id=q.transaction_id AND r.table_id=(q.l->>'table_id')::uuid
    AND r.club_id=(q.l->>'club_id')::uuid AND r.user_id=(q.l->>'to_entity_id')::uuid
    AND r.amount=(q.l->>'amount')::numeric
  ) rf ON true
  -- A seat won in a satellite and later refunded by the target tournament
  -- (cancelled, or the seat released) pays the seat's value back to the
  -- player's wallet from the target's prize liability. That seat was never a
  -- wallet-funded entry of the target, so no tournament credit receipt exists
  -- for it; its proof is the refund entitlement the payout is keyed by: same
  -- tournament, player, wallet club and gross, and the seat's owning club as
  -- resolved from its satellite registration.
  LEFT JOIN LATERAL (
   SELECT t.id refund_ent,t.user_id refund_ent_user,t.refund_wallet_club_id refund_ent_club
   FROM public.tournament_refund_entitlements t
   WHERE q.tournament_id IS NOT NULL AND t.tournament_id=q.tournament_id
    AND q.l->>'idempotency_key'='tourney:'||t.tournament_id::text||':refund-entitlement:'||t.id::text
    AND t.entitlement_kind IN('satellite_seat','wallet_charge') AND t.gross=(q.l->>'amount')::numeric
    AND t.user_id::text=q.l->>'to_entity_id' AND t.refund_wallet_club_id::text=q.l->>'club_id'
    AND q.l->>'from_type'='prize_liability' AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='refund'
    AND CASE t.entitlement_kind
     WHEN 'satellite_seat' THEN public.fn_union_pnl_satellite_seat_owner(t.registration_id,NULL)=t.refund_wallet_club_id
     -- A pre-capture wallet entry refunded by cancellation (20261006154000):
     -- its entitlement's source ledger is the entry proven at the opening
     -- boundary of the refund's own week, for this exact registration, club
     -- and gross.
     WHEN 'wallet_charge' THEN t.source_ledger_id IS NOT NULL AND (SELECT count(*) FROM public.union_pnl_opening_registration_resolutions r
       WHERE r.boundary=public.fn_union_week_start(q.recognized_at) AND r.union_id=p_union_id AND r.tournament_id=t.tournament_id AND r.user_id=t.user_id
        AND r.owning_club_id=t.refund_wallet_club_id AND r.entries=1 AND r.entry_amount=t.gross AND r.returned=0
        AND r.proof_md5=md5(r.proof::text)
        AND r.proof->'entry_ledger' @> jsonb_build_array(jsonb_build_object('ledger_id',t.source_ledger_id::text)))=1
     ELSE false END
  ) te ON true
 ), projected AS (
  SELECT *,CASE WHEN late_count=1 THEN 'cash_late_settlement' WHEN cash_funding_id IS NOT NULL THEN 'cash_funding' WHEN owners=1 OR moved_club IS NOT NULL OR refunds=1 THEN 'cash_return'
    WHEN entry_id IS NOT NULL THEN 'tournament_funding' WHEN credit_id IS NOT NULL OR refund_ent IS NOT NULL THEN 'tournament_return' ELSE 'unsupported' END k,
   COALESCE(late_club,cash_club,CASE WHEN moved_club IS NOT NULL THEN moved_club WHEN owners=1 THEN return_club ELSE refund_club END,entry_club,credit_club,refund_ent_club) owner_club,
   COALESCE(late_user,cash_user,CASE WHEN moved_club IS NOT NULL THEN moved_user WHEN owners=1 THEN return_user ELSE refund_user END,entry_user,credit_user,refund_ent_user) owner_user
  FROM matched
 ) SELECT ledger_id,owner_club,owner_user,
  CASE WHEN k='cash_late_settlement' AND late_delta<0 THEN -late_delta WHEN k IN('cash_funding','tournament_funding') THEN (l->>'amount')::numeric ELSE 0 END,
  CASE WHEN k='cash_late_settlement' AND late_delta>0 THEN late_delta WHEN k IN('cash_return','tournament_return') THEN (l->>'amount')::numeric ELSE 0 END,k,
  (l->>'status'='posted' AND public.fn_pnl_evidence_cents(l->'amount')>0 AND owner_club IS NOT NULL AND owner_user IS NOT NULL
   AND owner_club::text=l->>'club_id' AND game_scope->>'asset'='chips' AND game_scope->'unit_scale'='2'::jsonb
   AND CASE k
    WHEN 'cash_late_settlement' THEN late_count=1 AND abs(late_delta)=(l->>'amount')::numeric
    WHEN 'cash_funding' THEN cash_amount=(l->>'amount')::numeric AND l->>'to_type'='table_stack' AND l->>'category' IN('buyin','rebuy','addon','horse_funding')
    WHEN 'cash_return' THEN (owners=1 OR moved_club IS NOT NULL OR (refunds=1 AND l->>'category'='player_funding')) AND l->>'from_type'='table_stack' AND (l->>'category' IN('cashout','table_cashout','refund')
     OR (l->>'category'='player_funding' AND refunds=1 AND refund_club=owner_club AND refund_user=owner_user))
    WHEN 'tournament_funding' THEN entry_amount=(l->>'amount')::numeric AND l->>'to_type'='prize_liability' AND l->>'category' IN('tournament_buyin','rebuy','addon')
    WHEN 'tournament_return' THEN (credit_amount=(l->>'amount')::numeric OR (credit_id IS NULL AND refund_ent IS NOT NULL)) AND l->>'from_type'='prize_liability' AND l->>'category' IN('tournament_prize','prize','bounty','refund','tournament_refund')
    ELSE false END) IS TRUE
 FROM projected
;
$function$;
ALTER FUNCTION smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;

CREATE TEMP TABLE flow_windows_advance_security ON COMMIT DROP AS
 SELECT concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')) s
 FROM pg_proc p WHERE p.oid='public.fn_accounting_union_earned_plan_advance(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure;

CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_advance(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE w record; r record; began timestamptz; proved boolean:=false;
 stop_at timestamptz; v_generation text; v_bad bigint; v_flows jsonb; v_windows bigint; v_fresh bigint;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR p_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 -- THE STATEMENT'S OWN CLOCK (20261015b): an attempt can begin late in its
 -- tick (job 272 visits other scopes first in the same 240 s statement), so a
 -- proving loop also stops a minute before the statement itself would be
 -- cancelled, not only 120 s after the attempt began.
 stop_at:=began+interval '120 seconds';
 IF current_setting('statement_timeout') NOT IN ('0','0ms') THEN
  stop_at:=LEAST(stop_at,statement_timestamp()+current_setting('statement_timeout')::interval-interval '60 seconds');
 END IF;
 IF public.fn_accounting_close_certificate('earned_plan',p_union_id,p_start,p_end) IS NULL THEN
 DELETE FROM public.accounting_close_partials WHERE computed_at<clock_timestamp()-interval '8 days';
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='earned_plan_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-interval '12 hours');
  IF proved AND clock_timestamp()>stop_at THEN RETURN false; END IF;
  SELECT * INTO r FROM public.fn_accounting_union_earned_plan_window(p_union_id,w.window_start,w.window_end);
  IF NOT FOUND THEN
   -- v3 over the same window refuses exactly what it refuses in the week.
   PERFORM public.fn_accounting_union_earned_plan_v3(p_union_id,w.window_start,w.window_end);
   RAISE EXCEPTION 'union_earned_plan_window_unproved' USING ERRCODE='55000',
    DETAIL=jsonb_build_object('union_id',p_union_id,'period_start',p_start,'period_end',p_end,'window_start',w.window_start,'window_end',w.window_end)::text;
  END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,cash_ids,cash_md5,fee_ids,fee_md5,computed_at)
  VALUES('earned_plan_window',p_union_id,p_start,p_end,w.window_start,w.window_end,r.value,r.cash_ids,r.cash_md5,r.fee_ids,r.fee_md5,clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=EXCLUDED.cash_ids,cash_md5=EXCLUDED.cash_md5,fee_ids=EXCLUDED.fee_ids,fee_md5=EXCLUDED.fee_md5,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 -- PROVING WINDOWS IS A WHOLE ATTEMPT (20261015): an attempt that proved a
 -- window ends here, even when it proved the last one, so the closing boundary
 -- and every later step start the next attempt with the whole budget.
 IF proved THEN RETURN false; END IF;
 END IF;
 -- THE WEEK'S ORIGINAL FLOWS ARE PROVED TWO HOURS AT A TIME (20261015b).
 -- fn_union_pnl_evidence_report proves the week's original money flows in one
 -- statement (814,510 flows for the 2026-10-05 week: 162 s alone, 2 GB of
 -- temporary files), which cannot fit an attempt of job 272's 240 s statement
 -- once the attempt's preparation and the tick's other scopes have run, so
 -- every attempt that reached it was cancelled and rolled back. The same proof
 -- is made here one plan window at a time (each flow is proved from its own
 -- row and the week's bounds, so the windows partition the week exactly), kept
 -- as partials like the earned-plan windows, and assembled into the very
 -- certificate the report reads, in an attempt of its own. Only while the
 -- report and the week proof are the reviewed definitions, the window proof is
 -- derived from; otherwise the report proves the week itself, as before.
 IF p_union_id='fade0000-0000-0000-0000-000000000001'::uuid AND p_end>='2026-10-12 07:00Z'::timestamptz THEN
  v_generation:=COALESCE(smarter_private.original_inventory_basis_generation(),'original-inventory-245:unqualified');
 END IF;
 IF v_generation IS NOT DISTINCT FROM 'original-inventory-245:unqualified'
  OR md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'09745f78c6cc2ae57f403419020fd1ab'
  OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'edecfc5273ee4c96b608baa0ea863578'
  OR smarter_private.inventory_basis_cache_read(v_generation,false,'pnl_flows',p_union_id,p_start,p_end) IS NOT NULL
  OR smarter_private.inventory_basis_cache_read(v_generation,true,'pnl_flows',p_union_id,p_start,p_end) IS NOT NULL THEN
  RETURN true;
 END IF;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  -- A window that found a problem is re-proved after an hour, as the report
  -- re-proves a week whose flows found one.
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-interval '12 hours'
   AND (p.value->>'bad'='0' OR p.computed_at>clock_timestamp()-interval '1 hour')
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation);
  IF proved AND clock_timestamp()>stop_at THEN RETURN false; END IF;
  SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
   FROM smarter_private.union_pnl_original_flow_evidence_window(p_union_id,p_start,p_end,w.window_start,w.window_end) f;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES('pnl_flows_window',p_union_id,p_start,p_end,w.window_start,w.window_end,
   jsonb_build_object('generation',v_generation,'bad',v_bad,'flows',v_flows),clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 IF proved THEN RETURN false; END IF;
 -- Every window is fresh: the week's flows are its windows' flows and the two
 -- whole-week return families, the same rows the week proof returns.
 SELECT count(*),count(p.window_start) INTO v_windows,v_fresh
  FROM public.fn_accounting_close_windows(p_start,p_end) cw
  LEFT JOIN public.accounting_close_partials p ON p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=cw.window_start AND p.window_end=cw.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-interval '12 hours'
   AND (p.value->>'bad'='0' OR p.computed_at>clock_timestamp()-interval '1 hour')
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation;
 IF v_windows=0 OR v_fresh<>v_windows THEN RETURN false; END IF;
 WITH parts AS MATERIALIZED (
  SELECT p.value FROM public.fn_accounting_close_windows(p_start,p_end) cw
  JOIN public.accounting_close_partials p ON p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=cw.window_start AND p.window_end=cw.window_end
 ), tails AS MATERIALIZED (
  SELECT t.* FROM smarter_private.original_restoration_cash_returns(p_union_id,p_start,p_end) t(ledger_id,club_id,user_id,buyins,cashouts,kind,valid)
  UNION ALL
  SELECT t.* FROM smarter_private.original_erased_cash_discharge_returns(p_union_id,p_start,p_end) t(ledger_id,club_id,user_id,buyins,cashouts,kind,valid)
 ) SELECT COALESCE((SELECT sum((value->>'bad')::bigint) FROM parts),0)+(SELECT count(*) FILTER(WHERE NOT valid) FROM tails),
  COALESCE((SELECT jsonb_agg(x.flow) FROM (SELECT e.flow FROM parts CROSS JOIN LATERAL jsonb_array_elements(parts.value->'flows') e(flow)
   UNION ALL SELECT to_jsonb(t) FROM tails t) x),'[]')
 INTO v_bad,v_flows;
 IF v_bad=0 THEN PERFORM smarter_private.inventory_basis_cache_write(v_generation,'pnl_flows',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows));
 ELSE PERFORM smarter_private.inventory_basis_cache_write(v_generation,'pnl_flows_problem',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows)); END IF;
 -- Assembling the certificate is the attempt's step; the report reads it next.
 RETURN false;
END $function$;

DO $postimage$BEGIN
 IF md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'f24bac9808f16258b30ee227427dabcc' THEN RAISE EXCEPTION 'flow_windows_advance_postimage_refused';END IF;
 IF md5(pg_get_functiondef('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'8a625319f1aeeef9446feabff82262ef' THEN RAISE EXCEPTION 'flow_windows_window_proof_postimage_refused';END IF;
 IF (SELECT concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')) FROM pg_proc p
   WHERE p.oid='public.fn_accounting_union_earned_plan_advance(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)
  IS DISTINCT FROM (SELECT s FROM flow_windows_advance_security) THEN RAISE EXCEPTION 'flow_windows_advance_security_refused';END IF;
 IF (SELECT concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proacl,',')) FROM pg_proc p
   WHERE p.oid='smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)'::regprocedure)
  IS DISTINCT FROM 'postgres|t|s|postgres=X/postgres' THEN RAISE EXCEPTION 'flow_windows_window_proof_security_refused';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'09745f78c6cc2ae57f403419020fd1ab'
  OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'edecfc5273ee4c96b608baa0ea863578' THEN RAISE EXCEPTION 'flow_windows_week_sources_moved';END IF;
END $postimage$;

COMMIT;
