-- Prepared Phase 3 exact final-table-deal consent expansion. NOT APPLIED.
-- Apply this expansion before compatible clients/engine. Activation is separate.
-- The preview reads finalized funding and existing payout rules. It never pays,
-- finalizes, changes standings, or reuses unbound votes as consent.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';

CREATE TABLE public.tournament_deal_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  revision text NOT NULL CHECK (revision ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tournament_id,revision)
);
CREATE TABLE public.tournament_deal_proposal_consents (
  proposal_id uuid NOT NULL REFERENCES public.tournament_deal_proposals(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(proposal_id,user_id)
);
CREATE TABLE public.tournament_deal_proposal_executions (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  proposal_id uuid NOT NULL UNIQUE REFERENCES public.tournament_deal_proposals(id),
  revision text NOT NULL CHECK (revision ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Deadlines are server-owned policy. Clients cannot supply or extend them.
CREATE TABLE public.tournament_deal_review_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  request_seconds integer NOT NULL DEFAULT 120 CHECK(request_seconds BETWEEN 30 AND 900),
  consent_seconds integer NOT NULL DEFAULT 120 CHECK(consent_seconds BETWEEN 30 AND 900)
);
INSERT INTO public.tournament_deal_review_policy(singleton) VALUES(true);
CREATE TABLE public.tournament_deal_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  state text NOT NULL CHECK(state IN ('requested','reviewing','completed','cancelled','expired')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  requested_hand_revision text NOT NULL,
  consumed_hand_revision text,
  expires_at timestamptz NOT NULL,
  manager_lease_generation uuid,
  proposal_id uuid REFERENCES public.tournament_deal_proposals(id),
  revision text,
  closed_at timestamptz,
  CHECK((proposal_id IS NULL)=(revision IS NULL)),
  CHECK(state<>'reviewing' OR (proposal_id IS NOT NULL AND manager_lease_generation IS NOT NULL))
);
CREATE UNIQUE INDEX tournament_deal_one_active_review
  ON public.tournament_deal_reviews(tournament_id) WHERE state IN ('requested','reviewing');
ALTER TABLE public.tournament_deal_review_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_deal_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_deal_review_policy,public.tournament_deal_reviews
  FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.tournament_deal_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_deal_proposal_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_deal_proposal_executions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_deal_proposals,
  public.tournament_deal_proposal_consents,public.tournament_deal_proposal_executions
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_tournament_deal_proposal_is_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public,pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'deal proposal evidence is append-only' USING ERRCODE='23514';
END;
$immutable$;
CREATE TRIGGER tournament_deal_proposal_is_immutable
BEFORE UPDATE OR DELETE ON public.tournament_deal_proposals
FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_deal_proposal_is_immutable();
CREATE TRIGGER tournament_deal_consent_is_immutable
BEFORE UPDATE OR DELETE ON public.tournament_deal_proposal_consents
FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_deal_proposal_is_immutable();
CREATE TRIGGER tournament_deal_execution_is_immutable
BEFORE UPDATE OR DELETE ON public.tournament_deal_proposal_executions
FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_deal_proposal_is_immutable();

-- Owner-only projection. Locks use the existing terminal lane and parent-first
-- order; the canonical place calculator supplies the existing fixed ladder.
CREATE FUNCTION public.fn_ca_tournament_deal_snapshot(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp SET timezone TO 'UTC' AS $snapshot$
DECLARE
  t public.tournaments%ROWTYPE;
  v_live integer; v_field integer; v_chips numeric; v_max_place integer;
  v_pool bigint; v_fixed bigint; v_bubble bigint:=0; v_deal bigint;
  v_assigned bigint; v_shares jsonb; v_ladder jsonb; v_roster jsonb;
  v_seats jsonb; v_hands jsonb; v_paid jsonb; v_snapshot jsonb; v_review_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR t.status::text<>'RUNNING' OR t.final_table_deal_enabled IS NOT TRUE
     OR lower(COALESCE(t.variant::text,''))='satellite'
     OR upper(COALESCE(t.tournament_type::text,''))='SATELLITE'
     OR t.satellite_target_id IS NOT NULL OR t.satellite_target IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','deal_not_ready');
  END IF;
  SELECT id INTO v_review_id FROM public.tournament_deal_reviews WHERE tournament_id=p_tournament_id
    AND state IN ('requested','reviewing') AND manager_lease_generation IS NOT NULL AND expires_at>clock_timestamp();
  IF v_review_id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','review_not_ready'); END IF;
  IF t.prize_pool_finalized IS NOT TRUE OR t.prize_pool IS NULL
     OR t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR t.prize_pool<=0 OR t.prize_pool<>round(t.prize_pool,2)
     OR t.guaranteed_prize::text IN ('NaN','Infinity','-Infinity')
     OR t.prize_pool<COALESCE(t.guaranteed_prize,0) THEN
    RETURN jsonb_build_object('ok',false,'reason','pool_not_finalized');
  END IF;
  PERFORM 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id ORDER BY id FOR UPDATE;
  SELECT count(*),count(*) FILTER(WHERE status::text='playing' AND eliminated_at IS NULL),
    COALESCE(sum(chips) FILTER(WHERE status::text='playing' AND eliminated_at IS NULL),0)
    INTO v_field,v_live,v_chips FROM public.tournament_players WHERE tournament_id=p_tournament_id;
  IF v_live<2 OR v_live>COALESCE(t.table_size,0) OR t.table_size NOT BETWEEN 2 AND 10
     OR v_chips<=0 OR v_chips::text IN ('NaN','Infinity','-Infinity')
     OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
       AND status::text='playing' AND eliminated_at IS NULL
       AND (chips IS NULL OR chips<=0 OR chips::text IN ('NaN','Infinity','-Infinity'))) THEN
    RETURN jsonb_build_object('ok',false,'reason','deal_not_ready');
  END IF;
  IF EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id AND
      ((status::text='playing' AND eliminated_at IS NULL AND (position IS NOT NULL OR elimination_sequence IS NOT NULL))
       OR (NOT(status::text='playing' AND eliminated_at IS NULL)
          AND(status::text<>'eliminated' OR eliminated_at IS NULL OR elimination_sequence IS NULL OR elimination_sequence<=0))))
     OR (SELECT count(DISTINCT elimination_sequence) FROM public.tournament_players
          WHERE tournament_id=p_tournament_id AND status::text='eliminated')<>v_field-v_live THEN
    RETURN jsonb_build_object('ok',false,'reason','standing_evidence_invalid');
  END IF;
  PERFORM 1 FROM public.tables WHERE tournament_id=p_tournament_id ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
    WHERE tb.tournament_id=p_tournament_id ORDER BY s.id FOR SHARE OF s;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('seat_id',s.id,'table_id',s.table_id,
    'user_id',s.user_id,'seat_number',s.seat_number,'joined_at',s.joined_at,
    'stack',s.stack::text) ORDER BY s.id),'[]'::jsonb)
    INTO v_seats FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
    WHERE tb.tournament_id=p_tournament_id AND lower(tb.status::text) IN ('running','waiting')
      AND s.left_at IS NULL AND s.user_id IS NOT NULL;
  IF jsonb_array_length(v_seats)<>v_live
     OR (SELECT count(DISTINCT x->>'table_id') FROM jsonb_array_elements(v_seats)x)<>1
     OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(v_seats)x)<>v_live
     OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
       AND tp.status::text='playing' AND tp.eliminated_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_seats)x
         WHERE x->>'user_id'=tp.user_id::text AND (x->>'stack')::numeric=tp.chips)) THEN
    RETURN jsonb_build_object('ok',false,'reason','seat_snapshot_invalid');
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('place',a.place,'cents',round(a.amount*100)::bigint)
    ORDER BY a.place),'[]'::jsonb),max(a.place)
    INTO v_ladder,v_max_place FROM public.fn_ca_tournament_place_amounts(p_tournament_id)a;
  IF v_max_place IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','payout_plan_invalid'); END IF;
  SELECT COALESCE(sum((x->>'cents')::bigint),0)
    INTO v_fixed FROM jsonb_array_elements(v_ladder)x WHERE (x->>'place')::integer>v_live;
  IF COALESCE(t.bubble_protection,false) AND v_field>v_max_place AND v_max_place+1>v_live THEN
    IF t.buy_in_amount IS NULL OR t.buy_in_amount<=0 OR t.buy_in_amount<>round(t.buy_in_amount,2)
       OR t.buy_in_amount::text IN ('NaN','Infinity','-Infinity') THEN
      RETURN jsonb_build_object('ok',false,'reason','payout_plan_invalid');
    END IF;
    v_bubble:=round(t.buy_in_amount*100)::bigint;
  END IF;
  v_pool:=round(t.prize_pool*100)::bigint; v_deal:=v_pool-v_fixed-v_bubble;
  IF v_deal<=0 THEN RETURN jsonb_build_object('ok',false,'reason','payout_plan_invalid'); END IF;
  WITH ranked AS (
    SELECT user_id,chips,registered_at,row_number() OVER
      (ORDER BY chips DESC,registered_at ASC NULLS LAST,user_id ASC)::integer AS place
      FROM public.tournament_players WHERE tournament_id=p_tournament_id
        AND status::text='playing' AND eliminated_at IS NULL
  ), priced AS (
    SELECT *,floor(chips::numeric*v_deal::numeric/v_chips)::bigint AS cents FROM ranked
  )
  SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'place',place,
    'chips',chips::text,'amount_cents',cents::text) ORDER BY place),sum(cents)
    INTO v_shares,v_assigned FROM priced;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_shares)x WHERE (x->>'amount_cents')::bigint<=0) THEN
    RETURN jsonb_build_object('ok',false,'reason','payout_plan_invalid');
  END IF;
  v_shares:=jsonb_set(v_shares,'{0,amount_cents}',
    to_jsonb(((v_shares->0->>'amount_cents')::bigint+v_deal-v_assigned)::text));
  SELECT jsonb_agg(jsonb_build_object('id',tp.id,'user_id',tp.user_id,'chips',tp.chips::text,
    'registered_at',tp.registered_at,'live',tp.status::text='playing' AND tp.eliminated_at IS NULL,
    'elimination_sequence',tp.elimination_sequence) ORDER BY tp.id)
    INTO v_roster FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table_id',q.table_id,'hand_number',q.hand_number::text)
    ORDER BY q.table_id),'[]'::jsonb) INTO v_hands
    FROM(SELECT h.table_id,max(h.hand_number)hand_number FROM public.hand_atomic_commits h
      JOIN public.tables tb ON tb.id=h.table_id WHERE tb.tournament_id=p_tournament_id GROUP BY h.table_id)q;
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) INTO v_paid
    FROM public.tournament_payouts p WHERE p.tournament_id=p_tournament_id AND p.source<>'final_table_deal';
  v_snapshot:=jsonb_build_object('tournament_id',p_tournament_id,'review_id',v_review_id,
    'club_id',t.club_id,'union_id',t.union_id,'is_private',t.is_private,'pool_cents',v_pool::text,
    'fixed_cents',v_fixed::text,'bubble_cents',v_bubble::text,'deal_cents',v_deal::text,
    'shares',v_shares,'ladder',v_ladder,'roster',v_roster,'seats',v_seats,'hands',v_hands,
    'paid',v_paid,'payout_structure',to_jsonb(t)->'payout_structure',
    'guaranteed_prize',t.guaranteed_prize::text,'bubble_protection',t.bubble_protection,
    'buy_in_amount',t.buy_in_amount::text,'table_size',t.table_size);
  RETURN jsonb_build_object('ok',true,'snapshot',v_snapshot,
    'revision',encode(digest(convert_to(v_snapshot::text,'UTF8'),'sha256'),'hex'));
