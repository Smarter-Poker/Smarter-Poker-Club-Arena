CREATE OR REPLACE FUNCTION public.fn_poker_reject_diamond_hierarchy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id=NEW.club_id AND asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Arena Has No Agents Or Commissions' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_agent_commission_rollup_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pairs jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Transition tables cannot be combined with a column list on the
    -- trigger, so the trigger fires on every UPDATE and the filter is here:
    -- only rows whose outstanding amount, settlement or ownership changed
    -- name a pair to recompute. A notes-only update names none.
    SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('club_id', x.club_id, 'user_id', x.user_id)), '[]'::jsonb)
      INTO v_pairs
      FROM (
        SELECT o.club_id, o.user_id
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.settled_at IS DISTINCT FROM n.settled_at
            OR o.amount IS DISTINCT FROM n.amount
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.user_id IS DISTINCT FROM n.user_id
        UNION
        SELECT n.club_id, n.user_id
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.settled_at IS DISTINCT FROM n.settled_at
            OR o.amount IS DISTINCT FROM n.amount
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.user_id IS DISTINCT FROM n.user_id
      ) x;

    -- Phase 6: the day total moves only when amount, club or day moved.
    -- Subtract the old row, add the new one; a settlement changes neither.
    INSERT INTO public.ca_club_commission_daily AS c
           (club_id, stat_date, amount, rows_counted, updated_at)
    SELECT x.club_id, x.d, sum(x.amount), sum(x.n), now()
      FROM (
        SELECT o.club_id, (o.created_at AT TIME ZONE 'UTC')::date AS d, -o.amount AS amount, -1 AS n
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.amount IS DISTINCT FROM n.amount
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.created_at IS DISTINCT FROM n.created_at
        UNION ALL
        SELECT n.club_id, (n.created_at AT TIME ZONE 'UTC')::date, n.amount, 1
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.amount IS DISTINCT FROM n.amount
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.created_at IS DISTINCT FROM n.created_at
      ) x
     WHERE x.club_id IS NOT NULL
     GROUP BY x.club_id, x.d
    ON CONFLICT (club_id, stat_date) DO UPDATE
       SET amount       = c.amount + EXCLUDED.amount,
           rows_counted = c.rows_counted + EXCLUDED.rows_counted,
           updated_at   = now();
  ELSE
    SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('club_id', o.club_id, 'user_id', o.user_id)), '[]'::jsonb)
      INTO v_pairs
      FROM old_rows o;

    INSERT INTO public.ca_club_commission_daily AS c
           (club_id, stat_date, amount, rows_counted, updated_at)
    SELECT o.club_id, (o.created_at AT TIME ZONE 'UTC')::date, -sum(o.amount), -count(*), now()
      FROM old_rows o
     WHERE o.club_id IS NOT NULL
     GROUP BY o.club_id, (o.created_at AT TIME ZONE 'UTC')::date
    ON CONFLICT (club_id, stat_date) DO UPDATE
       SET amount       = c.amount + EXCLUDED.amount,
           rows_counted = c.rows_counted + EXCLUDED.rows_counted,
           updated_at   = now();
  END IF;
  IF v_pairs <> '[]'::jsonb THEN
    PERFORM public.fn_agent_commission_rollup_recompute(v_pairs);
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_agent_commission_rollup_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT n.club_id, n.user_id,
         sum(n.amount), count(*), min(n.created_at), now()
    FROM new_rows n
   WHERE n.settled_at IS NULL AND n.club_id IS NOT NULL AND n.user_id IS NOT NULL
     AND NOT public.fn_agent_commission_paid_by_period(n.club_id, n.user_id, n.created_at)
   GROUP BY n.club_id, n.user_id
  ON CONFLICT (club_id, user_id) DO UPDATE
     SET owed             = r.owed + EXCLUDED.owed,
         rows_behind      = r.rows_behind + EXCLUDED.rows_behind,
         oldest_unsettled = least(r.oldest_unsettled, EXCLUDED.oldest_unsettled),
         updated_at       = now();

  -- Phase 6: the per-day total the Financials page reads.
  INSERT INTO public.ca_club_commission_daily AS c
         (club_id, stat_date, amount, rows_counted, updated_at)
  SELECT n.club_id, (n.created_at AT TIME ZONE 'UTC')::date, sum(n.amount), count(*), now()
    FROM new_rows n
   WHERE n.club_id IS NOT NULL
   GROUP BY n.club_id, (n.created_at AT TIME ZONE 'UTC')::date
  ON CONFLICT (club_id, stat_date) DO UPDATE
     SET amount       = c.amount + EXCLUDED.amount,
         rows_counted = c.rows_counted + EXCLUDED.rows_counted,
         updated_at   = now();
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
  v_kind text;
  v_sev text;
  v_j jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSIF TG_TABLE_NAME = 'vip_points_ledger' THEN
      /* Phase 8 (2026-09-08). A VIP leg is written once, final: the award
         writer no longer inserts 0 and updates it afterwards. Nothing on this
         table may change. */
      v_allowed_update := false;
    ELSIF TG_TABLE_NAME = 'agent_commissions' THEN
      /* Phase 8. A commission row is what was earned on one hand. The only
         thing that happens to it afterwards is being settled, once. */
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.source_type IS NOT DISTINCT FROM OLD.source_type
        AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
        AND NEW.commission_rate IS NOT DISTINCT FROM OLD.commission_rate
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND (OLD.settled_at IS NULL OR NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at);
    ELSIF TG_TABLE_NAME = 'rakeback_period_payouts' THEN
      /* Phase 8. What was paid, to whom, for which period, never changes;
         status, paid_at, wallet_transaction_id and failure_reason are the
         payout's own bookkeeping. */
      v_allowed_update :=
        NEW.payout_amount IS NOT DISTINCT FROM OLD.payout_amount
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.rakeback_period_id IS NOT DISTINCT FROM OLD.rakeback_period_id
        AND NEW.currency IS NOT DISTINCT FROM OLD.currency
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  /* Phase 8. fn_close_settlement_period inserts a payout row as its
     idempotency claim BEFORE debiting the treasury and deletes it again on a
     shortfall, inside the same transaction. That is a compensation, not a
     mutation of history, so this table's DELETE is allowed - and RECORDED,
     every time, so a person can tell a compensation from a hand on the
     table. The meter counts these. */
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'rakeback_period_payouts' THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true),
            COALESCE(v_reason, 'rakeback-payout-delete: compensation on a treasury shortfall, or maintenance without app.ledger_maintenance'),
            to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);

    BEGIN
      v_kind := split_part(v_reason, ':', 1);
      -- a routine, recorded maintenance is filed, not shouted about
      SELECT k.severity INTO v_sev
        FROM public.ca_ledger_maintenance_kinds k WHERE k.kind = v_kind;
      v_sev := COALESCE(v_sev, 'warning');
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', v_sev,
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || v_kind,
        0, NULL, NULL, 'ledger', TG_TABLE_NAME,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on ' || TG_TABLE_NAME || ': ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log - this incident'
          || ' counts them (occurrences) rather than the chips; query that table by'
          || ' reason for the full inventory. Confirm the maintenance was intended,'
          || ' then resolve.',
        true,
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
                           'reason', v_reason, 'reason_kind', v_kind,
                           'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- DR5. The diamond journal is deleted from on an hourly cadence by the
    -- certification fleet. Keep the row and say who took it. Nothing here can
    -- refuse the DELETE the branch above has already permitted.
    IF TG_TABLE_NAME = 'diamond_transactions' AND TG_OP = 'DELETE' THEN
      BEGIN
        v_j := to_jsonb(OLD);
        INSERT INTO public.ca_diamond_journal_archive
          (id, user_id, type, amount, balance_after, description, reference_id, created_at,
           transaction_type, source, metadata, counterparty, issuance_class,
           deleted_profile_id, deletion_reason)
        VALUES
          ((v_j->>'id')::uuid, (v_j->>'user_id')::uuid, v_j->>'type',
           (v_j->>'amount')::integer, (v_j->>'balance_after')::integer,
           v_j->>'description', v_j->>'reference_id', (v_j->>'created_at')::timestamptz,
           v_j->>'transaction_type', v_j->>'source',
           COALESCE(v_j->'metadata', '{}'::jsonb),
           v_j->>'counterparty', v_j->>'issuance_class',
           (v_j->>'user_id')::uuid, v_reason)
        ON CONFLICT (id) DO NOTHING;

        PERFORM public.fn_ca_diamond_incident(
          'DR5:journal_row_deleted_under_maintenance', 'info',
          (v_j->>'user_id')::uuid, (v_j->>'amount')::numeric,
          'fn_ca_journal_append_only',
          jsonb_build_object('reason', v_reason,
                             'reference_id', v_j->>'reference_id',
                             'type', v_j->>'type',
                             'db_role', current_user));
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ca_diamond_journal_archive could not preserve a journal row deleted under maintenance (%): %',
          v_reason, SQLERRM;
      END;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $function$;
