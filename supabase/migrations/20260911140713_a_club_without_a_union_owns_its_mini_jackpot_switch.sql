-- 20260911140713_a_club_without_a_union_owns_its_mini_jackpot_switch.sql
--
-- Version 20260911140713 is the one production recorded when this was applied (the
-- reserved 20260911140154 was renamed to match it, so the file and the record agree).
--
-- WHAT THIS CHANGES, AND WHY. Dan, 2026-09-11:
--
--   "mini bad beat also needs to be a 'toggleable' on / off feature inside
--    clubs (that have no union affiliation) but should be 'added by default'
--    when a new club is started."
--
-- The mini's only switch until now was `bbj_mini_tiers.enabled`, which is a
-- GLOBAL per-stakes-tier flag: turning it off turns the mini off for every
-- club on the platform. A club had no say at all.
--
-- The switch goes on the POOL, because the pool is what the mini is paid from
-- (fn_bbj_mini_payout debits bbj_pools.backup_balance):
--
--   * a club with NO union has its own pool row, so that row is its switch,
--     and its own admins own it;
--   * a club INSIDE a union shares the union's pool - one reserve for every
--     member club - so the switch on that row belongs to the union, and one
--     member club cannot flip a jackpot the others are paying into and out of.
--     fn_bbj_set_club_mini_enabled refuses such a club by name rather than
--     silently writing a row nobody reads.
--
-- DEFAULT TRUE, NOT NULL, so "added by default when a new club is started" is
-- a property of the column rather than of any one creation path. Neither
-- fn_resolve_bbj_pool's two INSERTs nor fn_complete_club_opening_setup names
-- mini_enabled, so every pool ever created - today's five and every future one
-- - gets the mini without another line of code.
--
-- THE PAYOUT READS IT. fn_bbj_mini_payout already holds the pool row FOR
-- UPDATE before it decides; the switch is read from that same locked row, in
-- the same transaction, next to the reserve floor test. A mini refused this
-- way returns `mini_disabled_for_club`, which the engine records in
-- bbj_near_misses exactly as it records the floor refusal (phase 6), so a club
-- that switched its mini off can still see what it turned away.
--
-- THE SURFACES READ IT. fn_bbj_mini_for_club folds the switch into both
-- `enabled` and every tier's `payable`, so a surface that reads only `payable`
-- - the felt plate, the lobby line - cannot promise a mini this club has
-- turned off. It also returns `can_toggle` and `is_union_pool` so the club
-- settings page can show the control to the clubs that own it and an
-- explanation to the clubs that do not.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL search_path TO public, pg_temp;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The switch
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.bbj_pools
  ADD COLUMN IF NOT EXISTS mini_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.bbj_pools.mini_enabled IS
  'Whether the mini bad beat jackpot pays from this pool. Default true, so a new club has it from its first hand. A club with no union owns its own pool row and its admins may toggle this through fn_bbj_set_club_mini_enabled; a club inside a union shares the union pool, and that row is the union''s to set.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The payout honours it