END;
$snapshot$;

CREATE FUNCTION public.fn_ca_tournament_deal_proposals_active()
RETURNS boolean LANGUAGE sql STABLE SET search_path TO public,pg_temp AS $active$
  SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_obligations'::regclass
    AND tgname='require_exact_final_deal_proposal' AND tgenabled='O'
    AND tgfoid=to_regprocedure('public.fn_require_exact_final_deal_proposal()') AND NOT tgisinternal);
$active$;

CREATE FUNCTION public.fn_get_tournament_deal_proposal(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $get$
DECLARE v_actor uuid:=auth.uid(); v_state jsonb; p public.tournament_deal_proposals%ROWTYPE; v_voters jsonb; r public.tournament_deal_reviews%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF NOT public.fn_ca_tournament_deal_proposals_active() THEN
    RETURN jsonb_build_object('ok',false,'reason','proposal_authority_not_active');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND user_id=v_actor AND status::text='playing' AND eliminated_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','voter_not_alive');
  END IF;
  v_state:=public.fn_ca_tournament_deal_snapshot(p_tournament_id);
  IF (v_state->>'ok')::boolean IS NOT TRUE THEN RETURN v_state; END IF;
  -- Membership can change while the snapshot waits for the terminal lock.
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_state->'snapshot'->'shares')x
    WHERE x->>'user_id'=v_actor::text) THEN
    RETURN jsonb_build_object('ok',false,'reason','voter_not_alive');
  END IF;
  SELECT * INTO r FROM public.tournament_deal_reviews WHERE id=(v_state->'snapshot'->>'review_id')::uuid AND state='reviewing';
  SELECT * INTO p FROM public.tournament_deal_proposals WHERE id=r.proposal_id AND tournament_id=p_tournament_id;
  IF p.id IS NULL OR p.snapshot IS DISTINCT FROM v_state->'snapshot' OR p.revision IS DISTINCT FROM v_state->>'revision' THEN
    RETURN jsonb_build_object('ok',false,'reason','review_stale');
  END IF;
  SELECT COALESCE(jsonb_agg(user_id ORDER BY user_id),'[]'::jsonb) INTO v_voters
    FROM public.tournament_deal_proposal_consents WHERE proposal_id=p.id;
  RETURN jsonb_build_object('ok',true,'actor_id',v_actor,'tournament_id',p_tournament_id,
    'proposal_id',p.id,'revision',p.revision,'state','ready','review_id',r.id,'expires_at',r.expires_at,'shares',p.snapshot->'shares',
    'pool_cents',p.snapshot->'pool_cents','deal_cents',p.snapshot->'deal_cents','voter_ids',v_voters);
