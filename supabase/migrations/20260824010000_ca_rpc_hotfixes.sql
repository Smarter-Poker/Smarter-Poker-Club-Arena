-- ===========================================================================
-- CLUB ARENA RPC HOTFIXES (2026-08-24)
--
-- Six defects found while reviewing the Club Arena stats + wallet RPCs. One is
-- a privilege escalation, three make a feature fail 100% of the time, and two
-- are correctness. All six were applied to PokerIQ-Production live and are
-- recorded here so the repo matches the database.
--
-- Each patch rewrites the LIVE definition after asserting its target appears
-- exactly once, because several of these bodies are not in the repo at all
-- (they were applied by hand). Re-pasting them from memory would be invention,
-- not a migration. Every block is idempotent.
--
-- ---------------------------------------------------------------------------
-- 1. fn_wallet_claim_back - ANY LOGGED-IN USER COULD DRAIN ANY MEMBER'S WALLET
--
--    fn_club_bank_role() returns NULL for a non-member. Every permission gate
--    in this function is an IN / NOT IN test, and in SQL `NULL NOT IN (...)`
--    is NULL, not TRUE - so
--        IF v_actor_role NOT IN ('owner',...) THEN <reject> END IF;
--    did NOT reject. IF treats NULL as false and execution fell straight
--    through. The downline check `... AND v_actor_role IN (...)` was skipped
--    for the same reason. Net effect: a user who was not a member of the club
--    at all passed every gate and could move chips out of any active member's
--    wallet into their own agent or promo wallet. EXECUTE is granted to
--    `authenticated`, so that was every logged-in account on the platform.
--
--    Verified before the fix, by impersonating a non-member: role resolved to
--    NULL and the guards did not fire. Verified after: the same call returns
--    "You Are Not A Member Of This Club". No money moved - chip_transactions
--    held zero claims of any kind (see defect 2 for why).
--
-- 2. fn_wallet_claim_back - THE FEATURE HAD NEVER WORKED, AT ALL
--
--    It unconditionally inserted an `agents` row for BOTH parties on every
--    claim. agents.commission_rate and agents.player_rakeback_rate are NOT
--    NULL with no default and the insert supplied neither, so it raised
--    23502 and the whole call aborted with a raw Postgres error for anyone
--    without a pre-existing agents row. That is why zero claims exist.
--    Supplying 0 is not enough either: trg_agents_commission_bounds rejects
--    any rate outside the club's union policy band (measured: 0.20 .. 0.70).
--
--    It was also wrong in principle. An owner moving chips into the CLUB BANK
--    is not an agent, and minting an agent record for them injects a
--    fabricated commission rate into rakeback and commission maths. `agents`
--    is only read or written when an agent/promo wallet is one of the two
--    ends, so the row is now created only for those flows, at the union's
--    minimum permitted commission.
--
-- 3. ca_club_my_downline - INFINITE RECURSION ON LIVE DATA
--
--    WITH RECURSIVE ... UNION ALL with no cycle guard. club_members.agent_id
--    currently contains two two-node cycles (A is B's agent and B is A's).
--    Reproducing the walk against one blew past a four-second timeout even
--    with a 2000-row depth cap added for the probe; the deployed version had
--    no cap, so every call by an agent at or below such a cycle burned the
--    caller's whole 8s statement_timeout and returned nothing. The query was
--    already accumulating `path` for display, so it now doubles as the
--    visited-set. Measured after: 25ms for a user in a cycle, 10ms for a
--    10-member downline.
--
--    NOTE for whoever wrote the jsonb version of this function: it CANNOT be
--    deployed over this one. The live signature returns TABLE(...), and
--    CREATE OR REPLACE with a different return type fails with
--    42P13 "cannot change return type of existing function". It needs an
--    explicit DROP FUNCTION public.ca_club_my_downline(uuid) first, and every
--    caller updated, since the two APIs are not interchangeable.
--
-- 4. ca_player_ev_curve - THREW ON EVERY SINGLE CALL
--
--    `agg` counts `FILTER (WHERE was_all_in = true)` but selects FROM accum,
--    and accum projected only played_at, net_bb, ev_net_bb and the running
--    sums - it dropped was_all_in. Every call raised
--    42703 column "was_all_in" does not exist. Not an edge case: the EV curve
--    was broken 100% of the time for every player. Measured after the fix:
--    32 hands / 16 all-in / +52.05 bb for a real account.
--
-- 5. ca_player_stats_full - THE CAP WAS HARDCODED BESIDE THE CONSTANT
--
--    c_cap is 750, but the JSON emitted `'hand_cap', 750` and
--    `(hands >= 750)` as literals. Change c_cap and the API confidently
--    reports a cap it no longer uses, and hands_capped flips at the wrong
--    threshold - so the "based on your most recent N hands" line vanishes on
--    exactly the accounts that need it, which is the one thing the comment
--    above c_cap says must never happen.
--
-- 6. ca_player_hand_grid - totals.hands WAS NULL, NOT 0
--
--    sum() over zero rows is NULL. A player with no qualifying hands got
--    {"totals":{"hands":null}}, so any client arithmetic or comparison on it
--    silently produced NaN / false instead of an honest empty state.
--
-- ROLLBACK: each function's previous body is in the remote migration history.
-- ===========================================================================

