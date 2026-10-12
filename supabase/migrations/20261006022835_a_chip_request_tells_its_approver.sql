-- 20261006022835_a_chip_request_tells_its_approver.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (launch audit 2026-10-05, new-player funding):
--
-- A new member joins a club with 0 chips, and the way to get some is a chip
-- request from the club's cashier. fn_request_chips_core_20261004 inserted the
-- chip_requests row and returned. Nobody was told: no notification, no push.
-- The approver (the member's agent, or the club owner when there is none)
-- found out only by opening the cashier and noticing a badge. Production held
-- one chip request, ever.
--
-- The request and the word of it now happen in the same transaction: after
-- the row is written, the approver is sent one notification through the
-- platform's own fn_raise_notification, which the existing push mirror on
-- public.notifications carries to their devices. A replayed request returns
-- before this point, so a retry never notifies twice. An approver asking for
-- themselves is not notified.
--
-- The function is rewritten FROM ITS INSTALLED DEFINITION, with one block
-- added after the insert, so nothing else about it can drift. The migration
-- refuses to run if that definition is not the one this was written against.
--
-- @live-proof: position('fn_raise_notification' in pg_get_functiondef('public.fn_request_chips_core_20261004(uuid,numeric,text,uuid)'::regprocedure)) > 0
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $do$
DECLARE
  c_fn     constant regprocedure := 'public.fn_request_chips_core_20261004(uuid,numeric,text,uuid)'::regprocedure;
  c_anchor constant text := E'  RETURNING id INTO v_id;\n';
  v_def    text := pg_get_functiondef(c_fn);
  v_new    text;
BEGIN
  -- Applying this twice changes nothing the second time.
  IF position('fn_raise_notification' in v_def) > 0 THEN
    RETURN;
  END IF;
  IF md5(v_def) <> '236c0cecc1dd32f30f7b50e790f88b63' THEN
    RAISE EXCEPTION 'fn_request_chips_core_20261004 is not the definition this migration was written against (md5 %); re-read it first', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_anchor, ''))) <> length(c_anchor) THEN
    RAISE EXCEPTION 'the insert into chip_requests was not found exactly once';
  END IF;

  v_new := replace(v_def, c_anchor, c_anchor || $block$
  -- THE APPROVER IS TOLD, IN THIS TRANSACTION (launch audit 2026-10-05).
  -- A replay returned above, so a retry never notifies twice.
  IF v_agent IS NOT NULL AND v_agent <> v_me THEN
    PERFORM public.fn_raise_notification(
      v_agent,
      'chip_request',
      'Chip Request',
      public.fn_notify_display_name(v_me) || ' Requested '
        || btrim(to_char(p_amount, 'FM999,999,999,990.00')) || ' Chips',
      '/hub/club-arena/clubs/' || p_club_id::text || '/cashier',
      jsonb_build_object(
        'club_id', p_club_id,
        'request_id', v_id,
        'requester_id', v_me,
        'amount', p_amount
      )
    );
  END IF;
$block$);

  EXECUTE v_new;

  IF position('fn_raise_notification' in pg_get_functiondef(c_fn)) = 0 THEN
    RAISE EXCEPTION 'the chip request still does not notify its approver';
  END IF;
END
$do$;

COMMIT;
