-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820135918 "union_eco_win_tax_rebate"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 76b034f01ef71e77211e1cb58566240e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ECO — the union win tax / loss rebate (2026-08-20)
--
-- Dan's spec: winning clubs are taxed 10% of what they win; that money goes to
-- losing clubs as a rebate. Rake generated is "factored in somehow". It is an
-- INVOICE ADJUSTMENT — it changes what each club owes when squaring up with
-- the union each week. There is NO automatic chip distribution.
--
-- The published industry formula (Primetime Union charter) is:
--   "Tax/Rebate can be either negative or positive. It is -10% of your club's
--    winnings and rake from cash tables and -4% ... from MTT games.
--    Example: if your players won $5,000 and raked $1,000, the rebate will be
--    negative $600 and vice versa."
-- i.e. base = (players' winnings) + (rake generated), result signed, x rate,
-- sign inverted: a winner pays, a loser receives.
--
-- THAT BASE IS EXACTLY OUR settle_net. From the identity the settlement is
-- already built on and that our CI asserts:
--     realized_net + stack_delta = transfer_in - rake_paid
--     settle_net = realized_net + stack_delta + rake_paid = transfer_in
-- and the chips a club's players actually gained = realized_net + stack_delta
--                                                = settle_net - rake_paid.
-- Therefore  players_won + rake_generated = settle_net.
--
-- So ECO = -rate * settle_net, which
--   * automatically "factors in rake generated", as Dan described;
--   * is guaranteed consistent with the settlement, because it is a function
--     of the very number the settlement moves chips on — it can never drift;
--   * gives the right signs: settle_net > 0 (club's players won) => negative
--     ECO => the club pays; settle_net < 0 => positive ECO => the club is
--     rebated a share of its losses.
--
-- NOT zero-sum, by design: sum(settle_net) across clubs is the house residual
-- (horses/house are the counterparty), so the union nets a small difference.
-- fn_union_eco_adjustment reports that as union_net_eco so it is never hidden.
--
-- Rates live in unions.settings (no new infra, matches bbj_split /
-- union_rake_hold). DISABLED BY DEFAULT: eco_enabled must be set to true
-- deliberately. Nothing here changes the rake schedule and there are no late
-- fees anywhere in this migration.

CREATE TABLE IF NOT EXISTS public.union_eco_ledger (
  union_id      uuid NOT NULL,
  club_id       uuid NOT NULL,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  settle_net    numeric NOT NULL,   -- the ECO base (winnings + rake)
  eco_rate      numeric NOT NULL,
  eco_amount    numeric NOT NULL,   -- signed: + union owes club, - club owes union
  settlement_id uuid NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (union_id, club_id, period_start)
);
ALTER TABLE public.union_eco_ledger ENABLE ROW LEVEL SECURITY;

-- Effective ECO rate for a union (default 10%), and whether it is switched on.
CREATE OR REPLACE FUNCTION public.fn_union_eco_rate(p_union_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE((u.settings->>'eco_rate')::numeric, 0.10)
    FROM unions u WHERE u.id = p_union_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_eco_enabled(p_union_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE((u.settings->>'eco_enabled')::boolean, false)
    FROM unions u WHERE u.id = p_union_id;
$function$;

-- Per club for a period: the ECO base, the signed adjustment, and the union's
-- own net position on ECO for the same period (repeated on every row).
CREATE OR REPLACE FUNCTION public.fn_union_eco_adjustment(
  p_union_id uuid, p_start timestamptz, p_end timestamptz)
RETURNS TABLE(
  club_id uuid, club_name text,
  players_won numeric, rake_generated numeric, eco_base numeric,
  eco_rate numeric, eco_amount numeric, direction text,
  union_net_eco numeric, eco_enabled boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric := fn_union_eco_rate(p_union_id);
  v_on   boolean := fn_union_eco_enabled(p_union_id);
BEGIN
  RETURN QUERY
  WITH rep AS (
    -- inherits the reconciliation report's authorization check
    SELECT r.club_id, r.club_name, r.settle_net, r.rake_paid
      FROM fn_union_reconciliation_report(p_union_id, p_start, p_end) r
  ),
  calc AS (
    SELECT rep.club_id, rep.club_name,
           -- what the club's players actually gained, net of the rake they paid
           round(rep.settle_net - rep.rake_paid, 2) AS players_won,
           rep.rake_paid AS rake_generated,
           rep.settle_net AS eco_base,
           round(-v_rate * rep.settle_net, 2) AS eco_amount
      FROM rep
  ),
  agg AS (SELECT round(SUM(-calc.eco_amount), 2) AS union_net FROM calc)
  SELECT calc.club_id, calc.club_name, calc.players_won, calc.rake_generated,
         calc.eco_base, v_rate, calc.eco_amount,
         CASE WHEN calc.eco_amount < 0 THEN 'club pays union (win tax)'
              WHEN calc.eco_amount > 0 THEN 'union pays club (loss rebate)'
              ELSE 'square' END::text,
         agg.union_net, v_on
    FROM calc CROSS JOIN agg
   ORDER BY calc.eco_amount;
END;
$function$;

-- Persist a period's ECO so an invoice can always be reproduced exactly as it
-- was issued, even after live data moves on. Idempotent per (union, club,
-- period_start). Service role / union admin only.
CREATE OR REPLACE FUNCTION public.fn_union_eco_record(
  p_union_id uuid, p_start timestamptz, p_end timestamptz,
  p_settlement_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_rows int;
BEGIN
  IF v_caller IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_caller)
     AND NOT EXISTS (SELECT 1 FROM union_admins ua
                      WHERE ua.union_id = p_union_id AND ua.user_id = v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized');
  END IF;

  INSERT INTO union_eco_ledger (union_id, club_id, period_start, period_end,
                                settle_net, eco_rate, eco_amount, settlement_id)
  SELECT p_union_id, e.club_id, p_start, p_end, e.eco_base, e.eco_rate,
         e.eco_amount, p_settlement_id
    FROM fn_union_eco_adjustment(p_union_id, p_start, p_end) e
  ON CONFLICT (union_id, club_id, period_start) DO UPDATE
    SET period_end = EXCLUDED.period_end,
        settle_net = EXCLUDED.settle_net,
        eco_rate   = EXCLUDED.eco_rate,
        eco_amount = EXCLUDED.eco_amount,
        settlement_id = COALESCE(EXCLUDED.settlement_id, union_eco_ledger.settlement_id),
        computed_at = now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'clubs', v_rows,
                            'period_start', p_start, 'period_end', p_end);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_eco_rate(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_eco_enabled(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_eco_adjustment(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_union_eco_adjustment(uuid, timestamptz, timestamptz) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_eco_record(uuid, timestamptz, timestamptz, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_union_eco_record(uuid, timestamptz, timestamptz, uuid) TO authenticated;
