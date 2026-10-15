-- 20261015163632_agents_set_the_rakeback_their_players_receive.sql
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-15: "THE OWNER ASSIGNS THE AGENT A SPECIFIC RAKE BACK AMOUNT FOR
-- EACH AGENT, THAT AMOUNT THEY ASSIGN IS FOR THE AGENT ACCOUNT THAT THEY PLAY
-- UNDER AS WELL AS ANY AND ALL SUB AGENTS UNDER THEM. THE AGENT ASSIGNS WHAT
-- THEY WANT TO GIVE THEIR PLAYERS, THIS SHOULDN'T BE DONE BY THE PERSON
-- PROMOTING THEM."
--
-- This supersedes, for the PLAYER rakeback only, the 2026-08-31 rule that the
-- promoter chooses both rates (20260831235997). The promoter still chooses the
-- agent's own rate (agents.commission_rate), which a sub agent can never
-- exceed. agents.player_rakeback_rate is now the agent's own choice:
--
-- 1. fn_club_set_member_role and fn_create_agent no longer need a player
--    rakeback. A promotion that does not name one starts it at 0, and the
--    upline's PLAYER rakeback no longer caps it: what an agent gives their
--    players is paid out of their own commission, so their own commission is
--    the cap (checked by both functions and by fn_guard_agent_agreement).
-- 2. fn_agent_set_player_rakeback(club, rate): the agent sets it for
--    themselves, 0 to the lesser of 50% and their own commission. The agreement
--    guard and accounting_agreement_history record it like any other term.
-- 3. An agent's 0 now means 0. When a player has an agent, the weekly rakeback
--    engine (fn_calculate_cash_rakeback_periods, fn_rakeback_split_check,
--    fn_rakeback_split_write) and fn_player_rakeback_rate paid the legacy
--    volume ladder (5% to 30%) whenever the agent's offer was 0, which would
--    have handed every newly promoted agent's players rakeback nobody chose.
--    The ladder now applies only to players with no agent, as its own comment
--    always said. Read from production before the change: all 1,575 players
--    with an agent sit under an agent with a non-zero offer, and the one active
--    agent at 0 has no players, so no current figure moves.
--
-- Every function is patched against its md5 preimage read from production;
-- each anchor must occur exactly once, so a moved source aborts the whole
-- transaction instead of being overwritten. fn_accounting_legacy_certify_week
-- is deliberately untouched: it certifies closed weeks under the rule they ran
-- under.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_patch(p_sig text, p_before text, p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $patch$
DECLARE v_def text; v_n int; i int;
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned preimage (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_def) - length(replace(v_def, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_def := replace(v_def, p_old[i], p_new[i]);
  END LOOP;
  EXECUTE v_def;
END
$patch$;

-- 1a. Promotion: the player rakeback is optional and starts at 0; the upline's
--     player rakeback no longer caps it.
SELECT pg_temp.ca_patch(
  'public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)',
  'de77c9f60056efed95bbadb5c30f6437',
  ARRAY[
    E'      v_comm    := p_commission_rate;\n      v_rake    := p_player_rakeback_rate;\n',
    E'    IF v_cap_rake IS NOT NULL AND v_rake > v_cap_rake THEN\n      RETURN jsonb_build_object(''success'', false,\n        ''error'', ''the player rakeback rate cannot exceed the upline rate of '' || v_cap_rake);\n    END IF;\n',
    E'|| '' Percent And Your Player Rakeback Is '''
  ],
  ARRAY[
    E'      v_comm    := p_commission_rate;\n      -- The agent sets what their own players receive (Dan, 2026-10-15).\n      -- A promotion that does not name it starts it at 0 until they do.\n      v_rake    := COALESCE(p_player_rakeback_rate, 0);\n',
    E'    -- No upline cap on the PLAYER rakeback (Dan, 2026-10-15): it is paid out\n    -- of this agent''s own commission, which is checked against it above.\n',
    E'|| '' Percent. You Set The Rakeback Your Players Receive, Now '''
  ]);

-- 1b. Direct agent creation from the agents screen: the same rule.
SELECT pg_temp.ca_patch(
  'public.fn_create_agent(uuid,uuid,text,uuid,numeric,numeric,numeric,boolean)',
  '323d687e6129dc02ac8e24659d38cec7',
  ARRAY[
    E'  IF p_player_rakeback_rate IS NULL OR p_player_rakeback_rate < 0 OR p_player_rakeback_rate > 0.5 THEN',
    E'    v_rake := p_player_rakeback_rate;\n',
    E'    IF v_rake > v_parent_rake THEN RETURN jsonb_build_object(''success'',false,''error'',''rakeback rate cannot exceed parent rate''); END IF;\n'
  ],
  ARRAY[
    E'  IF p_player_rakeback_rate < 0 OR p_player_rakeback_rate > 0.5 THEN',
    E'    -- The agent sets what their own players receive (Dan, 2026-10-15).\n    v_rake := COALESCE(p_player_rakeback_rate, 0);\n    IF v_rake > v_comm THEN RETURN jsonb_build_object(''success'',false,''error'',''the player rakeback rate cannot exceed the commission it is paid out of''); END IF;\n',
    E''
  ]);

-- 1c. The agreement guard: a player rakeback is capped by the agent's own
--     commission, not by the upline's player rakeback, and an upline's player
--     rakeback no longer limits its sub agents'. Commission and credit keep
--     their upline caps (the owner's rate covers the whole downline).
SELECT pg_temp.ca_patch(
  'public.fn_guard_agent_agreement()',
  '0603b05f5046cbaa057228acd3a5c331',
  ARRAY[
    E'  IF NEW.parent_agent_id IS NOT NULL AND (new_edge OR new_value IS DISTINCT FROM old_value) THEN',
    E'  IF TG_OP=''UPDATE'' AND new_value IS DISTINCT FROM old_value THEN\n   FOR child IN'
  ],
  ARRAY[
    E'  IF field=''player_rakeback_rate'' AND (TG_OP=''INSERT'' OR new_value IS DISTINCT FROM old_value)\n     AND new_value > COALESCE((new_terms->>''commission_rate'')::numeric, 0) THEN\n   RAISE EXCEPTION ''agent player_rakeback_rate cannot exceed its own commission_rate'' USING ERRCODE=''23514'';END IF;\n  IF field<>''player_rakeback_rate'' AND NEW.parent_agent_id IS NOT NULL AND (new_edge OR new_value IS DISTINCT FROM old_value) THEN',
    E'  IF TG_OP=''UPDATE'' AND field<>''player_rakeback_rate'' AND new_value IS DISTINCT FROM old_value THEN\n   FOR child IN'
  ]);

-- 3. An agent's 0 means 0; the volume ladder is for players with no agent.
SELECT pg_temp.ca_patch(
  'public.fn_player_rakeback_rate(uuid,uuid,numeric)',
  'f9b2424384371f47f9fba2006a3f646d',
  ARRAY[
    E'v_cap numeric;',
    E'         COALESCE(a.commission_rate, 0)\n    INTO v_deal, v_agent_default, v_upline_rate',
    E'  ELSIF COALESCE(v_agent_default,0) > 0 THEN'
  ],
  ARRAY[
    E'v_cap numeric; v_has_agent boolean;',
    E'         COALESCE(a.commission_rate, 0),\n         a.id IS NOT NULL\n    INTO v_deal, v_agent_default, v_upline_rate, v_has_agent',
    E'  ELSIF v_has_agent THEN'
  ]);
SELECT pg_temp.ca_patch(
  'public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])',
  'a7b64f40053a275b392655589f12699f',
  ARRAY[E'CASE WHEN p.deal>0 THEN p.deal WHEN p.offer>0 THEN p.offer'],
  ARRAY[E'CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer']);
SELECT pg_temp.ca_patch(
  'public.fn_rakeback_split_check(uuid,date,date,uuid[])',
  '7de5beed2fb2bc7d3b2ae07551cc0e62',
  ARRAY[E'CASE WHEN p.deal>0 THEN p.deal WHEN p.offer>0 THEN p.offer'],
  ARRAY[E'CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer']);
SELECT pg_temp.ca_patch(
  'public.fn_rakeback_split_write(uuid,date,date,uuid[])',
  '6719797703130a3f8f07ad9c7e062988',
  ARRAY[E'CASE WHEN p.deal>0 THEN p.deal WHEN p.offer>0 THEN p.offer'],
  ARRAY[E'CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer']);

-- 2. The agent's own door.
CREATE FUNCTION public.fn_agent_set_player_rakeback(p_club_id uuid, p_rate numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_agent public.agents%ROWTYPE;
  v_role text;
  v_old numeric;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;
  IF p_club_id IS NULL OR p_rate IS NULL OR p_rate::text IN ('NaN','Infinity','-Infinity') THEN
    RETURN jsonb_build_object('success', false, 'error', 'a club and a rate are required');
  END IF;

  SELECT cm.role INTO v_role
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_caller
     AND coalesce(cm.status, 'approved') IN ('active', 'approved');
  IF v_role IS NULL OR v_role NOT IN ('super_agent', 'agent', 'sub_agent') THEN
    RETURN jsonb_build_object('success', false, 'error', 'only an agent sets the rakeback their players receive');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:' || p_club_id::text, 0));
  SELECT * INTO v_agent FROM public.agents
   WHERE club_id = p_club_id AND user_id = v_caller AND status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active agent agreement in this club');
  END IF;

  IF p_rate < 0 OR p_rate > 0.50 THEN
    RETURN jsonb_build_object('success', false, 'error', 'player rakeback must be between 0 and 50 percent');
  END IF;
  IF p_rate > v_agent.commission_rate THEN
    RETURN jsonb_build_object('success', false,
      'error', 'player rakeback cannot exceed your own rate of '
               || trim(to_char(v_agent.commission_rate * 100, 'FM990.00')) || ' percent',
      'max_rate', v_agent.commission_rate);
  END IF;

  v_old := v_agent.player_rakeback_rate;
  IF v_old IS DISTINCT FROM p_rate THEN
    UPDATE public.agents
       SET player_rakeback_rate = p_rate, updated_at = now()
     WHERE id = v_agent.id;

    INSERT INTO public.audit_trail (actor_id, actor_role, action, target_type, target_id,
                                    club_id, before_state, after_state, reason)
    VALUES (v_caller, v_role, 'set_player_rakeback', 'agent', v_caller, p_club_id,
            jsonb_build_object('player_rakeback_rate', v_old),
            jsonb_build_object('player_rakeback_rate', p_rate),
            'Agent set the rakeback their players receive');
  END IF;

  RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
    'player_rakeback_rate', p_rate, 'max_rate', v_agent.commission_rate);
END;
$function$;
COMMENT ON FUNCTION public.fn_agent_set_player_rakeback(uuid, numeric) IS
  'An agent sets the rakeback their own players receive (Dan, 2026-10-15): 0 to the lesser of 50% and their own commission. Records the change in audit_trail; accounting_agreement_history captures it through the agents trigger.';
REVOKE ALL ON FUNCTION public.fn_agent_set_player_rakeback(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_set_player_rakeback(uuid, numeric) TO authenticated, service_role;

COMMIT;
