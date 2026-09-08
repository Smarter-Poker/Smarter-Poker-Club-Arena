-- 20260907224355_the_second_writer_check_speaks_about_money_doors.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DEEP DIVE OVER PHASE 7 (roadmap 9.6), 2026-09-07 evening.
--
-- The check shipped an hour earlier (20260907221609) was scoped to ONE
-- directory of the second writer - pages/api/club-arena - and answered
-- "0 errors" for it. The deep dive's coverage test asked what the check was
-- NOT looking at, scanned the whole World Hub server side (pages/api, src/lib,
-- lib: 1,032 files, 326 rpc calls), and found the legacy World Hub poker
-- engine (src/lib/poker-engine/LobbyManager.js) calling two doors the
-- register CLOSED on 2026-09-04 - award_bbj and add_bbj_contribution - and
-- three more money doors with parameter names no live overload accepts,
-- from outside the directory the check watched. The engine has no production
-- request in seven days of Vercel logs (the Hetzner engine took every table),
-- so no chip moved wrongly; but the check said "clean" about a scope nobody
-- had stated. CLAUDE.md 10.86, again.
--
-- Widening the scan to the whole server side brings in calls to functions
-- that are not money doors at all - a responsible-gambling self-exclusion
-- whose parameter names are wrong, an admin lookup, a training cache. Those
-- are real defects and their lanes are told (see the changelog), but a chip
-- standard's check must fail on CHIPS. So severity is now scoped: a finding
-- on a function that is in ca_money_rpc_registry (any status) or that writes
-- balance columns is an ERROR; the same finding on any other function is a
-- WARNING, reported in full, never failing the run. Every finding carries
-- `money: true|false` so a reader can see which rule applied. closed_door is
-- always an error: a closed door is in the register by definition.
--
-- The scanner itself had a bug the same dive found: a nested object literal
-- in the payload (`p_details: { hand, equity }`) leaked its inner keys into
-- the parameter list and reported four correct calls as mismatches. Fixed in
-- scripts/ci/audit-second-writer.mjs with a balanced-brace walk; pinned by a
-- unit test on the scanner.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_second_writer_check(p_calls jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c            jsonb;
  v_fn         text;
  v_keys       text[];
  v_findings   jsonb := '[]'::jsonb;
  v_checked    int := 0;
  v_unchecked  int := 0;
  v_calls      int := 0;
  v_overloads  int;
  v_status     text;
  v_sr         boolean;
  v_sig_ok     boolean;
  v_live       text;
  v_writes     boolean;
  v_money      boolean;
  v_sev        text;
  v_kinds      jsonb := '{}'::jsonb;
BEGIN
  IF p_calls IS NULL OR jsonb_typeof(p_calls) <> 'array' THEN
    RAISE EXCEPTION 'fn_ca_second_writer_check wants a JSON array of {file, line, fn, keys}';
  END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(p_calls) LOOP
    v_calls := v_calls + 1;
    v_fn := c->>'fn';
    IF v_fn IS NULL OR v_fn !~ '^[a-z_][a-z0-9_]*$' THEN
      v_findings := v_findings || jsonb_build_object('file', c->>'file', 'line', c->'line', 'fn', v_fn,
        'kind', 'unreadable_call', 'severity', 'error', 'money', true,
        'detail', 'the function name is not a plain identifier');
      CONTINUE;
    END IF;

    /* keys: null = the payload was not a literal object; the script could not
       read it, so this call is counted as UNCHECKED, never as fine. */
    IF c->'keys' IS NULL OR jsonb_typeof(c->'keys') <> 'array' THEN
      v_keys := NULL;
    ELSE
      SELECT array_agg(x) INTO v_keys FROM jsonb_array_elements_text(c->'keys') x;
      v_keys := COALESCE(v_keys, '{}'::text[]);
    END IF;
    /* Coverage is counted here, before any verdict, so a missing function is
       still a call that was checked and the totals always sum to `calls`. */
    IF v_keys IS NULL THEN v_unchecked := v_unchecked + 1; ELSE v_checked := v_checked + 1; END IF;

    SELECT count(*), bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')),
           string_agg('(' || COALESCE(array_to_string(p.proargnames[1:p.pronargs], ', '), '') || ')', ' | '),
           bool_or(
             (p.prosrc ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
              OR p.prosrc ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y'
              OR p.prosrc ~* 'EXECUTE\s+format\s*\(\s*''UPDATE')
             AND p.prosrc ~* '\y(chip_balance|held_chips|locked_chips|credit_used|credit_limit|stack|balance|chips|prize|bounty_winnings|promo_balance)\y')
      INTO v_overloads, v_sr, v_live, v_writes
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_fn;

    SELECT status INTO v_status FROM public.ca_money_rpc_registry WHERE proname = v_fn;

    /* A MONEY DOOR is one the register knows (any status) or one that writes
       balance columns. A function the register has never seen and that has
       no function body to read (missing) is judged by the register alone. */
    v_money := (v_status IS NOT NULL) OR COALESCE(v_writes, false);
    v_sev   := CASE WHEN v_money THEN 'error' ELSE 'warning' END;

    IF v_overloads = 0 THEN
      v_findings := v_findings || jsonb_build_object('file', c->>'file', 'line', c->'line', 'fn', v_fn,
        'kind', 'missing_function', 'severity', v_sev, 'money', v_money,
        'detail', 'no function of this name exists in public; the route gets PGRST202 on every call');
      CONTINUE;
    END IF;

    IF v_status = 'closed' THEN
      v_findings := v_findings || jsonb_build_object('file', c->>'file', 'line', c->'line', 'fn', v_fn,
        'kind', 'closed_door', 'severity', 'error', 'money', true,
        'detail', 'the register closed this door; the route still calls it. Refuse before writing, or remove the branch.');
    ELSIF NOT COALESCE(v_sr, false) THEN
      v_findings := v_findings || jsonb_build_object('file', c->>'file', 'line', c->'line', 'fn', v_fn,
        'kind', 'not_executable_by_service_role', 'severity', v_sev, 'money', v_money,
        'detail', 'service_role cannot execute it; the route gets "permission denied" on every call');
    END IF;

    IF v_keys IS NOT NULL THEN
      /* PostgREST picks the overload whose NAMED parameters are exactly the
         keys sent, with every other parameter carrying a default. */
      SELECT bool_or(
               v_keys <@ COALESCE(p.proargnames[1:p.pronargs], '{}'::text[])
               AND NOT EXISTS (
                 SELECT 1 FROM unnest(COALESCE(p.proargnames[1:p.pronargs], '{}'::text[])) WITH ORDINALITY a(n, i)
                  WHERE NOT (a.n = ANY (v_keys))
                    AND a.i <= p.pronargs - p.pronargdefaults))
        INTO v_sig_ok
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_fn;
      IF NOT COALESCE(v_sig_ok, false) THEN
        v_findings := v_findings || jsonb_build_object('file', c->>'file', 'line', c->'line', 'fn', v_fn,
          'kind', 'signature_mismatch', 'severity', v_sev, 'money', v_money,
          'sent', to_jsonb(v_keys), 'live', v_live,
          'detail', 'no overload accepts exactly these parameter names; PostgREST answers PGRST202 and whatever the route does next is the only thing that runs');
      END IF;
    END IF;

    IF v_status IS NULL AND COALESCE(v_writes, false) THEN
      v_findings := v_findings || jsonb_build_object('file', c->>'file', 'line', c->'line', 'fn', v_fn,
        'kind', 'unregistered_writer', 'severity', 'warning', 'money', true,
        'detail', 'this function writes balance columns and is not in ca_money_rpc_registry: audit it, then register it');
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) INTO v_kinds
    FROM (SELECT f->>'kind' AS k, count(*) AS n FROM jsonb_array_elements(v_findings) f GROUP BY 1) s;

  RETURN jsonb_build_object(
    'calls', v_calls,
    'checked', v_checked,
    'unchecked', v_unchecked,
    'errors', (SELECT count(*) FROM jsonb_array_elements(v_findings) f WHERE f->>'severity' = 'error'),
    'warnings', (SELECT count(*) FROM jsonb_array_elements(v_findings) f WHERE f->>'severity' = 'warning'),
    'kinds', v_kinds,
    'findings', v_findings,
    'registry', (SELECT jsonb_build_object('approved', count(*) FILTER (WHERE status = 'approved'),
                                           'closed', count(*) FILTER (WHERE status = 'closed'))
                   FROM public.ca_money_rpc_registry),
    'as_of', now());
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_second_writer_check(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_second_writer_check(jsonb) TO service_role;

DO $verify$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public.fn_ca_second_writer_check('[
    {"file":"probe.js","line":1,"fn":"award_bbj","keys":["p_club_id"]},
    {"file":"probe.js","line":2,"fn":"fn_rg_self_exclude","keys":["p_user_id","p_until"]},
    {"file":"probe.js","line":3,"fn":"increment_settlement_counters","keys":["p_club_id","p_rake","p_hands"]},
    {"file":"probe.js","line":4,"fn":"fn_no_such_thing_at_all","keys":["x"]},
    {"file":"probe.js","line":5,"fn":"fn_credit_chips","keys":["p_club_id","p_user_id","p_amount"]}
  ]'::jsonb);
  -- a closed door is an error, money
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'findings') f WHERE f->>'fn' = 'award_bbj' AND f->>'kind' = 'closed_door' AND f->>'severity' = 'error' AND (f->>'money')::boolean) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a closed door is not an error: %', v_res;
  END IF;
  -- a wrong signature on a NON-money function is a warning, and says so
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'findings') f WHERE f->>'fn' = 'fn_rg_self_exclude' AND f->>'kind' = 'signature_mismatch' AND f->>'severity' = 'warning' AND NOT (f->>'money')::boolean) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a non-money mismatch is not a warning: %', v_res;
  END IF;
  -- a wrong signature on a registered money door is an error
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'findings') f WHERE f->>'fn' = 'increment_settlement_counters' AND f->>'kind' = 'signature_mismatch' AND f->>'severity' = 'error' AND (f->>'money')::boolean) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a money-door mismatch is not an error: %', v_res;
  END IF;
  -- a missing function the register never knew is a warning
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'findings') f WHERE f->>'fn' = 'fn_no_such_thing_at_all' AND f->>'kind' = 'missing_function' AND f->>'severity' = 'warning') THEN
    RAISE EXCEPTION 'VERIFY FAILED: an unknown missing function is not a warning: %', v_res;
  END IF;
  -- award_bbj is reported twice: closed, and (with a made-up key) mismatched.
  -- Both are true; a reader gets both. 3 errors, 2 warnings, 5 of 5 checked.
  IF (v_res->>'errors')::int <> 3 OR (v_res->>'warnings')::int <> 2 OR (v_res->>'calls')::int <> 5 OR (v_res->>'checked')::int <> 5 THEN
    RAISE EXCEPTION 'VERIFY FAILED: counts: %', v_res - 'findings';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_second_writer_check(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_second_writer_check(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_ca_second_writer_check(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: grants on fn_ca_second_writer_check';
  END IF;
  RAISE NOTICE 'the second writer check speaks about money doors: %', v_res - 'findings';
END $verify$;

COMMIT;
