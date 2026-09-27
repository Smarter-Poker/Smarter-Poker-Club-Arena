-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417144526 "phase14_home_games_money_ledger_fix_totals_fn"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 21dfa452fbe90f93233b402483d69381 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Rename the ambiguous output column; also rename the CTE columns
-- so there's zero chance of collision. Returns same shape to callers
-- (they can still alias on their side).
DROP FUNCTION IF EXISTS fn_home_game_totals(uuid);

CREATE FUNCTION fn_home_game_totals(p_game_id uuid)
RETURNS TABLE (
    out_user_id        uuid,
    total_buyin_cents  bigint,
    cashout_cents      bigint,
    net_cents          bigint,
    chip_count         integer,
    username           text,
    display_name       text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH buyins AS (
        SELECT b.user_id AS uid, SUM(b.amount_cents)::bigint AS total_cents
        FROM commander_home_buyins b
        WHERE b.game_id = p_game_id
        GROUP BY b.user_id
    ),
    cashouts AS (
        SELECT c.user_id AS uid, c.amount_cents::bigint AS amt, c.chip_count AS cc
        FROM commander_home_cashouts c
        WHERE c.game_id = p_game_id
    ),
    universe AS (
        SELECT uid FROM buyins
        UNION
        SELECT uid FROM cashouts
    )
    SELECT
        u.uid                                             AS out_user_id,
        COALESCE(b.total_cents, 0)                        AS total_buyin_cents,
        COALESCE(c.amt, 0)                                AS cashout_cents,
        COALESCE(c.amt, 0) - COALESCE(b.total_cents, 0)   AS net_cents,
        c.cc                                              AS chip_count,
        p.username                                        AS username,
        COALESCE(p.display_name, p.full_name, p.username) AS display_name
    FROM universe u
    LEFT JOIN buyins   b ON b.uid = u.uid
    LEFT JOIN cashouts c ON c.uid = u.uid
    LEFT JOIN profiles p ON p.id  = u.uid
    ORDER BY COALESCE(c.amt, 0) - COALESCE(b.total_cents, 0) DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_home_game_totals(uuid) TO authenticated, service_role;

-- fn_home_compute_settlements calls fn_home_game_totals and reads net_cents
-- via SELECT .. FROM fn_home_game_totals(..) — the column rename only affects
-- the first column name (user_id -> out_user_id). Update that reference too.
CREATE OR REPLACE FUNCTION fn_home_compute_settlements(
    p_caller  uuid,
    p_game_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_total_buyin   bigint;
    v_total_cashout bigint;
    v_row_count     integer := 0;
    v_unbalanced    bigint;
    debtors         jsonb := '[]'::jsonb;
    creditors       jsonb := '[]'::jsonb;
    d_user          uuid; d_amt bigint;
    c_user          uuid; c_amt bigint;
    pay             bigint;
BEGIN
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;

    SELECT COALESCE(SUM(amount_cents),0) INTO v_total_buyin
      FROM commander_home_buyins WHERE game_id = p_game_id;
    SELECT COALESCE(SUM(amount_cents),0) INTO v_total_cashout
      FROM commander_home_cashouts WHERE game_id = p_game_id;

    v_unbalanced := v_total_cashout - v_total_buyin;

    DELETE FROM commander_home_settlements
     WHERE game_id = p_game_id AND status = 'pending';

    SELECT
        COALESCE(jsonb_agg(jsonb_build_object('u', t.out_user_id, 'amt', -t.net_cents))
                 FILTER (WHERE t.net_cents < 0), '[]'::jsonb),
        COALESCE(jsonb_agg(jsonb_build_object('u', t.out_user_id, 'amt', t.net_cents))
                 FILTER (WHERE t.net_cents > 0), '[]'::jsonb)
      INTO debtors, creditors
      FROM fn_home_game_totals(p_game_id) t;

    WHILE jsonb_array_length(debtors) > 0 AND jsonb_array_length(creditors) > 0 LOOP
        debtors   := (SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'amt')::bigint DESC), '[]'::jsonb) FROM jsonb_array_elements(debtors) e);
        creditors := (SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'amt')::bigint DESC), '[]'::jsonb) FROM jsonb_array_elements(creditors) e);

        d_user := (debtors   -> 0 ->> 'u')::uuid;
        c_user := (creditors -> 0 ->> 'u')::uuid;
        d_amt  := (debtors   -> 0 ->> 'amt')::bigint;
        c_amt  := (creditors -> 0 ->> 'amt')::bigint;

        pay := LEAST(d_amt, c_amt);
        IF pay <= 0 THEN EXIT; END IF;

        INSERT INTO commander_home_settlements (
            game_id, payer_user_id, payee_user_id, amount_cents, status
        ) VALUES (
            p_game_id, d_user, c_user, pay::integer, 'pending'
        );
        v_row_count := v_row_count + 1;

        IF d_amt - pay > 0 THEN
            debtors := jsonb_set(debtors, '{0,amt}', to_jsonb(d_amt - pay));
        ELSE
            debtors := debtors - 0;
        END IF;
        IF c_amt - pay > 0 THEN
            creditors := jsonb_set(creditors, '{0,amt}', to_jsonb(c_amt - pay));
        ELSE
            creditors := creditors - 0;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'game_id', p_game_id,
        'total_buyin_cents',   v_total_buyin,
        'total_cashout_cents', v_total_cashout,
        'imbalance_cents',     v_unbalanced,
        'settlements_created', v_row_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION fn_home_compute_settlements(uuid, uuid) TO authenticated, service_role;
