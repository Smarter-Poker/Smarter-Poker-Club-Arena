-- 20261003092217_a_settlement_floor_cannot_pass_owed_agent_commission.sql
--
-- A SETTLEMENT FLOOR CANNOT PASS OWED AGENT COMMISSION
--
-- HOW 1,162,765.28 WENT UNPAID. The weekly close settles agent commission by
-- period and never reaches below its floor (union_settlement_floor,
-- club_settlement_floor). Moving a floor forward is how a week is declared
-- "never settled here", and three moves did it: 2026-09-02 (union floor set to
-- 09-07, "start clean"), 2026-09-20 (union and Deep Stack Society floors to
-- 09-21). Each recorded what it left behind for RAKEBACK
-- (accounting_deferred_obligations); none of them looked at the agent
-- commission rows of the weeks it skipped. Those rows stayed in
-- agent_commission_unsettled_rollup, unpayable by any path, until the one-off
-- 20261003092151 paid them. Nothing refused the move and nothing said so.
--
-- THE FIX, AT THE MOVE. A BEFORE INSERT OR UPDATE OF earliest_period_start
-- trigger on both floor tables refuses to put the floor above a recorded agent
-- commission row of its scope that is unsettled and not covered by a
-- settlement period (the same test the rollup and every settlement reader
-- use). The scope is the union's clubs (its house club included) for the
-- union floor, the club for a club floor. Only the weeks the move skips are
-- read: [old floor, new floor), or everything below the new floor for a new
-- row; and only the gaps between each agent's settlement periods, by index
-- range, so a move over fully settled weeks costs milliseconds. A move backwards, or one that skips only settled weeks, passes. The
-- refusal names the first owed row it found and says to settle or pay the
-- skipped weeks first. There is no switch: a floor is moved by a migration, and
-- the migration that moves it pays or settles what it skips in the same breath.
--
-- Not a monitor and not a repair (CLAUDE.md 10.11, 10.12): it refuses the
-- write that created the defect. The weekly close never writes either table.
--
-- One transaction, one PostgREST reload.
--
-- @live-proof: (SELECT count(*) = 2 FROM pg_trigger WHERE tgname = 'a_floor_cannot_pass_owed_agent_commission' AND NOT tgisinternal)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.fn_settlement_floor_refuses_owed_agent_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_from   timestamptz;
  v_to     timestamptz := NEW.earliest_period_start;
  v_clubs  uuid[];
  v_cursor timestamptz;
  p record; s record; v_owed record; v_stranded boolean := false;
BEGIN
  v_from := CASE WHEN TG_OP = 'UPDATE' THEN OLD.earliest_period_start ELSE '-infinity'::timestamptz END;
  IF v_to IS NULL OR v_to <= v_from THEN
    RETURN NEW;  -- a floor that does not move up skips nothing
  END IF;
  IF TG_TABLE_NAME = 'union_settlement_floor' THEN
    v_clubs := ARRAY(SELECT c.id FROM public.clubs c WHERE c.union_id = NEW.union_id OR c.id = NEW.union_id ORDER BY 1);
  ELSE
    v_clubs := ARRAY[NEW.club_id];
  END IF;

  -- Per (club, agent) with unsettled commission (the rollup keeps one row for
  -- every such pair): walk its settlement periods across the skipped range and
  -- probe each uncovered gap for an unsettled row, by index range. Measured on
  -- production 2026-10-03: 30 ms for the union's week of 09-21 (all covered),
  -- 1 ms to find the first stranded row below 09-28 before 20261003092151.
  <<pairs>>
  FOR p IN SELECT r.club_id, r.user_id FROM public.agent_commission_unsettled_rollup r
            WHERE r.club_id = ANY(v_clubs) ORDER BY 1, 2 LOOP
    v_cursor := v_from;
    FOR s IN SELECT x.period_start, x.period_end FROM public.agent_commission_settlements x
              WHERE x.club_id = p.club_id AND x.user_id = p.user_id
                AND x.period_end > v_from AND x.period_start < v_to
              ORDER BY x.period_start LOOP
      IF s.period_start > v_cursor THEN
        SELECT a.club_id, a.user_id, a.created_at, a.amount INTO v_owed FROM public.agent_commissions a
         WHERE a.club_id = p.club_id AND a.user_id = p.user_id AND a.settled_at IS NULL
           AND a.created_at >= v_cursor AND a.created_at < s.period_start
         ORDER BY a.created_at LIMIT 1;
        v_stranded := FOUND;
        EXIT pairs WHEN v_stranded;
      END IF;
      v_cursor := greatest(v_cursor, s.period_end);
    END LOOP;
    IF v_cursor < v_to THEN
      SELECT a.club_id, a.user_id, a.created_at, a.amount INTO v_owed FROM public.agent_commissions a
       WHERE a.club_id = p.club_id AND a.user_id = p.user_id AND a.settled_at IS NULL
         AND a.created_at >= v_cursor AND a.created_at < v_to
       ORDER BY a.created_at LIMIT 1;
      v_stranded := FOUND;
      EXIT pairs WHEN v_stranded;
    END IF;
  END LOOP;

  IF v_stranded THEN
    RAISE EXCEPTION 'settlement_floor_would_strand_agent_commission'
      USING ERRCODE = '23514',
            DETAIL = format('Moving the %s floor from %s to %s skips recorded agent commission that is unsettled and covered by no settlement period, e.g. club %s agent %s row of %s (%s). Below the floor no path can ever pay it.',
                            TG_TABLE_NAME, v_from, v_to, v_owed.club_id, v_owed.user_id, v_owed.created_at, v_owed.amount),
            HINT = 'Pay or settle the skipped weeks first (agent_commission_settlements periods, as 20261003092151 did), then move the floor.';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_settlement_floor_refuses_owed_agent_commission() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_floor_cannot_pass_owed_agent_commission ON public.union_settlement_floor;
CREATE TRIGGER a_floor_cannot_pass_owed_agent_commission
  BEFORE INSERT OR UPDATE OF earliest_period_start ON public.union_settlement_floor
  FOR EACH ROW EXECUTE FUNCTION public.fn_settlement_floor_refuses_owed_agent_commission();

DROP TRIGGER IF EXISTS a_floor_cannot_pass_owed_agent_commission ON public.club_settlement_floor;
CREATE TRIGGER a_floor_cannot_pass_owed_agent_commission
  BEFORE INSERT OR UPDATE OF earliest_period_start ON public.club_settlement_floor
  FOR EACH ROW EXECUTE FUNCTION public.fn_settlement_floor_refuses_owed_agent_commission();

COMMENT ON FUNCTION public.fn_settlement_floor_refuses_owed_agent_commission() IS
  'Refuses to move a union or club settlement floor above recorded agent commission that is unsettled and uncovered by a settlement period: below the floor nothing can pay it (20261003092217; the 1,162,765.28 paid by 20261003092151 was stranded this way).';

COMMIT;
