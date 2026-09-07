-- ═══════════════════════════════════════════════════════════════════════════
--  NOTHING CAN SEE TABLE-SHARE FARMING YET, AND IT SAYS SO
--  BBJ build plan phase 5.4 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE ATTACK. A bad beat jackpot pays 50% to the loser of the hand, 25% to the
-- winner, and 25% split among everyone dealt in. That last quarter is a fixed
-- amount divided by the seats, so seating several accounts you control at one
-- table does not enlarge the pot - it enlarges YOUR fraction of it, at the
-- expense of the honest players at the same table. Phase 5.4 asked whether the
-- multi-account detector can see that.
--
-- IT CANNOT, AND NEITHER CAN ANYTHING ELSE. Measured over the platform's whole
-- history - 29 payouts, 131 distinct recipients:
--
--   recipients who are horses                    131 of 131
--   recipients with any IP in action_audit_logs    0
--
-- `detect_multi_account_ips` groups `action_audit_logs` by IP. Every jackpot
-- recipient this platform has ever had is a horse; a horse has no browser, so
-- it has no IP, so it has no row. Join jackpot recipients to that detector and
-- you get an empty set - and an empty set from a detector reads exactly like a
-- clean bill of health. It is not clean. It has never been tested.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5), so the answer is emphatically NOT to
-- exclude them or to write a horse-shaped exception. The answer is that the
-- device bond simply does not exist for a player with no device, and the day a
-- human is paid a table share is the day this check has something to say.
--
-- THE BOND I TRIED AND REJECTED, and the rejection is the more useful finding.
-- The obvious substitute for an IP is the agent graph: two recipients of one
-- jackpot sitting under the same agent. It was built, and its own assertion
-- aborted the migration - **20 of the 29 payouts flagged**, on bonds like
-- `agent:be61d864` appearing across four separate hands. Of course they did:
-- a club has a handful of agents and hundreds of players, so two players at a
-- table sharing an agent is the ordinary shape of every club here, not evidence
-- of anything. Shipping it would have put a CRITICAL on two thirds of all
-- jackpots, and an alarm that is always on is an alarm that gets muted
-- (CLAUDE.md 10.84) - the exact defect phase 5.5 spent the afternoon undoing on
-- `I7_raked_hand_never_banked`.
--
-- So the agent count is reported as COVERAGE and never as a finding. Making it
-- into a real signal needs a baseline - what fraction of a table one agent's
-- players normally occupy - MEASURED, not guessed, and that measurement is not
-- done here. It is named in the function's own note so the next person does not
-- have to rediscover why the obvious bond was left out.
--
-- WHAT SHIPS. `fn_bbj_table_share_farming(p_days)` with three outcomes, not two
-- (CLAUDE.md 10.86 rule 1):
--
--   no_payouts_in_window   nothing happened in the window
--   cannot_tell            payouts happened, and NO recipient carried a device
--                          signal, so the scan proves nothing. **This is what
--                          it returns today, and the migration ASSERTS that**,
--                          so the day the answer changes somebody reads it
--                          rather than assuming.
--   shared_device_found    two recipients of one jackpot on one IP
--   clean                  scanned, with coverage, and found nothing
--
-- `clean` is deliberately false when coverage is zero. That single line is the
-- whole point of this migration.
--
-- No chips are moved and no player is touched.
--
-- ROLLBACK: `DROP FUNCTION public.fn_bbj_table_share_farming(integer);`

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_bbj_table_share_farming(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_days, 90), 1));
  v_payouts int; v_recipients int; v_with_ip int; v_with_agent int; v_findings jsonb;
