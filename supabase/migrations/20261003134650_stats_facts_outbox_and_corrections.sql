-- 20261003134650_stats_facts_outbox_and_corrections
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 13:46:50 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- Phase 2: exact Stats facts belong to the accepted-hand transaction.
-- Private folded holdings are carried only inside hand_atomic_commits, whose
-- tables/functions are service-owned; they never enter participant-readable
-- hand_history. The existing hand projection outbox remains the single retry
-- owner and cannot delete its claim until these rows are present.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.ca_hand_facts
  ADD COLUMN IF NOT EXISTS source_hash text;

-- `hand_history` is intentionally short-lived while human Stats facts and
-- their projection receipts are retained. A CASCADE erased canonical facts;
-- a NO ACTION constraint blocked the supported history prune. Identity is the
-- immutable hand UUID, not a lifetime relationship to the replay row.
ALTER TABLE public.ca_hand_facts
  DROP CONSTRAINT IF EXISTS ca_hand_facts_hand_id_fkey;

CREATE TABLE public.ca_hand_fact_projection_receipts (
  hand_id uuid PRIMARY KEY,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  fact_count integer NOT NULL CHECK (fact_count BETWEEN 1 AND 10),
  transfer_count integer NOT NULL CHECK (transfer_count BETWEEN 0 AND 90),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.ca_hand_fact_projection_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_hand_fact_projection_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.ca_hand_fact_projection_receipts TO service_role;

-- Replaces the PostgREST FK embed previously used by HandHistoryService.
-- It is deliberately self-only and joins while hand_history still exists;
-- retained facts continue to exist after the replay row is pruned.
CREATE OR REPLACE FUNCTION public.ca_own_hand_history_by_club(
  p_club_id uuid,
  p_table_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(hand jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'ca_own_hand_history_by_club requires authentication' USING ERRCODE='42501';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'ca_own_hand_history_by_club requires a club' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.club_members m
      JOIN public.clubs c ON c.id=m.club_id
     WHERE m.club_id=p_club_id
       AND m.user_id=v_user
       AND m.status IN ('active','approved')
       AND coalesce(c.lifecycle_status,'active')<>'retired'
  ) THEN
    RAISE EXCEPTION 'not authorized for hand-history club' USING ERRCODE='42501';
  END IF;

  RETURN QUERY
  SELECT jsonb_build_object(
      'id',h.id,
      'created_at',h.created_at,
      'started_at',h.started_at,
      'table_id',h.table_id,
      'hand_number',h.hand_number,
      'pot_size',h.pot_size,
      'community_cards',h.community_cards,
      'community_cards2',h.community_cards2,
      'community_cards3',h.community_cards3,
      'rit_boards',h.rit_boards,
      'players',h.players,
      'actions',h.actions,
      'winners',h.winners,
      'winners_by_board',h.winners_by_board,
      'game_variant',h.game_variant,
      'small_blind',h.small_blind,
      'big_blind',h.big_blind,
      'rake_amount',h.rake_amount,
      'bbj_amount',h.bbj_amount,
      'button_seat',h.button_seat,
      -- This is the same participant-visible showdown-only field selected by
      -- the prior query; private folded cards remain only in own fact rows.
      'hole_cards',h.hole_cards,
      'showdown',h.showdown,
      'pots',h.pots,
      'bomb_pot',h.bomb_pot,
      'kill_pot',h.kill_pot
    ) AS hand
    FROM public.hand_history h
   WHERE (p_table_id IS NULL OR h.table_id=p_table_id)
     AND EXISTS (
       SELECT 1
         FROM public.ca_hand_facts f
        WHERE f.hand_id=h.id
          AND f.user_id=v_user
          AND f.club_id=p_club_id
     )
   ORDER BY h.hand_number DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),200)
  OFFSET LEAST(GREATEST(COALESCE(p_offset,0),0),1000000);
END
$function$;

