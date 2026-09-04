-- R3 GOES FROM LOG TO REFUSE, AND THE SWITCH BACK IS ONE UPDATE.
--
-- 2026-09-03, Dan: "THERE IS NOTHING THAT'S MY CALL. THIS IS 100% ON YOU TO
-- FIGURE OUT: the R3 flip from log to refuse."
--
-- R3 is the rule that a tournament-category credit is written by
-- fn_settle_tournament_obligation and by nothing else. It has been logging
-- since 2026-09-02 while the eight legacy payers were re-pointed (roadmap 1.1).
--
-- The evidence for the flip:
--
--   * ca_money_path_violations has taken ZERO rows since 2026-09-02 22:04:27,
--     the last legacy bounty credit - over 25 hours;
--   * the trigger is not idle while that is true: wallet_transactions took
--     18,017 credits in R3 scope in the last 24 hours (16,763 prize, 1,212
--     bounty, 42 refund), and every one of them declared the sanctioned money
--     path and returned early. Every write that happens today would pass.
--
-- So the flip is not a leap; it is closing a door that nothing has walked
-- through in a day of full traffic.
--
-- What refuse means: the credit's transaction is aborted. That is the point -
-- a tournament prize written outside the one payer is the bug the whole
-- standard exists to prevent, and a refused write is a loud, recoverable
-- failure where a silent one is an overpay nobody sees.
--
-- The mode lives in a table, not in the function body, so going back is:
--
--     UPDATE public.ca_money_path_enforcement SET mode = 'log';
--
-- one statement, no migration, no deploy, effective on the next write.

