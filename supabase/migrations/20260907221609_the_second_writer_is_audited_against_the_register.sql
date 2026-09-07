-- 20260907221148_the_second_writer_is_audited_against_the_register.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- PHASE 7 OF THE CHIP-ACCOUNTING PROGRAMME, roadmap 9.6:
-- "THE SECOND WRITER HAS NEVER BEEN AUDITED. Phase 5 registered every money
--  door in the database. The World Hub carries its own money routes under
--  pages/api/club-arena/, in another repo, and nothing has ever been checked
--  against that register. A door is only closed if both repos agree it is
--  closed."
--
-- Everything below was READ from production and from the World Hub's
-- origin/main on 2026-09-07 before it was written.
--
-- WHAT THE FIRST AUDIT FOUND (69 routes, 81 RPC calls, every one compared
-- against pg_proc and ca_money_rpc_registry):
--
--   1. Two routes call doors the register CLOSED on 2026-09-04 and that
--      service_role can no longer execute: promo-wallet.js `mint_promo` calls
--      mint_club_promo, and union-wallet.js `process_bbj_payout` calls
--      fn_union_bbj_pool_payout - after inserting an idempotency claim row it
--      then has to delete again. Both have answered "permission denied" as a
--      500 since the day the doors closed, and nothing on either side said so.
--   2. agent-credit.js calls fn_atomic_increment_field with a parameter shape
--      (p_table, p_field, p_increment, p_where_club_id, p_where_user_id) that
--      does not exist - the live signature is (p_table_name, p_id, p_field,
--      p_amount), and its allowlist does not contain club_members at all. So
--      PostgREST answers PGRST202 every time and the route's "fallback" - JS
--      arithmetic on credit_limit with an optimistic lock, mirrored by hand
--      into a second table - is the ONLY path that has ever run. It has no
--      caller anywhere in the organisation (GitHub code search across every
--      repository: the route file, the rate-limiter table, and two e2e
--      scripts); Club Arena adjusts credit through fn_admin_update_agent, a
--      registered door, from the browser.
--   3. increment_column(table_name, column_name, row_id) is a GENERIC door:
--      `UPDATE public.%I SET %I = %I + 1` on ANY table and column, service
--      role only, SECURITY INVOKER, with `EXCEPTION WHEN OTHERS THEN NULL`.
--      The register's drift scan cannot see it, because it names no table in
--      its source. Its one caller increments table_templates.use_count.
--   4. fn_atomic_increment_field carries an allowlist that includes
--      agents.credit_used and agents.credit_limit - balance columns by the
--      register's own definition - and is executable by `authenticated`,
--      and is not registered, for the same reason: dynamic SQL.
--   5. Eighteen money routes in the World Hub have no caller in either
--      repository or anywhere else in the organisation. They are doors both
--      repos agree are OPEN; this migration does not close them, it makes
--      sure they can be checked. Named in the changelog for a decision.
--
-- WHAT THIS BUILDS:
--
--   fn_ca_second_writer_check(p_calls jsonb) - the register's answer to the
--   question "does this list of (file, line, function, parameter names) agree
--   with what production has?" It is what scripts/ci/audit-second-writer.mjs
--   sends, hourly, after scanning the World Hub's route files. A call is a
--   finding when its function is missing, closed, not executable by the
--   service role, or when no overload accepts exactly the parameter names the
--   route sends (PostgREST resolves overloads by NAMED parameters: a wrong
--   name is a 404, not a wrong value). It also names, as a warning, any called
--   function that writes balance columns and is not in the register. The
--   answer carries what it could NOT check (calls whose payload is not a
--   literal object) so "0 findings" cannot be read as "all clear".
--
--   increment_column is given an allowlist and stops swallowing errors, and
--   both generic doors are registered with their allowlists as the note, so
--   the register is complete about what a caller can reach through them.
--
-- The World Hub side of this - the two closed-door call sites refusing before
-- they write, the dead agent-credit route removed, and the workflow that runs
-- the check - ships in the World Hub's own pull request and in this
-- repository's schema-manifest-refresh.yml.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The register answers for a list of calls.
-- ---------------------------------------------------------------------------
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
        'kind', 'unreadable_call', 'severity', 'error', 'detail', 'the function name is not a plain identifier');
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

    IF v_overloads = 0 THEN
      v_findings := v_findings || jsonb_build_object('file', c->>'file', 'line', c->'line', 'fn', v_fn,
        'kind', 'missing_function', 'severity', 'error',
        'detail', 'no function of this name exists in public; the route gets PGRST202 on every call');
      CONTINUE;
    END IF;

    IF v_status = 'closed' THEN
      v_findings := v_findings || jsonb_build_object('file', c->>'file', 'line', c->'line', 'fn', v_fn,
        'kind', 'closed_door', 'severity', 'error',
        'detail', 'the register closed this door; the route still calls it. Refuse before writing, or remove the branch.');
    ELSIF NOT COALESCE(v_sr, false) THEN
      v_findings := v_findings || jsonb_build_object('file', c->>'file', 'line', c->'line', 'fn', v_fn,
        'kind', 'not_executable_by_service_role', 'severity', 'error',
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
          'kind', 'signature_mismatch', 'severity', 'error',
          'sent', to_jsonb(v_keys), 'live', v_live,
          'detail', 'no overload accepts exactly these parameter names; PostgREST answers PGRST202 and whatever the route does next is the only thing that runs');
      END IF;
    END IF;

    IF v_status IS NULL AND COALESCE(v_writes, false) THEN
      v_findings := v_findings || jsonb_build_object('file', c->>'file', 'line', c->'line', 'fn', v_fn,
        'kind', 'unregistered_writer', 'severity', 'warning',
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

COMMENT ON FUNCTION public.fn_ca_second_writer_check(jsonb) IS
  'Phase 7 (roadmap 9.6). Takes [{file,line,fn,keys}] as scanned from the World Hub''s pages/api/club-arena routes and answers whether each call agrees with pg_proc and ca_money_rpc_registry: missing, closed, not executable by service_role, parameter names no overload accepts, or an unregistered balance writer. The answer carries `unchecked` for calls whose payload could not be read.';

-- ---------------------------------------------------------------------------
-- 2. The generic door gets an allowlist and stops swallowing errors.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_column(table_name text, column_name text, row_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  /* Before 2026-09-07 this was `UPDATE public.%I SET %I = %I + 1` on ANY
     table and column, with every error swallowed. It is a door onto every
     balance column on the platform that names no table in its source, so the
     register's drift scan could not see it. The allowlist is the declaration;
     widening it is a registry note, not a code edit. */
  IF row_id IS NULL THEN
    RAISE EXCEPTION 'increment_column: row_id is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES ('table_templates', 'use_count')) v(t, f)
     WHERE v.t = table_name AND v.f = column_name
  ) THEN
    RAISE EXCEPTION 'increment_column: %.% is not on the allowlist (table_templates.use_count). A balance column is never reached through a generic door.',
      table_name, column_name USING ERRCODE = 'P0403';
  END IF;
  EXECUTE format('UPDATE public.%I SET %I = COALESCE(%I, 0) + 1 WHERE id = $1', table_name, column_name, column_name)
    USING row_id;
END $fn$;

REVOKE ALL ON FUNCTION public.increment_column(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_column(text, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Both generic doors are in the register, with what they can reach.
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES
  ('increment_column', 'approved',
   'generic +1 door, dynamic SQL, service_role only. Allowlisted 2026-09-07 (phase 7, 9.6) to table_templates.use_count - its one caller, World Hub table-templates.js. Any other (table, column) is refused with P0403.'),
  ('fn_atomic_increment_field', 'approved',
   'generic increment door with an in-function allowlist (clubs.member_count/table_count/active_players/active_tables/hands_played/total_rake, agents.total_players/active_player_count/sub_agent_count/credit_used/credit_limit, tables.hands_played, tournaments.registered_count/current_players/total_rake); dynamic SQL, so the drift scan cannot see it. Registered 2026-09-07 (phase 7, 9.6). The World Hub route that called it with a parameter shape it never had (agent-credit.js) is removed in the same programme.')
ON CONFLICT (proname) DO UPDATE SET notes = EXCLUDED.notes;

-- ---------------------------------------------------------------------------
-- 4. PROVE IT, in this transaction, or abort it.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_res jsonb;
  v_kinds jsonb;
BEGIN
  -- the check answers correctly about calls whose truth is known
  v_res := public.fn_ca_second_writer_check('[
    {"file":"probe.js","line":1,"fn":"fn_credit_chips","keys":["p_club_id","p_user_id","p_amount"]},
    {"file":"probe.js","line":2,"fn":"fn_atomic_increment_field","keys":["p_table","p_field","p_increment","p_where_club_id","p_where_user_id"]},
    {"file":"probe.js","line":3,"fn":"mint_club_promo","keys":["p_club_id","p_amount"]},
    {"file":"probe.js","line":4,"fn":"fn_this_door_does_not_exist","keys":["p_x"]},
    {"file":"probe.js","line":5,"fn":"fn_ad_stats","keys":null},
    {"file":"probe.js","line":6,"fn":"increment_column","keys":["table_name","column_name","row_id"]}
  ]'::jsonb);
  v_kinds := v_res->'kinds';
  IF (v_res->>'calls')::int <> 6 OR (v_res->>'checked')::int <> 5 OR (v_res->>'unchecked')::int <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the check miscounted its own coverage: %', v_res - 'findings';
  END IF;
  IF COALESCE((v_kinds->>'signature_mismatch')::int, 0) <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the agent-credit parameter shape was not reported as a signature mismatch: %', v_res;
  END IF;
  IF COALESCE((v_kinds->>'closed_door')::int, 0) <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: mint_club_promo was not reported as a closed door: %', v_res;
  END IF;
  IF COALESCE((v_kinds->>'missing_function')::int, 0) <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: a function that does not exist was not reported: %', v_res;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'findings') f WHERE f->>'fn' IN ('fn_credit_chips', 'increment_column')) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a correct call was reported as a finding: %', v_res;
  END IF;

  -- the generic door refuses everything but its allowlist (subtransaction, rolled back)
  BEGIN
    PERFORM public.increment_column('club_members', 'chip_balance', gen_random_uuid());
    RAISE EXCEPTION 'VERIFY FAILED: increment_column reached club_members.chip_balance';
  EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
  END;

  -- the register now knows both generic doors
  IF (SELECT count(*) FROM public.ca_money_rpc_registry WHERE proname IN ('increment_column', 'fn_atomic_increment_field') AND status = 'approved') <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the generic doors are not registered';
  END IF;

  -- nothing here is reachable from a browser
  IF has_function_privilege('anon', 'public.fn_ca_second_writer_check(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_second_writer_check(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.increment_column(text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.increment_column(text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: a phase 7 function is executable by a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_second_writer_check(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.increment_column(text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: service_role lost a door it needs';
  END IF;

  RAISE NOTICE 'the second writer is audited against the register: %', v_res - 'findings';
END $verify$;

COMMIT;
