-- NO EMOJI IN THE COPY A PLAYER READS
--
-- design-guidelines.md rule 1: "NO EMOJIS - EVER."
-- scripts/ci/check-no-emoji.mjs enforces that on source. It cannot see this
-- database, which is the same blind spot the dash ban hit in 20260831202752.
--
-- SIX player-facing surfaces carried one, inside copy a person reads:
--
--   send_wallet_diamond_transfer   "You received 500 [gem] from @someone"
--   claim_reward                   "[sparkles] RARE FIND!" and three siblings
--   fn_atomic_buyin                "Buy-in: 400 chips for 5 [gem]"
--   fn_notify_agent_on_cashout     "[money] Cashout Request"  title AND body
--   fn_send_message                "[clip] Shared Post"       link preview
--   fn_welcome_new_approved_member "[wave] Everyone welcome X to Y!"
--
-- TWO EARLIER ATTEMPTS AT THIS MIGRATION FAILED, AND BOTH FAILURES WERE THE
-- POST-CHECK EARNING ITS PLACE.
--
-- The first installed an emoji character class in the gate that was too wide:
-- it matched the ARROW block and the dingbat star, so it reported '->' inside
-- a HINT, '->' in a deprecation message, and '* NEW:' in two comments. None of
-- those are emoji and none are copy. A gate that cries wolf gets deleted by
-- the next agent, so the class is now the pictograph planes plus four named
-- BMP characters and nothing else; arrows and check/cross glyphs stay text.
--
-- The second carried a malformed replacement for fn_send_message - a stray
-- quote that would have written a syntactically broken function body into a
-- live messaging path. Postgres refused the EXECUTE and the whole transaction
-- rolled back, so production never saw it. That is why every one of these
-- passes is written as one transaction with an assertion at the end rather
-- than a loop that reports what it managed.
--
-- WHAT IS DELIBERATELY LEFT ALONE, AND WHY
--
-- The fn_ca_* incident and attestation functions, the two health verifiers,
-- and fn_submit_bug_report_to_admin render glyphs as STATUS COLUMNS and
-- severity flags in operator dashboards and admin alerts. Rule 1 and
-- check-no-emoji.mjs are both scoped to "player-facing code"; an internal
-- reconciliation report is neither a page nor a sub page. Exempted BY NAME
-- below, in the open, so it is a decision somebody can argue with.
--
-- The casing here is minimal on purpose. 'RARE FIND!' already satisfies "the
-- first letter of every word is capitalized"; shouting is a style the reward
-- popups chose and this migration is not the place to relitigate it.

SET LOCAL statement_timeout = '600s';
SET LOCAL lock_timeout = '15s';

DO $emoji$
DECLARE
  m text[][] := ARRAY[
    ['''You received '' || p_amount || '' 💎 from @''',
     '''You Received '' || p_amount || '' Diamonds From @'''],
    ['''✨ RARE FIND!''', '''RARE FIND!'''],
    ['''💎 DIAMONDS EARNED!''', '''DIAMONDS EARNED!'''],
    ['''🎊 LEGENDARY ACHIEVEMENT!''', '''LEGENDARY ACHIEVEMENT!'''],
    ['''⭐ EPIC DISCOVERY!''', '''EPIC DISCOVERY!'''],
    ['''Buy-in: '' || p_chip_amount || '' chips for '' || p_diamond_cost || '' 💎''',
     '''Buy-In: '' || p_chip_amount || '' Chips For '' || p_diamond_cost || '' Diamonds'''],
    ['''💰 Cashout Request: '' || NEW.amount || '' chips. Please review in your agent dashboard.''',
     '''Cashout Request: '' || NEW.amount || '' Chips. Please Review In Your Agent Dashboard.'''],
    ['''💰 Cashout Request''', '''Cashout Request'''],
    ['COALESCE(''📎 '' || (p_metadata->>''preview_title'')',
     'COALESCE((p_metadata->>''preview_title'')'],
    ['''📎 Shared Post''', '''Shared Post'''],
    ['''👋 Everyone welcome '' || v_member_name || '' to ''',
     '''Everyone Welcome '' || v_member_name || '' To ''']
  ];
  r      record;
  v_def  text;
  v_new  text;
  v_ok   int := 0;
  v_i    int;
  v_left text := '';
