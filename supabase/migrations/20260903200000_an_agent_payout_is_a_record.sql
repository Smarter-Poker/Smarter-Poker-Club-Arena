-- AN AGENT PAYOUT IS A RECORD, NOT AN ESTIMATE THE BROWSER MADE UP.
--
-- Phase 3 of Dan's Club Operations upgrade. The agent network's payables
-- screen has never read a payable.
--
-- WHAT THE PAGE SHOWS TODAY. AgentManagementPage's "Upcoming Agent Payouts"
-- table computes, per row:
--
--   commission = agents.weekly_rake_generated * agents.commission_rate
--   rakeback   = agents.weekly_rake_generated * agents.player_rakeback_rate
--   status     = <span>Pending</span>          -- a literal, on every row
--
-- No payout, settlement or commission table is read anywhere in that file.
-- Measured against Deep Stack Society's real unsettled commission on
-- 2026-09-03, the arithmetic understates what the club owes by two to four
-- times:
--
--   role          page shows     actually owed     commission rows
--   super_agent      2,480.47          9,733.62              32,971
--   super_agent      2,343.61          8,584.77              32,728
--   agent            3,054.07          4,213.73              13,118
--   agent            2,572.10          4,024.10              13,812
--   ...
--   club total                        63,376.82             249,196
--
-- Every one of those 249,196 rows has settled_at IS NULL. The club is
-- carrying 63,376.82 chips of unpaid commission and its own payables screen
-- reports about a quarter of it, next to a hardcoded word.
--
-- WHY THIS NEEDS A FUNCTION AND NOT A SELECT. agent_commissions grants
-- `authenticated` exactly one read - `user_id = auth.uid()`, an agent reading
-- their own. A club owner has no policy on that table at all, so the honest
-- number is not reachable from the browser by any query. Same for the credit
-- position: `agents` is readable, but joining 2,038,305 commission rows to it
-- from the client is not something a page should attempt.
--
-- WHAT IT RETURNS. One row per agent in the club: who they are, their funding
-- (a credit line with what is drawn against it, or prepaid), the commission
-- they have earned and not been paid, and the count of rows behind that
-- figure so an operator can see the number is a sum of records rather than a
-- guess. The `estimate` field carries the old arithmetic alongside it, so the
-- page can show the two together for one release rather than silently
-- swapping a number an operator may have been reconciling against.
--
-- Horses are counted like every other player (CLAUDE.md 10.5): nothing here
-- filters on whether an account is house-run. An agent's downline is their
-- downline, and what the club owes on it is what the club owes.
--
-- The aggregate rides agent_commissions_unsettled_idx (club_id, user_id)
-- WHERE settled_at IS NULL, which already exists.

-- ─────────────────────────────────────────────────────────────────────────
--  ONE GATE
-- ─────────────────────────────────────────────────────────────────────────
-- The same three roles fn_admin_update_agent authorizes for writes, so the
-- people who can change an agent's funding are exactly the people who can see
-- what the club owes them. Named separately rather than reused from the
-- integrity gate: reviewing a collusion flag and paying an agent are
-- different jobs, and a club may well want them held by different people
-- later. Requires an account: an anonymous PostgREST call is refused rather
-- than being treated as an internal caller.
CREATE OR REPLACE FUNCTION public.fn_ca_can_manage_agents(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT auth.uid() IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM clubs c
                WHERE c.id = p_club_id AND c.owner_id = auth.uid())
       OR EXISTS (SELECT 1 FROM club_members cm
                   WHERE cm.club_id = p_club_id
                     AND cm.user_id = auth.uid()
                     AND cm.role IN ('owner', 'co_owner', 'admin'))
     );
$$;

