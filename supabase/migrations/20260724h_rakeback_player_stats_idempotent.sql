-- 20260724h_rakeback_player_stats_idempotent.sql
-- RAKE-AUDIT 2026-07-24 [money-adjacent] P1: RakebackSettlerService section 2c
-- refreshed player_stats.hands_played/total_rake with a JS read-then-update
-- aggregate. That increment was NON-idempotent: a crash between the increment
-- and saveHighWaterMark() left the watermark un-advanced, so the next cycle
-- re-read the SAME rake_records and RE-INCREMENTED player_stats (the exact class
-- of bug the audit flagged for users/agents). Fix: make the per-(rake_record,
-- user) stat application exactly-once in ONE transaction (claim-then-increment),
-- so re-scanning already-processed rows is a safe no-op regardless of the
-- watermark. rakeback_periods was already recompute-from-source (idempotent) and
-- agent commission already dedupes; player_stats was the last non-idempotent leg.

-- Per-(rake_record, user) claim ledger.
CREATE TABLE IF NOT EXISTS public.rakeback_stats_applied (
  rake_record_id uuid NOT NULL,
  user_id        uuid NOT NULL,
  hands          integer,
  rake           numeric,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rake_record_id, user_id)
);
ALTER TABLE public.rakeback_stats_applied ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rakeback_stats_applied FROM PUBLIC;
GRANT SELECT, INSERT ON public.rakeback_stats_applied TO service_role;

CREATE OR REPLACE FUNCTION public.apply_rakeback_player_stats(
  p_rake_record_id uuid,
  p_user_id uuid,
  p_club_id uuid,
  p_hands integer,
  p_rake numeric
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer;
BEGIN
  IF p_rake_record_id IS NULL OR p_user_id IS NULL OR p_club_id IS NULL THEN
    RETURN false;
  END IF;

  -- Exactly-once claim for this (rake_record, user). Claim + increment share one
  -- transaction, so a rollback frees the claim for a genuine retry, while a
  -- committed claim blocks any re-increment on a watermark re-scan.
  INSERT INTO public.rakeback_stats_applied (rake_record_id, user_id, hands, rake)
  VALUES (p_rake_record_id, p_user_id, p_hands, p_rake)
  ON CONFLICT (rake_record_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN false;  -- already applied — idempotent no-op
  END IF;

  INSERT INTO public.player_stats (
    user_id, club_id, hands_played, total_rake,
    total_winnings, total_losses, vpip, pfr, tournaments_played, tournaments_won
  ) VALUES (
    p_user_id, p_club_id, COALESCE(p_hands, 0), COALESCE(p_rake, 0),
    0, 0, 0, 0, 0, 0
  )
  ON CONFLICT (user_id, club_id) DO UPDATE SET
    hands_played = public.player_stats.hands_played + EXCLUDED.hands_played,
    total_rake   = ROUND((public.player_stats.total_rake + EXCLUDED.total_rake) * 100) / 100,
    updated_at   = NOW();

  RETURN true;
END;
$function$;

ALTER FUNCTION public.apply_rakeback_player_stats(uuid, uuid, uuid, integer, numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_rakeback_player_stats(uuid, uuid, uuid, integer, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_rakeback_player_stats(uuid, uuid, uuid, integer, numeric) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_rakeback_player_stats(uuid, uuid, uuid, integer, numeric) TO postgres, service_role;