END;
$get$;

CREATE FUNCTION public.fn_cast_tournament_deal_vote(p_tournament_id uuid,p_proposal_id uuid,p_expected_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $vote$
DECLARE v_actor uuid:=auth.uid(); v_state jsonb; p public.tournament_deal_proposals%ROWTYPE;
  v_inserted integer; v_wake bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF p_expected_actor_id IS NULL OR v_actor IS DISTINCT FROM p_expected_actor_id THEN
    RETURN jsonb_build_object('ok',false,'reason','actor_mismatch');
  END IF;
  IF NOT public.fn_ca_tournament_deal_proposals_active() THEN
    RETURN jsonb_build_object('ok',false,'reason','proposal_authority_not_active');
  END IF;
  -- Reject outsiders before acquiring the global terminal lock; membership
  -- is checked again against the locked proposal shares below.
  IF NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND user_id=v_actor AND status::text='playing' AND eliminated_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','voter_not_alive');
  END IF;
  v_state:=public.fn_ca_tournament_deal_snapshot(p_tournament_id);
  IF (v_state->>'ok')::boolean IS NOT TRUE THEN RETURN v_state; END IF;
  SELECT * INTO p FROM public.tournament_deal_proposals WHERE id=p_proposal_id AND tournament_id=p_tournament_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','proposal_not_found'); END IF;
  IF p.revision IS DISTINCT FROM v_state->>'revision' OR p.snapshot IS DISTINCT FROM v_state->'snapshot' THEN
    RETURN jsonb_build_object('ok',false,'reason','proposal_stale');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.snapshot->'shares')x WHERE x->>'user_id'=v_actor::text) THEN
    RETURN jsonb_build_object('ok',false,'reason','voter_not_alive');
  END IF;
  INSERT INTO public.tournament_deal_proposal_consents(proposal_id,user_id) VALUES(p.id,v_actor)
    ON CONFLICT(proposal_id,user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  INSERT INTO public.tournament_deal_votes(tournament_id,user_id) VALUES(p_tournament_id,v_actor)
    ON CONFLICT(tournament_id,user_id) DO NOTHING;
  v_wake:=public.fn_emit_tournament_manager_wake(p_tournament_id,'deal_vote');
  RETURN jsonb_build_object('ok',true,'actor_id',v_actor,'proposal_id',p.id,'revision',p.revision,
    'voted',true,'already',v_inserted=0,'wake_id',v_wake);
END;
$vote$;

CREATE FUNCTION public.fn_get_tournament_deal_consensus(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $consensus$
DECLARE v_state jsonb; p public.tournament_deal_proposals%ROWTYPE; v_voters jsonb; v_required integer;
  r public.tournament_deal_reviews%ROWTYPE; v_review_state text; v_identity jsonb;
BEGIN
  IF NOT public.fn_ca_tournament_deal_proposals_active() THEN
    RETURN jsonb_build_object('ok',false,'reason','proposal_authority_not_active');
  END IF;
  -- Expiry is observed only after any admitted terminal transaction resolves.
  PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  SELECT * INTO r FROM public.tournament_deal_reviews WHERE tournament_id=p_tournament_id
    ORDER BY requested_at DESC,id DESC LIMIT 1;
  v_review_state:=CASE WHEN r.id IS NULL THEN 'none'
    WHEN r.state IN ('requested','reviewing') AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.state END;
  v_identity:=jsonb_build_object('ok',true,'review_id',r.id,'review_state',v_review_state,'review_expires_at',r.expires_at,
    'proposal_id',NULL,'revision',NULL,'voter_ids','[]'::jsonb,'required',0,'ready',false);
  IF v_review_state<>'reviewing' THEN RETURN v_identity; END IF;
  v_state:=public.fn_ca_tournament_deal_snapshot(p_tournament_id);
  SELECT * INTO r FROM public.tournament_deal_reviews WHERE id=r.id;
  IF r.state<>'reviewing' OR r.expires_at<=clock_timestamp() THEN
    RETURN v_identity||jsonb_build_object('review_state',CASE WHEN r.state='reviewing' THEN 'expired' ELSE r.state END);
  END IF;
  SELECT * INTO p FROM public.tournament_deal_proposals WHERE id=r.proposal_id;
  v_required:=jsonb_array_length(p.snapshot->'shares');
  SELECT COALESCE(jsonb_agg(c.user_id ORDER BY c.user_id),'[]'::jsonb) INTO v_voters
    FROM public.tournament_deal_proposal_consents c WHERE c.proposal_id=p.id
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.snapshot->'shares')x WHERE x->>'user_id'=c.user_id::text);
  v_identity:=v_identity||jsonb_build_object('proposal_id',p.id,'revision',p.revision,'voter_ids',v_voters,'required',v_required);
  IF (v_state->>'ok')::boolean IS NOT TRUE OR p.snapshot IS DISTINCT FROM v_state->'snapshot'
    OR p.revision IS DISTINCT FROM v_state->>'revision' THEN
    RETURN v_identity||jsonb_build_object('reason','review_stale');
  END IF;
  RETURN v_identity||jsonb_build_object('ready',jsonb_array_length(v_voters)=v_required);