REVOKE ALL ON FUNCTION public.ca_own_hand_history_by_club(uuid,uuid,integer,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_own_hand_history_by_club(uuid,uuid,integer,integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ca_project_hand_stats_facts(p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_stats jsonb;
  v_hash text;
  v_existing_hash text;
  v_facts integer;
  v_transfers integer;
  v_table uuid;
  v_club uuid;
  v_tournament uuid;
  v_conflict jsonb;
BEGIN
  IF current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION 'ca_project_hand_stats_facts is engine/service only' USING ERRCODE='42501';
  END IF;

  SELECT c.post_commit_payload #> '{accepted_hand_facts,stats_facts}',
         c.table_id
    INTO v_stats, v_table
    FROM public.hand_atomic_commits c
   WHERE c.hand_id=p_hand_id
   FOR SHARE OF c;

  -- Rolling protocol-1 receipts predate the private payload. They remain
  -- explicitly unavailable; reconstruction is never invented.
  IF v_stats IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','stats_facts_unavailable','hand_id',p_hand_id);
  END IF;
  IF v_stats->>'version' IS DISTINCT FROM '1'
     OR jsonb_typeof(v_stats->'facts') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_stats->'transfers') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'stats facts refused (invalid_payload_shape)';
  END IF;
  v_facts := jsonb_array_length(v_stats->'facts');
  v_transfers := jsonb_array_length(v_stats->'transfers');
  IF v_facts NOT BETWEEN 1 AND 10 OR v_transfers NOT BETWEEN 0 AND 90 THEN
    RAISE EXCEPTION 'stats facts refused (payload_bounds)';
  END IF;

  -- The accepted-hand receipt is the indefinite source. hand_history is a
  -- prunable replay surface and must not be required by reconciliation.
  -- Derive fact scope from the first validated nonempty payload row, then
  -- bind it to the immutable atomic table and its current owning club.
  SELECT (f->>'club_id')::uuid,
         nullif(f->>'tournament_id','')::uuid
    INTO v_club, v_tournament
    FROM jsonb_array_elements(v_stats->'facts') f
   LIMIT 1;
  IF v_table IS NULL OR v_club IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.tables t WHERE t.id=v_table AND t.club_id=v_club
  ) THEN
    RAISE EXCEPTION 'stats facts refused (atomic_table_scope)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_stats->'facts') f
     WHERE (f->>'hand_id')::uuid IS DISTINCT FROM p_hand_id
        OR (f->>'table_id')::uuid IS DISTINCT FROM v_table
        OR (f->>'club_id')::uuid IS DISTINCT FROM v_club
        OR COALESCE(f->>'tournament_id','') IS DISTINCT FROM COALESCE(v_tournament::text,'')
  ) OR (
    SELECT count(DISTINCT f->>'user_id') FROM jsonb_array_elements(v_stats->'facts') f
  ) IS DISTINCT FROM v_facts THEN
    RAISE EXCEPTION 'stats facts refused (scope_or_duplicate_player)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_stats->'transfers') x
     WHERE (x->>'hand_id')::uuid IS DISTINCT FROM p_hand_id
        OR (x->>'table_id')::uuid IS DISTINCT FROM v_table
        OR (x->>'club_id')::uuid IS DISTINCT FROM v_club
  ) THEN
    RAISE EXCEPTION 'stats facts refused (transfer_scope)';
  END IF;

  v_hash := encode(extensions.digest(convert_to(v_stats::text,'UTF8'),'sha256'),'hex');
  SELECT source_hash INTO v_existing_hash
    FROM public.ca_hand_fact_projection_receipts WHERE hand_id=p_hand_id FOR UPDATE;
  IF FOUND AND v_existing_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'stats facts refused (source_hash_conflict)';
  END IF;

  INSERT INTO public.ca_hand_facts (
    hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,big_blind,
    seat,position,players_dealt,opponent_ids,hole_cards,hand_class,invested,returned,
    net,net_bb,rake_paid,vpip,pfr,three_bet,four_bet,faced_three_bet,
    folded_to_three_bet,had_cbet_flop_opp,cbet_flop,saw_flop,went_to_showdown,
    won_at_showdown,aggressive_actions,passive_actions,was_all_in,all_in_street,
    all_in_at_risk,all_in_equity,ev_returned,ev_net,ev_net_bb,source_hash)
  SELECT f.hand_id,f.user_id,f.club_id,f.table_id,f.tournament_id,f.played_at,
         f.game_variant,f.big_blind,f.seat,f.position,f.players_dealt,f.opponent_ids,
         f.hole_cards,f.hand_class,f.invested,f.returned,f.net,f.net_bb,f.rake_paid,
         f.vpip,f.pfr,f.three_bet,f.four_bet,f.faced_three_bet,f.folded_to_three_bet,
         f.had_cbet_flop_opp,f.cbet_flop,f.saw_flop,f.went_to_showdown,
         f.won_at_showdown,f.aggressive_actions,f.passive_actions,f.was_all_in,
         f.all_in_street,f.all_in_at_risk,f.all_in_equity,f.ev_returned,f.ev_net,
         f.ev_net_bb,v_hash
    FROM jsonb_populate_recordset(NULL::public.ca_hand_facts,v_stats->'facts') f
  ON CONFLICT (hand_id,user_id) DO UPDATE SET
    source_hash=EXCLUDED.source_hash
  WHERE ca_hand_facts.source_hash IS NULL
    AND ca_hand_facts.club_id IS NOT DISTINCT FROM EXCLUDED.club_id
    AND ca_hand_facts.table_id IS NOT DISTINCT FROM EXCLUDED.table_id
    AND ca_hand_facts.invested IS NOT DISTINCT FROM EXCLUDED.invested
    AND ca_hand_facts.returned IS NOT DISTINCT FROM EXCLUDED.returned
    AND ca_hand_facts.net IS NOT DISTINCT FROM EXCLUDED.net
    AND ca_hand_facts.rake_paid IS NOT DISTINCT FROM EXCLUDED.rake_paid;

  SELECT jsonb_build_object(
      'expected',expected-'created_at'-'source_hash'-'all_in_equity_owed',
      'actual',to_jsonb(actual)-'created_at'-'source_hash'-'all_in_equity_owed')
    INTO v_conflict
    FROM jsonb_array_elements(v_stats->'facts') expected
    LEFT JOIN public.ca_hand_facts actual
      ON actual.hand_id=(expected->>'hand_id')::uuid
     AND actual.user_id=(expected->>'user_id')::uuid
    WHERE actual.source_hash IS DISTINCT FROM v_hash
       OR actual.played_at IS DISTINCT FROM (expected->>'played_at')::timestamptz
       OR NOT (
         (to_jsonb(actual)-'created_at'-'source_hash'-'all_in_equity_owed'-'played_at')
         @>
         (expected-'created_at'-'source_hash'-'all_in_equity_owed'-'played_at')
       )
    LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'stats facts refused (existing_fact_conflict)'
      USING DETAIL=v_conflict::text;
  END IF;

  INSERT INTO public.ca_hand_transfers
    (hand_id,winner_id,loser_id,amount,played_at,club_id,table_id)
  SELECT x.hand_id,x.winner_id,x.loser_id,x.amount,x.played_at,x.club_id,x.table_id
    FROM jsonb_populate_recordset(NULL::public.ca_hand_transfers,v_stats->'transfers') x
  ON CONFLICT (hand_id,winner_id,loser_id) DO NOTHING;

  v_conflict:=NULL;
  SELECT jsonb_build_object('expected',expected-'created_at',
      'actual',to_jsonb(actual)-'created_at')
    INTO v_conflict
    FROM jsonb_array_elements(v_stats->'transfers') expected
    LEFT JOIN public.ca_hand_transfers actual
      ON actual.hand_id=(expected->>'hand_id')::uuid
     AND actual.winner_id=(expected->>'winner_id')::uuid
     AND actual.loser_id=(expected->>'loser_id')::uuid
    WHERE actual.played_at IS DISTINCT FROM (expected->>'played_at')::timestamptz
       OR (to_jsonb(actual)-'created_at'-'played_at')
          IS DISTINCT FROM (expected-'created_at'-'played_at')
    LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'stats facts refused (existing_transfer_conflict)'
      USING DETAIL=v_conflict::text;
  END IF;

  INSERT INTO public.ca_hand_fact_projection_receipts
    (hand_id,source_hash,fact_count,transfer_count)
  VALUES (p_hand_id,v_hash,v_facts,v_transfers)
  ON CONFLICT (hand_id) DO NOTHING;

  RETURN jsonb_build_object('ok',true,'hand_id',p_hand_id,'source_hash',v_hash,
    'facts',v_facts,'transfers',v_transfers);
