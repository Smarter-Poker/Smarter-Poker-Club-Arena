-- Version20260911170040 reserved with scripts/new-migration.mjs.
-- Depends on exact D12 composition and private accepted-fact migration.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
DO $legacy_source_preflight$
BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND tgenabled='O' AND tgname IN ('aa_guard_tournament_completing_claim','aaa_guard_atomic_satellite_completion','zzzz_freeze_finalized_tournament_prize_pool','zzzz_tournament_pool_finalization_window_guard','zzzz_tournaments_atomic_place_completion_guard','zzzzz_tournaments_atomic_final_table_deal_completion_guard','zzzzzz_tournaments_financial_certificate'))<>7 THEN
  RAISE EXCEPTION 'legacy finish requires all seven current D12 guards'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN ('fn_ca_accepted_tournament_settlement_fact(jsonb)'::regprocedure,'fn_ca_legacy_tournament_finish_witness(uuid)'::regprocedure) AND (proowner IS DISTINCT FROM 'postgres'::regrole OR NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp','TimeZone=UTC']::text[] OR proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[])) THEN
  RAISE EXCEPTION 'legacy accepted-source dependency metadata differs'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure)) IS DISTINCT FROM 'bb132bf0c6fdedec767db56109c48e5e' THEN RAISE EXCEPTION 'legacy finish requires the finalized-ladder status fix'; END IF;
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_ca_accepted_tournament_settlement_fact(jsonb)'::regprocedure))<>'0be7ce46c91572336ee97c80e827428d'
 OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_ca_legacy_tournament_finish_witness(uuid)'::regprocedure))<>'3c525ec1bccfe36fe4306b3a62e33e60' THEN
  RAISE EXCEPTION 'legacy accepted-source prerequisite differs'; END IF;
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_settle_tournament_places(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '473f67cf3949b938f5277c89fb64edef' THEN RAISE EXCEPTION 'legacy integration source differs: fn_settle_tournament_places(uuid,uuid)'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_settle_tournament_places(uuid,uuid)'::regprocedure
  AND (proowner IS DISTINCT FROM 'postgres'::regrole OR proacl IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[])) THEN
  RAISE EXCEPTION 'legacy place settlement permission prerequisite differs'; END IF;
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_refuse_new_entries_while_frozen()'::regprocedure)) IS DISTINCT FROM 'd21668d1254e1bdb49661f6365fd9cfc' THEN RAISE EXCEPTION 'legacy integration source differs: fn_refuse_new_entries_while_frozen()'; END IF;
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_ca_verify_terminal_place_batch(uuid,boolean)'::regprocedure)) IS DISTINCT FROM '8be8c827e64ac853a562e294cd25735b' THEN RAISE EXCEPTION 'legacy integration source differs: fn_ca_verify_terminal_place_batch(uuid,boolean)'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_verify_terminal_place_batch(uuid,boolean)'::regprocedure
  AND (proowner IS DISTINCT FROM 'postgres'::regrole OR proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[])) THEN
  RAISE EXCEPTION 'legacy terminal verifier private permission prerequisite differs'; END IF;
END $legacy_source_preflight$;
CREATE TABLE public.tournament_legacy_finish_evidence (
 tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
 basis_sha256 text NOT NULL CHECK(basis_sha256 ~ '^[0-9a-f]{64}$'),
 witness jsonb NOT NULL,
 source_receipts jsonb NOT NULL CHECK(jsonb_typeof(source_receipts)='array'),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 tournament_before jsonb NOT NULL,
 created_txid bigint NOT NULL DEFAULT txid_current(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.tournament_legacy_finish_evidence OWNER TO postgres;
ALTER TABLE public.tournament_legacy_finish_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_legacy_finish_evidence FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_legacy_finish_source_rows(p_tournament_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET timezone TO 'UTC'
AS $source_rows$
 SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.table_id,s.hand_id),'[]'::jsonb)
 FROM public.settlement_idempotency_keys s JOIN public.tables t ON t.id=s.table_id
 WHERE t.tournament_id=p_tournament_id;
$source_rows$;
ALTER FUNCTION public.fn_ca_legacy_finish_source_rows(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_finish_source_rows(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_guard_legacy_finish_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET timezone TO 'UTC'
AS $guard_legacy_finish_evidence$
DECLARE w jsonb; t jsonb; source_hash text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'legacy finish evidence is append-only' USING ERRCODE='42501'; END IF;
 PERFORM public.fn_ca_lock_settlement_lane_global();
 SELECT to_jsonb(x) INTO STRICT t FROM public.tournaments x WHERE id=NEW.tournament_id FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=NEW.tournament_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=NEW.tournament_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.settlement_idempotency_keys s JOIN public.tables x ON x.id=s.table_id
  WHERE x.tournament_id=NEW.tournament_id ORDER BY s.table_id,s.hand_id FOR UPDATE OF s;
 w:=public.fn_ca_legacy_tournament_finish_witness(NEW.tournament_id);
 IF w->'ok' IS DISTINCT FROM 'true'::jsonb
  OR w->'recorded_winner_chips_match' IS DISTINCT FROM 'true'::jsonb
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(w->'standings') p
    WHERE (p->>'position')::integer>1 AND ((p->>'recorded_chips')::numeric IS DISTINCT FROM 0 OR p->>'recorded_status' IS DISTINCT FROM 'eliminated'))
  OR (w->>'financial_mode'='satellite' AND (NOT EXISTS(SELECT 1 FROM public.tournament_satellite_economic_snapshots WHERE tournament_id=NEW.tournament_id) OR NOT EXISTS(SELECT 1 FROM public.tournament_entry_close_receipts WHERE tournament_id=NEW.tournament_id)))
  OR w IS DISTINCT FROM NEW.witness OR NEW.basis_sha256 IS DISTINCT FROM w->>'basis_sha256'
  OR NEW.source_receipts::text IS DISTINCT FROM public.fn_ca_legacy_finish_source_rows(NEW.tournament_id)::text
  OR NEW.tournament_before IS DISTINCT FROM t OR NEW.created_txid IS DISTINCT FROM txid_current()
 THEN RAISE EXCEPTION 'legacy finish source seal refused: %',w USING ERRCODE='40001'; END IF;
 source_hash:=encode(extensions.digest(convert_to(NEW.source_receipts::text,'UTF8'),'sha256'),'hex');
 IF NEW.source_sha256 IS NOT NULL AND NEW.source_sha256 IS DISTINCT FROM source_hash THEN RAISE EXCEPTION 'legacy finish source digest differs'; END IF;
 NEW.source_sha256:=source_hash;
 RETURN NEW;
END;
$guard_legacy_finish_evidence$;
ALTER FUNCTION public.fn_ca_guard_legacy_finish_evidence() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_legacy_finish_evidence() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER legacy_finish_evidence_is_append_only BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_legacy_finish_evidence
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_legacy_finish_evidence();

CREATE TRIGGER legacy_finish_evidence_cannot_truncate BEFORE TRUNCATE ON public.tournament_legacy_finish_evidence
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_guard_legacy_finish_evidence();

CREATE FUNCTION public.fn_ca_legacy_finish_sealed_witness(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET timezone TO 'UTC'
AS $sealed_legacy_witness$
DECLARE s public.tournament_legacy_finish_evidence%ROWTYPE;
BEGIN
 SELECT * INTO s FROM public.tournament_legacy_finish_evidence WHERE tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF s.source_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(public.fn_ca_legacy_finish_source_rows(p_tournament_id)::text,'UTF8'),'sha256'),'hex')
  OR s.source_receipts IS DISTINCT FROM public.fn_ca_legacy_finish_source_rows(p_tournament_id)
  OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id AND elimination_sequence IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE tournament_id=p_tournament_id)
  OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a JOIN public.tables t ON t.id=a.table_id WHERE t.tournament_id=p_tournament_id)
  OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id) IS DISTINCT FROM (s.witness->>'field_size')::integer
  OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=p_tournament_id AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(s.witness->'standings') w WHERE (w->>'user_id')::uuid=p.user_id AND (w->>'player_id')::uuid=p.id))
 THEN RAISE EXCEPTION 'sealed legacy finish source or roster changed' USING ERRCODE='40001'; END IF;
 RETURN s.witness;