END;
$consensus$;

CREATE FUNCTION public.fn_require_exact_final_deal_proposal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $guard$
DECLARE v_id uuid; v_revision text; v_state jsonb; p public.tournament_deal_proposals%ROWTYPE; v_share jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.kind='final_table_deal' AND ROW(NEW.tournament_id,NEW.kind,NEW.user_id,NEW.place,NEW.amount_owed)
      IS DISTINCT FROM ROW(OLD.tournament_id,OLD.kind,OLD.user_id,OLD.place,OLD.amount_owed) THEN
      RAISE EXCEPTION 'approved final-deal obligation cannot change' USING ERRCODE='23514';
    END IF;
    IF NEW.kind IS NOT DISTINCT FROM OLD.kind THEN RETURN NEW; END IF;
  END IF;
  IF NEW.kind<>'final_table_deal' THEN RETURN NEW; END IF;
  v_id:=NULLIF(current_setting('app.tournament_deal_proposal_id',true),'')::uuid;
  v_revision:=NULLIF(current_setting('app.tournament_deal_proposal_revision',true),'');
  IF v_id IS NULL OR v_revision IS NULL THEN RAISE EXCEPTION 'exact deal proposal context required' USING ERRCODE='42501'; END IF;
  SELECT * INTO p FROM public.tournament_deal_proposals WHERE id=v_id AND tournament_id=NEW.tournament_id AND revision=v_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'deal proposal identity mismatch' USING ERRCODE='23514'; END IF;
  v_state:=public.fn_ca_tournament_deal_snapshot(NEW.tournament_id);
  IF (v_state->>'ok')::boolean IS NOT TRUE OR p.snapshot IS DISTINCT FROM v_state->'snapshot'
     OR p.revision IS DISTINCT FROM v_state->>'revision' THEN
    RAISE EXCEPTION 'deal proposal is stale' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.snapshot->'shares')x WHERE NOT EXISTS(
    SELECT 1 FROM public.tournament_deal_proposal_consents c WHERE c.proposal_id=p.id AND c.user_id=(x->>'user_id')::uuid)) THEN
    RAISE EXCEPTION 'deal proposal lacks unanimous exact consent' USING ERRCODE='23514';
  END IF;
  SELECT x INTO v_share FROM jsonb_array_elements(p.snapshot->'shares')x WHERE x->>'user_id'=NEW.user_id::text;
  IF v_share IS NULL OR NEW.place IS NOT NULL OR NEW.amount_owed IS DISTINCT FROM (v_share->>'amount_cents')::numeric/100
     OR NEW.amount_paid IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'deal obligation differs from approved recipient or amount' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$guard$;

