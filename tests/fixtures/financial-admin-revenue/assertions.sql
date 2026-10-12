CREATE OR REPLACE FUNCTION fixture_expect_refusal(p_sql text, p_state text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'expected SQLSTATE %, but the call succeeded', p_state;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> p_state THEN RAISE; END IF;
  END;
END;
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.rake_records
       WHERE club_id = '10000000-0000-4000-8000-000000000001'
         AND NOT is_tournament
         AND (created_at AT TIME ZONE 'UTC')::date =
           (now() AT TIME ZONE 'UTC')::date - 1) <= 5000
  THEN
    RAISE EXCEPTION 'fixture did not cross the retired 5,000-row browser ceiling';
  END IF;
END;
$$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', false);

DO $$
DECLARE
  v jsonb;
  v_cash numeric;
  v_fees numeric;
  v_total numeric;
  v_raw numeric;
  v_first date;
  v_last date;
  v_distinct integer;
  v_bad_order integer;
  v_bad_math integer;
  v_zero_day jsonb;
BEGIN
  v := public.ca_financial_admin_revenue_series(
    '10000000-0000-4000-8000-000000000001', 7
  );
  SELECT sum((row->>'cash_rake')::numeric),
         sum((row->>'tournament_fees')::numeric),
         sum((row->>'revenue')::numeric),
         min((row->>'d')::date),
         max((row->>'d')::date),
         count(DISTINCT row->>'d'),
         count(*) FILTER (
           WHERE (row->>'d')::date <>
             (v->>'range_start')::date + (ordinality::integer - 1)
         ),
         count(*) FILTER (
           WHERE (row->>'revenue')::numeric <>
             (row->>'cash_rake')::numeric + (row->>'tournament_fees')::numeric
         )
    INTO v_cash, v_fees, v_total, v_first, v_last,
         v_distinct, v_bad_order, v_bad_math
    FROM jsonb_array_elements(v->'daily') WITH ORDINALITY AS item(row, ordinality);

  SELECT total
    INTO v_raw
    FROM public.fixture_expected_revenue
   WHERE scope = 'club-alpha';

  SELECT row INTO v_zero_day
    FROM jsonb_array_elements(v->'daily') row
   WHERE (row->>'d')::date = (now() AT TIME ZONE 'UTC')::date - 3;

  IF v->>'contract' <> 'ca_financial_admin_revenue_series_v1'
     OR v->>'basis' <> 'cash_rake_plus_tournament_fees'
     OR (v->>'includes_live_day')::boolean IS NOT FALSE
     OR v->>'scope' <> 'club'
     OR v->>'club_id' <> '10000000-0000-4000-8000-000000000001'
     OR (v->>'range_days')::integer <> 7
     OR jsonb_array_length(v->'daily') <> 7
     OR (v->>'range_start')::date <> (now() AT TIME ZONE 'UTC')::date - 7
     OR (v->>'range_end')::date <> (now() AT TIME ZONE 'UTC')::date - 1
     OR v_first <> (now() AT TIME ZONE 'UTC')::date - 7
     OR v_last <> (now() AT TIME ZONE 'UTC')::date - 1
     OR v_distinct <> 7
     OR v_bad_order <> 0
     OR v_bad_math <> 0
     OR v_cash <> 64.0247
     OR v_fees <> 3.75
     OR v_total <> v_raw
     OR (v->>'period_total')::numeric <> round(v_raw, 2)
     OR (v->>'period_total')::numeric <> 67.77
     OR v_zero_day IS NULL
     OR (v_zero_day->>'cash_rake')::numeric <> 0
     OR (v_zero_day->>'tournament_fees')::numeric <> 0
     OR (v_zero_day->>'revenue')::numeric <> 0
     OR v->>'data_updated_at' IS NULL
     OR (v->>'data_updated_at')::timestamptz IS NULL
     OR (v->>'generated_at')::timestamptz IS NULL
  THEN
    RAISE EXCEPTION 'club revenue contract is wrong: %', v;
  END IF;
END;
$$;

SELECT fixture_expect_refusal(
  $$SELECT public.ca_financial_admin_revenue_series(NULL, 7)$$,
  '42501'
);
SELECT fixture_expect_refusal(
  $$SELECT public.ca_financial_admin_revenue_series('10000000-0000-4000-8000-000000000001', 0)$$,
  '22023'
);
SELECT fixture_expect_refusal(
  $$SELECT public.ca_financial_admin_revenue_series('10000000-0000-4000-8000-000000000001', 91)$$,
  '22023'
);

SELECT set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000003', false);
SELECT fixture_expect_refusal(
  $$SELECT public.ca_financial_admin_revenue_series('10000000-0000-4000-8000-000000000001', 7)$$,
  '42501'
);

SELECT set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', false);
DO $$
DECLARE
  v jsonb;
  v_cash numeric;
  v_fees numeric;
  v_total numeric;
  v_raw numeric;
BEGIN
  v := public.ca_financial_admin_revenue_series(NULL, 7);
  SELECT sum((row->>'cash_rake')::numeric),
         sum((row->>'tournament_fees')::numeric),
         sum((row->>'revenue')::numeric)
    INTO v_cash, v_fees, v_total
    FROM jsonb_array_elements(v->'daily') row;
  SELECT total
    INTO v_raw
    FROM public.fixture_expected_revenue
   WHERE scope = 'platform';
  IF v->>'scope' <> 'platform'
     OR (v->'club_id') <> 'null'::jsonb
     OR jsonb_array_length(v->'daily') <> 7
     OR v_cash <> 69.0247
     OR v_fees <> 7.75
     OR v_total <> v_raw
     OR (v->>'period_total')::numeric <> round(v_raw, 2)
     OR (v->>'period_total')::numeric <> 76.77
  THEN
    RAISE EXCEPTION 'platform revenue contract is wrong: %', v;
  END IF;
END;
$$;

RESET ROLE;
SET ROLE anon;
SELECT fixture_expect_refusal(
  $$SELECT public.ca_financial_admin_revenue_series(NULL, 7)$$,
  '42501'
);
RESET ROLE;

DO $$
DECLARE
  v_auth boolean;
  v_anon boolean;
  v_public boolean;
BEGIN
  SELECT has_function_privilege('authenticated', 'public.ca_financial_admin_revenue_series(uuid,integer)', 'EXECUTE'),
         has_function_privilege('anon', 'public.ca_financial_admin_revenue_series(uuid,integer)', 'EXECUTE'),
         EXISTS (
           SELECT 1
             FROM pg_proc p
             CROSS JOIN LATERAL aclexplode(p.proacl) acl
            WHERE p.oid = 'public.ca_financial_admin_revenue_series(uuid,integer)'::regprocedure
              AND acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
         )
    INTO v_auth, v_anon, v_public;
  IF NOT v_auth OR v_anon OR v_public THEN
    RAISE EXCEPTION 'unexpected revenue function grants: auth %, anon %, public %',
      v_auth, v_anon, v_public;
  END IF;
END;
$$;

SELECT 'PASS: financial admin revenue is complete-day, exact, scoped and zero-filled' AS result;