REVOKE ALL ON FUNCTION public.fn_ca_can_manage_agents(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_can_manage_agents(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_can_manage_agents(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_can_manage_agents(uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  WHAT THE CLUB OWES ITS AGENTS
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_agent_payables(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rows      jsonb;
  v_owed      numeric;
  v_count     bigint;
  v_agents    integer;
  v_estimate  numeric;
  v_oldest    timestamptz;
  v_cap constant integer := 200;
BEGIN
  IF NOT fn_ca_can_manage_agents(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  WITH owed AS (
    SELECT ac.user_id,
           sum(ac.amount)   AS owed,
           count(*)         AS rows_behind,
           min(ac.created_at) AS oldest
      FROM agent_commissions ac
     WHERE ac.club_id = p_club_id
       AND ac.settled_at IS NULL
     GROUP BY ac.user_id
  ),
  ranked AS (
    SELECT a.id,
           a.user_id,
           a.role,
           coalesce(a.status, 'active') AS status,
           coalesce(a.is_prepaid, false) AS is_prepaid,
           coalesce(a.credit_limit, 0)   AS credit_limit,
           coalesce(a.credit_used, 0)    AS credit_used,
           coalesce(a.commission_rate, 0) AS commission_rate,
           coalesce(a.player_rakeback_rate, 0) AS player_rakeback_rate,
           coalesce(a.total_players, 0)  AS total_players,
           coalesce(o.owed, 0)           AS owed,
           coalesce(o.rows_behind, 0)    AS rows_behind,
           o.oldest,
           -- What the page printed before this function existed, kept beside
           -- the truth rather than replaced silently.
           round(coalesce(a.weekly_rake_generated, 0)
                 * coalesce(a.commission_rate, 0), 2) AS estimate,
           coalesce(
             nullif(btrim(pr.display_name), ''),
             nullif(btrim(pr.alias), ''),
             nullif(btrim(pr.username), ''),
             'Member') AS name,
           row_number() OVER (ORDER BY coalesce(o.owed, 0) DESC, a.created_at) AS rn
      FROM agents a
      LEFT JOIN owed o     ON o.user_id = a.user_id
      LEFT JOIN profiles pr ON pr.id = a.user_id
     WHERE a.club_id = p_club_id
  )
  SELECT
    coalesce(jsonb_agg(
      jsonb_build_object(
        'agent_id', r.id,
        'user_id', r.user_id,
        'name', r.name,
        'role', r.role,
        'status', r.status,
        'is_prepaid', r.is_prepaid,
        'credit_limit', r.credit_limit,
        'credit_used', r.credit_used,
        'credit_available', greatest(r.credit_limit - r.credit_used, 0),
        'utilization', CASE WHEN r.credit_limit > 0
                            THEN round(r.credit_used / r.credit_limit, 4)
                            ELSE 0 END,
        'commission_rate', r.commission_rate,
        'player_rakeback_rate', r.player_rakeback_rate,
        'total_players', r.total_players,
        'owed', round(r.owed, 2),
        'rows_behind', r.rows_behind,
        'oldest_unsettled', r.oldest,
        'estimate', r.estimate)
      ORDER BY r.rn) FILTER (WHERE r.rn <= v_cap), '[]'::jsonb),
    count(*)::integer,
    round(sum(r.owed), 2),
    sum(r.rows_behind),
    round(sum(r.estimate), 2),
    min(r.oldest)
    INTO v_rows, v_agents, v_owed, v_count, v_estimate, v_oldest
  FROM ranked r;

  RETURN jsonb_build_object(
    'agents', coalesce(v_agents, 0),
    'cap', v_cap,
    'total_owed', coalesce(v_owed, 0),
    'total_rows', coalesce(v_count, 0),
    'total_estimate', coalesce(v_estimate, 0),
    'oldest_unsettled', v_oldest,
    'rows', v_rows,
    'generated_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.fn_ca_agent_payables(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_agent_payables(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_agent_payables(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_agent_payables(uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  A BAN IS A WRITE
-- ─────────────────────────────────────────────────────────────────────────
-- AgentManagementPage's Ban Player action is, in full:
--
--   else if (type === 'ban') { toast.success('Player banned'); }
--
-- No write of any kind. The confirm dialog collects the player id and
-- discards it.
--
-- WHAT A BAN IS HERE. A `blacklists` row for the club, which is not a label:
-- atomic_table_buyin, atomic_table_rebuy and atomic_tournament_register all
-- read that table, so the exclusion stops the player buying in, rebuying or
-- registering. The insert also fires fn_blacklists_audit, which files the
-- player_banned event.
--
-- WHAT A BAN IS NOT. It does not delete the club_members row, and it does not
-- close a seat.
--
--   * club_members carries chip_balance, held_chips, locked_chips,
--     promo_balance and credit_used. Deleting that row destroys whatever is
--     in it, which is the same class of mistake as closing a seat outside a
--     cash-out (CLAUDE.md 11.5). The first draft of this function did delete
--     it; probing it against production is what caught that, and what this
--     function returns instead is the balance, so the operator can settle
--     deliberately.
--   * Removing a banned player from a live table is the engine's job. The
--     client asks it separately through IntegrityActionService, exactly as
--     the anti-cheat console does.
--
-- This is also how BlacklistManagerPage already behaves - exclude, then warn
-- about the seat - so the two surfaces mean the same thing by the word.
CREATE OR REPLACE FUNCTION public.fn_ca_ban_club_player(
  p_club_id    uuid,
  p_user_id    uuid,
  p_reason     text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller    uuid := auth.uid();
  v_role      text;
  v_agent     uuid;
  v_chips     numeric;
  v_credit    numeric;
  v_seats     integer;
  v_blacklist uuid;
  v_re_ban    boolean := false;
BEGIN
  IF NOT fn_ca_can_manage_agents(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_player');
  END IF;

  -- Banning the person who holds the club is how a club loses its owner.
  IF EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cannot_ban_the_owner');
  END IF;

  SELECT cm.role,
         cm.agent_id,
         coalesce(cm.chip_balance, 0) + coalesce(cm.held_chips, 0)
           + coalesce(cm.locked_chips, 0) + coalesce(cm.promo_balance, 0),
         coalesce(cm.credit_used, 0)
    INTO v_role, v_agent, v_chips, v_credit
    FROM club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_member_of_this_club');
  END IF;

  IF v_role IN ('owner', 'co_owner', 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cannot_ban_club_staff');
  END IF;

  -- An existing exclusion for this pair is replaced rather than duplicated.
  -- Written as a lookup and a branch rather than ON CONFLICT because the
  -- unique index here is partial (permanent rows only), so a timed ban does
  -- not match the arbiter and the two cases are clearer spelled out. A re-ban
  -- is the same ban and files no second audit event.
  SELECT b.id INTO v_blacklist
    FROM blacklists b
   WHERE b.club_id = p_club_id AND b.user_id = p_user_id
   LIMIT 1;

  v_re_ban := v_blacklist IS NOT NULL;

  IF v_re_ban THEN
    UPDATE blacklists b
       SET reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), b.reason),
           banned_by = v_caller,
           banned_at = now(),
           expires_at = p_expires_at
     WHERE b.id = v_blacklist;
  ELSE
    INSERT INTO blacklists (club_id, user_id, reason, banned_by, banned_at, expires_at)
    VALUES (p_club_id, p_user_id,
            nullif(btrim(coalesce(p_reason, '')), ''),
            v_caller, now(), p_expires_at)
    RETURNING id INTO v_blacklist;
  END IF;

  -- What the operator now has to deal with, said plainly rather than left for
  -- them to discover: an excluded player who is still sitting, and whatever
  -- the membership row is still holding.
  SELECT count(*)::integer INTO v_seats
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE t.club_id = p_club_id
     AND ts.user_id = p_user_id
     AND ts.left_at IS NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'blacklist_id', v_blacklist,
    'was_already_excluded', v_re_ban,
    'expires_at', p_expires_at,
    'was_role', v_role,
    'had_agent', v_agent,
    'chips_held', v_chips,
    'credit_used', v_credit,
    'live_seats', coalesce(v_seats, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.fn_ca_ban_club_player(uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_ban_club_player(uuid, uuid, text, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_ban_club_player(uuid, uuid, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ban_club_player(uuid, uuid, text, timestamptz) TO service_role;
