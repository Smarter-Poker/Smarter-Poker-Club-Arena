-- 20260906011010_phase_8_1_the_other_side_of_a_leg_names_the_column_this_side.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 8.1, 2026-09-06 01:1x UTC):
--
-- THE REPLAY'S LAST BLIND SPOT. fn_ca_ledger_replay has reported the same
-- number every run since it was built: 579 legs a day it cannot key to a
-- column, and therefore cannot replay. A union wallet has six balance columns
-- and an agent has two, so a leg on that side needs a label to say WHICH one
-- moved - and the autoledger writes the label only on the side whose table it
-- watched. The counterparty side carries none.
--
-- Read against the rows rather than guessed at: the 579 are three shapes, and
-- every one of them is a promo move.
--
--   288 legs  bbj_pool -> union_wallet   (category promo), and all 288
--             entities ARE unions: the BBJ promo slice swept into the union's
--             promo wallet by fn_sweep_bbj_promo.
--   287 legs  bbj_pool -> promo_wallet   (category promo), and all 287
--             entities ARE clubs: the same sweep into a standalone club's
--             promo balance.
--     3 legs  union_wallet -> (a club's promo balance), category promo_send:
--             the promo reroute of 2026-09-05.
--
-- THE RULE, and why it is exact rather than a heuristic: THE OTHER SIDE OF A
-- LEG NAMES WHAT MOVED. Money that leaves a promo bank arrives in a promo
-- bank; the labelled side says 'bbj_pools.promo_balance' or
-- 'clubs.promo_balance', and the unlabelled side is then the promo column of
-- whatever its entity is - a union's promo_wallet, a club's promo_balance, an
-- agent's promo_wallet_balance. The entity's identity decides which, and it
-- is read from the tables, not assumed: 288 of 288 unions, 287 of 287 clubs,
-- 0 agents. Nothing is inferred from the category, which could change; the
-- rule reads the leg's own two sides.
--
-- What still cannot be keyed is still counted and still reported as
-- 'unkeyable' - the number is the work item, and after this it should be zero.
-- The fix belongs in the replay rather than in the sweep because
-- fn_ca_declare_ledger has no way to pass a counterparty LABEL, so a writer
-- cannot supply one without a change to the declaration API that every other
-- door would then have to adopt; and because this reads history too, where no
-- writer can reach any more.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_leg_accounts(p_since timestamptz, p_until timestamptz)
 RETURNS TABLE(account_key text, account_type text, entity_id uuid, club_id uuid, column_name text, net numeric, legs bigint, unkeyable bigint)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH sides AS (
    /* Each side carries the OTHER side's label, because that is what names
       the column when this side has none. */
    SELECT l.to_type AS t, l.to_entity_id AS id, l.to_label AS lbl, l.from_label AS other_lbl, l.amount AS amt
      FROM public.chip_ledger l
     WHERE l.created_at > p_since AND l.created_at <= p_until AND l.to_entity_id IS NOT NULL
    UNION ALL
    SELECT l.from_type, l.from_entity_id, l.from_label, l.to_label, -l.amount
      FROM public.chip_ledger l
     WHERE l.created_at > p_since AND l.created_at <= p_until AND l.from_entity_id IS NOT NULL
  ), resolved AS (
    SELECT s.*,
      CASE s.t
        WHEN 'player_wallet'  THEN 'club_members.chip_balance'
        WHEN 'table_stack'    THEN 'table_seats.stack'
        WHEN 'club_treasury'  THEN 'clubs.chip_treasury'
        WHEN 'union_bank'     THEN 'union_wallets.chip_balance'
        WHEN 'spin_reserve'   THEN 'spin_bonus_pools.balance'
        WHEN 'union_wallet'   THEN COALESCE(s.lbl,
               /* THE OTHER SIDE NAMES WHAT MOVED: out of a promo bank, into a
                  promo bank. The entity decides which promo column. */
               CASE WHEN s.other_lbl LIKE '%promo%'
                         AND EXISTS (SELECT 1 FROM public.unions u WHERE u.id = s.id)
                    THEN 'union_wallets.promo_wallet' END)
        WHEN 'bbj_pool'       THEN s.lbl
        WHEN 'promo_wallet'   THEN COALESCE(s.lbl,
               CASE WHEN s.other_lbl LIKE '%promo%' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)
                    THEN 'clubs.promo_balance'
                    WHEN s.other_lbl LIKE '%promo%' AND EXISTS (SELECT 1 FROM public.agents a WHERE a.id = s.id OR a.user_id = s.id)
                    THEN 'agents.promo_wallet_balance'
                    WHEN s.other_lbl LIKE '%promo%' AND EXISTS (SELECT 1 FROM public.unions u WHERE u.id = s.id)
                    THEN 'union_wallets.promo_wallet' END)
        WHEN 'agent_wallet'   THEN COALESCE(s.lbl, 'agents.agent_wallet_balance')
        ELSE NULL
      END AS col,
      CASE WHEN s.t = 'table_stack' THEN '00000000-0000-0000-0000-0000000fe17e'::uuid ELSE s.id END AS owner
      FROM sides s
     WHERE s.t <> 'prize_liability'
  )
  SELECT k.t || ':' || k.owner::text || ':' || k.col AS account_key,
         k.t, k.owner, NULL::uuid, k.col,
         round(sum(k.amt), 2), count(*), 0::bigint
    FROM resolved k
   WHERE k.col IS NOT NULL
   GROUP BY 1, 2, 3, 4, 5
  UNION ALL
  SELECT NULL, 'unkeyable', NULL, NULL, NULL, round(sum(k.amt), 2), count(*), count(*)
    FROM resolved k
   WHERE k.col IS NULL
  HAVING count(*) > 0;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts(timestamptz, timestamptz) TO service_role;

DO $$
DECLARE v_unkeyable bigint; v_before bigint := 579;
BEGIN
  SELECT COALESCE(sum(a.unkeyable), 0) INTO v_unkeyable
    FROM public.fn_ca_leg_accounts(now() - interval '26 hours', now()) a WHERE a.account_type = 'unkeyable';
  IF v_unkeyable > 0 THEN
    RAISE EXCEPTION 'the replay still cannot key % legs (it could not key % before this); read them before assuming the rule covers them', v_unkeyable, v_before;
  END IF;
  RAISE NOTICE 'every leg in the last 26 hours can be keyed to an account (was % unkeyable)', v_before;
END $$;

COMMIT;