-- ───────────────────────────────────────────────────────────────────────────
-- Read from the row already locked FOR UPDATE two statements above, so the
-- switch cannot change between the test and the debit.
CREATE OR REPLACE FUNCTION public.fn_bbj_mini_payout(
  p_pool_id uuid, p_table_id uuid, p_hand_number bigint, p_tier_id text,
  p_loser_user_id uuid, p_winner_user_id uuid, p_dealt_in_ids uuid[],
  p_seated_ids uuid[], p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(applied boolean, already_paid boolean, refused text, payout_id uuid,
  total_payout numeric, loser_share numeric, winner_share numeric, table_share numeric,
  per_player_share numeric, backup_after numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_backup numeric; v_floor numeric; v_amount numeric; v_enabled boolean;
  v_total numeric; v_loser numeric; v_winner numeric; v_table numeric; v_per numeric;
  v_payout_id uuid; v_existing uuid; v_table_ids uuid[]; v_n_table integer;
  v_club_id uuid; v_uid uuid; v_remainder numeric; v_hand_id uuid;
  v_loser_name text; v_winner_name text; v_pending record;
  v_pool_mini_enabled boolean;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_mini_payout is service only' USING ERRCODE = '42501';
  END IF;

  /* The same kill switch the main jackpot honours, and the same error class,
     so the engine's queue retries a mini frozen mid-flight exactly as it
     retries a main one. */
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
              WHERE f.scope = 'bbj_payouts' AND f.cleared_at IS NULL) THEN
    RAISE EXCEPTION 'payout_frozen: jackpot payouts are frozen by the kill switch (ca_payout_freeze scope bbj_payouts); the engine retries when it is cleared'
      USING ERRCODE = 'P0404';
  END IF;

  IF p_pool_id IS NULL OR p_table_id IS NULL OR p_hand_number IS NULL
     OR p_loser_user_id IS NULL OR p_winner_user_id IS NULL
     OR p_loser_user_id = p_winner_user_id THEN
    RAISE EXCEPTION 'mini jackpot requires a hand and two distinct recipients'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize the decision before inspecting its idempotency record. A
  -- concurrent second caller must see the first caller's committed payout.
  SELECT COALESCE(backup_balance,0), COALESCE(mini_reserve_floor, 0), club_id,
         COALESCE(mini_enabled, true)
    INTO v_backup, v_floor, v_club_id, v_pool_mini_enabled
    FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'pool_not_found'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;

  /* IDEMPOTENT ON THE HAND, and it shares the key with the main jackpot on
     purpose: bbj_payouts_pool_table_hand_uidx means one hand can produce one
     payout of either kind and never both. A mini only ever runs when
     detectBBJHit refused the main, so the two cannot race for the same hand -
     and if that ever stops being true, this is where it stops, not a second
     row nobody reconciles.

     BEFORE the switch is tested, deliberately: a club that turns its mini off
     after a hit was queued must still have that hit's parked shares settled.
     The switch decides whether a NEW mini is owed, never whether an owed one
     is paid. */
  SELECT id INTO v_existing FROM public.bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number LIMIT 1;
  IF v_existing IS NOT NULL THEN
    SELECT bp.total_amount, bp.loser_share, bp.winner_share, bp.table_share, bp.table_player_count
      INTO v_total, v_loser, v_winner, v_table, v_n_table
      FROM public.bbj_payouts bp WHERE bp.id = v_existing;
    FOR v_pending IN SELECT u.user_id,u.amount FROM public.bbj_unclaimed_shares u
      WHERE u.payout_id=v_existing AND u.paid_at IS NULL ORDER BY u.user_id
    LOOP
      PERFORM public.bbj_credit_one_recipient(v_existing,p_table_id,v_pending.user_id,v_pending.amount,
        EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=p_table_id
          AND s.user_id=v_pending.user_id AND s.left_at IS NULL));
    END LOOP;
    SELECT COALESCE(backup_balance,0) INTO v_backup FROM public.bbj_pools WHERE id = p_pool_id;
    RETURN QUERY SELECT false, true, NULL::text, v_existing, v_total, v_loser, v_winner,
      v_table, CASE WHEN v_n_table > 0 THEN v_table / v_n_table ELSE 0::numeric END, v_backup;
    RETURN;
  END IF;

  /* THE CLUB'S OWN SWITCH (Dan 2026-09-11). Read from the row locked above, so
     it cannot change between this test and the debit below. A refusal here is
     recorded as a near miss by the engine, exactly like the floor refusal, so
     a club that switched the mini off can still see what it turned away. */
  IF NOT v_pool_mini_enabled THEN
    RETURN QUERY SELECT false, false, 'mini_disabled_for_club'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, v_backup;
    RETURN;
  END IF;

  SELECT amount, enabled INTO v_amount, v_enabled
    FROM public.bbj_mini_tiers WHERE tier_id = p_tier_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'no_mini_amount_for_tier'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;
  IF NOT v_enabled THEN
    RETURN QUERY SELECT false, false, 'mini_disabled_for_tier'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;

  /* THE FLOOR IS NOT NEGOTIABLE AND THE MINI IS NOT SHRUNK TO FIT.
     Paying a partial mini would publish one number to the player and pay
     another; a mini that cannot be paid in full is simply not owed. */
  IF v_backup - public.fn_bbj_parked_reserve(p_pool_id,'backup') - v_amount < v_floor THEN
    RETURN QUERY SELECT false, false, 'reserve_at_floor'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, v_backup;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[]) INTO v_table_ids
    FROM unnest(COALESCE(p_dealt_in_ids, ARRAY[]::uuid[])) AS x
   WHERE x IS NOT NULL AND x <> p_loser_user_id AND x <> p_winner_user_id;
  v_n_table := COALESCE(array_length(v_table_ids, 1), 0);

  v_total  := round(v_amount, 2);
  v_loser  := round(v_total * 0.50, 2);
  v_winner := round(v_total * 0.25, 2);
  v_table  := round(v_total - v_loser - v_winner, 2);
  IF v_n_table > 0 THEN
    v_per := round(v_table / v_n_table, 2);
    -- Preserve the main jackpot's signed residual rule, BEFORE the loser is
    -- credited. A second credit is deduplicated; ignoring a negative residual
    -- creates chips. Persist the actual table allocation shown to clients.
    v_remainder := v_table - v_per * v_n_table;
    v_loser := v_loser + v_remainder;
    v_table := v_per * v_n_table;
  ELSE
    /* Nobody else was dealt in: the table quarter goes to the player who took
       the beat rather than staying in a bank nobody can see. */
    v_per := 0;
    v_loser := round(v_loser + v_table, 2);
    v_table := 0;
  END IF;

  IF v_loser < 0 OR v_winner < 0 OR v_table < 0
     OR v_loser + v_winner + v_table <> v_total THEN
    RAISE EXCEPTION 'mini jackpot allocation does not conserve its funded total';
  END IF;

  SELECT id INTO v_hand_id FROM public.hand_history
   WHERE table_id = p_table_id AND hand_number = p_hand_number
   ORDER BY created_at DESC LIMIT 1;

  /* THE POOL DEBIT IS THE LEG (2026-09-09). This declared bbj_pool as its
     own counterparty, so the autoledger wrote bbj_pool -> bbj_pool and the
     700.00 that reached the seats appeared nowhere. table_stack is what
     bbj_atomic_payout_v2 declares for the same movement, and what
     bbj_credit_one_recipient assumes when it pays a departed recipient out
     of the felt. */
  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id, NULL,
            'bbj_mini:' || p_pool_id::text || ':' || p_table_id::text || ':' || p_hand_number::text, NULL);
  UPDATE public.bbj_pools
     SET backup_balance = GREATEST(0, COALESCE(backup_balance,0) - v_total),
         /* The pool's own paid-out counter moves with every payout of either
            kind. fn_bbj_conservation_check compares that counter against the
            bbj_payouts rows (phase 5.3); a mini that wrote a row and left the
            counter behind would take `paid_without_a_payout_row_since`
            negative and the lifetime verdict false. */
         total_paid_out = COALESCE(total_paid_out, 0) + v_total,
         updated_at = now()
   WHERE id = p_pool_id
   RETURNING COALESCE(backup_balance,0) INTO v_backup;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  INSERT INTO public.bbj_payouts
    (pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
     total_amount, winner_share, loser_share, table_share, table_player_count, kind, metadata)
  VALUES (p_pool_id, v_hand_id, p_table_id, p_hand_number, p_winner_user_id, p_loser_user_id,
          v_total, v_winner, v_loser, v_table, v_n_table, 'mini',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('tier_id', p_tier_id, 'funded_from', 'backup_reserve'))
  RETURNING id INTO v_payout_id;

  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_loser,
            p_loser_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_winner_user_id, v_winner,
            p_winner_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
  IF v_n_table > 0 AND v_per > 0 THEN
    FOREACH v_uid IN ARRAY v_table_ids LOOP
      PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, v_uid, v_per,
                v_uid = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
    END LOOP;

  END IF;

  /* THE ARENA NAME, through the platform's own helper. The first cut of this
     function read `profiles.arena_name`, a column that does not exist, and a
     rolled-back probe (CLAUDE.md 11.5) found it before a single real hand
     could. fn_arena_name is what fn_bbj_recent_hits and the rest of the arena
     already use, and reusing it is why the mini ticker will show the same name
     the main one does. */
  SELECT COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name),
                  pr.username, 'Player')
    INTO v_loser_name FROM public.profiles pr WHERE pr.id = p_loser_user_id;
  SELECT COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name),
                  pr.username, 'Player')
    INTO v_winner_name FROM public.profiles pr WHERE pr.id = p_winner_user_id;

  INSERT INTO public.bbj_winners
    (club_id, pool_id, loser_id, winner_id, loser_payout, winner_payout,
     table_share_payout, total_payout, pool_amount_at_hit, stakes_tier,
     table_id, hand_number, awarded_at, winner_display_name, loser_display_name, kind)
  VALUES (v_club_id, p_pool_id, p_loser_user_id, p_winner_user_id, v_loser, v_winner,
          v_table, v_total, v_backup + v_total, p_tier_id,
          p_table_id, p_hand_number, now(), v_winner_name, v_loser_name, 'mini')
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING;

  RETURN QUERY SELECT true, false, NULL::text, v_payout_id, v_total, v_loser, v_winner,
    v_table, v_per, v_backup;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)
  TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The club's own control
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_bbj_set_club_mini_enabled(
  p_club_id uuid, p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_pool uuid; v_now boolean;
BEGIN
  IF p_club_id IS NULL OR p_enabled IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_and_state_required');
  END IF;

  -- The club must exist before anything else is said about it.
  SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;

  /* WHO MAY SET IT. Dan, 2026-09-11: "club admin, owner or co owner have
     access to all features and details like that, create a table, edit
     settings etc." fn_is_club_admin_uid is exactly that set - read, not
     assumed: `role IN ('owner','co_owner','admin','manager')` AND an active
     membership - and it is the same gate the rest of the club settings page
     uses, so this control cannot end up stricter or looser than the ones
     beside it. It reads the CALLER, so a member of one club cannot set
     another's switch by passing its id. */
  IF NOT public.fn_is_club_admin_uid(p_club_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_club_admin');
  END IF;

  /* A UNION CLUB DOES NOT OWN THIS SWITCH. It plays into the union's pool, so
     flipping it would turn the mini off for every other club in that union.
     Refused by name rather than written somewhere nothing reads. */
  IF v_union IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_club_follows_the_union',
                              'union_id', v_union);
  END IF;

  SELECT id INTO v_pool FROM public.bbj_pools
   WHERE club_id = p_club_id AND union_id IS NULL AND status = 'active'
   ORDER BY created_at LIMIT 1;

  /* NO POOL YET IS NOT AN ERROR, and it must not silently drop the setting.
     fn_resolve_bbj_pool creates the row on the club's first raked hand; a club
     that sets this before then gets the row now, at zero, carrying its
     choice. */
  IF v_pool IS NULL THEN
    INSERT INTO public.bbj_pools
      (club_id, pool_amount, main_balance, backup_balance, promo_balance,
       hands_contributed, status, mini_enabled)
    VALUES (p_club_id, 0, 0, 0, 0, 0, 'active', p_enabled)
    RETURNING id INTO v_pool;
  ELSE
    UPDATE public.bbj_pools
       SET mini_enabled = p_enabled, updated_at = now()
     WHERE id = v_pool;
  END IF;

  SELECT COALESCE(mini_enabled, true) INTO v_now FROM public.bbj_pools WHERE id = v_pool;
  RETURN jsonb_build_object('ok', true, 'pool_id', v_pool, 'mini_enabled', v_now);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_set_club_mini_enabled(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_set_club_mini_enabled(uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_bbj_set_club_mini_enabled(uuid, boolean) IS
  'Turn the mini bad beat jackpot on or off for a club that has no union. Club admins only (owner, co_owner, admin, manager); a club inside a union is refused with union_club_follows_the_union, because its mini pays from the union''s shared reserve.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The surfaces read it
-- ───────────────────────────────────────────────────────────────────────────
-- Three new columns, so the return type changes and CREATE OR REPLACE is
-- refused (42P13). Dropped and re-created in the same transaction; every
-- existing column keeps its name, its type and its position.
DROP FUNCTION IF EXISTS public.fn_bbj_mini_for_club(uuid);

CREATE FUNCTION public.fn_bbj_mini_for_club(p_club_id uuid)
RETURNS TABLE(
  pool_id uuid,
  enabled boolean,
  backup_balance numeric,
  reserve_floor numeric,
  parked numeric,
  available numeric,
  tiers jsonb,
  hits_30d bigint,
  paid_30d numeric,
  last_hit_at timestamptz,
  -- 2026-09-11: whose switch this is. `can_toggle` is true only for a club
  -- that owns its own pool, which is exactly the club fn_bbj_set_club_mini_enabled
  -- will accept, so the settings page and the function cannot disagree.
  club_switch boolean,
  can_toggle boolean,
  is_union_pool boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH club AS (
    SELECT c.id, c.union_id FROM public.clubs c WHERE c.id = p_club_id
  ),
  pool AS (
    SELECT p.pool_id, p.backup_balance, p.is_union_pool
      FROM public.fn_bbj_pool_for_club(p_club_id) p
  ),
  pool_row AS (
    SELECT bp.id, COALESCE(bp.mini_reserve_floor, 0) AS reserve_floor,
           COALESCE(bp.mini_enabled, true) AS mini_enabled
      FROM public.bbj_pools bp JOIN pool ON pool.pool_id = bp.id
  ),
  parked_row AS (
    /* A parked mini share is still in the reserve but already owed. The
       payout RPC subtracts it before it tests the floor; so does this, or the
       felt would promise a mini the RPC is about to refuse. */
    SELECT public.fn_bbj_parked_reserve(pool.pool_id, 'backup') AS parked FROM pool
  ),
  tier_rows AS (
    SELECT st.id AS tier_id, st.label, st.blind_range, st.min_bb, st.max_bb,
           mt.amount, mt.enabled,
           /* Exactly fn_bbj_mini_payout's refusals, inverted and in its order:
                the club's switch, the tier's switch, then
                backup - parked - amount < floor */
           (pool_row.mini_enabled
            AND mt.enabled
            AND COALESCE(pool.backup_balance, 0) - parked_row.parked - mt.amount
                >= pool_row.reserve_floor) AS payable
      FROM public.bbj_stakes_tiers st
      JOIN public.bbj_mini_tiers mt ON mt.tier_id = st.id
      CROSS JOIN pool CROSS JOIN pool_row CROSS JOIN parked_row
  ),
  hits AS (
    SELECT count(*) AS n,
           COALESCE(sum(w.total_payout), 0) AS paid,
           max(w.awarded_at) AS last_at
      FROM public.bbj_winners w JOIN pool ON w.pool_id = pool.pool_id
     WHERE w.kind = 'mini' AND w.awarded_at > now() - interval '30 days'
  )
  SELECT pool.pool_id,
         (pool_row.mini_enabled
          AND EXISTS (SELECT 1 FROM public.bbj_mini_tiers t WHERE t.enabled)) AS enabled,
         COALESCE(pool.backup_balance, 0) AS backup_balance,
         pool_row.reserve_floor,
         parked_row.parked,
         GREATEST(0, COALESCE(pool.backup_balance, 0) - parked_row.parked - pool_row.reserve_floor)
           AS available,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'tierId', tr.tier_id,
                     'label', tr.label,
                     'blindRange', tr.blind_range,
                     'minBB', tr.min_bb,
                     'maxBB', tr.max_bb,
                     'amount', tr.amount,
                     'enabled', tr.enabled,
                     'payable', tr.payable) ORDER BY tr.min_bb)
                   FROM tier_rows tr), '[]'::jsonb) AS tiers,
         hits.n AS hits_30d,
         hits.paid AS paid_30d,
         (SELECT max(w.awarded_at) FROM public.bbj_winners w
           WHERE w.pool_id = pool.pool_id AND w.kind = 'mini') AS last_hit_at,
         pool_row.mini_enabled AS club_switch,
         (club.union_id IS NULL AND COALESCE(pool.is_union_pool, false) IS NOT TRUE) AS can_toggle,
         COALESCE(pool.is_union_pool, false) AS is_union_pool
    FROM pool, pool_row, parked_row, hits, club;
