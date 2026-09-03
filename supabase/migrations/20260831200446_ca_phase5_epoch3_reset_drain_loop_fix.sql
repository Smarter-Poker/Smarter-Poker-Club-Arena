-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831200446; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ca_phase5_epoch3_reset_drain_loop_fix (prod 20260831200446). Canonical body lives in prod schema_migrations -
-- replace this marker byte-exact via scripts/dev/export-applied-migrations.sh.
-- Phase 5 fixup: mint retirement drains a user's club balances largest-first until fully retired.

-- ZERO-DRIFT phase 5 fixup (caught in self-review before any execution): the
-- epoch-3 horse-mint retirement drained at most ONE club wallet per user and
-- could under-retire. It now walks each minted user's club balances largest-
-- first, debiting until the measured mint is fully retired or the balances
-- run out, every debit ledgered as 'burn' vs chip_retirement.
DO $$
DECLARE v_def text; v_new text; v_old_block text; v_new_block text;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_execute_epoch3_reset(text,boolean)'::regprocedure);
  v_old_block :=
'  FOR r IN SELECT m.user_id, m.minted FROM _mint m WHERE m.minted > 0 LOOP
    -- cap at what the wallet still holds across clubs, largest balances first
    FOR v_take IN
      SELECT LEAST(cm.chip_balance, r.minted) FROM public.club_members cm
       WHERE cm.user_id = r.user_id AND cm.chip_balance > 0
       ORDER BY cm.chip_balance DESC LIMIT 1
    LOOP
      UPDATE public.club_members cm
         SET chip_balance = round(chip_balance - v_take, 2), updated_at = now()
       WHERE cm.user_id = r.user_id
         AND cm.club_id = (SELECT cm2.club_id FROM public.club_members cm2
                            WHERE cm2.user_id = r.user_id AND cm2.chip_balance > 0
                            ORDER BY cm2.chip_balance DESC LIMIT 1);
      v_retired_mint := v_retired_mint + v_take;
    END LOOP;
  END LOOP;';
  v_new_block :=
'  FOR r IN SELECT m.user_id, m.minted FROM _mint m WHERE m.minted > 0 LOOP
    DECLARE
      v_left numeric := r.minted; v_club uuid; v_bal numeric;
    BEGIN
      -- drain the user''s club balances largest-first until the measured
      -- mint is retired or the balances run out; each debit is ledgered
      LOOP
        EXIT WHEN v_left <= 0;
        SELECT cm.club_id, cm.chip_balance INTO v_club, v_bal
          FROM public.club_members cm
         WHERE cm.user_id = r.user_id AND cm.chip_balance > 0
         ORDER BY cm.chip_balance DESC LIMIT 1
         FOR UPDATE;
        EXIT WHEN v_club IS NULL;
        v_take := LEAST(v_bal, v_left);
        UPDATE public.club_members
           SET chip_balance = round(chip_balance - v_take, 2), updated_at = now()
         WHERE user_id = r.user_id AND club_id = v_club;
        v_retired_mint := v_retired_mint + v_take;
        v_left := round(v_left - v_take, 2);
        v_club := NULL;
      END LOOP;
    END;
  END LOOP;';
  IF position(v_old_block in v_def) = 0 THEN
    IF v_def LIKE '%drain the user%' THEN RETURN; END IF; -- already fixed
    RAISE EXCEPTION 'epoch3 drain fix: anchor not found';
  END IF;
  v_new := replace(v_def, v_old_block, v_new_block);
  EXECUTE v_new;
END $$;
