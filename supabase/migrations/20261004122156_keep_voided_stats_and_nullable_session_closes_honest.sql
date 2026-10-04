-- 20261004122156_keep_voided_stats_and_nullable_session_closes_honest.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Serialize the repair with every fact revision and session close. Calls
-- already in flight finish before these locks; new writers resume only after
-- the replacement functions and committed-revision cleanup are visible.
LOCK TABLE public.ca_hand_fact_revisions, public.ca_hand_facts,
  public.ca_hand_player_stat, public.ca_hand_player_idx,
  public.ca_hand_transfers, public.cash_player_session
  IN SHARE ROW EXCLUSIVE MODE;

-- A revision is one serialized operation, and its legacy projections must
-- agree with the exact fact. Otherwise a void disappears from a club-scoped
-- read while surviving in All Clubs, lifetime counts and notable hands.
DO $patch$
DECLARE
  v_def text;
  v_anchor text;
BEGIN
  v_def := pg_get_functiondef(
    'public.ca_append_hand_fact_revision(uuid,uuid,text,jsonb,text,uuid)'::regprocedure
  );

  v_anchor := $a$  SELECT * INTO v_existing FROM public.ca_hand_fact_revisions
   WHERE idempotency_key=p_idempotency_key;$a$;
  IF (length(v_def)-length(replace(v_def,v_anchor,''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'revision idempotency anchor drifted';
  END IF;
  v_def := replace(v_def,v_anchor,
    $a$  PERFORM pg_advisory_xact_lock(hashtextextended(
    'ca-hand-fact-revision:'||p_idempotency_key::text,0));
  SELECT * INTO v_existing FROM public.ca_hand_fact_revisions
   WHERE idempotency_key=p_idempotency_key;$a$);

  v_anchor := $a$    DELETE FROM public.ca_hand_facts WHERE hand_id=p_hand_id AND user_id=p_user_id;$a$;
  IF (length(v_def)-length(replace(v_def,v_anchor,''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'revision void projection anchor drifted';
  END IF;
  v_def := replace(v_def,v_anchor,$a$    DELETE FROM public.ca_hand_facts WHERE hand_id=p_hand_id AND user_id=p_user_id;
    DELETE FROM public.ca_hand_player_stat WHERE hand_id=p_hand_id AND user_id=p_user_id;
    DELETE FROM public.ca_hand_player_idx WHERE hand_id=p_hand_id AND user_id=p_user_id;$a$);

  v_anchor := $a$    -- Transfers are attribution, not authoritative money. A correction/refund$a$;
  IF (length(v_def)-length(replace(v_def,v_anchor,''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'revision correction projection anchor drifted';
  END IF;
  v_def := replace(v_def,v_anchor,$a$    UPDATE public.ca_hand_player_stat SET
      won_amt=(v_result->>'returned')::numeric,
      profit=(v_result->>'net')::numeric,
      is_winner=((v_result->>'net')::numeric>0)
    WHERE hand_id=p_hand_id AND user_id=p_user_id;
    -- Transfers are attribution, not authoritative money. A correction/refund$a$);
  EXECUTE v_def;
END;
$patch$;

-- These triggers were replaced by 20261003142109. Refuse to overwrite another
-- later semantic change: direct trigger replacement without a preimage pin is
-- how the Diamond custody exclusion was lost.
DO $preflight$
BEGIN
  IF md5(pg_get_functiondef(
       'public.trg_fn_close_session_when_seat_vacated()'::regprocedure
     )) <> 'a1137da38352e8f10551d980a983adb5' THEN
    RAISE EXCEPTION 'seat-vacate session trigger preimage drifted';
  END IF;
  IF md5(pg_get_functiondef(
       'public.trg_fn_close_sessions_when_table_closes()'::regprocedure
     )) <> '131a2ad259f458399b0be506f91f86a5' THEN
    RAISE EXCEPTION 'table-close session trigger preimage drifted';
  END IF;
END;
$preflight$;

-- Close events must never manufacture an exact zero from an unknown stack.
CREATE OR REPLACE FUNCTION public.trg_fn_close_session_when_seat_vacated()
RETURNS trigger LANGUAGE plpgsql SET search_path='public' AS $function$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  -- Diamond Arena seats are admission receipts, not chip cash sessions. Keep
  -- the exclusion installed by 20260910023541 when replacing this trigger.
  IF EXISTS (
    SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
     WHERE t.id=NEW.table_id AND c.asset='diamonds'
  ) THEN
    RETURN NULL;
  END IF;
  IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id=NEW.table_id AND t.tournament_id IS NULL) THEN
    UPDATE public.cash_player_session
       SET closed_at=v_now, closed_reason='seat_vacated',
           final_stack=CASE WHEN NEW.stack IS NULL THEN NULL ELSE round(greatest(NEW.stack,0),2) END,
           final_stack_captured_at=CASE WHEN NEW.stack IS NULL THEN NULL ELSE v_now END,
           financial_capture_status=CASE WHEN NEW.stack IS NULL THEN 'partial' ELSE 'exact' END,
           close_table_id=NEW.table_id
     WHERE player_id=NEW.user_id AND scope_type='table'
       AND scope_id=NEW.table_id AND closed_at IS NULL;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_fn_close_sessions_when_table_closes()
RETURNS trigger LANGUAGE plpgsql SET search_path='public' AS $function$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF (NEW.status='closed' AND OLD.status IS DISTINCT FROM 'closed')
     OR (coalesce(NEW.is_deleted,false) AND NOT coalesce(OLD.is_deleted,false)) THEN
    WITH closing AS MATERIALIZED (
      SELECT s.id,seat.stack
        FROM public.cash_player_session s
        JOIN LATERAL (
          SELECT ts.stack FROM public.table_seats ts
           WHERE ts.table_id=NEW.id AND ts.user_id=s.player_id AND ts.left_at IS NULL
           ORDER BY ts.joined_at DESC NULLS LAST,ts.id DESC LIMIT 1
        ) seat ON true
       WHERE s.scope_type='table' AND s.scope_id=NEW.id AND s.closed_at IS NULL
    )
    UPDATE public.cash_player_session s
       SET closed_at=v_now,closed_reason='table_closed',
           final_stack=CASE WHEN closing.stack IS NULL THEN NULL ELSE round(greatest(closing.stack,0),2) END,
           final_stack_captured_at=CASE WHEN closing.stack IS NULL THEN NULL ELSE v_now END,
           financial_capture_status=CASE WHEN closing.stack IS NULL THEN 'partial' ELSE 'exact' END,
           close_table_id=NEW.id
      FROM closing WHERE s.id=closing.id;

    UPDATE public.cash_player_session s
       SET closed_at=v_now,closed_reason='table_closed',final_stack=NULL,
           final_stack_captured_at=NULL,financial_capture_status='partial',close_table_id=NEW.id
     WHERE s.scope_type='table' AND s.scope_id=NEW.id AND s.closed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- An open session overlaps every later range until it closes. The old
-- coalesce-to-opened_at predicate dropped long-running sessions.
DO $patch$
DECLARE v_def text; v_anchor text := '(v_from IS NULL OR coalesce(s.closed_at,s.opened_at)>=v_from)';
BEGIN
  v_def := pg_get_functiondef(
    'public.ca_player_stats_cash_sessions(uuid,uuid,integer,text,text,integer)'::regprocedure
  );
  IF (length(v_def)-length(replace(v_def,v_anchor,''))) / length(v_anchor) <> 2 THEN
    RAISE EXCEPTION 'cash session overlap predicate drifted';
  END IF;
  EXECUTE replace(v_def,v_anchor,
    '(v_from IS NULL OR coalesce(s.closed_at,''infinity''::timestamptz)>v_from)');
END;
$patch$;

-- A session evidence URL is asset-scoped. A Diamond request must never open a
-- chip session merely because the caller owns the opaque session UUID.
DO $patch$
DECLARE v_def text; v_anchor text;
BEGIN
  v_def := pg_get_functiondef(
    'public.ca_player_stats_hand_evidence(uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,boolean,boolean,text,boolean,text,uuid,timestamptz,uuid,integer)'::regprocedure
  );
  v_anchor := '  PERFORM public.ca_assert_self(p_user);';
  IF (length(v_def)-length(replace(v_def,v_anchor,''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'session evidence self assertion drifted';
  END IF;
  v_def := replace(v_def,v_anchor,v_anchor||E'\n  IF p_asset IS NULL OR p_asset NOT IN (''chips'',''diamonds'') THEN\n    RAISE EXCEPTION ''unknown stats asset: %'',p_asset USING ERRCODE=''22023'';\n  END IF;');
  v_anchor := $a$     AND coalesce(c.lifecycle_status,'active')<>'retired'
     AND (p_club_id IS NULL OR s.club_id=p_club_id);$a$;
  IF (length(v_def)-length(replace(v_def,v_anchor,''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'session evidence asset authorization anchor drifted';
  END IF;
  v_def := replace(v_def,v_anchor,$a$     AND coalesce(c.lifecycle_status,'active')<>'retired'
     AND coalesce(c.asset,'chips')=p_asset
     AND (p_club_id IS NULL OR s.club_id=p_club_id);$a$);
  EXECUTE v_def;
END;
$patch$;

-- Preferences may order real owner tabs, never invent or remove features.
CREATE OR REPLACE FUNCTION public.fn_ca_stats_workspace_preferences_save(
  p_dashboard_layout jsonb DEFAULT '[]'::jsonb,
  p_privacy_presentation_mode boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_user uuid := auth.uid(); v_layout jsonb := coalesce(p_dashboard_layout,'[]'::jsonb);
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(v_layout)<>'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_layout) e
       WHERE jsonb_typeof(e)<>'string' OR e#>>'{}' NOT IN
         ('overview','performance','positions','hands','tournaments','analysis','trophies','rake'))
     OR (SELECT count(*) FROM jsonb_array_elements(v_layout)) <>
        (SELECT count(DISTINCT e#>>'{}') FROM jsonb_array_elements(v_layout) e)
  THEN RAISE EXCEPTION 'invalid_dashboard_layout' USING ERRCODE='22023'; END IF;
  INSERT INTO public.ca_stats_workspace_preferences
    (user_id,dashboard_layout,privacy_presentation_mode)
  VALUES (v_user,v_layout,coalesce(p_privacy_presentation_mode,false))
  ON CONFLICT (user_id) DO UPDATE SET dashboard_layout=EXCLUDED.dashboard_layout,
    privacy_presentation_mode=EXCLUDED.privacy_presentation_mode,updated_at=now();
  RETURN true;
END;
$function$;

-- Bounded repair from immutable revision receipts only. The table locks above
-- make this the complete set committed before the new revision function is
-- visible.
DELETE FROM public.ca_hand_transfers t USING public.ca_hand_fact_revisions r
 WHERE r.kind='void' AND t.hand_id=r.hand_id
   AND (t.winner_id=r.user_id OR t.loser_id=r.user_id);
DELETE FROM public.ca_hand_facts f USING public.ca_hand_fact_revisions r
 WHERE r.kind='void' AND f.hand_id=r.hand_id AND f.user_id=r.user_id;
DELETE FROM public.ca_hand_player_stat s USING public.ca_hand_fact_revisions r
 WHERE r.kind='void' AND s.hand_id=r.hand_id AND s.user_id=r.user_id;
DELETE FROM public.ca_hand_player_idx i USING public.ca_hand_fact_revisions r
 WHERE r.kind='void' AND i.hand_id=r.hand_id AND i.user_id=r.user_id;
WITH latest AS (
  SELECT DISTINCT ON (r.hand_id,r.user_id)
    r.hand_id,r.user_id,r.kind,r.resulting_fact
  FROM public.ca_hand_fact_revisions r
  ORDER BY r.hand_id,r.user_id,r.created_at DESC,r.id DESC
)
UPDATE public.ca_hand_player_stat s SET
  won_amt=(latest.resulting_fact->>'returned')::numeric,
  profit=(latest.resulting_fact->>'net')::numeric,
  is_winner=((latest.resulting_fact->>'net')::numeric>0)
FROM latest
WHERE latest.kind IN ('correction','refund')
  AND latest.resulting_fact IS NOT NULL
  AND s.hand_id=latest.hand_id AND s.user_id=latest.user_id;

REVOKE ALL ON FUNCTION public.ca_append_hand_fact_revision(uuid,uuid,text,jsonb,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_append_hand_fact_revision(uuid,uuid,text,jsonb,text,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.ca_player_stats_cash_sessions(uuid,uuid,integer,text,text,integer)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_cash_sessions(uuid,uuid,integer,text,text,integer)
  TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.ca_player_stats_hand_evidence(
  uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,
  boolean,boolean,text,boolean,text,uuid,timestamptz,uuid,integer
) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_hand_evidence(
  uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,
  boolean,boolean,text,boolean,text,uuid,timestamptz,uuid,integer
) TO authenticated,service_role;

COMMIT;