CREATE OR REPLACE FUNCTION public.fn_agent_commission_paid_by_period(p_club_id uuid, p_user_id uuid, p_created_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                  WHERE s.club_id = p_club_id AND s.user_id = p_user_id
                    AND p_created_at >= s.period_start AND p_created_at < s.period_end);
$function$;

CREATE OR REPLACE FUNCTION public.fn_agent_commission_rollup_recompute(p_pairs jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  WITH pairs AS (
    SELECT DISTINCT (p->>'club_id')::uuid AS club_id, (p->>'user_id')::uuid AS user_id
      FROM jsonb_array_elements(p_pairs) p
     WHERE p->>'club_id' IS NOT NULL AND p->>'user_id' IS NOT NULL
  ),
  fresh AS (
    SELECT pr.club_id, pr.user_id,
           coalesce(sum(ac.amount), 0)  AS owed,
           count(ac.id)                 AS rows_behind,
           min(ac.created_at)           AS oldest
      FROM pairs pr
      LEFT JOIN public.agent_commissions ac
        ON ac.club_id = pr.club_id AND ac.user_id = pr.user_id
       AND ac.settled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
     GROUP BY pr.club_id, pr.user_id
  )
  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT f.club_id, f.user_id, f.owed, f.rows_behind, f.oldest, now() FROM fresh f
  ON CONFLICT (club_id, user_id) DO UPDATE
     SET owed = EXCLUDED.owed,
         rows_behind = EXCLUDED.rows_behind,
         oldest_unsettled = EXCLUDED.oldest_unsettled,
         updated_at = now();
END;
$function$;
CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy();
CREATE TRIGGER trg_agent_commission_rollup_del AFTER DELETE ON public.agent_commissions REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_agent_commission_rollup_change();
CREATE TRIGGER trg_agent_commission_rollup_ins AFTER INSERT ON public.agent_commissions REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_agent_commission_rollup_insert();
CREATE TRIGGER trg_agent_commission_rollup_upd AFTER UPDATE ON public.agent_commissions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_agent_commission_rollup_change();
CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only();