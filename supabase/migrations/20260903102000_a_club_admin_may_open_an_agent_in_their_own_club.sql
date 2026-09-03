-- A CLUB ADMIN MAY OPEN AN AGENT IN THEIR OWN CLUB.
--
-- The club data page shows an owner that an agent's network produced 30,634.
-- Clicking that row to ask WHO produced it was refused, because the downline
-- walker admitted only three kinds of caller: the agent themselves, an agent
-- ABOVE them, or a union overseer. A club owner is none of those.
--
-- So the owner of the club was shown a number and then denied its composition.
-- Measured on production before this change: owner REFUSED, the agent's own
-- upline CAN DRILL. That is not a policy, it is an oversight.
--
-- The fix admits club ADMINS - owner, co-owner, admin, manager, per
-- fn_is_club_admin_uid - and only when a club is named. With p_club_id NULL
-- the walker spans every club the agent belongs to, and there is no single
-- club to be an admin of; the clause would then be meaningless rather than
-- merely wrong.
--
-- PEER AGENTS ARE STILL REFUSED, deliberately. Overseeing a club is not the
-- same as one agent reading a rival's player list, and ca_can_view_club_finances
-- would have granted exactly that, since it counts every super agent. Measured
-- after this change: owner CAN DRILL, the agent's own upline CAN DRILL, a peer
-- super agent REFUSED, three peer agents REFUSED, an outsider REFUSED.
--
-- Applied as a guarded patch rather than a re-declaration. The function is
-- some two hundred lines that this change does not touch, and copying them
-- forward is how a migration silently reverts an unrelated fix made in
-- between. If the anchor is ever gone this raises instead of guessing.

DO $do$
DECLARE
  v_def text;
  v_anchor text := E'  THEN\n    RAISE EXCEPTION ''not_authorised'';';
  v_repl   text := E'     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))\n  THEN\n    RAISE EXCEPTION ''not_authorised'';';
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'fn_agent_downline_rake';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_agent_downline_rake is missing';
  END IF;

  -- Already carries the club-admin clause: nothing to do.
  IF position('fn_is_club_admin_uid' IN v_def) > 0 THEN
    RETURN;
  END IF;

  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'the not_authorised gate has moved - patch it by hand';
  END IF;

  EXECUTE replace(v_def, v_anchor, v_repl);
END
$do$;

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'fn_agent_downline_rake'
       AND prosrc ILIKE '%fn_is_club_admin_uid%')
  THEN
    RAISE EXCEPTION 'club admins still cannot open an agent in their own club';
  END IF;
END
$check$;
