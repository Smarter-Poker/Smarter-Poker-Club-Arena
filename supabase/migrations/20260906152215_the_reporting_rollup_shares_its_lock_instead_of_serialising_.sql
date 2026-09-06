-- THE REPORTING ROLLUP SHARES ITS LOCK INSTEAD OF SERIALISING EVERY CHIP MOVEMENT.
--
-- ROOT CAUSE, read from the Postgres log for the 24 hours to 2026-09-06 15:15
-- UTC: 2,731 waits of more than a second on ONE advisory lock,
-- [5,0,918273645,1]; 2,916 statements cancelled by statement_timeout; 875
-- deadlocks; 6,969 row-lock waits over a second. The three "WINNER prize
-- credit failed after 3 retries" alerts at 12:47 and 12:52 were
-- fn_settle_tournament_obligation timing out behind it, and the reconciler
-- paid those winners 28 minutes late. Every one of the 13 heads-up events
-- whose 2nd/3rd place the escrow shadow filed today (H2) is downstream of the
-- same queue.
--
-- The lock is taken by trg_ca_reporting_wallet_insert, AFTER INSERT ON
-- wallet_transactions, and trg_ca_reporting_rake_insert, AFTER INSERT ON
-- rake_records, as pg_advisory_xact_lock(918273645): one EXCLUSIVE,
-- transaction-scoped lock for the whole platform, held from the first wallet
-- or rake row a transaction writes until that transaction commits. Every
-- buy-in, cash-out, prize, bounty, refund and tournament rake row on the
-- platform therefore queues behind every other one, and any transaction that
-- holds it while it waits for a row that another transaction holds - while
-- THAT transaction waits to write its own wallet row - is a deadlock. The
-- [918273645] cycles in the log are exactly that shape: fn_repair_seat_first_
-- games holding it against fn_seat_horse_in_seat_first_game (a FOR UPDATE on
-- tournaments), and atomic_deduct_wallet_and_log (club_members FOR UPDATE)
-- against a buy-in.
--
-- WHAT THE LOCK IS FOR. It keeps the two incremental rollups (ca_club_player_
-- daily, ca_club_tournament_daily and ca_club_tournament_player_daily) from
-- interleaving with the two range REBUILDS, ca_refresh_reporting_rollups_base
-- and ca_refresh_reporting_cash_rollup, which DELETE a date range and
-- recompute it. That is a many-readers / one-writer relationship, and
-- Postgres has a lock mode for it: the rebuilds keep the EXCLUSIVE lock; the
-- triggers take pg_advisory_xact_lock_SHARED(918273645). Shared holders never
-- block each other, so two chip movements no longer queue on a global
-- counter; a rebuild waits for in-flight triggers and blocks new ones only
-- for its own duration, which is the serialisation that was ever needed.
--
-- The rows the triggers upsert are still locked per (club, user, day) by ON
-- CONFLICT DO UPDATE, which is the correct granularity. The tournament loop
-- is ORDERED BY club_id so two credits to players of the same event lock its
-- ca_club_tournament_daily rows in one order.
--
-- Nothing else changes: same rows written, same amounts, same failure
-- handling (the trigger has always swallowed its own errors into a WARNING
-- rather than fail the money row - unchanged, and now it has far fewer to
-- swallow). No cron, no sweep, no reconciliation: the write path itself
-- stops queueing.
--
-- Dan, 2026-09-06: "I WANT HARD CODED FIXES FOR THINGS THAT BREAK ... FIXED
-- AT THE ROOT CAUSE AND STOPPED FROM HAPPENING AGAIN."

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_wallet_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid; v_union uuid; v_table_club uuid; v_is_tournament_table boolean; v_day date;
  v_cash numeric:=0; v_tournament numeric:=0; r record;