BEGIN;

-- == 1 + 2. fn_wallet_claim_back ===========================================
DO $$
DECLARE
  v_src text; v_out text; n1 int; n2 int; n3 int;
  c_anchor constant text := '  v_actor_role := public.fn_club_bank_role(p_club_id);';
  c_fixed  constant text :=
'  v_actor_role := public.fn_club_bank_role(p_club_id);
  -- FAIL CLOSED ON AN UNKNOWN ROLE (2026-08-24, security). fn_club_bank_role
  -- returns NULL for a non-member, and `NULL NOT IN (...)` is NULL, so every
  -- guard below silently did not fire. See this migration''s header, defect 1.
  if v_actor_role is null or btrim(v_actor_role) = '''' then
    return jsonb_build_object(''success'', false, ''error'', ''You Are Not A Member Of This Club'');
  end if;';
  c_decl  constant text := '  v_second uuid;';
  c_decl2 constant text := '  v_second uuid;
  v_union uuid;
  v_min_comm numeric;';
  c_ins_a constant text :=
'  insert into agents (user_id, club_id, role, status)
    values (v_actor, p_club_id, v_actor_role, ''active'')
    on conflict (user_id, club_id) do nothing;';
  c_ins_a2 constant text :=
'  -- ONLY MINT AN AGENTS ROW WHEN THE FLOW ACTUALLY USES ONE (2026-08-24).
  -- See this migration''s header, defect 2: the unconditional insert violated
  -- two NOT NULL columns, then the union commission band, and fabricated an
  -- agent record for owners who are not agents.
  select coalesce(uc.union_id, c.union_id) into v_union
    from clubs c left join union_clubs uc on uc.club_id = c.id
   where c.id = p_club_id limit 1;
  v_min_comm := case when v_union is null then 0
                     else public.fn_union_setting(v_union, ''min_agent_commission'', 0) end;

  if v_target in (''agent_wallet'', ''promo_wallet'') then
    insert into agents (user_id, club_id, role, status, commission_rate, player_rakeback_rate)
      values (v_actor, p_club_id, v_actor_role, ''active'', v_min_comm, 0)
      on conflict (user_id, club_id) do nothing;
  end if;';
  c_ins_b constant text :=
'  insert into agents (user_id, club_id, role, status)
    values (p_from_user_id, p_club_id, v_from_role, ''active'')
    on conflict (user_id, club_id) do nothing;';
  c_ins_b2 constant text :=
'  if v_source in (''agent_wallet'', ''promo_wallet'') then
    insert into agents (user_id, club_id, role, status, commission_rate, player_rakeback_rate)
      values (p_from_user_id, p_club_id, v_from_role, ''active'', v_min_comm, 0)
      on conflict (user_id, club_id) do nothing;
  end if;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_wallet_claim_back' LIMIT 1;
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_wallet_claim_back not found'; END IF;
  IF position('You Are Not A Member Of This Club' IN v_src) > 0
     AND position('ONLY MINT AN AGENTS ROW' IN v_src) > 0 THEN
    RAISE NOTICE 'fn_wallet_claim_back already hotfixed'; RETURN;
  END IF;

  n1 := (length(v_src) - length(replace(v_src, c_anchor, ''))) / length(c_anchor);
  n2 := (length(v_src) - length(replace(v_src, c_decl,   ''))) / length(c_decl);
  n3 := (length(v_src) - length(replace(v_src, c_ins_a,  ''))) / length(c_ins_a);
  IF n1 <> 1 OR n2 <> 1 OR n3 <> 1 THEN
    RAISE EXCEPTION 'fn_wallet_claim_back shape anchor=% decl=% insA=% - refusing to patch blind', n1, n2, n3;
  END IF;

  v_out := replace(v_src, c_anchor, c_fixed);
  v_out := replace(v_out, c_decl,   c_decl2);
  v_out := replace(v_out, c_ins_a,  c_ins_a2);
  v_out := replace(v_out, c_ins_b,  c_ins_b2);
  -- Defence in depth: make the comparisons themselves NULL-proof too.
  v_out := replace(v_out, 'if v_actor_role not in', 'if coalesce(v_actor_role, '''') not in');
  v_out := replace(v_out, 'and v_actor_role in (''super_agent'', ''agent'', ''sub_agent'')',
                          'and coalesce(v_actor_role, '''') in (''super_agent'', ''agent'', ''sub_agent'')');
  EXECUTE v_out;
END $$;

-- == 3. ca_club_my_downline: cycle-safe ====================================
CREATE OR REPLACE FUNCTION public.ca_club_my_downline(p_club_id uuid)
RETURNS TABLE(agent_id uuid, path uuid[], depth integer, username text,
              full_name text, avatar_url text, total_members integer, direct_members integer)
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH RECURSIVE
  user_roles AS (
    SELECT user_id, role FROM club_members WHERE club_id = p_club_id
  ),
  tree AS (
    SELECT cm.user_id, ARRAY[cm.user_id] AS path, 1 AS depth
    FROM club_members cm
    WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid() AND cm.status = 'active'
    UNION ALL
    -- CYCLE SAFETY (2026-08-24). UNION ALL never dedupes, so a cycle in the
    -- agent graph recursed until the statement timeout. Not hypothetical:
    -- club_members.agent_id holds two two-node cycles right now, and running
    -- this walk against one blew past a 4s timeout even with a 2000-row cap.
    -- Every call by an agent at or below such a cycle burned the caller's whole
    -- 8s budget and returned nothing. `path` was already accumulated for
    -- display, so using it as the visited-set costs nothing.
    SELECT cm.user_id, t.path || cm.user_id, t.depth + 1
    FROM club_members cm
    JOIN tree t ON cm.agent_id = t.user_id
    WHERE cm.club_id = p_club_id AND cm.status = 'active'
      AND NOT (cm.user_id = ANY (t.path))
      AND t.depth < 64
  )
  SELECT t.user_id AS agent_id, t.path, t.depth,
         p.username, p.full_name, p.avatar_url,
         (SELECT count(*)::int - 1 FROM tree sub WHERE sub.path @> ARRAY[t.user_id]) AS total_members,
         (SELECT count(*)::int FROM club_members child
           WHERE child.agent_id = t.user_id AND child.club_id = p_club_id
             AND child.status = 'active') AS direct_members
  FROM tree t
  JOIN profiles p ON p.id = t.user_id
  JOIN user_roles ur ON ur.user_id = t.user_id
  WHERE ur.role IN ('owner', 'admin', 'agent', 'super_agent')
  ORDER BY t.path;
$function$;

-- == 4. ca_player_ev_curve: carry was_all_in through accum ==================
DO $$
DECLARE v_src text; n int;
  c_a constant text :=
'      sum(net_bb - ev_net_bb) OVER w AS luck_bb
    FROM picked';
  c_b constant text :=
'      sum(net_bb - ev_net_bb) OVER w AS luck_bb,
      -- CARRY was_all_in THROUGH (2026-08-24). `agg` counts
      -- FILTER (WHERE was_all_in = true) but selects FROM accum, and accum
      -- dropped the column, so every call raised 42703. See defect 4.
      was_all_in
    FROM picked';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ca_player_ev_curve' LIMIT 1;
  IF v_src IS NULL THEN RAISE EXCEPTION 'ca_player_ev_curve not found'; END IF;
  IF position('CARRY was_all_in THROUGH' IN v_src) > 0 THEN
    RAISE NOTICE 'ca_player_ev_curve already hotfixed'; RETURN;
  END IF;
  n := (length(v_src) - length(replace(v_src, c_a, ''))) / length(c_a);
  IF n <> 1 THEN RAISE EXCEPTION 'ca_player_ev_curve shape=% - refusing to patch blind', n; END IF;
  EXECUTE replace(v_src, c_a, c_b);
END $$;

-- == 5. ca_player_stats_full: derive the cap from c_cap =====================
DO $$
DECLARE v_src text; v_out text; n1 int; n2 int;
  c_a constant text := '''hand_cap'', 750,';
  c_b constant text := '''hands_capped'', (hands >= 750),';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ca_player_stats_full' LIMIT 1;
  IF v_src IS NULL THEN RAISE EXCEPTION 'ca_player_stats_full not found'; END IF;
  IF position('''hand_cap'', c_cap' IN v_src) > 0 THEN
    RAISE NOTICE 'ca_player_stats_full already hotfixed'; RETURN;
  END IF;
  n1 := (length(v_src) - length(replace(v_src, c_a, ''))) / length(c_a);
  n2 := (length(v_src) - length(replace(v_src, c_b, ''))) / length(c_b);
  IF n1 <> 1 OR n2 <> 1 THEN
    RAISE EXCEPTION 'ca_player_stats_full shape a=% b=% - refusing to patch blind', n1, n2;
  END IF;
  v_out := replace(v_src, c_a, '''hand_cap'', c_cap,');
  v_out := replace(v_out, c_b, '''hands_capped'', (hands >= c_cap),');
  EXECUTE v_out;
END $$;

-- == 6. ca_player_hand_grid: totals.hands is 0, not NULL ====================
DO $$
DECLARE v_src text; n int;
  c_a constant text := '''hands'', (SELECT sum(hands) FROM grouped),';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ca_player_hand_grid' LIMIT 1;
  IF v_src IS NULL THEN RAISE EXCEPTION 'ca_player_hand_grid not found'; END IF;
  IF position('coalesce(sum(hands), 0)' IN v_src) > 0 THEN
    RAISE NOTICE 'ca_player_hand_grid already hotfixed'; RETURN;
  END IF;
  n := (length(v_src) - length(replace(v_src, c_a, ''))) / length(c_a);
  IF n <> 1 THEN RAISE EXCEPTION 'ca_player_hand_grid shape=% - refusing to patch blind', n; END IF;
  EXECUTE replace(v_src, c_a, '''hands'', (SELECT coalesce(sum(hands), 0) FROM grouped),');
END $$;

-- == Post-conditions: every fix must be present in the deployed bodies ======
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_wallet_claim_back' LIMIT 1;
  IF position('You Are Not A Member Of This Club' IN v) = 0 THEN
    RAISE EXCEPTION 'post-check: wallet NULL-role guard missing'; END IF;
  IF position('if v_actor_role not in' IN v) > 0 THEN
    RAISE EXCEPTION 'post-check: a bare NOT IN guard survived'; END IF;
  IF position('is distinct from v_actor' IN v) = 0 THEN
    RAISE EXCEPTION 'post-check: downline check was lost'; END IF;
  IF position('insert into chip_transactions' IN v) = 0 THEN
    RAISE EXCEPTION 'post-check: claim logging was lost'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ca_club_my_downline' LIMIT 1;
  IF position('ANY (t.path)' IN v) = 0 THEN
    RAISE EXCEPTION 'post-check: downline cycle guard missing'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ca_player_ev_curve' LIMIT 1;
  IF position('was_all_in' IN v) = 0 THEN
    RAISE EXCEPTION 'post-check: ev_curve was_all_in missing'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ca_player_stats_full' LIMIT 1;
  IF position('''hand_cap'', c_cap' IN v) = 0 THEN
    RAISE EXCEPTION 'post-check: stats_full still hardcodes the cap'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ca_player_hand_grid' LIMIT 1;
  IF position('coalesce(sum(hands), 0)' IN v) = 0 THEN
    RAISE EXCEPTION 'post-check: hand_grid totals still NULL'; END IF;
END $$;

COMMIT;
