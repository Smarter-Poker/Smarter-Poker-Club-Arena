-- Owner 2026-10-20: add 0.50/1.00 NLH and every PLO variation in Midway,
-- for Classic, Action and Madness, alongside the existing games.
-- Only this host and rung get a separate catalog key. Horse stake bands,
-- template promises, wallets, seats and other hosts retain their contracts.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE OR REPLACE FUNCTION public.fn_cash_game_category_key(
  p_club uuid, p_variant text, p_sb numeric, p_bb numeric
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO public, pg_temp
AS $$
  SELECT CASE WHEN p_club = 'fade0000-0000-0000-0000-000000000001'::uuid
    AND p_variant IN ('nlh','plo4','plo5','plo6','plo8')
    AND p_sb = 0.50 AND p_bb = 1.00 THEN 'half_one'
    ELSE public.fn_cash_stake_band(p_bb) END;
$$;
REVOKE ALL ON FUNCTION public.fn_cash_game_category_key(uuid,text,numeric,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_category_key(uuid,text,numeric,numeric) TO authenticated, service_role;

-- Acquire the writer lock before changing either guard. If a live transaction
-- holds it, fail promptly and leave the original guard/index fully intact.
LOCK TABLE public.cash_games IN SHARE ROW EXCLUSIVE MODE;
CREATE UNIQUE INDEX cash_games_category_key_action_madness
  ON public.cash_games (club_id, template_name, variant,
    public.fn_cash_game_category_key(club_id, variant, sb, bb))
  WHERE enabled AND template_name IN ('action','madness');

CREATE OR REPLACE FUNCTION public.fn_guard_one_game_per_blind_category()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE v_existing text;
BEGIN
  IF NOT NEW.enabled OR NEW.template_name NOT IN ('action', 'madness') THEN RETURN NEW; END IF;
  SELECT g.name || ' (' || g.sb || '/' || g.bb || ')' INTO v_existing
  FROM public.cash_games g
  WHERE g.enabled AND g.id <> NEW.id AND g.club_id = NEW.club_id
    AND g.template_name = NEW.template_name AND g.variant = NEW.variant
    AND public.fn_cash_game_category_key(g.club_id,g.variant,g.sb,g.bb)
      = public.fn_cash_game_category_key(NEW.club_id,NEW.variant,NEW.sb,NEW.bb)
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION
      'ONE_GAME_PER_BLIND_CATEGORY: this club already runs % as its % % game. Close it before opening another.',
      v_existing, initcap(NEW.template_name), public.fn_cash_stake_band(NEW.bb)
      USING ERRCODE = 'unique_violation',
      HINT = 'One Action or Madness game per category; Midway NLH/PLO 0.50/1.00 has its own category.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER zz_one_game_per_blind_category ON public.cash_games;
CREATE TRIGGER zz_one_game_per_blind_category
  BEFORE INSERT OR UPDATE OF enabled,template_name,variant,sb,bb,club_id
  ON public.cash_games FOR EACH ROW EXECUTE FUNCTION public.fn_guard_one_game_per_blind_category();
DROP INDEX public.cash_games_one_per_band_action_madness;
-- Keep the historical index identity for existing readers and diagnostics.
ALTER INDEX public.cash_games_category_key_action_madness RENAME TO cash_games_one_per_band_action_madness;
REVOKE ALL ON FUNCTION public.fn_guard_one_game_per_blind_category() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_guard_one_game_per_blind_category() TO service_role;
COMMIT;