BEGIN
  FOR r IN
    SELECT DISTINCT p.oid, p.oid::regprocedure::text AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND EXISTS (SELECT 1 FROM generate_subscripts(m, 1) AS i
                  WHERE position(m[i][1] in p.prosrc) > 0)
    ORDER BY 2
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := v_def;
    FOR v_i IN 1 .. array_length(m, 1) LOOP
      v_new := replace(v_new, m[v_i][1], m[v_i][2]);
    END LOOP;
    IF v_new <> v_def THEN
      EXECUTE v_new;
      v_ok := v_ok + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'emoji pass: % function(s) rewritten', v_ok;

  FOR v_i IN 1 .. array_length(m, 1) LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.prokind = 'f'
                 AND position(m[v_i][1] in p.prosrc) > 0) THEN
      v_left := v_left || E'\n  ' || left(m[v_i][1], 80);
    END IF;
  END LOOP;
  IF v_left <> '' THEN
    RAISE EXCEPTION 'emoji pass: these old strings survived:%', v_left;
  END IF;
END
$emoji$;

CREATE OR REPLACE FUNCTION public.fn_ca_banned_copy_characters()
RETURNS TABLE (
  kind        text,
  object_name text,
  detail      text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
  WITH lines AS (
    SELECT p.proname, p.oid::regprocedure::text AS sig, l
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(string_to_array(p.prosrc, E'\n')) AS l
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      -- The checker is allowed to hold the characters it checks for. Same
      -- exemption check-ui-text.mjs keeps for titleCase.ts and popupStyle.ts:
      -- without this the function reports ITSELF forever and never passes.
      AND p.proname <> 'fn_ca_banned_copy_characters'
  )
  SELECT 'dash'::text, sig, left(trim(l), 200)
  FROM lines
  WHERE l ~ '[‒–—―]'
  UNION ALL
  SELECT 'emoji'::text, sig, left(trim(l), 200)
  FROM lines
  -- The pictograph planes, plus the four BMP characters this product actually
  -- uses AS emoji. Arrows and check/cross glyphs are deliberately NOT here:
  -- the first version of this gate matched them and reported '->' inside a
  -- HINT and '* NEW:' in a comment, which is how a gate earns its own deletion.
  WHERE l ~ '[\U0001F000-\U0001FAFF✨⭐✅❌]'
    -- Operator dashboards and admin alerts, exempted in the open: glyphs as
    -- status columns and severity flags for staff, not copy on a page. A NAME
    -- LIST rather than a pattern, because a pattern quietly grows to cover
    -- whatever somebody names next.
    AND proname NOT IN (
      'fn_ca_incident_action',
      'fn_ca_incident_escalation_tick',
      'fn_ca_incident_notify',
      'fn_ca_raise_drift_incident',
      'fn_ca_auto_reconcile_tick',
      'fn_ca_burnin_gate_tick',
      'fn_ca_daily_attestation',
      'fn_submit_bug_report_to_admin',
      'verify_home_games_health_core',
      'verify_home_games_health_addendum'
    )
  ORDER BY 1, 2, 3;
$fn$;

COMMENT ON FUNCTION public.fn_ca_banned_copy_characters() IS
  'Every line of every public function that breaks one of Dan''s two character bans: a dash character (banned 2026-08-20) or an emoji in player-facing copy (design-guidelines.md rule 1). Empty is the only passing result. Read by scripts/ci/check-db-copy.mjs. Operator dashboards are exempted by name, in the function body.';

REVOKE ALL ON FUNCTION public.fn_ca_banned_copy_characters() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_banned_copy_characters() TO service_role;

DO $verify$
DECLARE v_left int; v_detail text;
BEGIN
  SELECT count(*) INTO v_left FROM public.fn_ca_banned_copy_characters();
  IF v_left > 0 THEN
    SELECT string_agg(E'\n  ' || kind || ' ' || object_name || ' :: ' || detail, '')
      INTO v_detail FROM (SELECT * FROM public.fn_ca_banned_copy_characters() LIMIT 20) q;
    RAISE EXCEPTION 'banned characters still live:%', v_detail;
  END IF;
END
$verify$;