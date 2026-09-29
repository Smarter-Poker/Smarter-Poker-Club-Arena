-- 20260922032153_a_wheel_ticket_is_never_pulled_from_under_a_live_page
--
-- A wheel ticket is never pulled from under a live page.
--
-- WHAT HAPPENED. The Diamond Wheel had the defect the Diamond Games had until
-- 20260921185541 (2026-09-21, Shark Club: a page kept a dead ticket and got
-- stuck). fn_wheel_commit began by deleting EVERY unconsumed wheel ticket the
-- player held before it dealt a new one. The wheel page deals itself a ticket
-- when it loads and again after every spin, so a second page of the same
-- player - another tab, or a refresh during the maintenance break - destroyed
-- the ticket the first page was holding. The first page's next spin was then
-- refused by fn_wheel_spin_v2 with "That Spin Ticket Is Not Yours Or Was
-- Already Used. Open The Wheel Again": two wheel pages cancelled each other's
-- ticket, and the player was refused a ticket that was theirs.
--
-- WHY. The old comment said one open commit per player, so that a stale hash
-- on a stale tab could never be spun. A stale tab's ticket is still the
-- player's own ticket, and nothing needs a player to hold only one. Every spin
-- path looks up the ticket it was PASSED: fn_wheel_spin_v2 (the live path) and
-- the retired fn_wheel_spin_core (which refuses every new spin with "Refresh
-- Diamond Spins To Use The New Wheel" after its receipt replay) both select
-- id = p_commit_id AND user_id = the caller AND consumed_by IS NULL FOR UPDATE
-- and refuse once expires_at < now(), before the first money leg; the
-- fn_wheel_spin, fn_wheel_welcome_spin and fn_wheel_daily_bonus_spin wrappers
-- pass p_commit_id through unchanged; and the daily-bonus ticket guard checks
-- owner, unconsumed and unexpired on NEW.commit_id. No state function, view,
-- cron job or client code reads "the player's open ticket".
--
-- WHY SEVERAL LIVE TICKETS GIVE NO EDGE. A ticket shows the player only
-- sha256(server_seed). The seed is revealed by the spin that consumes it, in
-- the same transaction as the money, and by nothing else. Nobody knows the
-- seed behind any live ticket, so choosing between two of them is choosing
-- between two unknown uniform draws. The daily limit, the pause between spins,
-- the per-player advisory lock that serialises entries across tabs and the
-- nonce are all counted per spin, not per ticket, so a second ticket buys no
-- extra spin.
--
-- EVIDENCE (production, 2026-09-22 03:22 UTC). wheel_seed_commits holds 80
-- rows. Its only indexes are the primary key and the NON-unique partial index
-- wheel_seed_commits_user_open_idx (user_id) WHERE consumed_by IS NULL, so no
-- constraint ever enforced one open ticket; only this function did. No foreign
-- key references the table and no trigger is defined on it; only postgres and
-- service_role hold grants on it (RLS on, no policies). A rolled-back probe as
-- player 47965354-0e56-43ef-931c-ddaab82af765 called fn_wheel_commit twice:
-- the first ticket was gone, one ticket stayed open, and fn_wheel_spin_v2 with
-- the first ticket answered "That Spin Ticket Is Not Yours Or Was Already
-- Used. Open The Wheel Again".
--
-- THE FIX. fn_wheel_commit sweeps only this player's EXPIRED unconsumed
-- tickets (expires_at < now(), the test the spin refuses on, so a ticket a
-- spin would still accept is never swept). A spin holds its ticket FOR UPDATE,
-- so the sweep cannot take a ticket from a spin in flight, and once that spin
-- commits the ticket is consumed and no longer matches. Everything else in the
-- function is byte-identical to the live definition. The spin paths are not
-- changed; their bodies are pinned below because this change relies on them.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
DO $preimages$ DECLARE expected record; BEGIN
 FOR expected IN SELECT * FROM (VALUES
 -- replaced here
 ('fn_wheel_commit()','34c775fe864cc754f30793582aa162ad'),
 -- relied upon, not replaced: each looks up the ticket it was passed
 ('fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)','cb2a22529dd1eeab1451d6e451747c58'),
 ('fn_wheel_spin_core(uuid,uuid,text,boolean,uuid)','d2d449daa747be0d4ae53006cf0c8eba'),
 ('fn_wheel_spin_core(uuid,uuid,text,boolean)','4c9c2645c10f7440951f15ffeca63d68'),
 ('fn_wheel_spin(uuid,uuid,text)','f39ee4eb328f9c4176a982a7b009f76e'),
 ('fn_wheel_welcome_spin(uuid,uuid,text)','437ae1a74244f9aa819bf4066cfe824d'),
 ('fn_wheel_daily_bonus_spin(uuid,uuid,text,uuid)','d935f35758239ee605b47fb668f521e9'),
 ('fn_diamond_bonus_spin_ticket_guard()','6771d97906576f09e64b58bd86e53d9e')
 ) x(signature,body_hash) LOOP
  IF md5(pg_get_functiondef(to_regprocedure('public.'||expected.signature))) IS DISTINCT FROM expected.body_hash THEN
   RAISE EXCEPTION 'Wheel Ticket Preimage Changed: %',expected.signature; END IF;
 END LOOP;
END $preimages$;

CREATE OR REPLACE FUNCTION public.fn_wheel_commit()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_seed text;
  v_hash text;
  v_id uuid;
  v_exp timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  -- Only this player's expired, never-used tickets are swept. A live ticket
  -- another page of theirs is holding stays valid until it is used or expires.
  DELETE FROM public.wheel_seed_commits WHERE user_id = v_user AND consumed_by IS NULL AND expires_at < now();
  v_seed := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_seed, 'sha256'), 'hex');
  INSERT INTO public.wheel_seed_commits (user_id, server_seed, server_seed_hash)
  VALUES (v_user, v_seed, v_hash) RETURNING id, expires_at INTO v_id, v_exp;
  RETURN jsonb_build_object('ok', true, 'commit_id', v_id, 'server_seed_hash', v_hash, 'expires_at', v_exp);
END $function$;
COMMIT;