END;
$sealed_legacy_witness$;
ALTER FUNCTION public.fn_ca_legacy_finish_sealed_witness(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_finish_sealed_witness(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_legacy_finish_standings_are_exact(p_tournament_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET timezone TO 'UTC'
AS $legacy_standings_exact$
DECLARE w jsonb;
BEGIN
 w:=public.fn_ca_legacy_finish_sealed_witness(p_tournament_id);
 IF w IS NULL THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.tournament_players p JOIN jsonb_array_elements(w->'standings') f
  ON (f->>'player_id')::uuid=p.id WHERE p.tournament_id=p_tournament_id AND (
   p.position IS DISTINCT FROM (f->>'position')::integer
   OR p.status IS DISTINCT FROM CASE WHEN (f->>'position')::integer=1 THEN 'winner' ELSE 'eliminated' END
   OR ((f->>'position')::integer>1 AND (p.chips IS DISTINCT FROM 0 OR p.eliminated_at IS NULL))
   OR ((f->>'position')::integer=1 AND (p.chips IS DISTINCT FROM (w->>'observed_winner_chips')::numeric OR p.eliminated_at IS NOT NULL))
   OR p.elimination_sequence IS NOT NULL));
END;
$legacy_standings_exact$;
ALTER FUNCTION public.fn_ca_legacy_finish_standings_are_exact(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_finish_standings_are_exact(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_legacy_finish_must_close()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET timezone TO 'UTC'
AS $legacy_finish_must_close$
DECLARE w jsonb; mode text;
BEGIN
 w:=public.fn_ca_legacy_finish_sealed_witness(NEW.tournament_id);mode:=w->>'financial_mode';
 IF (SELECT status FROM public.tournaments WHERE id=NEW.tournament_id) IS DISTINCT FROM 'COMPLETED'
  OR NOT public.fn_ca_legacy_finish_standings_are_exact(NEW.tournament_id)
  OR NOT EXISTS(SELECT 1 FROM public.tournament_finish_receipts f WHERE f.tournament_id=NEW.tournament_id
   AND f.winner_user_id=(w->>'observed_winner_user_id')::uuid AND f.certified_at IS NOT NULL)
  OR (mode='satellite' AND NOT EXISTS(SELECT 1 FROM public.tournament_satellite_settlement_batches b WHERE b.tournament_id=NEW.tournament_id AND b.settled_at IS NOT NULL))
  OR (mode<>'satellite' AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements r WHERE r.tournament_id=NEW.tournament_id))
 THEN RAISE EXCEPTION 'legacy source seal must commit with its fully certified ordinary finish' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$legacy_finish_must_close$;
ALTER FUNCTION public.fn_ca_legacy_finish_must_close() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_finish_must_close() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER legacy_finish_requires_same_transaction_completion AFTER INSERT ON public.tournament_legacy_finish_evidence
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_ca_legacy_finish_must_close();

CREATE FUNCTION public.fn_ca_complete_legacy_tournament(p_tournament_id uuid,p_expected_basis_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET timezone TO 'UTC' SET statement_timeout TO '45s'
AS $complete_legacy_tournament$
DECLARE w jsonb; r jsonb; sealed public.tournament_legacy_finish_evidence%ROWTYPE; t public.tournaments%ROWTYPE; winner uuid;
BEGIN
 PERFORM public.fn_ca_lock_settlement_lane_global();
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 SELECT * INTO STRICT t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=p_tournament_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.settlement_idempotency_keys s JOIN public.tables tb ON tb.id=s.table_id
  WHERE tb.tournament_id=p_tournament_id ORDER BY s.table_id,s.hand_id FOR UPDATE OF s;
 SELECT * INTO sealed FROM public.tournament_legacy_finish_evidence WHERE tournament_id=p_tournament_id;
 IF FOUND THEN
  IF sealed.basis_sha256 IS DISTINCT FROM p_expected_basis_sha256 OR t.status IS DISTINCT FROM 'COMPLETED' THEN
   RAISE EXCEPTION 'legacy finish replay basis or terminal status differs' USING ERRCODE='40001';
  END IF;
  w:=public.fn_ca_legacy_finish_sealed_witness(p_tournament_id);
 ELSE
  w:=public.fn_ca_legacy_tournament_finish_witness(p_tournament_id);
  IF w->'ok' IS DISTINCT FROM 'true'::jsonb OR w->>'basis_sha256' IS DISTINCT FROM p_expected_basis_sha256
   OR w->'recorded_winner_chips_match' IS DISTINCT FROM 'true'::jsonb THEN
   RAISE EXCEPTION 'legacy finish current proof refused or preview changed: %',w USING ERRCODE='40001';
  END IF;
  IF w->>'financial_mode'='satellite' AND (
    NOT EXISTS(SELECT 1 FROM public.tournament_satellite_economic_snapshots WHERE tournament_id=p_tournament_id)
    OR NOT EXISTS(SELECT 1 FROM public.tournament_entry_close_receipts WHERE tournament_id=p_tournament_id)) THEN
   RAISE EXCEPTION 'legacy satellite original economics and entry close are not proven' USING ERRCODE='55000';
  END IF;
  INSERT INTO public.tournament_legacy_finish_evidence(tournament_id,basis_sha256,witness,source_receipts,tournament_before)
   VALUES(p_tournament_id,p_expected_basis_sha256,w,public.fn_ca_legacy_finish_source_rows(p_tournament_id),to_jsonb(t));
  IF t.status='REGISTERING' THEN
   UPDATE public.tournaments SET status='RUNNING' WHERE id=p_tournament_id AND status='REGISTERING';
  END IF;
 END IF;
 winner:=(w->>'observed_winner_user_id')::uuid;
 IF w->>'financial_mode'='satellite' THEN
  -- The existing satellite authority owns every ticket/cash fallback and fee.
  IF t.status<>'COMPLETED' THEN
   r:=public.fn_claim_tournament_finish(p_tournament_id,winner,'engine.legacy_accepted_finish');
   IF r->'ok' IS DISTINCT FROM 'true'::jsonb OR r->>'winner_user_id' IS DISTINCT FROM winner::text THEN
    RAISE EXCEPTION 'legacy satellite finish claim refused: %',r; END IF;
   UPDATE public.tournament_players p SET position=(f->>'position')::integer,
    status=CASE WHEN (f->>'position')::integer=1 THEN 'winner' ELSE 'eliminated' END,
    eliminated_at=CASE WHEN (f->>'position')::integer=1 THEN NULL ELSE p.eliminated_at END
   FROM jsonb_array_elements(w->'standings') f WHERE p.id=(f->>'player_id')::uuid AND p.tournament_id=p_tournament_id;
   r:=public.fn_settle_tournament_rake(p_tournament_id,'engine.legacy_accepted_finish');
   IF r->'ok' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'legacy satellite rake refused: %',r; END IF;
  END IF;
  r:=public.fn_settle_satellite_finish_atomic(p_tournament_id,'engine.legacy_accepted_finish');
  IF r->'ok' IS DISTINCT FROM 'true'::jsonb OR r->'settled' IS DISTINCT FROM 'true'::jsonb THEN
   RAISE EXCEPTION 'legacy canonical satellite authority refused: %',r; END IF;
 ELSE
  r:=public.fn_complete_tournament_terminal(p_tournament_id,winner,'places');
  IF r->'ok' IS DISTINCT FROM 'true'::jsonb OR r->>'status' IS DISTINCT FROM 'COMPLETED' THEN
   RAISE EXCEPTION 'legacy canonical terminal refused: %',r; END IF;
 END IF;
 IF NOT public.fn_ca_legacy_finish_standings_are_exact(p_tournament_id) THEN RAISE EXCEPTION 'legacy terminal standings differ from accepted hand proof'; END IF;
 RETURN r;
END;
$complete_legacy_tournament$;
ALTER FUNCTION public.fn_ca_complete_legacy_tournament(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_complete_legacy_tournament(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

DO $legacy_patch$
DECLARE before_meta jsonb; after_meta jsonb;
BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc','oid'] INTO before_meta FROM pg_proc p WHERE oid='public.fn_settle_tournament_places(uuid,uuid)'::regprocedure;
 EXECUTE $exact_definition$CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record;
  v_ladder jsonb;
  v_payouts jsonb := '[]'::jsonb;
  v_status text;
  v_live_count integer;
  v_field_size integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric := 0;
  v_bubble_payout_count integer := 0;
  v_bubble_paid numeric := 0;
  v_bubble_ob_count integer := 0;
  v_bubble_ob public.tournament_obligations%ROWTYPE;
  v_bubble_result jsonb;
  v_winner public.tournament_players%ROWTYPE;
  v_row record;
  v_place integer;
  v_amount numeric;
  v_user_id uuid;
  v_ob public.tournament_obligations%ROWTYPE;
  v_evidence numeric;
  v_evidence_count integer;
  v_total_expected numeric := 0;
  v_winner_amount numeric := 0;
  v_result jsonb;
  v_guarantee_result jsonb;
  v_legacy_witness jsonb;
  v_rows integer;
  v_modern_batch public.tournament_place_settlement_batches%ROWTYPE;
  v_modern_replay boolean := false;
  v_modern_required numeric := 0;
  v_modern_escrow_before numeric := 0;
  v_modern_plan jsonb;
  v_modern_positive integer;

  v_unwitnessed_busts integer;
  v_misplaced_busts integer;
BEGIN
  -- Every rolling and terminal money authority enters one transaction lane
  -- before it can own an event, obligation, bank, or recipient row.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  v_legacy_witness:=public.fn_ca_legacy_finish_sealed_witness(p_tournament_id);
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'place settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- Canonical lock order. Re-locks inside owner-only callees are rows already
  -- owned by this transaction and therefore cannot invert a wait dependency.
  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_status := upper(COALESCE(v_t.status,''));
  IF v_status NOT IN ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot settle from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  -- A published batch is an immutable money plan. Replay it without even
  -- transiently clearing cached prizes or rewriting a frozen obligation.
  SELECT * INTO v_modern_batch FROM public.tournament_place_settlement_batches
   WHERE tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND THEN
    IF v_modern_batch.contract_version<>2 OR v_modern_batch.settled_at IS NULL THEN
      RAISE EXCEPTION 'existing place batch requires its original settlement authority'
        USING ERRCODE='55000';
    END IF;
    v_modern_replay:=true;
  END IF;

  IF lower(COALESCE(v_t.variant,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not an ordinary cash ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id
                AND lower(COALESCE(p.source,'')) = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind = 'final_table_deal') THEN
    RAISE EXCEPTION
      'tournament % carries final-table-deal evidence; use the deal authority',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Funding the advertised guarantee is part of this settlement transaction,
  -- not a best-effort request made by the game process immediately beforehand.
  -- fn_apply_prize_guarantee re-locks the row already owned here and either
  -- debits the event-owned bank plus finalizes the pool, or raises. Prove its
  -- receipt against the refreshed row before deriving even the first place; a
  -- refusal therefore rolls back the overlay, every payout and the finish.
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  IF v_t.guaranteed_prize IS NOT NULL
     AND (v_t.guaranteed_prize::text IN ('NaN','Infinity','-Infinity')
       OR v_t.guaranteed_prize < 0
       OR v_t.guaranteed_prize IS DISTINCT FROM round(v_t.guaranteed_prize, 2)) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent guarantee %',
      p_tournament_id, v_t.guaranteed_prize USING ERRCODE = '22003';
  END IF;
  v_guarantee_result := public.fn_apply_prize_guarantee(
    p_tournament_id, 'engine.fn_settle_tournament_places');
  IF COALESCE((v_guarantee_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_guarantee_result->>'overlay')::numeric,0) > 0
         AND COALESCE(
           (v_guarantee_result->>'overlay_journaled')::boolean,false)
             IS NOT TRUE) THEN
    RAISE EXCEPTION 'tournament % guarantee funding refused: %',
      p_tournament_id, v_guarantee_result USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2)
     OR v_t.prize_pool < COALESCE(v_t.guaranteed_prize, 0)
     OR v_guarantee_result->>'prize_pool' IS NULL
     OR (v_guarantee_result->>'prize_pool')::numeric IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % guarantee funding did not produce one finalized locked pool: result %, pool %, guarantee %, finalized %',
      p_tournament_id, v_guarantee_result, v_t.prize_pool,
      v_t.guaranteed_prize, v_t.prize_pool_finalized USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id FOR UPDATE;
  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.status::text = 'registered') THEN
    RAISE EXCEPTION 'tournament % still has a registered unresolved player',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- The helper counts the final field, so derive only after the complete
  -- roster has joined the canonical tournament -> roster lock sequence.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',a.place,'amount',a.amount) ORDER BY a.place),'[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  IF jsonb_array_length(v_ladder) = 0 THEN
    RAISE EXCEPTION 'tournament % derived an empty ladder', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_live_count FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'tournament % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    -- The observed last survivor may already have crossed through
    -- `eliminated` in an all-in race. The committed transition sequence, not
    -- a wall clock, proves that this row was the final elimination.
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'tournament % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
              OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'observed winner % does not match locked winner % for tournament %',
      p_observed_winner_id, v_winner.user_id, p_tournament_id
      USING ERRCODE = '40001';
  END IF;

  -- Lock the whole set once, before validation or the ascending-place walk.
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND (o.place IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = o.place))
  ) THEN
    RAISE EXCEPTION
      'tournament % has a place obligation outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  IF (v_status = 'COMPLETED' OR v_modern_replay) THEN
    IF v_winner.status::text <> 'winner' OR v_winner.position <> 1 THEN
      RAISE EXCEPTION
        'COMPLETED tournament % is not an exact replay: winner is not durable',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  ELSE
    -- Recorded finish positions are the engine's live witness. Never rebuild
    -- an all-busted field from timestamps. Promotion may fill first place, but
    -- it cannot displace another recorded first or vacate a ladder place.
    IF EXISTS (SELECT 1 FROM public.tournament_players tp
                WHERE tp.tournament_id = p_tournament_id
                  AND tp.position = 1
                  AND tp.user_id <> v_winner.user_id) THEN
      RAISE EXCEPTION 'tournament % assigns first place to another player',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF v_winner.position IS NOT NULL AND v_winner.position <> 1
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder) a
                    WHERE (a->>'place')::integer = v_winner.position) THEN
      RAISE EXCEPTION
        'promoting winner % would vacate cash place % in tournament %',
        v_winner.user_id, v_winner.position, p_tournament_id
        USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournament_players
       SET status = 'winner', position = 1,
           eliminated_at = NULL, elimination_sequence = NULL
     WHERE id = v_winner.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'tournament % could not promote exactly one winner',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    -- An owner-sealed legacy witness certifies this already recorded order.
    -- It cannot select a winner, rewrite historical sequences or relabel money.
    IF v_legacy_witness IS NOT NULL THEN
      IF v_legacy_witness->>'financial_mode'='satellite'
         OR v_legacy_witness->>'observed_winner_user_id' IS DISTINCT FROM p_observed_winner_id::text
         OR NOT public.fn_ca_legacy_finish_standings_are_exact(p_tournament_id) THEN
        RAISE EXCEPTION 'legacy places do not match their sealed accepted hands' USING ERRCODE='40001';
      END IF;
    ELSE
    -- Final numeric positions are derived from the transition witness, not
    -- from the field size that happened to exist when each player busted.
    -- This is the root fix for late registration enlarging the field after an
    -- early elimination. Existing money evidence is never relabelled: a
    -- legacy event whose paid place would move fails closed for explicit
    -- adjudication instead of rewriting settled history.
    SELECT count(*), count(tp.elimination_sequence),
           count(DISTINCT tp.elimination_sequence)
      INTO v_eliminated_count, v_sequenced_count, v_rows
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated';
    IF v_eliminated_count <> v_field_size - 1
       OR v_sequenced_count <> v_eliminated_count
       OR v_rows <> v_eliminated_count THEN
      RAISE EXCEPTION
        'tournament % has no complete durable elimination sequence (%/% of %)',
        p_tournament_id, v_sequenced_count, v_rows, v_eliminated_count
        USING ERRCODE = 'P0404';
    END IF;

    /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). Places were
       numbered in elimination_sequence order, which a trigger stamps when
       the knockout door RECORDS a bust, so a bust the door recorded hours
       late was paid a place it did not finish in. Each eliminated row is now
       ranked by when its bust happened, derived in the statement that uses
       it from what the door proved: the commit time of the accepted hand of
       the player's latest 'eliminated' knockout generation, plus one
       microsecond per earlier rank in that hand (smaller hand-start stack
       first, then user id - the rule the door stamps eliminated_at with).
       Busts in different hands are ordered by those hands' commit times.
       The hand-history prune deletes a horse-only hand's commit row after
       its retention window, and only a PENDING generation protects it; the
       generation rows themselves are never pruned, so a hand whose commit
       is gone is timed by when its first generation was captured (the
       earliest created_at of that hand's generations, written before the
       commit) - one time for the whole hand, so the same-hand stack rank
       still decides within it - never by when a bust was recorded. A row
       with no such witness keeps its eliminated_at; a row with neither is
       refused, never guessed. Equal times fall back to
       elimination_sequence, then id. elimination_sequence alone still names
       the last elimination, and so the winner, above. The same order decides
       whether anything moves, so a ladder already in true order is left
       exactly as it is. */
    WITH busts AS (
      SELECT tp.id, tp.position, tp.elimination_sequence,
             COALESCE((
               SELECT COALESCE(a.committed_at,
                               (SELECT min(g.created_at)
                                  FROM public.tournament_knockout_candidates g
                                 WHERE g.tournament_id = c.tournament_id
                                   AND g.table_id = c.table_id
                                   AND g.hand_number = c.hand_number
                                   AND g.hand_id = c.hand_id))
                      + (SELECT count(*)
                           FROM public.tournament_knockout_candidates s
                          WHERE s.tournament_id = c.tournament_id
                            AND s.table_id = c.table_id
                            AND s.hand_number = c.hand_number
                            AND s.hand_id = c.hand_id
                            AND (s.stack_before, s.eliminated_user_id)
                                < (c.stack_before, c.eliminated_user_id))::integer
                        * interval '1 microsecond'
                 FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                              k.hand_id, k.stack_before, k.eliminated_user_id
                         FROM public.tournament_knockout_candidates k
                        WHERE k.tournament_id = tp.tournament_id
                          AND k.eliminated_user_id = tp.user_id
                          AND k.state = 'eliminated'
                        ORDER BY k.hand_number DESC, k.id DESC
                        LIMIT 1) c
                 LEFT JOIN public.hand_atomic_commits a
                   ON a.table_id = c.table_id
                  AND a.hand_number = c.hand_number
                  AND a.hand_id = c.hand_id
             ), tp.eliminated_at) AS bust_at
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
    ),
    ranked AS (
      SELECT b.id, b.position, b.bust_at,
             row_number() OVER (
               ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
             )::integer + 1 AS expected_position
        FROM busts b
    )
    SELECT count(*) FILTER (WHERE ranked.bust_at IS NULL),
           count(*) FILTER (WHERE ranked.position IS DISTINCT FROM ranked.expected_position)
      INTO v_unwitnessed_busts, v_misplaced_busts
      FROM ranked;
    IF v_unwitnessed_busts > 0 THEN
      RAISE EXCEPTION
        'tournament % has % eliminated player(s) with no bust witness and no eliminated_at',
        p_tournament_id, v_unwitnessed_busts USING ERRCODE = 'P0404';
    END IF;

    IF v_misplaced_busts > 0 THEN
      IF EXISTS (
        SELECT 1 FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p."position" IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id
           AND o.kind = 'place'
      ) THEN
        /* Paid places are never relabelled. A COMPLETING event whose
           places are exactly the recording-order ladder was settled by the
           rule this replaces, and is replayed as it was paid, not refused. */
        IF v_status <> 'COMPLETING' OR EXISTS (
          SELECT 1
            FROM (
              SELECT tp.position,
                     row_number() OVER (
                       ORDER BY tp.elimination_sequence DESC, tp.id ASC
                     )::integer + 1 AS expected_position
                FROM public.tournament_players tp
               WHERE tp.tournament_id = p_tournament_id
                 AND tp.status::text = 'eliminated'
            ) recorded
           WHERE recorded.position IS DISTINCT FROM recorded.expected_position
        ) THEN
          RAISE EXCEPTION
            'tournament % needs a late-entry position normalization but already carries settled place evidence',
            p_tournament_id USING ERRCODE = 'P0404';
        END IF;
      ELSE
        UPDATE public.tournament_players tp
           SET position = NULL
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated';

        WITH busts AS (
        SELECT tp.id, tp.position, tp.elimination_sequence,
               COALESCE((
                 SELECT COALESCE(a.committed_at,
                                 (SELECT min(g.created_at)
                                    FROM public.tournament_knockout_candidates g
                                   WHERE g.tournament_id = c.tournament_id
                                     AND g.table_id = c.table_id
                                     AND g.hand_number = c.hand_number
                                     AND g.hand_id = c.hand_id))
                        + (SELECT count(*)
                             FROM public.tournament_knockout_candidates s
                            WHERE s.tournament_id = c.tournament_id
                              AND s.table_id = c.table_id
                              AND s.hand_number = c.hand_number
                              AND s.hand_id = c.hand_id
                              AND (s.stack_before, s.eliminated_user_id)
                                  < (c.stack_before, c.eliminated_user_id))::integer
                          * interval '1 microsecond'
                   FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                                k.hand_id, k.stack_before, k.eliminated_user_id
                           FROM public.tournament_knockout_candidates k
                          WHERE k.tournament_id = tp.tournament_id
                            AND k.eliminated_user_id = tp.user_id
                            AND k.state = 'eliminated'
                          ORDER BY k.hand_number DESC, k.id DESC
                          LIMIT 1) c
                   LEFT JOIN public.hand_atomic_commits a
                     ON a.table_id = c.table_id
                    AND a.hand_number = c.hand_number
                    AND a.hand_id = c.hand_id
               ), tp.eliminated_at) AS bust_at
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated'
        ),
        ranked AS (
          SELECT b.id,
                 row_number() OVER (
                   ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
                 )::integer + 1 AS expected_position
            FROM busts b
        )
        UPDATE public.tournament_players tp
           SET position = ranked.expected_position
          FROM ranked
         WHERE tp.id = ranked.id;
      END IF;
    END IF;
    END IF;
  END IF;

  -- Derive the single pool-funded bubble promise after standings are final.
  -- The percentage helper has already reserved this exact amount from its
  -- ladder. Satellites never enter this authority: their bubble is paid the
  -- residual that cannot buy a full seat by the satellite settle path.
  SELECT max((a->>'place')::integer) + 1
    INTO v_bubble_place
    FROM jsonb_array_elements(v_ladder) a;
  IF COALESCE(v_t.bubble_protection, false)
     AND v_bubble_place IS NOT NULL
     AND v_bubble_place <= v_field_size THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'tournament % has invalid bubble buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
    IF v_bubble_amount > v_t.prize_pool THEN
      RAISE EXCEPTION 'tournament % bubble amount % exceeds pool %',
        p_tournament_id, v_bubble_amount, v_t.prize_pool
        USING ERRCODE = '23514';
    END IF;

    SELECT count(*), min(tp.user_id::text)::uuid
      INTO v_rows, v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_place
       AND tp.status::text = 'eliminated';
    IF v_rows <> 1 OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no single eliminated stone bubble at place %',
        p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_bubble_payout_count, v_bubble_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  SELECT count(*) INTO v_bubble_ob_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';

  IF v_bubble_amount = 0 THEN
    IF v_bubble_payout_count <> 0 OR v_bubble_paid <> 0
       OR v_bubble_ob_count <> 0 THEN
      RAISE EXCEPTION 'tournament % carries bubble evidence but no bubble is due',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_bubble_paid > v_bubble_amount
       OR EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND (p.user_id IS DISTINCT FROM v_bubble_user_id
              OR p."position" IS NOT NULL
              OR p.amount IS NULL
              OR p.amount::text IN ('NaN','Infinity','-Infinity')
              OR p.amount <= 0
              OR p.amount IS DISTINCT FROM round(p.amount, 2)
              OR p.idempotency_key IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM public.wallet_credit_idempotency k
                 WHERE k.key = p.idempotency_key
                   AND k.user_id = p.user_id
                   AND k.amount = p.amount))) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble payout evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT * INTO v_bubble_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection'
       AND o.user_id = v_bubble_user_id;
    IF v_bubble_ob_count > 0
       AND (v_bubble_ob_count <> 1 OR v_bubble_ob.id IS NULL
         OR v_bubble_ob.place IS NOT NULL
         OR v_bubble_ob.amount_owed IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_paid
         OR v_bubble_ob.amount_paid < 0
         OR v_bubble_ob.amount_paid > v_bubble_ob.amount_owed
         OR (v_bubble_ob.amount_paid = v_bubble_ob.amount_owed) IS DISTINCT FROM
            (v_bubble_ob.settled_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble obligation evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_bubble_ob_count = 0
       AND (v_bubble_payout_count <> 0 OR v_bubble_paid <> 0) THEN
      RAISE EXCEPTION 'tournament % has bubble money without its debt record',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF (v_status = 'COMPLETED' OR v_modern_replay)
       AND (v_bubble_ob_count <> 1
         OR v_bubble_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.settled_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.user_id = v_bubble_user_id
              AND tp.position = v_bubble_place
              AND tp.prize IS NOT DISTINCT FROM v_bubble_amount)) THEN
      RAISE EXCEPTION 'COMPLETED tournament % has no exact bubble replay',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  END IF;

  -- Anything paid from the prize bank outside the derived ladder makes a full
  -- structure payout unsafe. Bounty/seat sources belong to other authorities.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND COALESCE(p.source,'') NOT IN
           ('bounty','own_bounty','mystery_bounty','mystery_bounty_residual',
            'bounty_residual','satellite_seat','bubble_protection')
       AND (p."position" IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = p."position"))
  ) THEN
    RAISE EXCEPTION 'tournament % has prize evidence outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Obligation-shaped wallet identity with no exact payout row is mixed
  -- evidence. It is checked globally before any place can move.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE 'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.idempotency_key = k.key
            AND p.tournament_id = p_tournament_id
            AND p.user_id = k.user_id AND p.amount = k.amount)
  ) THEN
    RAISE EXCEPTION
      'tournament % has wallet-credit identity without payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Preflight every place before settling the first one.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    v_place := v_row.place; v_amount := v_row.amount; v_user_id := v_row.user_id;
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no finisher for cash place %',
        p_tournament_id, v_place USING ERRCODE = '23502';
    END IF;
    IF v_amount::text IN ('NaN','Infinity','-Infinity') OR v_amount < 0
       OR v_amount IS DISTINCT FROM round(v_amount,2) THEN
      RAISE EXCEPTION 'tournament % derived invalid amount % for place %',
        p_tournament_id, v_amount, v_place USING ERRCODE = '22003';
    END IF;
    v_total_expected := v_total_expected + v_amount;
    IF v_place = 1 THEN v_winner_amount := v_amount; END IF;
    IF (v_status = 'COMPLETED' OR v_modern_replay)
       AND v_row.cached_prize IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION
        'COMPLETED tournament %, place % has stale prize cache % (expected %)',
        p_tournament_id, v_place, v_row.cached_prize, v_amount
        USING ERRCODE = '55000';
    END IF;

    -- Each payout row is also required to name an exact wallet-credit identity.
    IF EXISTS (
      SELECT 1 FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id AND p."position" = v_place
         AND (p.user_id IS DISTINCT FROM v_user_id OR p.amount IS NULL
           OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount < 0
           OR p.amount IS DISTINCT FROM round(p.amount,2)
           OR p.idempotency_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.wallet_credit_idempotency k
              WHERE k.key = p.idempotency_key AND k.user_id = p.user_id
                AND k.amount = p.amount))
    ) THEN
      RAISE EXCEPTION
        'tournament %, place % has mixed/malformed/wrong-recipient evidence',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*), COALESCE(sum(p.amount),0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p."position" = v_place;
    v_evidence := round(v_evidence,2);
    IF v_evidence > v_amount THEN
      RAISE EXCEPTION 'tournament %, place % records % above entitlement %',
        p_tournament_id, v_place, v_evidence, v_amount USING ERRCODE = '23514';
    END IF;

    v_ob := NULL;
    SELECT * INTO v_ob FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = v_place;
    IF FOUND THEN
      IF v_ob.user_id IS DISTINCT FROM v_user_id OR v_ob.amount_owed IS NULL
         OR v_ob.amount_paid IS NULL
         OR v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_owed IS DISTINCT FROM round(v_ob.amount_owed,2)
         OR v_ob.amount_paid IS DISTINCT FROM round(v_ob.amount_paid,2)
         OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
         OR v_ob.amount_paid > v_ob.amount_owed
         OR v_ob.amount_owed > v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_evidence THEN
        RAISE EXCEPTION 'tournament %, place % has incompatible obligation',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_amount = 0 THEN
      -- Zero-valued ladder places are standings, not debts.
      IF v_evidence <> 0 OR (v_ob.id IS NOT NULL
         AND (v_ob.amount_owed <> 0 OR v_ob.amount_paid <> 0)) THEN
        RAISE EXCEPTION 'zero-value place % in tournament % carries money evidence',
          v_place, p_tournament_id USING ERRCODE = '23514';
      END IF;
    ELSIF (v_status = 'COMPLETED' OR v_modern_replay) THEN
      IF v_ob.id IS NULL OR v_ob.amount_owed IS DISTINCT FROM v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_amount
         OR v_evidence IS DISTINCT FROM v_amount THEN
        RAISE EXCEPTION 'COMPLETED tournament %, place % is not an exact replay',
          p_tournament_id, v_place USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;

  IF round(v_total_expected + v_bubble_amount, 2)
       IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % ladder % plus bubble % does not equal locked pool %',
      p_tournament_id, v_total_expected, v_bubble_amount, v_t.prize_pool
      USING ERRCODE = '23514';
  END IF;

  IF (v_status <> 'COMPLETED' AND NOT v_modern_replay) THEN
    -- Materialize the bubble and the entire positive ladder before the first
    -- wallet credit. The payment walk is driven from one complete locked debt
    -- set, so failure on any recipient rolls every obligation and credit back.
    IF v_bubble_amount > 0 AND v_bubble_ob_count = 0 THEN
      INSERT INTO public.tournament_obligations
        (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
      VALUES
        (p_tournament_id,'bubble_protection',NULL,v_bubble_user_id,
         v_bubble_amount,0,'engine.fn_settle_tournament_places',NULL)
      RETURNING * INTO v_bubble_ob;
      v_bubble_ob_count := 1;
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place;

      UPDATE public.tournament_obligations o
         SET amount_owed = v_row.amount,
             source = COALESCE(o.source, 'engine.fn_settle_tournament_places'),
             updated_at = now()
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN
        INSERT INTO public.tournament_obligations
          (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
        VALUES
          (p_tournament_id,'place',v_row.place,v_row.user_id,v_row.amount,
           v_evidence,'engine.fn_settle_tournament_places',
           CASE WHEN v_evidence = v_row.amount THEN now() ELSE NULL END);
      ELSIF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament %, place % matched % obligations',
          p_tournament_id, v_row.place, v_rows USING ERRCODE = '23505';
      END IF;
    END LOOP;

    -- Re-lock/prove the complete set immediately before any raw payer runs.
    PERFORM 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind IN ('bubble_protection','place')
     ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

    SELECT e.prize_balance INTO STRICT v_modern_escrow_before
      FROM public.tournament_escrow e
     WHERE e.tournament_id=p_tournament_id AND e.enforced FOR UPDATE;
    SELECT COALESCE(sum(o.amount_owed-o.amount_paid),0)
      INTO v_modern_required FROM public.tournament_obligations o
     WHERE o.tournament_id=p_tournament_id AND o.kind IN ('place','bubble_protection');
    IF v_modern_required<0 OR v_modern_required<>round(v_modern_required,2)
       OR v_modern_escrow_before IS NULL
       OR v_modern_escrow_before<v_modern_required
       OR v_modern_escrow_before<>round(v_modern_escrow_before,2) THEN
      RAISE EXCEPTION 'canonical place batch lacks exact pre-credit funding'
        USING ERRCODE='23514';
    END IF;

    IF v_bubble_amount > 0 THEN
      v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
        p_tournament_id, v_bubble_user_id, v_bubble_amount);
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      v_result := public.fn_ca_settle_tournament_place_raw(
        p_tournament_id,v_row.place,v_row.user_id,v_row.amount);
      IF COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'tournament %, place % returned a partial settlement',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    -- tournament_players.prize is presentation cache, stamped only from the
    -- successfully settled DB ladder and in this same transaction.
    UPDATE public.tournament_players SET prize = 0
     WHERE tournament_id = p_tournament_id;
    FOR v_row IN SELECT (a->>'place')::integer AS place,
                         (a->>'amount')::numeric AS amount
                   FROM jsonb_array_elements(v_ladder) a
    LOOP
      UPDATE public.tournament_players SET prize = v_row.amount
       WHERE tournament_id = p_tournament_id AND position = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'could not stamp one prize cache for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    IF v_bubble_amount > 0 THEN
      UPDATE public.tournament_players
         SET prize = v_bubble_amount
       WHERE tournament_id = p_tournament_id
         AND user_id = v_bubble_user_id
         AND position = v_bubble_place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION
          'could not stamp one bubble prize cache for tournament %, place %',
          p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_status = 'RUNNING' THEN
      UPDATE public.tournaments SET status = 'COMPLETING'
       WHERE id = p_tournament_id AND status = 'RUNNING';
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament % lost its RUNNING finish claim',
          p_tournament_id USING ERRCODE = '40001';
      END IF;
      v_status := 'COMPLETING';
    END IF;
  END IF;

  IF v_bubble_amount > 0 AND (v_status = 'COMPLETED' OR v_modern_replay) THEN
    -- Exact replay only: the completed preflight above proved this call cannot
    -- move money, while the raw helper proves every durable receipt again.
    v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
      p_tournament_id, v_bubble_user_id, v_bubble_amount);
  END IF;

  IF v_bubble_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = v_bubble_user_id
       AND tp.position = v_bubble_place
       AND tp.prize IS NOT DISTINCT FROM v_bubble_amount
  ) THEN
    RAISE EXCEPTION
      'post-settlement bubble prize-cache proof failed for tournament %, place %',
      p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
  END IF;

  -- Prove the durable end-state and build the presentation-only receipt.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    IF v_row.cached_prize IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'post-settlement prize-cache proof failed for tournament %, place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
    IF v_row.amount > 0 THEN
      v_ob := NULL;
      SELECT * INTO v_ob FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place AND p.user_id = v_row.user_id;
      IF v_ob.id IS NULL OR v_ob.user_id IS DISTINCT FROM v_row.user_id
         OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
         OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
         OR v_evidence IS DISTINCT FROM v_row.amount THEN
        RAISE EXCEPTION 'post-settlement proof failed for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END IF;
    v_payouts := v_payouts || jsonb_build_object(
      'place',v_row.place,'user_id',v_row.user_id,'amount',v_row.amount);
  END LOOP;

  -- This header certifies money the same authority just proved and paid.
  -- It never invents or seeds a payment, and its original funding snapshot is
  -- preserved unchanged on every retry.
  IF NOT v_modern_replay THEN
    IF v_status='COMPLETED' THEN
      RAISE EXCEPTION 'completed event has no current canonical place batch'
        USING ERRCODE='55000';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'place',(a->>'place')::integer,'user_id',tp.user_id,'club_id',tp.club_id,
      'cents',round((a->>'amount')::numeric*100)::bigint)
      ORDER BY (a->>'place')::integer),'[]'::jsonb),count(*)
      INTO v_modern_plan,v_modern_positive
      FROM jsonb_array_elements(v_ladder) a JOIN public.tournament_players tp
       ON tp.tournament_id=p_tournament_id AND tp.position=(a->>'place')::integer
     WHERE (a->>'amount')::numeric>0;
    IF (SELECT e.prize_balance FROM public.tournament_escrow e
         WHERE e.tournament_id=p_tournament_id) IS DISTINCT FROM
         v_modern_escrow_before-v_modern_required THEN
      RAISE EXCEPTION 'canonical place batch lost its exact escrow delta'
        USING ERRCODE='23514';
    END IF;
    -- The real Bubble payer may normalize source while crediting. Record its
    -- settled identity, retaining v_bubble_paid as the pre-credit snapshot.
    IF v_bubble_amount>0 THEN
      SELECT * INTO STRICT v_bubble_ob FROM public.tournament_obligations
       WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
    END IF;
    INSERT INTO public.tournament_place_settlement_batches(
      tournament_id,mode,plan_fingerprint,place_count,amount_owed,
      escrow_required,escrow_available,bubble_contract_required,
      bubble_obligation_id,bubble_user_id,bubble_source,
      bubble_amount_owed,bubble_amount_paid_before,source,settled_at,contract_version)
    VALUES(p_tournament_id,'structure',md5(v_modern_plan::text),
      v_modern_positive,v_total_expected,v_modern_required,v_modern_escrow_before,
      v_bubble_amount>0,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_ob.id ELSE NULL END,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_user_id ELSE NULL END,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_ob.source ELSE NULL END,
      v_bubble_amount,CASE WHEN v_bubble_amount>0 THEN v_bubble_paid ELSE 0 END,
      'engine.fn_settle_tournament_places',transaction_timestamp(),2);
  END IF;
  PERFORM public.fn_ca_verify_terminal_place_batch(p_tournament_id,false);

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status',v_status,
    'payouts',v_payouts,
    'bubble_protection',CASE WHEN v_bubble_amount > 0 THEN
      jsonb_build_object('user_id',v_bubble_user_id,'position',v_bubble_place,
                         'amount',v_bubble_amount)
      ELSE 'null'::jsonb END,
    'winner_amount',v_winner_amount);