BEGIN
  SELECT count(DISTINCT p.id), count(DISTINCT r.user_id)
    INTO v_payouts, v_recipients
    FROM bbj_payouts p JOIN bbj_payout_recipients r ON r.payout_id = p.id
   WHERE p.created_at >= v_since;

  /* COVERAGE FIRST, because an empty result over an empty population reads
     exactly like an empty result over a clean one. */
  SELECT count(DISTINCT r.user_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM action_audit_logs a
            WHERE a.user_id = r.user_id AND a.ip_address IS NOT NULL)),
         count(DISTINCT r.user_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM club_members cm
            WHERE cm.user_id = r.user_id
              AND COALESCE(cm.agent_id, cm.parent_agent_id) IS NOT NULL))
    INTO v_with_ip, v_with_agent
    FROM bbj_payouts p JOIN bbj_payout_recipients r ON r.payout_id = p.id
   WHERE p.created_at >= v_since;

  /* THE ONLY BOND THAT MEANS ANYTHING HERE IS THE DEVICE.
     The agent graph was tried and REJECTED, and the rejection is the finding:
     asking it on 2026-09-07 flagged 20 of 29 payouts, because two recipients
     sharing an agent is the ordinary shape of every club on this platform, not
     evidence of anything. A check that fires on two thirds of all jackpots is
     an alarm that gets muted (CLAUDE.md 10.84), so the agent count is reported
     as COVERAGE and never as a finding. Making it usable needs a baseline -
     what fraction of a table an agent's players normally occupy - measured
     rather than guessed, and that is not done here. */
  WITH rec AS (
    SELECT p.id AS payout_id, p.hand_number, r.user_id
      FROM bbj_payouts p JOIN bbj_payout_recipients r ON r.payout_id = p.id
     WHERE p.created_at >= v_since
  ), link AS (
    SELECT rc.payout_id, rc.hand_number, rc.user_id, a.ip_address AS bond
      FROM rec rc JOIN action_audit_logs a ON a.user_id = rc.user_id
     WHERE a.ip_address IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'hand_number', hand_number, 'ip', bond,
           'linked_recipients', n, 'users', users)), '[]'::jsonb)
    INTO v_findings
    FROM (SELECT hand_number, bond, count(DISTINCT user_id) AS n,
                 jsonb_agg(DISTINCT user_id) AS users
            FROM link GROUP BY 1, 2 HAVING count(DISTINCT user_id) > 1
           ORDER BY 3 DESC LIMIT 20) x;

  RETURN jsonb_build_object(
    'window_days', p_days,
    'payouts_examined', v_payouts,
    'recipients_examined', v_recipients,
    'recipients_with_a_device_signal', v_with_ip,
    'recipients_with_an_agent_above_them', v_with_agent,
    'findings', v_findings,
    'finding_count', jsonb_array_length(v_findings),
    /* THREE OUTCOMES, NOT TWO (CLAUDE.md 10.86 rule 1). */
    'verdict', CASE
      WHEN v_recipients = 0 THEN 'no_payouts_in_window'
      WHEN v_with_ip = 0 THEN 'cannot_tell'
      WHEN jsonb_array_length(v_findings) > 0 THEN 'shared_device_found'
      ELSE 'clean' END,
    'clean', (v_recipients > 0 AND v_with_ip > 0 AND jsonb_array_length(v_findings) = 0),
    'note', 'Table-share farming is seating several accounts you control at one table so that a jackpot pays you several dealt-in shares of a fixed 25%. It does not enlarge the pot; it enlarges your fraction of it at the honest players'' expense. MEASURED 2026-09-07 over all 29 payouts and 131 distinct recipients in the platform''s history: every recipient is a horse, not one has ever had an IP, and so this check''s only real signal has zero coverage. `cannot_tell` is the true answer and it is what this returns - it has never yet been able to see farming, and until a human collects a table share it never will. HORSES ARE PLAYERS (10.5): the fix is not to exclude them, it is that a horse has no browser and therefore no device bond, so the day a human is paid a share is the day this check starts working. What would make it work for everyone: a per-agent table-occupancy baseline, measured, so that "several of one agent''s players at one table" can be told from the ordinary shape of a club.');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_table_share_farming(integer) TO service_role;

COMMENT ON FUNCTION public.fn_bbj_table_share_farming(integer) IS
  'BBJ phase 5.4. Answers whether two recipients of one jackpot share a device. Returns `cannot_tell` rather than `clean` when no recipient in the window carries a device signal - which is every window so far, because every jackpot recipient to date is a horse.';

DO $$
DECLARE v jsonb;
BEGIN
  v := public.fn_bbj_table_share_farming(365);
  IF (v->>'finding_count')::int > 0 THEN
    RAISE EXCEPTION 'two recipients of one jackpot share a device; a human must read this before it is called done: %', v;
  END IF;
  IF v->>'verdict' <> 'cannot_tell' THEN
    RAISE EXCEPTION 'the coverage changed while this was written - re-read it rather than trusting the verdict: %', v;
  END IF;
  IF (v->>'recipients_examined')::int < 100 THEN
    RAISE EXCEPTION 'the recipient population is not the 131 this was measured against: %', v;
  END IF;
END $$;

COMMIT;