END
$function$;
REVOKE ALL ON FUNCTION public.ca_project_hand_stats_facts(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_project_hand_stats_facts(uuid) TO service_role;

-- Insert the durable fact projection immediately before the legacy stat
-- materialisation. A failure aborts the projector transaction, retaining the
-- outbox row and every prior additive projection in that transaction.
DO $patch_projector$
DECLARE
  v_oid oid := 'public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)'::regprocedure;
  v_def text;
  v_needle text := '  -- Projection 4: exact per-hand stats materialisation and player index.';
  v_insert text := E'  -- Projection 3b: immutable private Stats facts.\n  PERFORM public.ca_project_hand_stats_facts(v_h.id);\n\n';
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF (length(v_def)-length(replace(v_def,v_needle,'')))/length(v_needle) <> 1 THEN
    RAISE EXCEPTION 'stats facts projector patch point drifted';
  END IF;
  EXECUTE replace(v_def,v_needle,v_insert||v_needle);
END
$patch_projector$;

-- No repair/reconcile door exists. The accepted-hand transaction owns a
-- durable outbox row, and its projector persists facts plus an immutable
-- receipt before the claim can be deleted. Protocol-1 history that never
-- carried private facts remains explicitly unavailable; it is not invented.

CREATE TABLE public.ca_hand_fact_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key uuid NOT NULL UNIQUE,
  hand_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('correction','void','refund')),
  source_reference text NOT NULL CHECK (length(btrim(source_reference)) BETWEEN 1 AND 500),
  patch jsonb,
  prior_fact jsonb NOT NULL,
  resulting_fact jsonb,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL DEFAULT current_user
);
CREATE INDEX ca_hand_fact_revisions_hand_user_idx
  ON public.ca_hand_fact_revisions(hand_id,user_id,created_at);
