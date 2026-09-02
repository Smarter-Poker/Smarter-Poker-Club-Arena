-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902212622; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- An omitted field means "unchanged", never NULL.
--
-- fn_update_managed_game's table branch validated the patch like this:
--
--   IF (p_patch->>'small_blind')::numeric <= 0 OR ... THEN
--     RETURN invalid_table_limits;
--   END IF;
--   UPDATE public.tables SET small_blind = (p_patch->>'small_blind')::numeric, ...
--
-- When the patch omits those keys, `p_patch->>'small_blind'` is NULL, so the
-- comparison is NULL, so the whole OR-chain is NULL, so the guard does not
-- fire - and the UPDATE then writes NULL into small_blind, big_blind,
-- min_buy_in, max_buy_in, and (through GREATEST(2, NULL)) max_players. A guard
-- written to reject bad limits silently permits no limits at all.
--
-- It is reachable. The board omits those fields whenever IT believes the table
-- is locked, and its rule is not the server's: the client locks on the
-- contract (any occupied table_seats row) OR status running/active, while this
-- function locks on current_players > 0 OR status running/active. A table with
-- an occupied seat row and a zero counter is locked to the client and unlocked
-- here, so the client sends name-only and this writes NULL limits. 20 tables
-- were in exactly that state when this was found, and the board offers Edit on
-- closed games, which is how an operator reaches them.
--
-- Checked before fixing: 0 of 2,154 tables have NULL structure today. This is
-- a live hazard that had not fired yet, not damage being repaired.
--
-- The fix is the rule the name field already followed: a key the patch does
-- not carry is not being changed. Every structural value is COALESCEd to what
-- the row already holds, the guard validates the EFFECTIVE values rather than
-- the raw patch, and the UPDATE writes those. A name-only patch on an unlocked
-- table now does what it says - it changes the name.
--
-- The tournament branch had the same shape in GREATEST(2, (p_patch->>
-- 'max_players')::int) and is COALESCEd the same way. Its own registration
-- guard is deliberately stricter than a counter and is left exactly as it was.
--
-- Authorisation, the seat/registration locks and every returned reason code
-- are unchanged. This only stops a write that nobody asked for.

BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fn_update_managed_game(
  p_kind text, p_game_id uuid, p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid(); v_club uuid; v_players int; v_status text; v_name text;
  v_sb numeric; v_bb numeric; v_min numeric; v_max numeric; v_seats int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF p_kind='table' THEN
    SELECT club_id,current_players,status INTO v_club,v_players,v_status FROM public.tables WHERE id=p_game_id FOR UPDATE;
  ELSIF p_kind='tournament' THEN
    SELECT club_id,current_players,status INTO v_club,v_players,v_status FROM public.tournaments WHERE id=p_game_id FOR UPDATE;
  ELSE RETURN jsonb_build_object('ok',false,'reason','invalid_game_kind'); END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','game_not_found'); END IF;
  IF NOT public.fn_can_create_games(v_club,v_uid) THEN RETURN jsonb_build_object('ok',false,'reason','not_authorized'); END IF;
  v_name:=left(regexp_replace(COALESCE(p_patch->>'name',''),'\s+',' ','g'),80);
  IF length(trim(v_name))=0 THEN RETURN jsonb_build_object('ok',false,'reason','name_required'); END IF;
  IF p_kind='table' THEN
    IF v_players>0 OR lower(v_status) IN ('running','active') THEN
      UPDATE public.tables SET name=v_name,updated_at=now() WHERE id=p_game_id;
    ELSE
      -- An omitted key keeps the stored value. Validate what would actually be
      -- written, so the guard can never be skipped by leaving a field out.
      SELECT COALESCE((p_patch->>'small_blind')::numeric, t.small_blind),
             COALESCE((p_patch->>'big_blind')::numeric,   t.big_blind),
             COALESCE((p_patch->>'min_buy_in')::numeric,  t.min_buy_in),
             COALESCE((p_patch->>'max_buy_in')::numeric,  t.max_buy_in),
             COALESCE((p_patch->>'max_players')::int,     t.max_players)
        INTO v_sb, v_bb, v_min, v_max, v_seats
        FROM public.tables t WHERE t.id=p_game_id;
      IF v_sb IS NULL OR v_bb IS NULL OR v_min IS NULL OR v_max IS NULL OR v_seats IS NULL
         OR v_sb<=0 OR v_bb<v_sb OR v_min<=0 OR v_max<v_min THEN
        RETURN jsonb_build_object('ok',false,'reason','invalid_table_limits');
      END IF;
      UPDATE public.tables SET name=v_name,small_blind=v_sb,big_blind=v_bb,
        min_buy_in=v_min,max_buy_in=v_max,
        max_players=LEAST(10,GREATEST(2,v_seats)),updated_at=now()
      WHERE id=p_game_id;
    END IF;
  ELSE
    -- Once even one real player registers, the advertised tournament contract
    -- is immutable. This is intentionally stricter than a current_players
    -- counter because a stale counter must never reopen the edit path.
    IF EXISTS (
      SELECT 1 FROM public.tournament_players tp
      WHERE tp.tournament_id=p_game_id AND tp.user_id IS NOT NULL
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','players_registered');
    END IF;
    IF upper(v_status) NOT IN ('ANNOUNCED','REGISTERING','SCHEDULED') THEN
      RETURN jsonb_build_object('ok',false,'reason','already_started');
    END IF;
    UPDATE public.tournaments SET name=v_name,
      max_players=GREATEST(2,COALESCE((p_patch->>'max_players')::int,max_players)),
      start_time=COALESCE((p_patch->>'start_time')::timestamptz,start_time),
      updated_at=now()
    WHERE id=p_game_id;
  END IF;
  RETURN jsonb_build_object('ok',true);
END
$fn$;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='fn_update_managed_game'
      AND p.prosecdef
      AND p.prosrc LIKE '%An omitted key keeps the stored value%'
  ) THEN
    RAISE EXCEPTION 'fn_update_managed_game lost the omitted-field guard or its security-definer flag';
  END IF;
  IF has_function_privilege('anon','public.fn_update_managed_game(text,uuid,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'fn_update_managed_game is reachable by anon';
  END IF;
END;
$assert$;

COMMIT;
