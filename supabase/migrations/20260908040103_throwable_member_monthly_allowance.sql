-- Planned 30 monthly throws for every member, 500 for VIP, Lifetime unlimited.
-- Release together with the matching allowance display. Not manually applied.
BEGIN;

DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.fn_use_throwable_v2(text,uuid)'::regprocedure);
BEGIN
  IF md5(definition) <> '4c0bd3b5606f9d6f6ae9ccd7700dbc6a' THEN
    RAISE EXCEPTION 'fn_use_throwable_v2 changed since review; revalidate before applying';
  END IF;
  definition := replace(definition,
    '  v_free        constant integer := 500;',
    E'  v_free        constant integer := 500;\n  v_member_free constant integer := 30;\n  v_limit       integer;');
  definition := replace(definition,
    '  IF v_vip THEN',
    E'  v_limit := CASE WHEN v_vip THEN v_free ELSE v_member_free END;\n  IF v_limit > 0 THEN');
  definition := replace(definition, 'v_used < v_free', 'v_used < v_limit');
  definition := replace(definition, 'v_free - v_used - 1', 'v_limit - v_used - 1');
  definition := replace(definition,
    '''source'', ''vip_monthly''',
    '''source'', CASE WHEN v_vip THEN ''vip_monthly'' ELSE ''member_monthly'' END');
  -- Resolve the month after waiting for the account lock, not at transaction start.
  definition := replace(definition,
    '  v_month_start timestamptz := date_trunc(''month'', now() AT TIME ZONE ''UTC'') AT TIME ZONE ''UTC'';',
    '  v_month_start timestamptz;');
  definition := replace(definition,
    '  SELECT' || E'\n    COALESCE(p.is_vip, false)',
    E'  v_month_start := date_trunc(''month'', clock_timestamp() AT TIME ZONE ''UTC'') AT TIME ZONE ''UTC'';\n\n  SELECT\n    COALESCE(p.is_vip, false)');
  definition := replace(definition, 'p.vip_expires_at > now()', 'p.vip_expires_at > clock_timestamp()');
  EXECUTE definition;
END
$migration$;

COMMIT;