END;
$function$
$exact_definition$;
 SELECT to_jsonb(p)-ARRAY['prosrc','oid'] INTO after_meta FROM pg_proc p WHERE oid='public.fn_settle_tournament_places(uuid,uuid)'::regprocedure;
 IF before_meta IS DISTINCT FROM after_meta THEN RAISE EXCEPTION 'legacy integration changed function metadata: fn_settle_tournament_places'; END IF;
END $legacy_patch$;
DO $legacy_patch$
DECLARE before_meta jsonb; after_meta jsonb;
BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc','oid'] INTO before_meta FROM pg_proc p WHERE oid='public.fn_refuse_new_entries_while_frozen()'::regprocedure;
 EXECUTE $exact_definition$CREATE OR REPLACE FUNCTION public.fn_refuse_new_entries_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_cash boolean;
BEGIN
  /* Classify non-admissions before asking for the boundary. Departures,
     ordinary seat updates, tournament table balancing, earned satellite
     seats, and non-RUNNING status changes can arrive inside transactions that
     already own their own rows. They are not new entry and must never acquire
     this lock late. */
  IF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP = 'UPDATE'
       AND NOT (
         (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL)
         OR OLD.user_id IS DISTINCT FROM NEW.user_id
       ) THEN
      RETURN NEW;
    END IF;

    SELECT (t.tournament_id IS NULL) INTO v_is_cash
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    /* Tournament seating is movement inside an already-admitted field. This
       includes INSERT and reuse of a vacated destination row (UPDATE that
       clears left_at or changes user_id). Freezing the latter after its source
       seat was vacated strands a player between tables. New tournament entry
       remains guarded at tournament_players and in its canonical outer RPC. */
    IF NOT COALESCE(v_is_cash, true) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'tournaments' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'RUNNING' THEN
      RETURN NEW;
    END IF;
    /* This is not a new launch: fn_begin_tournament_launch_atomic already
       admitted it before the maintenance boundary. Only the private completion
       RPC can set this exact transaction-local marker, and the immutable
       incomplete receipt proves which launch it is completing. */
    -- This field already played. An owner-validated, transaction-bound seal
    -- proves its exact historical status repair; a deferred constraint requires
    -- full ordinary completion in this same transaction. This is no new entry.
    IF OLD.status='REGISTERING'
       AND (to_jsonb(NEW)-'status') IS NOT DISTINCT FROM (to_jsonb(OLD)-'status')
       AND EXISTS(SELECT 1 FROM public.tournament_legacy_finish_evidence e
         WHERE e.tournament_id=NEW.id AND e.created_txid=txid_current()
          AND e.tournament_before IS NOT DISTINCT FROM to_jsonb(OLD)
          AND e.witness->'ok'='true'::jsonb
          AND e.witness->'recorded_winner_chips_match'='true'::jsonb) THEN
      PERFORM public.fn_ca_legacy_finish_sealed_witness(NEW.id);
      RETURN NEW;
    END IF;
    IF OLD.status = 'REGISTERING'
       AND EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.id
            AND r.completed_at IS NULL
            AND current_setting('app.atomic_tournament_launch', true)
                = NEW.id::text || ':' || r.launch_id::text
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'TOURNAMENT_LAUNCH_RECEIPT_REQUIRED: REGISTERING to RUNNING belongs to the atomic launch completion RPC'
      USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    /* Every roster insertion must serialize on its tournament parent before
       launch completion proves the field. Canonical registration functions
       already take this lock before their first child mutation, so this is
       re-entrant there; it closes the direct-owner/legacy path that could
       otherwise commit a new registered row between completion's roster read
       and its RUNNING write. */
    PERFORM 1
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % does not exist', NEW.tournament_id
        USING ERRCODE = '23503';
    END IF;

    IF COALESCE(NEW.is_satellite_qualifier, false)
       AND NEW.source_satellite_id IS NOT NULL
       AND current_setting('app.atomic_satellite_settlement', true)
           = NEW.source_satellite_id::text THEN
      RETURN NEW;
    END IF;
  END IF;

  /* Canonical RPCs own this already, so try-lock is re-entrant. A direct or
     previously unknown outer caller fails without waiting while it may hold
     other rows; this is the deadlock-safe backstop, not the normal path. */
  IF NOT pg_try_advisory_xact_lock_shared(530090, 1) THEN
    RAISE EXCEPTION
      'ENTRY_BOUNDARY_BUSY: maintenance announcement owns the entry boundary'
      USING ERRCODE = '40001';
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN NEW;
  END IF;

  IF NOT public.fn_entry_purchases_frozen() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'PLATFORM_FROZEN: scheduled maintenance has closed new entries. % on % was refused without moving chips.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55006',
          HINT = 'Retry after the maintenance break has ended.';
