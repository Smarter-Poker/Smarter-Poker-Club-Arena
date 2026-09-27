-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815165118 "seed_bounty_heads_on_every_registration_path"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ba76c0997ae82187b646417ce642053c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- VISIBLE FIX 2026-08-15: bounty badges never appear on any table.
-- TablePage already loads a bountyMap from tournament_players.current_bounty
-- and SeatSlot already renders a target badge for it — but the ONLY path that
-- ever sets current_bounty is fn_register_for_tournament, and the recurring /
-- horse seeder inserts tournament_players DIRECTLY. Since horses are almost
-- the entire field, current_bounty is 0 everywhere, the map is empty, and the
-- badge is never drawn. Same root cause leaves bounty_pool unfunded.
--
-- One trigger fixes both, on EVERY insert path (RPC, horse seeder, admin):
-- seed the head and fund the pool by the same amount, so the invariant
-- sum(heads) == bounty_pool holds by construction.

CREATE OR REPLACE FUNCTION public.trg_seed_bounty_head()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_head numeric; v_mystery numeric := 0; v_roll numeric; v_mult numeric;
BEGIN
  -- Already seeded by fn_register_for_tournament: nothing to do.
  IF COALESCE(NEW.current_bounty, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT is_bounty, is_pko, is_mystery_bounty, bounty_amount
    INTO v_t FROM tournaments WHERE id = NEW.tournament_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN NEW;
  END IF;

  v_head := round(COALESCE(v_t.bounty_amount, 0), 2);
  IF v_head <= 0 THEN RETURN NEW; END IF;

  -- Mystery: seal a head from the jackpot ladder (EV exactly 1x the bounty,
  -- so the pool funds the heads in aggregate).
  IF COALESCE(v_t.is_mystery_bounty, false) THEN
    v_roll := random() * 100;
    IF    v_roll < 60 THEN v_mult := 0.5;
    ELSIF v_roll < 85 THEN v_mult := 1;
    ELSIF v_roll < 95 THEN v_mult := 2;
    ELSIF v_roll < 99 THEN v_mult := 3;
    ELSE                   v_mult := 13;
    END IF;
    v_mystery := round(v_head * v_mult, 2);
    v_head := v_mystery;
  END IF;

  UPDATE tournament_players
     SET current_bounty = v_head,
         mystery_bounty_value = CASE WHEN v_mystery > 0 THEN v_mystery
                                     ELSE mystery_bounty_value END
   WHERE id = NEW.id;

  -- Fund the pool by this entrant's bounty contribution.
  UPDATE tournaments
     SET bounty_pool = round(COALESCE(bounty_pool, 0) + round(COALESCE(v_t.bounty_amount,0), 2), 2)
   WHERE id = NEW.tournament_id;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS seed_bounty_head ON public.tournament_players;
CREATE TRIGGER seed_bounty_head
  AFTER INSERT ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.trg_seed_bounty_head();

-- ── Backfill every LIVE bounty tournament so badges appear immediately ──
DO $$
DECLARE r RECORD; v_head numeric; v_roll numeric; v_mult numeric; v_n integer := 0;
BEGIN
  FOR r IN
    SELECT tp.id, tp.user_id, t.id AS tid, t.bounty_amount, t.is_mystery_bounty
      FROM tournament_players tp
      JOIN tournaments t ON t.id = tp.tournament_id
     WHERE t.status IN ('RUNNING','REGISTERING','ANNOUNCED')
       AND (t.is_bounty OR t.is_pko OR t.is_mystery_bounty)
       AND COALESCE(t.bounty_amount,0) > 0
       AND COALESCE(tp.current_bounty,0) = 0
       AND tp.status IN ('registered','playing')
  LOOP
    v_head := round(r.bounty_amount, 2);
    IF COALESCE(r.is_mystery_bounty,false) THEN
      v_roll := random() * 100;
      IF    v_roll < 60 THEN v_mult := 0.5;
      ELSIF v_roll < 85 THEN v_mult := 1;
      ELSIF v_roll < 95 THEN v_mult := 2;
      ELSIF v_roll < 99 THEN v_mult := 3;
      ELSE                   v_mult := 13;
      END IF;
      v_head := round(r.bounty_amount * v_mult, 2);
      UPDATE tournament_players SET current_bounty = v_head, mystery_bounty_value = v_head
       WHERE id = r.id;
    ELSE
      UPDATE tournament_players SET current_bounty = v_head WHERE id = r.id;
    END IF;
    UPDATE tournaments
       SET bounty_pool = round(COALESCE(bounty_pool,0) + round(r.bounty_amount,2), 2)
     WHERE id = r.tid;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'seeded % live bounty heads', v_n;
END $$;