$$;

REVOKE ALL ON FUNCTION public.fn_bbj_mini_for_club(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_for_club(uuid) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Assertions
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_default text; v_notnull boolean; v_off int;
BEGIN
  SELECT column_default, is_nullable = 'NO' INTO v_default, v_notnull
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'bbj_pools' AND column_name = 'mini_enabled';
  IF v_default IS DISTINCT FROM 'true' OR v_notnull IS NOT TRUE THEN
    RAISE EXCEPTION 'mini_enabled must be NOT NULL DEFAULT true so a new club has the mini by default (got default %, not null %)', v_default, v_notnull;
  END IF;

  -- Nothing that exists today may be switched off by this migration.
  SELECT count(*) INTO v_off FROM public.bbj_pools WHERE mini_enabled IS NOT TRUE;
  IF v_off <> 0 THEN
    RAISE EXCEPTION 'this migration must not turn the mini off anywhere; % pool(s) are off', v_off;
  END IF;

  IF position('mini_disabled_for_club' IN
       pg_get_functiondef('public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the payout does not honour the club switch';
  END IF;
  -- The switch is read from the row the payout already holds FOR UPDATE.
  IF position('COALESCE(mini_enabled, true)' IN
       pg_get_functiondef('public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the payout does not read the switch from its locked pool row';
  END IF;

  IF pg_get_function_result('public.fn_bbj_mini_for_club(uuid)'::regprocedure) NOT LIKE '%can_toggle boolean%' THEN
    RAISE EXCEPTION 'fn_bbj_mini_for_club does not say whose switch it is';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_set_club_mini_enabled') THEN
    RAISE EXCEPTION 'fn_bbj_set_club_mini_enabled missing';
  END IF;
END $$;

COMMIT;
