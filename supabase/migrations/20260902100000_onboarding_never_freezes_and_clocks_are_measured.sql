-- ═══════════════════════════════════════════════════════════════════════════
--  JOINING A CLUB IS NOT A CHIP MOVEMENT, AND CLOCK SKEW GETS MEASURED
--  Restart to-do list (#2563) items 1 and 4. Single transaction per DDL policy.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ITEM 1. The freeze guard refused every INSERT on club_members, and
-- fn_join_club INSERTs a membership row - so a brand-new player trying to
-- join a club during the :55 break hit PLATFORM_FROZEN at the door. Dan's
-- rule is "no chip movements"; a membership row with a zero balance moves no
-- chips. The guard now lets a ZERO-BALANCE club_members INSERT through and
-- keeps refusing everything else on that table: a nonzero-balance INSERT is
-- minting, an UPDATE that touches chip_balance is movement, and a DELETE
-- destroys a wallet. Seat inserts are unaffected - they live on table_seats.
--
-- ITEM 4. Three clocks now cooperate on the freeze: the engine writes
-- break_ends_at from ITS clock, fn_platform_frozen compares it against the
-- DATABASE's NOW(), and the browser counts down on a third. NTP keeps them
-- close, and nothing would notice if it stopped - a 15-second skew would
-- refuse a player's rebuy moments after play visibly resumed. fn_db_now gives
-- the engine a one-round-trip way to measure the skew, publish it on /health,
-- and alarm past a threshold. Read-only, SECURITY INVOKER, harmless.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_refuse_while_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  col  TEXT;
  changed BOOLEAN := FALSE;
  v_claims TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        changed := TRUE;
        EXIT;
      END IF;
    END LOOP;
    IF NOT changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ONBOARDING NEVER FREEZES (to-do #2563 item 1). A membership row carrying
  -- no chips is identity, not money: refusing it made every new player who
  -- tapped Join during a break bounce off PLATFORM_FROZEN. Scoped as tightly
  -- as the exemption can be written - this table, INSERT only, zero balance.
  IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'chip_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- The engine (service_role via PostgREST) is exempt: it is frozen by its
  -- own machinery and must keep its SIGTERM flush and boot bookkeeping
  -- working. What this trigger stops is everything that does NOT stop when
  -- the engine dies: browsers, legacy PUBLIC-EXECUTE RPCs, and pg_cron.
  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. % on % was refused; it will succeed when play resumes.',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55006',
            HINT = 'Scheduled maintenance breaks run from :55 to :00. Nothing is lost - retry after the break.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.fn_refuse_while_frozen() IS
  'Refuses money and seat movement while the platform is frozen. Attached to the seven tables that receive every such write. One scoped exemption: a zero-balance club_members INSERT is identity, not money, so joining a club never freezes.';

CREATE OR REPLACE FUNCTION public.fn_db_now()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $$
  SELECT NOW();
$$;

COMMENT ON FUNCTION public.fn_db_now() IS
  'The database clock, for skew measurement. The engine compares this against its own Date.now() and publishes the difference on /health - three clocks cooperate on the maintenance freeze and drift between them must be visible before it is a bug.';

GRANT EXECUTE ON FUNCTION public.fn_db_now() TO anon, authenticated, service_role;

COMMIT;