BEGIN
  -- 2026-09-04: a table add-on (top-up), a rebuy and a refund move cash-table
  -- money too, and a tournament add-on, rebuy, refund or prize reversal moves
  -- tournament money; this knew buy-in, cash-out, tournament buy-in, prize
  -- and bounty alone. A row with a table is cash; a row with a tournament and
  -- no table is tournament. The sign is the row's own type, never its name.
  IF NOT ((NEW.category IN('buyin','cashout','addon','rebuy','refund') AND NEW.table_id IS NOT NULL)
    OR (NEW.category IN('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
        AND NEW.related_entity_id IS NOT NULL AND NEW.table_id IS NULL))
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive (20260906152215). The exclusive form serialised
     every chip movement on the platform behind one lock and held it to
     commit: 2,731 waits over a second in one day, 2,916 statement timeouts,
     and the deadlock cycles that failed prize credits. Shared holders never
     block each other; only the range rebuilds take the exclusive lock, and
     they still wait for every in-flight trigger before they delete a day. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.table_id IS NOT NULL THEN
    SELECT t.union_id,t.club_id,(t.tournament_id IS NOT NULL)
      INTO v_union,v_table_club,v_is_tournament_table
      FROM public.tables t WHERE t.id=NEW.table_id;
    IF v_is_tournament_table THEN RETURN NULL; END IF;
    IF v_union IS NULL THEN
      -- A standalone table: the club is the table's club.
      v_club:=v_table_club;
    ELSE
      SELECT cm.club_id INTO v_club FROM public.club_members cm
        JOIN public.union_clubs uc ON uc.club_id=cm.club_id AND uc.union_id=v_union
       WHERE cm.user_id=NEW.user_id
       ORDER BY cm.joined_at ASC NULLS LAST,cm.club_id LIMIT 1;
    END IF;
    v_cash:=CASE WHEN NEW.type='credit' THEN NEW.amount
                 WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    IF v_club IS NOT NULL THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(v_club,NEW.user_id,v_day,v_cash,0,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET cash_net=d.cash_net+EXCLUDED.cash_net,updated_at=now();
    END IF;
  ELSE
    v_tournament:=CASE WHEN NEW.type='credit' THEN NEW.amount
                       WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    /* ORDER BY club_id: two credits to players of the same event upsert the
       shared ca_club_tournament_daily rows in one order, so they wait on each
       other instead of cycling. */
    FOR r IN SELECT c.club_id FROM public.ca_reporting_tournament_clubs_for_user(NEW.user_id) c
              ORDER BY c.club_id LOOP
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(r.club_id,NEW.user_id,v_day,0,v_tournament,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET tournament_net=d.tournament_net+EXCLUDED.tournament_net,updated_at=now();
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,winnings,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,v_day,v_tournament,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET winnings=d.winnings+EXCLUDED.winnings,updated_at=now();
      INSERT INTO public.ca_club_tournament_player_daily
        (club_id,tournament_id,user_id,stat_date,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,NEW.user_id,v_day,now())
      ON CONFLICT(club_id,tournament_id,user_id,stat_date) DO UPDATE SET updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data wallet rollup failed for tx %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_rake_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_day date; r record;
BEGIN
  IF NOT NEW.is_tournament OR NEW.tournament_id IS NULL OR NEW.rake_amount=0
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive - see trg_ca_reporting_wallet_insert and
     20260906152215. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.metadata ? 'user_id' THEN
    FOR r IN
      SELECT c.club_id FROM public.tournament_players tp
      CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
      WHERE tp.tournament_id=NEW.tournament_id
        AND tp.user_id::text=NEW.metadata->>'user_id'
      ORDER BY c.club_id
    LOOP
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,NEW.rake_amount,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  ELSE
    FOR r IN
      WITH total AS (SELECT count(*)::numeric n FROM public.tournament_players
                      WHERE tournament_id=NEW.tournament_id), mapped AS (
        SELECT c.club_id FROM public.tournament_players tp
        CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
        WHERE tp.tournament_id=NEW.tournament_id)
      SELECT m.club_id,count(*)::numeric AS club_players,t.n AS total_players
        FROM mapped m CROSS JOIN total t GROUP BY m.club_id,t.n
       ORDER BY m.club_id
    LOOP
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,
             NEW.rake_amount*r.club_players/NULLIF(r.total_players,0),now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data rake rollup failed for row %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------
-- PROVE THE SHAPE: the two triggers take the shared form, the two rebuilds
-- keep the exclusive one, and nothing else on the platform takes either.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE v_bad text; v_n int;
BEGIN
  SELECT string_agg(proname, ', ') INTO v_bad
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('trg_ca_reporting_wallet_insert', 'trg_ca_reporting_rake_insert')
     AND prosrc !~ 'pg_advisory_xact_lock_shared\(918273645\)';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: trigger(s) still take the exclusive reporting lock: %', v_bad;
  END IF;

  SELECT string_agg(proname, ', ') INTO v_bad
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('ca_refresh_reporting_rollups_base', 'ca_refresh_reporting_cash_rollup')
     AND prosrc !~ 'pg_advisory_xact_lock\(918273645\)';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: rebuild(s) no longer take the exclusive reporting lock: %', v_bad;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND prosrc ~ '918273645'
     AND proname NOT IN ('trg_ca_reporting_wallet_insert', 'trg_ca_reporting_rake_insert',
                         'ca_refresh_reporting_rollups_base', 'ca_refresh_reporting_cash_rollup');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % other function(s) reference the reporting lock; read them before applying', v_n;
  END IF;

  -- The triggers are still attached where they were.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ca_reporting_wallet_insert'
                    AND tgrelid = 'public.wallet_transactions'::regclass AND tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ca_reporting_rake_insert'
                    AND tgrelid = 'public.rake_records'::regclass AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'VERIFY FAILED: a reporting trigger is not attached and enabled';
  END IF;

  RAISE NOTICE 'REPORTING_LOCK_SHARED triggers shared, rebuilds exclusive, no other takers';
END $verify$;

COMMIT;