REVOKE ALL ON FUNCTION public.fn_tournament_deal_proposal_is_immutable(),
  public.fn_ca_tournament_deal_snapshot(uuid),public.fn_ca_tournament_deal_proposals_active(),
  public.fn_require_exact_final_deal_proposal() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_get_tournament_deal_proposal(uuid),
  public.fn_cast_tournament_deal_vote(uuid,uuid,uuid),
  public.fn_get_tournament_deal_consensus(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_tournament_deal_proposal(uuid),
  public.fn_cast_tournament_deal_vote(uuid,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_tournament_deal_consensus(uuid) TO service_role;

-- Bind the engine's selected proposal to the existing terminal transaction.
-- Only a successful current terminal receipt creates the durable execution row.
CREATE FUNCTION public.fn_complete_tournament_terminal_proposal(
  p_tournament_id uuid,p_observed_winner_id uuid,p_settlement_mode text,
  p_proposal_id uuid,p_revision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $complete$
DECLARE p public.tournament_deal_proposals%ROWTYPE;
  e public.tournament_deal_proposal_executions%ROWTYPE; v_result jsonb; v_state jsonb; r public.tournament_deal_reviews%ROWTYPE;
  v_old_id text:=current_setting('app.tournament_deal_proposal_id',true);
  v_old_revision text:=current_setting('app.tournament_deal_proposal_revision',true);
BEGIN
  PERFORM public.fn_assert_tournament_manager_write_scope(p_tournament_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF p_settlement_mode IS DISTINCT FROM 'final_table_deal' OR p_observed_winner_id IS NOT NULL
     OR p_proposal_id IS NULL OR p_revision IS NULL THEN
    RAISE EXCEPTION 'exact final-deal proposal request required' USING ERRCODE='22023';
  END IF;
  IF NOT public.fn_ca_tournament_deal_proposals_active() THEN
    RAISE EXCEPTION 'proposal authority is not active' USING ERRCODE='55000';
  END IF;
  SELECT * INTO p FROM public.tournament_deal_proposals WHERE id=p_proposal_id
    AND tournament_id=p_tournament_id AND revision=p_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'deal proposal request identity mismatch' USING ERRCODE='22023'; END IF;
  SELECT * INTO e FROM public.tournament_deal_proposal_executions WHERE tournament_id=p_tournament_id;
  IF FOUND AND (e.proposal_id IS DISTINCT FROM p.id OR e.revision IS DISTINCT FROM p.revision) THEN
    RAISE EXCEPTION 'tournament committed a different deal proposal' USING ERRCODE='22023';
  END IF;
  -- A legacy receipt can be replayed through its old route, but can never be
  -- relabeled as consent to a new proposal.
  IF e.proposal_id IS NULL AND EXISTS(SELECT 1 FROM public.tournaments
    WHERE id=p_tournament_id AND status::text IN ('COMPLETING','COMPLETED')) THEN
    RAISE EXCEPTION 'existing terminal state has no exact proposal execution' USING ERRCODE='55000';
  END IF;
  IF e.proposal_id IS NULL THEN
    SELECT * INTO r FROM public.tournament_deal_reviews WHERE id=(p.snapshot->>'review_id')::uuid AND tournament_id=p_tournament_id FOR UPDATE;
    IF r.state IS DISTINCT FROM 'reviewing' OR r.expires_at<=clock_timestamp()
      OR r.proposal_id IS DISTINCT FROM p.id OR r.revision IS DISTINCT FROM p.revision
      OR r.manager_lease_generation IS DISTINCT FROM NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid THEN
      RAISE EXCEPTION 'exact active review and manager generation required' USING ERRCODE='23514';
    END IF;
    v_state:=public.fn_ca_tournament_deal_snapshot(p_tournament_id);
    IF (v_state->>'ok')::boolean IS NOT TRUE OR p.snapshot IS DISTINCT FROM v_state->'snapshot'
       OR p.revision IS DISTINCT FROM v_state->>'revision' THEN
      RAISE EXCEPTION 'deal proposal is stale' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.snapshot->'shares')x WHERE NOT EXISTS(
      SELECT 1 FROM public.tournament_deal_proposal_consents c WHERE c.proposal_id=p.id
        AND c.user_id=(x->>'user_id')::uuid)) THEN
      RAISE EXCEPTION 'deal proposal lacks unanimous exact consent' USING ERRCODE='23514';
    END IF;
  END IF;
  PERFORM set_config('app.tournament_deal_proposal_id',p.id::text,true);
  PERFORM set_config('app.tournament_deal_proposal_revision',p.revision,true);
  v_result:=public.fn_complete_tournament_terminal(p_tournament_id,p_observed_winner_id,p_settlement_mode);
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR v_result->>'mode' IS DISTINCT FROM 'final_table_deal'
     OR v_result->>'tournament_id' IS DISTINCT FROM p_tournament_id::text THEN
    RAISE EXCEPTION 'terminal authority did not return the requested deal receipt' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.tournament_deal_proposal_executions(tournament_id,proposal_id,revision)
    VALUES(p_tournament_id,p.id,p.revision) ON CONFLICT(tournament_id) DO NOTHING;
  SELECT * INTO STRICT e FROM public.tournament_deal_proposal_executions WHERE tournament_id=p_tournament_id;
  IF e.proposal_id IS DISTINCT FROM p.id OR e.revision IS DISTINCT FROM p.revision THEN
    RAISE EXCEPTION 'terminal receipt proposal binding changed' USING ERRCODE='23514';
  END IF;
  UPDATE public.tournament_deal_reviews SET state='completed',closed_at=clock_timestamp()
    WHERE id=(p.snapshot->>'review_id')::uuid AND state='reviewing' AND proposal_id=p.id AND revision=p.revision;
  PERFORM set_config('app.tournament_deal_proposal_id',COALESCE(v_old_id,''),true);
  PERFORM set_config('app.tournament_deal_proposal_revision',COALESCE(v_old_revision,''),true);
  RETURN v_result||jsonb_build_object('proposal_id',e.proposal_id,'revision',e.revision);
END;
$complete$;

CREATE FUNCTION public.fn_resolve_tournament_terminal_proposal_outcome(
  p_tournament_id uuid,p_observed_winner_id uuid,p_settlement_mode text,
  p_proposal_id uuid,p_revision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $resolve$
DECLARE p public.tournament_deal_proposals%ROWTYPE;
  e public.tournament_deal_proposal_executions%ROWTYPE; v_result jsonb; v_identity jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF p_settlement_mode IS DISTINCT FROM 'final_table_deal' OR p_observed_winner_id IS NOT NULL
     OR p_proposal_id IS NULL OR p_revision IS NULL THEN
    RAISE EXCEPTION 'exact final-deal proposal request required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO p FROM public.tournament_deal_proposals WHERE id=p_proposal_id
    AND tournament_id=p_tournament_id AND revision=p_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'deal proposal request identity mismatch' USING ERRCODE='22023'; END IF;
  SELECT * INTO e FROM public.tournament_deal_proposal_executions WHERE tournament_id=p_tournament_id;
  IF FOUND AND (e.proposal_id IS DISTINCT FROM p.id OR e.revision IS DISTINCT FROM p.revision) THEN
    RAISE EXCEPTION 'different proposal owns the terminal receipt' USING ERRCODE='22023';
  END IF;
  v_result:=public.fn_resolve_tournament_terminal_outcome(p_tournament_id,p_observed_winner_id,p_settlement_mode);
  v_identity:=jsonb_build_object('proposal_id',p.id,'revision',p.revision);
  IF COALESCE((v_result->>'terminal_committed')::boolean,false) THEN
    IF e.proposal_id IS NULL THEN RAISE EXCEPTION 'terminal receipt lacks exact proposal proof' USING ERRCODE='23514'; END IF;
    RETURN jsonb_set(v_result||v_identity,'{receipt}',(v_result->'receipt')||v_identity);
  END IF;
  IF e.proposal_id IS NOT NULL THEN RAISE EXCEPTION 'proposal execution lacks its terminal receipt' USING ERRCODE='23514'; END IF;
  RETURN v_result||v_identity;
END;
$resolve$;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal_proposal(uuid,uuid,text,uuid,text),
  public.fn_resolve_tournament_terminal_proposal_outcome(uuid,uuid,text,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal_proposal(uuid,uuid,text,uuid,text),
  public.fn_resolve_tournament_terminal_proposal_outcome(uuid,uuid,text,uuid,text) TO service_role;
-- Read helpers return stored session identity; a GET never starts a pause.
CREATE FUNCTION public.fn_ca_tournament_deal_hand_revision(p_tournament_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $hand_revision$
  SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(q.id,q.hand_number) ORDER BY q.id),'[]'::jsonb)::text)
  FROM(SELECT tb.id,COALESCE(max(h.hand_number),-1) AS hand_number FROM public.tables tb
    LEFT JOIN public.hand_atomic_commits h ON h.table_id=tb.id WHERE tb.tournament_id=p_tournament_id GROUP BY tb.id)q;
$hand_revision$;

CREATE FUNCTION public.fn_ca_tournament_deal_review_result(
  p_tournament_id uuid,p_actor_id uuid,p_review_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $review_result$
DECLARE r public.tournament_deal_reviews%ROWTYPE; v_state text;
BEGIN
  SELECT * INTO r FROM public.tournament_deal_reviews
    WHERE tournament_id=p_tournament_id AND (p_review_id IS NULL OR id=p_review_id)
    ORDER BY requested_at DESC,id DESC LIMIT 1;
  v_state:=CASE WHEN r.id IS NULL THEN 'none'
    WHEN r.state IN ('requested','reviewing') AND r.expires_at<=clock_timestamp() THEN 'expired'
    ELSE r.state END;
  RETURN jsonb_build_object('ok',true,'actor_id',p_actor_id,'tournament_id',p_tournament_id,
    'review_id',r.id,'state',v_state,'expires_at',r.expires_at,
    'proposal_id',CASE WHEN v_state='reviewing' THEN r.proposal_id ELSE NULL END,
    'revision',CASE WHEN v_state='reviewing' THEN r.revision ELSE NULL END);
END;
$review_result$;

CREATE FUNCTION public.fn_get_tournament_deal_review(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $review_get$
DECLARE v_actor uuid:=auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF NOT public.fn_ca_tournament_deal_proposals_active() THEN
    RETURN jsonb_build_object('ok',false,'reason','proposal_authority_not_active');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id AND user_id=v_actor) THEN
    RETURN jsonb_build_object('ok',false,'reason','voter_not_alive');
  END IF;
  RETURN public.fn_ca_tournament_deal_review_result(p_tournament_id,v_actor);
END;
$review_get$;

CREATE FUNCTION public.fn_request_tournament_deal_review(p_tournament_id uuid,p_expected_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $review_request$
DECLARE v_actor uuid:=auth.uid(); r public.tournament_deal_reviews%ROWTYPE; v_seconds integer; v_hand_revision text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF p_expected_actor_id IS NULL OR v_actor IS DISTINCT FROM p_expected_actor_id THEN
    RETURN jsonb_build_object('ok',false,'reason','actor_mismatch');
  END IF;
  IF NOT public.fn_ca_tournament_deal_proposals_active() THEN
    RETURN jsonb_build_object('ok',false,'reason','proposal_authority_not_active');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND user_id=v_actor AND status::text='playing' AND eliminated_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','voter_not_alive');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND user_id=v_actor AND status::text='playing' AND eliminated_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','voter_not_alive');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=p_tournament_id
    AND t.status::text='RUNNING' AND t.final_table_deal_enabled IS TRUE
    AND t.prize_pool_finalized IS TRUE AND lower(COALESCE(t.variant::text,''))<>'satellite'
    AND upper(COALESCE(t.tournament_type::text,''))<>'SATELLITE'
    AND t.satellite_target_id IS NULL AND t.satellite_target IS NULL
    AND (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id=t.id
      AND tp.status::text='playing' AND tp.eliminated_at IS NULL) BETWEEN 2 AND t.table_size) THEN
    RETURN jsonb_build_object('ok',false,'reason','deal_not_ready');
  END IF;
  UPDATE public.tournament_deal_reviews SET state='expired',closed_at=clock_timestamp()
    WHERE tournament_id=p_tournament_id AND state IN ('requested','reviewing') AND expires_at<=clock_timestamp();
  SELECT * INTO r FROM public.tournament_deal_reviews
    WHERE tournament_id=p_tournament_id AND state IN ('requested','reviewing');
  IF r.id IS NULL THEN
    v_hand_revision:=public.fn_ca_tournament_deal_hand_revision(p_tournament_id);
    IF EXISTS(SELECT 1 FROM public.tournament_deal_reviews old WHERE old.tournament_id=p_tournament_id
      AND COALESCE(old.consumed_hand_revision,old.requested_hand_revision)=v_hand_revision) THEN
      RETURN jsonb_build_object('ok',false,'reason','review_wait_for_next_hand');
    END IF;
    SELECT request_seconds INTO STRICT v_seconds FROM public.tournament_deal_review_policy WHERE singleton;
    INSERT INTO public.tournament_deal_reviews(tournament_id,requested_by,state,expires_at,requested_hand_revision)
      VALUES(p_tournament_id,v_actor,'requested',clock_timestamp()+make_interval(secs=>v_seconds),v_hand_revision) RETURNING * INTO r;
    PERFORM public.fn_emit_tournament_manager_wake(p_tournament_id,'deal_vote');
  END IF;
  RETURN public.fn_ca_tournament_deal_review_result(p_tournament_id,v_actor,r.id);
END;
$review_request$;

CREATE FUNCTION public.fn_cancel_tournament_deal_review(p_tournament_id uuid,p_review_id uuid,p_expected_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $review_cancel$
DECLARE v_actor uuid:=auth.uid(); r public.tournament_deal_reviews%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF p_expected_actor_id IS NULL OR v_actor IS DISTINCT FROM p_expected_actor_id THEN
    RETURN jsonb_build_object('ok',false,'reason','actor_mismatch');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND user_id=v_actor) THEN
    RETURN jsonb_build_object('ok',false,'reason','voter_not_alive');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  SELECT * INTO r FROM public.tournament_deal_reviews WHERE id=p_review_id AND tournament_id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','review_not_found'); END IF;
  IF r.state NOT IN ('requested','reviewing') THEN
    RETURN public.fn_ca_tournament_deal_review_result(p_tournament_id,v_actor,r.id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND user_id=v_actor AND status::text='playing' AND eliminated_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','voter_not_alive');
  END IF;
  IF r.state IN ('requested','reviewing') THEN
    IF EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=p_tournament_id AND t.status::text IN ('COMPLETING','COMPLETED')) THEN
      RETURN jsonb_build_object('ok',false,'reason','terminal_outcome_pending');
    END IF;
    UPDATE public.tournament_deal_reviews SET state=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'cancelled' END,
      closed_at=clock_timestamp() WHERE id=r.id;
    PERFORM public.fn_emit_tournament_manager_wake(p_tournament_id,'deal_vote');
  END IF;
  RETURN public.fn_ca_tournament_deal_review_result(p_tournament_id,v_actor,r.id);
END;
$review_cancel$;

CREATE FUNCTION public.fn_begin_tournament_deal_review(p_tournament_id uuid,p_review_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $review_begin$
DECLARE r public.tournament_deal_reviews%ROWTYPE; v_state jsonb; v_seconds integer;
  p public.tournament_deal_proposals%ROWTYPE; v_generation uuid;
BEGIN
  PERFORM public.fn_assert_tournament_manager_write_scope(p_tournament_id);
  v_generation:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  SELECT * INTO r FROM public.tournament_deal_reviews WHERE id=p_review_id AND tournament_id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','review_not_found'); END IF;
  IF r.state<>'completed' AND NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=p_tournament_id AND t.status::text='RUNNING') THEN
    RETURN jsonb_build_object('ok',false,'reason','terminal_outcome_pending');
  END IF;
  IF r.state IN ('requested','reviewing') AND r.expires_at<=clock_timestamp() THEN
    UPDATE public.tournament_deal_reviews SET state='expired',closed_at=clock_timestamp() WHERE id=r.id;
  ELSIF r.state='requested' THEN
    SELECT consent_seconds INTO STRICT v_seconds FROM public.tournament_deal_review_policy WHERE singleton;
    -- The engine has parked before this request. Keep requested until the
    -- proposal exists so the table's reviewing invariant holds at each write.
    UPDATE public.tournament_deal_reviews SET manager_lease_generation=v_generation,
      expires_at=clock_timestamp()+make_interval(secs=>v_seconds),
      consumed_hand_revision=public.fn_ca_tournament_deal_hand_revision(p_tournament_id) WHERE id=r.id;
    v_state:=public.fn_ca_tournament_deal_snapshot(p_tournament_id);
    IF (v_state->>'ok')::boolean IS NOT TRUE OR NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(v_state->'snapshot'->'shares')x WHERE x->>'user_id'=r.requested_by::text) THEN
      UPDATE public.tournament_deal_reviews SET state='cancelled',closed_at=clock_timestamp() WHERE id=r.id;
    ELSE
      INSERT INTO public.tournament_deal_proposals(tournament_id,revision,snapshot)
        VALUES(p_tournament_id,v_state->>'revision',v_state->'snapshot') RETURNING * INTO p;
      UPDATE public.tournament_deal_reviews SET state='reviewing',proposal_id=p.id,revision=p.revision WHERE id=r.id;
    END IF;
  ELSIF r.state='reviewing' THEN
    v_state:=public.fn_ca_tournament_deal_snapshot(p_tournament_id);
    SELECT * INTO p FROM public.tournament_deal_proposals WHERE id=r.proposal_id;
    IF (v_state->>'ok')::boolean IS TRUE AND p.snapshot=v_state->'snapshot' AND p.revision=v_state->>'revision' THEN
      UPDATE public.tournament_deal_reviews SET manager_lease_generation=v_generation WHERE id=r.id;
    END IF;
  END IF;
  SELECT * INTO r FROM public.tournament_deal_reviews WHERE id=p_review_id AND tournament_id=p_tournament_id;
  IF r.state NOT IN ('requested','reviewing') THEN
    RETURN jsonb_build_object('ok',true,'review_id',r.id,'review_state',r.state,'review_expires_at',r.expires_at,
      'proposal_id',NULL,'revision',NULL,'voter_ids','[]'::jsonb,'required',0,'ready',false);
  END IF;
  RETURN public.fn_get_tournament_deal_consensus(p_tournament_id);
END;
$review_begin$;

CREATE FUNCTION public.fn_close_tournament_deal_review(p_tournament_id uuid,p_review_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $review_close$
DECLARE r public.tournament_deal_reviews%ROWTYPE;
BEGIN
  PERFORM public.fn_assert_tournament_manager_write_scope(p_tournament_id);
  IF p_reason IS NULL OR p_reason NOT IN ('stale','expired','cancelled') THEN
    RAISE EXCEPTION 'review close reason is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  SELECT * INTO r FROM public.tournament_deal_reviews WHERE id=p_review_id AND tournament_id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','review_not_found'); END IF;
  IF r.state<>'completed' AND NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=p_tournament_id AND t.status::text='RUNNING') THEN
    RETURN jsonb_build_object('ok',false,'reason','terminal_outcome_pending');
  END IF;
  IF r.state IN ('requested','reviewing') THEN
    IF p_reason='expired' AND r.expires_at>clock_timestamp() THEN
      RETURN jsonb_build_object('ok',false,'reason','review_not_expired');
    END IF;
    IF EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=p_tournament_id AND t.status::text IN ('COMPLETING','COMPLETED'))
      OR EXISTS(SELECT 1 FROM public.tournament_deal_proposal_executions e
      WHERE e.tournament_id=p_tournament_id AND e.proposal_id=r.proposal_id) THEN
      RAISE EXCEPTION 'committed review cannot close without its completed state' USING ERRCODE='23514';
    END IF;
    UPDATE public.tournament_deal_reviews SET state=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'cancelled' END,
      closed_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('ok',true,'review_id',r.id,'review_state',r.state,'review_expires_at',r.expires_at,
    'proposal_id',NULL,'revision',NULL,'voter_ids','[]'::jsonb,'required',0,'ready',false);
END;
$review_close$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_deal_hand_revision(uuid),public.fn_ca_tournament_deal_review_result(uuid,uuid,uuid),
  public.fn_get_tournament_deal_review(uuid),public.fn_request_tournament_deal_review(uuid,uuid),
  public.fn_cancel_tournament_deal_review(uuid,uuid,uuid),public.fn_begin_tournament_deal_review(uuid,uuid),
  public.fn_close_tournament_deal_review(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_tournament_deal_review(uuid),public.fn_request_tournament_deal_review(uuid,uuid),
  public.fn_cancel_tournament_deal_review(uuid,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_deal_review(uuid,uuid),
  public.fn_close_tournament_deal_review(uuid,uuid,text) TO service_role;

INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
  ('fn_complete_tournament_terminal_proposal','approved',
   'Service-only exact review/proposal wrapper; preserves the native terminal money transaction and binds its durable receipt. Activation and compatible engine adoption are separate gates.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
COMMIT;