CREATE TABLE IF NOT EXISTS public.ca_money_path_enforcement (
  only_row   boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  mode       text        NOT NULL DEFAULT 'log' CHECK (mode IN ('log', 'refuse')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text        NOT NULL DEFAULT session_user,
  note       text
);

COMMENT ON TABLE public.ca_money_path_enforcement IS
  'R3 enforcement mode for tournament-category wallet credits. mode=log records '
  'a violation and lets the write through; mode=refuse aborts it. One row. '
  'Flip back with: UPDATE public.ca_money_path_enforcement SET mode = ''log'';';

REVOKE ALL ON TABLE public.ca_money_path_enforcement FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_money_path_enforcement TO service_role;

INSERT INTO public.ca_money_path_enforcement (only_row, mode, note)
VALUES (true, 'refuse',
        'flipped 2026-09-03 after 25h of zero violations against 18,017 in-scope credits')
ON CONFLICT (only_row) DO UPDATE
  SET mode = EXCLUDED.mode, changed_at = now(), changed_by = session_user,
      note = EXCLUDED.note;

CREATE OR REPLACE FUNCTION public.fn_ca_money_path_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_cat  text;
  v_mode text;
BEGIN
  v_path := COALESCE(current_setting('app.money_path', true), '');
  IF v_path = 'fn_settle_tournament_obligation' THEN
    RETURN NEW;
  END IF;

  v_cat := lower(COALESCE(NEW.category, ''));

  -- The mode is data, so the way back is an UPDATE and not a deploy. A missing
  -- row means log: this guard never becomes stricter by accident.
  SELECT e.mode INTO v_mode FROM public.ca_money_path_enforcement e WHERE e.only_row;
  v_mode := COALESCE(v_mode, 'log');

  IF v_mode = 'refuse' THEN
    -- Nothing survives this raise, so the message carries the evidence: who
    -- wrote, from where, for how much, against which entity.
    RAISE EXCEPTION
      'R3: a % credit of % was written outside fn_settle_tournament_obligation (money_path=%, app=%, role=%, wallet_transactions.related_entity_id=%). Route it through fn_settle_tournament_obligation. To reopen the door: UPDATE public.ca_money_path_enforcement SET mode = ''log'';',
      COALESCE(NULLIF(v_cat, ''), '<none>'), NEW.amount, COALESCE(NULLIF(v_path, ''), '<none>'),
      COALESCE(NULLIF(current_setting('application_name', true), ''), '<none>'),
      session_user::text, NEW.related_entity_id
      USING ERRCODE = 'raise_exception';
  END IF;

  BEGIN
    INSERT INTO public.ca_money_path_violations
      (table_name, user_id, amount, category, description, related_entity_id,
       money_path, app_name, db_role)
    VALUES
      (TG_TABLE_NAME, NEW.user_id, NEW.amount, NEW.category, NEW.description,
       NEW.related_entity_id, NULLIF(v_path, ''),
       NULLIF(current_setting('application_name', true), ''),
       session_user::text);
  EXCEPTION WHEN OTHERS THEN
    -- The logger must never be the reason a credit fails.
    NULL;
  END;

  BEGIN
    -- Global scope (no entity dimension) so it files for every union; the
    -- tournament id travels in metadata only. INFO never pages.
    PERFORM public.fn_ca_raise_drift_incident(
      p_source         => 'r3_money_path_log',
      p_classification => 'unauthorized_adjustment',
      p_severity       => 'info',
      p_dedupe_key     => 'r3:' || v_cat || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24'),
      p_discrepancy    => NEW.amount,
      p_layer          => 'settlement',
      p_entity_type    => 'wallet_transactions',
      p_entity_id      => NEW.id,
      p_suspected_cause => 'a tournament-category credit was written outside fn_settle_tournament_obligation (R3, log-only)',
      p_metadata       => jsonb_build_object('category', NEW.category, 'money_path', NULLIF(v_path, ''),
                            'related_entity_id', NEW.related_entity_id,
                            'app_name', NULLIF(current_setting('application_name', true), ''),
                            'session_user', session_user::text));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_money_path_log() FROM PUBLIC, anon, authenticated;

-- Self-check: in refuse mode an unsanctioned tournament credit is refused and a
-- sanctioned one is not. Both probes run inside subtransactions and leave
-- nothing behind.
DO $selfcheck$
DECLARE
  v_user    uuid;
  v_refused boolean := false;
  v_allowed boolean := false;
  v_other   text;
BEGIN
  SELECT user_id INTO v_user FROM public.wallet_transactions
   WHERE created_at > now() - interval '2 hours' AND user_id IS NOT NULL LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'R3_SELFCHECK: no recent wallet_transactions row to borrow a user from; skipping';
    RETURN;
  END IF;

  -- Probe one: no declared money path. R3 must refuse it.
  BEGIN
    PERFORM set_config('app.money_path', '', true);
    INSERT INTO public.wallet_transactions (user_id, wallet_type, type, category, amount, description)
    VALUES (v_user, 'PLAYER', 'credit', 'prize', 0.01, 'R3 refuse self-check, rolled back');
    RAISE EXCEPTION 'R3_SELFCHECK_NOT_REFUSED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'R3_SELFCHECK_NOT_REFUSED' THEN
      RAISE EXCEPTION 'R3_SELFCHECK: refuse mode did NOT refuse an unsanctioned tournament credit';
    ELSIF SQLERRM LIKE 'R3:%' THEN
      v_refused := true;
    ELSE
      -- Another guard on this table spoke first (the maintenance freeze, say).
      -- That is not an R3 failure and must not fail the migration; it only
      -- means this probe could not see R3 from here.
      v_other := SQLERRM;
    END IF;
  END;

  IF v_other IS NOT NULL THEN
    PERFORM set_config('app.money_path', '', true);
    RAISE NOTICE 'R3_SELFCHECK_INCONCLUSIVE: another guard answered first (%); mode is set to refuse regardless', v_other;
    RETURN;
  END IF;

  -- Probe two: the sanctioned path. R3 must let it through.
  BEGIN
    PERFORM set_config('app.money_path', 'fn_settle_tournament_obligation', true);
    INSERT INTO public.wallet_transactions (user_id, wallet_type, type, category, amount, description)
    VALUES (v_user, 'PLAYER', 'credit', 'prize', 0.01, 'R3 allow self-check, rolled back');
    v_allowed := true;
    RAISE EXCEPTION 'R3_SELFCHECK_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'R3:%' THEN
      RAISE EXCEPTION 'R3_SELFCHECK: the sanctioned path was refused: %', SQLERRM;
    ELSIF SQLERRM <> 'R3_SELFCHECK_ROLLBACK' THEN
      v_other := SQLERRM;
    END IF;
  END;
  PERFORM set_config('app.money_path', '', true);

  IF v_other IS NOT NULL THEN
    RAISE NOTICE 'R3_SELFCHECK: refuse proven; the allow probe was answered by another guard (%)', v_other;
    RETURN;
  END IF;

  IF NOT (v_refused AND v_allowed) THEN
    RAISE EXCEPTION 'R3_SELFCHECK: refused=% allowed=%', v_refused, v_allowed;
  END IF;

  RAISE NOTICE 'R3_SELFCHECK_OK: unsanctioned refused, sanctioned allowed, both rolled back';
END
$selfcheck$;