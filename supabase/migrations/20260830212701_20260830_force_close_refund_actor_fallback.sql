-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830212701; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- audit_trail.actor_id is NOT NULL, and force_close_table_and_refund inserted
-- p_actor_id straight into it. Called without an actor — which an engine, a
-- cron or a psql session all reasonably would — the whole call fails on a
-- constraint AFTER the refund logic has run. It is atomic, so nothing is lost,
-- but the players do not get paid and the table does not close, at exactly the
-- moment somebody is trying to rescue a broken table by hand.
--
-- Same fallback the ledger writer already uses: attribute to the smarterpoker
-- system principal when there is no caller identity. The audit row is then
-- honest about who did it rather than absent.

CREATE OR REPLACE FUNCTION public.force_close_table_and_refund(
  p_table_id uuid,
  p_actor_id uuid DEFAULT NULL,
  p_reason   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_res            jsonb;
  v_total_refunded numeric := 0;
  v_count          integer := 0;
  v_actor          uuid;
BEGIN
  IF p_table_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_table_id required');
  END IF;

  v_actor := COALESCE(p_actor_id, auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  /* Pay every seated player into the LIVE wallet before anything is released.
     Returns immediately for a tournament table, where a stack is not wallet
     money and is settled by the payout structure instead. */
  v_res := public.fn_cashout_seats_for_closing_table(
             p_table_id,
             'force-closed by admin' || COALESCE(' — ' || p_reason, ''));

  IF COALESCE(v_res->>'ok', 'false') <> 'true' THEN
    RETURN jsonb_build_object('success', false, 'error', v_res->>'reason');
  END IF;

  v_count          := COALESCE((v_res->>'players_paid')::int, 0);
  v_total_refunded := COALESCE((v_res->>'chips_returned')::numeric, 0);

  UPDATE public.table_seats SET left_at = NOW()
   WHERE table_id = p_table_id AND left_at IS NULL;

  UPDATE public.tables SET status = 'closed' WHERE id = p_table_id;

  INSERT INTO public.audit_trail
    (actor_id, actor_role, action, target_type, target_id, amount, reason)
  VALUES (v_actor, 'platform_admin', 'force_close_table', 'table',
          p_table_id, v_total_refunded, p_reason);

  RETURN jsonb_build_object('success', true,
    'players_refunded', v_count, 'total_refunded', v_total_refunded);
END;
$fn$;
