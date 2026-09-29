-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260720040152 "promo_playthrough_release_20260719"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b0082dad44ce8021477d0c9f3d121197 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PROMO-PLAY 2026-07-19 — makes granted promo usable via playthrough, safely.
-- Promo lives in club_members.promo_balance (non-cashable, set by the promo
-- grant with promo_playthrough_required = 3x). This RPC accrues the player's
-- per-hand wagering into promo_wagered and, once promo_wagered >=
-- promo_playthrough_required, RELEASES the promo bonus into the cashable
-- chip_balance. Promo never enters a table stack (no drain risk from mixing);
-- the player unlocks the bonus by genuinely playing with their real chips. Once
-- released, promo_balance is zeroed so it can never re-release. No-op when the
-- member has no outstanding promo.
CREATE OR REPLACE FUNCTION public.promo_apply_playthrough(
  p_club_id uuid, p_user_id uuid, p_wagered numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_promo    numeric;
  v_required numeric;
  v_wagered  numeric;
  v_released numeric := 0;
BEGIN
  IF p_wagered IS NULL OR p_wagered <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_wager');
  END IF;

  SELECT COALESCE(promo_balance, 0), COALESCE(promo_playthrough_required, 0), COALESCE(promo_wagered, 0)
    INTO v_promo, v_required, v_wagered
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
   FOR UPDATE;

  -- Nothing outstanding to unlock.
  IF v_promo IS NULL OR v_promo <= 0 OR v_required <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_outstanding_promo');
  END IF;

  v_wagered := v_wagered + p_wagered;

  IF v_wagered >= v_required THEN
    -- Playthrough met: release the bonus to cashable chip_balance. Zero the promo
    -- fields so it can never release twice.
    v_released := v_promo;
    UPDATE club_members
       SET chip_balance               = COALESCE(chip_balance, 0) + v_promo::integer,
           promo_balance              = 0,
           promo_playthrough_required = 0,
           promo_wagered              = 0,
           updated_at                 = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;

    INSERT INTO chip_transactions (id, club_id, to_user_id, amount, transaction_type, notes, created_at)
    VALUES (gen_random_uuid(), p_club_id, p_user_id, v_released, 'promo_released',
            'Promo bonus released to cashable balance after playthrough met', NOW());
  ELSE
    UPDATE club_members
       SET promo_wagered = v_wagered, updated_at = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('applied', true, 'released', v_released,
                            'wagered', v_wagered, 'required', v_required);
END;
$function$;
