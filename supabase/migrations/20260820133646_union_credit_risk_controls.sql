-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820133646 "union_credit_risk_controls"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1c86b5ce284283065a5d344ea9a24732 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- UNION CREDIT RISK CONTROLS (2026-08-20)
--
-- Researched against how production PokerBros/PPPoker unions actually
-- operate (e.g. the Primetime Union charter). Every real union runs on four
-- risk primitives that this platform had NONE of:
--
--   1. SECURITY DEPOSIT — collateral the union holds per club. Returned only
--      when the club leaves. It is the union's only protection against a club
--      that loses more than it can pay.
--   2. STOP LOSS — a weekly loss limit, conventionally equal to the security
--      deposit, reset at the start of each settlement week. When a club
--      crosses it the club is suspended until it settles. Without this a club
--      can run up an unbounded debt between Monday settlements.
--   3. PRESETTLEMENT — money sent mid-week. It offsets the running balance AND
--      raises the stop-loss headroom 1:1, which is how a club keeps playing
--      after a bad run without the union extending free credit.
--   4. SETTLEMENT AGING — a due date after the weekly statement (Wednesday in
--      most unions) and a late fee, so "unpaid" is a state with consequences
--      rather than a number that sits forever.
--
-- Our settlement moves chips atomically, so we cannot be left with an unpaid
-- invoice the way an off-platform union can — but we CAN be left with a club
-- whose treasury is empty and whose players keep losing, which is the same
-- exposure wearing a different hat. `total_unpaid` on union_pnl_settlements
-- already records exactly that and nothing watches it.
--
-- Conservative by design: a club with no terms row, or a NULL stop_loss_limit,
-- is NOT enforced — it is reported as "no terms on file". Nothing is
-- suspended automatically by this migration; it makes exposure VISIBLE and
-- alertable first. Enforcement is a policy decision for Dan.

CREATE TABLE IF NOT EXISTS public.union_club_terms (
  union_id          uuid NOT NULL,
  club_id           uuid NOT NULL,
  security_deposit  numeric NOT NULL DEFAULT 0,
  -- NULL = not enforced (unlimited). Conventionally equal to the deposit.
  stop_loss_limit   numeric NULL,
  -- Optional cap on the biggest blind the club may spread, the way unions
  -- tier permitted stakes by deposit size.
  stakes_cap_bb     numeric NULL,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','closed')),
  suspended_at      timestamptz NULL,
  suspended_reason  text NULL,
  notes             text NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (union_id, club_id)
);
ALTER TABLE public.union_club_terms ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.union_presettlements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  union_id      uuid NOT NULL,
  club_id       uuid NOT NULL,
  amount        numeric NOT NULL CHECK (amount > 0),
  received_at   timestamptz NOT NULL DEFAULT now(),
  method        text NULL,
  reference     text NULL,
  note          text NULL,
  recorded_by   uuid NULL,
  -- set when a weekly settlement consumes this presettlement
  applied_settlement_id uuid NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_union_presettlements_club_received
  ON public.union_presettlements (union_id, club_id, received_at);
CREATE INDEX IF NOT EXISTS idx_union_presettlements_unapplied
  ON public.union_presettlements (union_id, club_id)
  WHERE applied_settlement_id IS NULL;
ALTER TABLE public.union_presettlements ENABLE ROW LEVEL SECURITY;

-- Start of the current settlement week (Monday 00:00 UTC), matching the
-- weekly rakeback close and the Monday auto-settlement cron.
CREATE OR REPLACE FUNCTION public.fn_union_week_start(p_at timestamptz DEFAULT now())
RETURNS timestamptz
LANGUAGE sql IMMUTABLE
AS $function$
  SELECT date_trunc('week', (p_at AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';
$function$;

-- Record a mid-week payment from a club. Raises stop-loss headroom 1:1 and
-- offsets the running balance until the weekly settlement consumes it.
CREATE OR REPLACE FUNCTION public.fn_union_record_presettlement(
  p_union_id uuid, p_club_id uuid, p_amount numeric,
  p_method text DEFAULT NULL, p_reference text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'positive amount required');
  END IF;

  -- Only the service role, the union owner, or a union admin may record money.
  IF v_caller IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_caller)
     AND NOT EXISTS (SELECT 1 FROM union_admins ua
                      WHERE ua.union_id = p_union_id AND ua.user_id = v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM union_clubs uc
                  WHERE uc.union_id = p_union_id AND uc.club_id = p_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'club is not a member of this union');
  END IF;

  INSERT INTO union_presettlements (union_id, club_id, amount, method, reference, note, recorded_by)
  VALUES (p_union_id, p_club_id, p_amount, p_method, p_reference, p_note, v_caller)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'presettlement_id', v_id, 'amount', p_amount);
END;
$function$;

-- THE RISK VIEW. Per club, for the current settlement week:
--   running_net   what the club would owe (negative) or be owed (positive)
--                 if the week settled right now -- the same arithmetic the
--                 Monday settlement uses
--   presettled    money already sent mid-week
--   exposure      what the union is actually carrying = amount owed beyond
--                 what has been pre-paid (0 if the club is up)
--   headroom      stop_loss_limit - exposure  (NULL when not enforced)
--   breached      exposure has crossed the stop loss
CREATE OR REPLACE FUNCTION public.fn_union_club_exposure(
  p_union_id uuid, p_week_start timestamptz DEFAULT NULL)
RETURNS TABLE(
  club_id uuid, club_name text, week_start timestamptz,
  running_net numeric, presettled numeric, exposure numeric,
  security_deposit numeric, stop_loss_limit numeric, headroom numeric,
  breached boolean, terms_on_file boolean, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := COALESCE(p_week_start, fn_union_week_start());
BEGIN
  RETURN QUERY
  WITH rep AS (
    -- inherits the reconciliation report's own authorization check
    SELECT r.club_id, r.club_name, r.settle_net
      FROM fn_union_reconciliation_report(p_union_id, v_start, now()) r
  ),
  pre AS (
    SELECT p.club_id, COALESCE(SUM(p.amount), 0) AS amt
      FROM union_presettlements p
     WHERE p.union_id = p_union_id
       AND p.received_at >= v_start
       AND p.applied_settlement_id IS NULL
     GROUP BY p.club_id
  )
  SELECT rep.club_id,
         rep.club_name,
         v_start,
         rep.settle_net,
         COALESCE(pre.amt, 0),
         GREATEST(0, round(-rep.settle_net - COALESCE(pre.amt, 0), 2)) AS exposure,
         COALESCE(t.security_deposit, 0),
         t.stop_loss_limit,
         CASE WHEN t.stop_loss_limit IS NULL THEN NULL
              ELSE round(t.stop_loss_limit
                         - GREATEST(0, -rep.settle_net - COALESCE(pre.amt, 0)), 2) END,
         CASE WHEN t.stop_loss_limit IS NULL THEN false
              ELSE GREATEST(0, -rep.settle_net - COALESCE(pre.amt, 0)) > t.stop_loss_limit END,
         (t.club_id IS NOT NULL),
         COALESCE(t.status, 'no_terms')
    FROM rep
    LEFT JOIN pre ON pre.club_id = rep.club_id
    LEFT JOIN union_club_terms t
           ON t.union_id = p_union_id AND t.club_id = rep.club_id
   ORDER BY exposure DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_record_presettlement(uuid, uuid, numeric, text, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_union_record_presettlement(uuid, uuid, numeric, text, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_club_exposure(uuid, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_union_club_exposure(uuid, timestamptz) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_week_start(timestamptz) FROM PUBLIC, anon;