ALTER TABLE public.ca_hand_fact_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_hand_fact_revisions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.ca_hand_fact_revisions TO service_role;

CREATE OR REPLACE FUNCTION public.ca_hand_fact_revisions_are_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
BEGIN RAISE EXCEPTION 'ca_hand_fact_revisions is append-only'; END $$;
CREATE TRIGGER ca_hand_fact_revisions_are_append_only
  BEFORE UPDATE OR DELETE ON public.ca_hand_fact_revisions
  FOR EACH ROW EXECUTE FUNCTION public.ca_hand_fact_revisions_are_append_only();
REVOKE ALL ON FUNCTION public.ca_hand_fact_revisions_are_append_only() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.ca_append_hand_fact_revision(
  p_hand_id uuid,p_user_id uuid,p_kind text,p_patch jsonb,
  p_source_reference text,p_idempotency_key uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions','pg_temp'
AS $function$
DECLARE
  v_fact public.ca_hand_facts%ROWTYPE;
  v_prior jsonb;
  v_result jsonb;
  v_hash text;
  v_existing public.ca_hand_fact_revisions%ROWTYPE;
BEGIN
  IF current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION 'ca_append_hand_fact_revision is service only' USING ERRCODE='42501';
  END IF;
  IF p_idempotency_key IS NULL OR p_kind NOT IN ('correction','void','refund')
     OR length(btrim(COALESCE(p_source_reference,''))) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'hand fact revision refused (invalid_identity)';
  END IF;
  SELECT * INTO v_existing FROM public.ca_hand_fact_revisions
   WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    v_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
      'hand_id',p_hand_id,'user_id',p_user_id,'kind',p_kind,'patch',p_patch,
      'source_reference',p_source_reference)::text,'UTF8'),'sha256'),'hex');
    IF v_existing.source_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'hand fact revision refused (idempotency_conflict)';
    END IF;
    RETURN jsonb_build_object('ok',true,'replay',true,'revision_id',v_existing.id);
  END IF;

  SELECT * INTO v_fact FROM public.ca_hand_facts
   WHERE hand_id=p_hand_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hand fact revision refused (fact_unavailable)'; END IF;
  v_prior:=to_jsonb(v_fact);
  IF p_kind='void' THEN
    IF p_patch IS NOT NULL AND p_patch <> '{}'::jsonb THEN
      RAISE EXCEPTION 'hand fact revision refused (void_has_patch)';
    END IF;
    v_result:=NULL;
  ELSE
    IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR p_patch='{}'::jsonb
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k
                   WHERE k NOT IN ('invested','returned','net','net_bb','rake_paid',
                                   'ev_returned','ev_net','ev_net_bb'))
       OR EXISTS (SELECT 1 FROM jsonb_each(p_patch) e WHERE jsonb_typeof(e.value)<>'number') THEN
      RAISE EXCEPTION 'hand fact revision refused (invalid_patch)';
    END IF;
    v_result:=v_prior||p_patch;
    IF (v_result->>'invested')::numeric<0 OR (v_result->>'returned')::numeric<0
       OR (v_result->>'rake_paid')::numeric<0 OR (v_result->>'big_blind')::numeric<=0
       OR abs((v_result->>'net')::numeric -
              ((v_result->>'returned')::numeric-(v_result->>'invested')::numeric))>0.005
       OR abs((v_result->>'net_bb')::numeric -
              ((v_result->>'net')::numeric/(v_result->>'big_blind')::numeric))>0.005 THEN
      RAISE EXCEPTION 'hand fact revision refused (money_invariant)';
    END IF;
  END IF;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
    'hand_id',p_hand_id,'user_id',p_user_id,'kind',p_kind,'patch',p_patch,
    'source_reference',p_source_reference)::text,'UTF8'),'sha256'),'hex');
  INSERT INTO public.ca_hand_fact_revisions
    (idempotency_key,hand_id,user_id,kind,source_reference,patch,prior_fact,resulting_fact,source_hash)
  VALUES(p_idempotency_key,p_hand_id,p_user_id,p_kind,p_source_reference,p_patch,
         v_prior,v_result,v_hash);

  IF p_kind='void' THEN
    DELETE FROM public.ca_hand_transfers
     WHERE hand_id=p_hand_id AND (winner_id=p_user_id OR loser_id=p_user_id);
    DELETE FROM public.ca_hand_facts WHERE hand_id=p_hand_id AND user_id=p_user_id;
  ELSE
    UPDATE public.ca_hand_facts SET
      invested=(v_result->>'invested')::numeric,
      returned=(v_result->>'returned')::numeric,
      net=(v_result->>'net')::numeric,
      net_bb=(v_result->>'net_bb')::numeric,
      rake_paid=(v_result->>'rake_paid')::numeric,
      ev_returned=CASE WHEN v_result->'ev_returned'='null'::jsonb THEN NULL ELSE (v_result->>'ev_returned')::numeric END,
      ev_net=(v_result->>'ev_net')::numeric,
      ev_net_bb=(v_result->>'ev_net_bb')::numeric,
      source_hash=v_hash
    WHERE hand_id=p_hand_id AND user_id=p_user_id;
    -- Transfers are attribution, not authoritative money. A correction/refund
    -- cannot safely reconstruct side-pot ownership, so remove affected rows
    -- instead of presenting stale opponent flow as exact.
    DELETE FROM public.ca_hand_transfers
     WHERE hand_id=p_hand_id AND (winner_id=p_user_id OR loser_id=p_user_id);
  END IF;
  RETURN jsonb_build_object('ok',true,'replay',false,'source_hash',v_hash,
    'kind',p_kind,'hand_id',p_hand_id,'user_id',p_user_id);
END
$function$;
REVOKE ALL ON FUNCTION public.ca_append_hand_fact_revision(uuid,uuid,text,jsonb,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_append_hand_fact_revision(uuid,uuid,text,jsonb,text,uuid)
  TO service_role;

COMMIT;