END;
$function$
$exact_definition$;
 SELECT to_jsonb(p)-ARRAY['prosrc','oid'] INTO after_meta FROM pg_proc p WHERE oid='public.fn_refuse_new_entries_while_frozen()'::regprocedure;
 IF before_meta IS DISTINCT FROM after_meta THEN RAISE EXCEPTION 'legacy integration changed function metadata: fn_refuse_new_entries_while_frozen'; END IF;
END $legacy_patch$;
DO $legacy_patch$
DECLARE before_meta jsonb; after_meta jsonb;
BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc','oid'] INTO before_meta FROM pg_proc p WHERE oid='public.fn_ca_verify_terminal_place_batch(uuid,boolean)'::regprocedure;
 EXECUTE $exact_definition$CREATE OR REPLACE FUNCTION public.fn_ca_verify_terminal_place_batch(p_tournament_id uuid, p_require_terminal boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_legacy_witness jsonb;
 v_t public.tournaments%ROWTYPE;
 v_b public.tournament_place_settlement_batches%ROWTYPE;
 v_e public.tournament_escrow%ROWTYPE;
 v_ladder jsonb; v_plan jsonb;
 v_field integer; v_positive integer; v_bubble_place integer;
 v_place_total numeric; v_bubble_amount numeric:=0;
 v_bubble_user uuid; v_ob public.tournament_obligations%ROWTYPE;
 v_bubble_count integer;
BEGIN
 SELECT * INTO STRICT v_t FROM public.tournaments WHERE id=p_tournament_id;
 SELECT * INTO STRICT v_b FROM public.tournament_place_settlement_batches
  WHERE tournament_id=p_tournament_id;
 IF v_b.contract_version<>2 OR v_b.mode<>'structure' OR v_b.settled_at IS NULL
  OR v_t.prize_pool_finalized IS DISTINCT FROM true
  OR v_t.prize_pool IS NULL OR v_t.prize_pool<0
  OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
  OR v_t.prize_pool<>round(v_t.prize_pool,2)
  OR v_t.prize_pool<COALESCE(v_t.guaranteed_prize,0)
 THEN RAISE EXCEPTION 'canonical terminal batch is not funded and settled'; END IF;
 SELECT count(*) INTO v_field FROM public.tournament_players
  WHERE tournament_id=p_tournament_id;
 v_legacy_witness:=public.fn_ca_legacy_finish_sealed_witness(p_tournament_id);
 IF v_legacy_witness IS NOT NULL THEN
  IF v_legacy_witness->>'financial_mode'='satellite'
    OR NOT public.fn_ca_legacy_finish_standings_are_exact(p_tournament_id) THEN
   RAISE EXCEPTION 'canonical legacy terminal batch differs from sealed accepted standings';
  END IF;
 ELSE
 IF v_field=0 OR
  (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id
   AND status='winner' AND position=1)<>1
  OR (SELECT count(DISTINCT position) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id)<>v_field
  OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND (position IS NULL OR position<1 OR position>v_field
     OR status NOT IN ('winner','eliminated')
     OR (status='winner' AND position<>1)
     OR (status='eliminated' AND (eliminated_at IS NULL OR elimination_sequence IS NULL))))
  OR (SELECT count(DISTINCT elimination_sequence) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND status='eliminated')<>v_field-1
  OR EXISTS(
    WITH busts AS (
      SELECT tp.id, tp.position, tp.elimination_sequence,
             COALESCE((
               SELECT COALESCE(a.committed_at,
                               (SELECT min(g.created_at)
                                  FROM public.tournament_knockout_candidates g
                                 WHERE g.tournament_id = c.tournament_id
                                   AND g.table_id = c.table_id
                                   AND g.hand_number = c.hand_number
                                   AND g.hand_id = c.hand_id))
                      + (SELECT count(*)
                           FROM public.tournament_knockout_candidates s
                          WHERE s.tournament_id = c.tournament_id
                            AND s.table_id = c.table_id
                            AND s.hand_number = c.hand_number
                            AND s.hand_id = c.hand_id
                            AND (s.stack_before, s.eliminated_user_id)
                                < (c.stack_before, c.eliminated_user_id))::integer
                        * interval '1 microsecond'
                 FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                              k.hand_id, k.stack_before, k.eliminated_user_id
                         FROM public.tournament_knockout_candidates k
                        WHERE k.tournament_id = tp.tournament_id
                          AND k.eliminated_user_id = tp.user_id
                          AND k.state = 'eliminated'
                        ORDER BY k.hand_number DESC, k.id DESC
                        LIMIT 1) c
                 LEFT JOIN public.hand_atomic_commits a
                   ON a.table_id = c.table_id
                  AND a.hand_number = c.hand_number
                  AND a.hand_id = c.hand_id
             ), tp.eliminated_at) AS bust_at
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
    ),
    ranked AS (
      SELECT b.id, b.position, b.bust_at,
             row_number() OVER (
               ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
             )::integer + 1 AS expected_position
        FROM busts b
    )
    SELECT 1 FROM ranked WHERE ranked.bust_at IS NULL
       OR ranked.position IS DISTINCT FROM ranked.expected_position)
 THEN RAISE EXCEPTION 'canonical terminal batch has no exact durable standings'; END IF;
 END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',a.place,'amount',a.amount)
   ORDER BY a.place),'[]'::jsonb),COALESCE(sum(a.amount),0),
   count(*) FILTER(WHERE a.amount>0),max(a.place)+1
 INTO v_ladder,v_place_total,v_positive,v_bubble_place
 FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
 IF jsonb_array_length(v_ladder)=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_ladder) a
   WHERE (a->>'amount')::numeric<0 OR (a->>'amount')::numeric<>round((a->>'amount')::numeric,2))
 THEN RAISE EXCEPTION 'canonical terminal batch ladder is invalid'; END IF;
 IF v_t.bubble_protection AND v_bubble_place<=v_field THEN
  v_bubble_amount:=v_t.buy_in_amount;
  IF v_bubble_amount IS NULL OR v_bubble_amount<=0
   OR v_bubble_amount::text IN ('NaN','Infinity','-Infinity')
   OR v_bubble_amount<>round(v_bubble_amount,2)
  THEN RAISE EXCEPTION 'canonical terminal batch Bubble amount is invalid'; END IF;
  SELECT user_id INTO STRICT v_bubble_user FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND position=v_bubble_place AND status='eliminated';
 END IF;
 IF v_place_total+v_bubble_amount IS DISTINCT FROM v_t.prize_pool
 THEN RAISE EXCEPTION 'canonical ladder and Bubble do not allocate one pool'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',(a->>'place')::integer,
  'user_id',tp.user_id,'club_id',tp.club_id,'cents',round((a->>'amount')::numeric*100)::bigint)
  ORDER BY (a->>'place')::integer),'[]'::jsonb) INTO v_plan
 FROM jsonb_array_elements(v_ladder) a JOIN public.tournament_players tp
  ON tp.tournament_id=p_tournament_id AND tp.position=(a->>'place')::integer
 WHERE (a->>'amount')::numeric>0;
 IF jsonb_array_length(v_plan)<>v_positive OR v_b.place_count<>v_positive
  OR v_b.amount_owed IS DISTINCT FROM v_place_total
  OR v_b.plan_fingerprint IS DISTINCT FROM md5(v_plan::text)
  OR v_b.escrow_required<0 OR v_b.escrow_available<v_b.escrow_required
  OR v_b.escrow_required>v_t.prize_pool
  OR v_b.escrow_required<>round(v_b.escrow_required,2)
  OR v_b.escrow_available<>round(v_b.escrow_available,2)
 THEN RAISE EXCEPTION 'canonical terminal batch header or funding proof differs'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_players tp
  LEFT JOIN LATERAL (SELECT (a->>'amount')::numeric AS amount
   FROM jsonb_array_elements(v_ladder) a WHERE (a->>'place')::integer=tp.position) expected ON true
  WHERE tp.tournament_id=p_tournament_id
   AND tp.prize IS DISTINCT FROM COALESCE(expected.amount,
    CASE WHEN tp.user_id=v_bubble_user THEN v_bubble_amount ELSE 0 END))
 THEN RAISE EXCEPTION 'canonical terminal batch prize cache differs'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
  LEFT JOIN public.tournament_obligations o ON o.tournament_id=p_tournament_id
   AND o.kind='place' AND o.place=(a->>'place')::integer
  WHERE o.id IS NULL OR o.user_id IS DISTINCT FROM (a->>'user_id')::uuid
   OR o.amount_owed IS DISTINCT FROM (a->>'cents')::numeric/100
   OR o.amount_paid IS DISTINCT FROM o.amount_owed OR o.settled_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.tournament_obligations o
   WHERE o.tournament_id=p_tournament_id AND o.kind='place'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
     WHERE o.place=(a->>'place')::integer AND o.user_id=(a->>'user_id')::uuid
      AND o.amount_owed=(a->>'cents')::numeric/100))
 THEN RAISE EXCEPTION 'canonical terminal batch obligations differ'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a WHERE
  (SELECT COALESCE(sum(p.amount),0) FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.position=(a->>'place')::integer
    AND p.user_id=(a->>'user_id')::uuid) IS DISTINCT FROM (a->>'cents')::numeric/100)
  OR EXISTS(SELECT 1 FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.position IS NOT NULL AND
    (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
      WHERE p.position=(a->>'place')::integer AND p.user_id=(a->>'user_id')::uuid)
     OR p.amount IS NULL OR p.amount<=0 OR p.amount<>round(p.amount,2)
     OR p.idempotency_key IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key=p.idempotency_key
       AND k.user_id=p.user_id AND k.amount=p.amount)))
 THEN RAISE EXCEPTION 'canonical terminal batch payout or wallet receipt differs'; END IF;
 SELECT count(*) INTO v_bubble_count FROM public.tournament_obligations
  WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
 IF v_bubble_amount>0 THEN
  SELECT * INTO STRICT v_ob FROM public.tournament_obligations
   WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
  IF v_bubble_count<>1 OR v_ob.place IS NOT NULL OR v_ob.user_id IS DISTINCT FROM v_bubble_user
   OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount OR v_ob.amount_paid IS DISTINCT FROM v_bubble_amount
   OR v_ob.settled_at IS NULL
   OR v_ob.source IS NULL
   OR v_ob.source NOT IN ('engine.eliminatePlayer','engine.atomicPlaceSettlement','engine.fn_settle_tournament_places','engine.fn_settle_tournament_bubble_protection')
   OR v_b.bubble_contract_required IS DISTINCT FROM true
   OR v_b.bubble_obligation_id IS DISTINCT FROM v_ob.id
   OR v_b.bubble_user_id IS DISTINCT FROM v_bubble_user
   OR v_b.bubble_source IS DISTINCT FROM v_ob.source
   OR v_b.bubble_amount_owed IS DISTINCT FROM v_bubble_amount
   OR v_b.bubble_amount_paid_before<0 OR v_b.bubble_amount_paid_before>v_bubble_amount
   OR (SELECT COALESCE(sum(amount),0) FROM public.tournament_payouts
    WHERE tournament_id=p_tournament_id AND source='bubble_protection')<>v_bubble_amount
   OR EXISTS(SELECT 1 FROM public.tournament_payouts p
    WHERE p.tournament_id=p_tournament_id AND p.source='bubble_protection'
     AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user OR p.amount<=0
      OR p.amount<>round(p.amount,2) OR p.idempotency_key IS NULL
      OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency k
       WHERE k.key=p.idempotency_key AND k.user_id=p.user_id AND k.amount=p.amount)))
  THEN RAISE EXCEPTION 'canonical terminal batch Bubble proof differs'; END IF;
 ELSIF v_bubble_count<>0 OR v_b.bubble_contract_required IS DISTINCT FROM false
  OR v_b.bubble_obligation_id IS NOT NULL OR v_b.bubble_user_id IS NOT NULL
  OR v_b.bubble_source IS NOT NULL OR v_b.bubble_amount_owed<>0
  OR v_b.bubble_amount_paid_before<>0
  OR EXISTS(SELECT 1 FROM public.tournament_payouts
   WHERE tournament_id=p_tournament_id AND source='bubble_protection')
 THEN RAISE EXCEPTION 'canonical terminal batch has uncontracted Bubble evidence'; END IF;
 SELECT * INTO STRICT v_e FROM public.tournament_escrow WHERE tournament_id=p_tournament_id;
 IF v_e.enforced IS DISTINCT FROM true OR v_e.prize_balance IS DISTINCT FROM 0::numeric
  OR (p_require_terminal AND (v_e.bounty_balance IS DISTINCT FROM 0::numeric
   OR v_e.fee_balance IS DISTINCT FROM 0::numeric OR v_e.closed_at IS NULL
   OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
    WHERE t.tournament_id=p_tournament_id AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'))))
 THEN RAISE EXCEPTION 'canonical terminal batch has open custody or seats'; END IF;
 RETURN jsonb_build_object('ok',true,'contract_version',2,'place_total',v_place_total,
  'bubble_amount',v_bubble_amount,'place_count',v_positive,'plan_fingerprint',v_b.plan_fingerprint);
END;
$function$
$exact_definition$;
 SELECT to_jsonb(p)-ARRAY['prosrc','oid'] INTO after_meta FROM pg_proc p WHERE oid='public.fn_ca_verify_terminal_place_batch(uuid,boolean)'::regprocedure;
 IF before_meta IS DISTINCT FROM after_meta THEN RAISE EXCEPTION 'legacy integration changed function metadata: fn_ca_verify_terminal_place_batch'; END IF;
END $legacy_patch$;
-- This body replacement preserves its existing private caller contract. The
-- prerequisite above refuses ACL drift instead of silently removing a grant.
REVOKE ALL ON FUNCTION public.fn_ca_verify_terminal_place_batch(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) FROM PUBLIC,anon,authenticated;
COMMIT;
