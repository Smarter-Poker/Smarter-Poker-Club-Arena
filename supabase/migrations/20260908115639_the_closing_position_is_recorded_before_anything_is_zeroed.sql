CREATE TABLE IF NOT EXISTS public.ca_epoch_closing_positions (
  id            bigserial PRIMARY KEY,
  capture_ref   uuid        NOT NULL,
  epoch_id      integer     NOT NULL,
  epoch_name    text        NOT NULL,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  account_type  text        NOT NULL,
  column_name   text        NOT NULL,
  entity_id     uuid,
  club_id       uuid,
  balance       numeric(20,2) NOT NULL,
  note          text
);

COMMENT ON TABLE public.ca_epoch_closing_positions IS
  'What every account held the moment before an epoch reset. Written by fn_ca_capture_closing_position inside the maintenance freeze, append-only, kept seven years under docs/CHIP-JOURNAL-RETENTION-POLICY.md. It is the only evidence of what anybody held before a reset, and the only thing a restore migration can be written from - see docs/CHIP-EPOCH-RESET-CONTRACT.md step 1.';

CREATE INDEX IF NOT EXISTS idx_ca_epoch_closing_positions_ref
  ON public.ca_epoch_closing_positions (capture_ref, account_type);
CREATE INDEX IF NOT EXISTS idx_ca_epoch_closing_positions_epoch
  ON public.ca_epoch_closing_positions (epoch_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ca_epoch_closing_positions_entity
  ON public.ca_epoch_closing_positions (entity_id) WHERE entity_id IS NOT NULL;

ALTER TABLE public.ca_epoch_closing_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ca_epoch_closing_positions_service_only ON public.ca_epoch_closing_positions;
CREATE POLICY ca_epoch_closing_positions_service_only
  ON public.ca_epoch_closing_positions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_ca_append_only ON public.ca_epoch_closing_positions;
CREATE TRIGGER trg_ca_append_only
  BEFORE UPDATE OR DELETE ON public.ca_epoch_closing_positions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();

DO $c$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ca_epoch_closing_positions'::regclass
       AND conname = 'chk_balance_is_two_decimal_places'
  ) THEN
    ALTER TABLE public.ca_epoch_closing_positions
      ADD CONSTRAINT chk_balance_is_two_decimal_places
      CHECK (balance = round(balance, 2));
  END IF;
END $c$;

CREATE OR REPLACE FUNCTION public.fn_ca_capture_closing_position(
  p_note    text    DEFAULT NULL,
  p_dry_run boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ref    uuid := gen_random_uuid();
  v_epoch  record;
  v_rows   integer := 0;
  v_total  numeric := 0;
  v_by     jsonb;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'closing-position capture is operator-only';
  END IF;

  SELECT id, name INTO v_epoch
    FROM public.ca_financial_epochs WHERE is_current LIMIT 1;
  IF v_epoch.id IS NULL THEN
    RAISE EXCEPTION 'no current epoch - ca_financial_epochs has no is_current row';
  END IF;

  IF NOT p_dry_run AND NOT public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'closing-position capture refused: the platform is not frozen. Capture inside the :55 maintenance break, or pass p_dry_run => true to rehearse.'
      USING ERRCODE = '55006';
  END IF;

  CREATE TEMP TABLE _closing (
    account_type text, column_name text, entity_id uuid, club_id uuid, balance numeric
  ) ON COMMIT DROP;

  INSERT INTO _closing
  SELECT 'player_wallet', 'club_members.chip_balance', cm.user_id, cm.club_id, round(COALESCE(cm.chip_balance,0),2)
    FROM public.club_members cm WHERE COALESCE(cm.chip_balance,0) <> 0;

  INSERT INTO _closing
  SELECT 'member_promo', 'club_members.promo_balance', cm.user_id, cm.club_id, round(COALESCE(cm.promo_balance,0),2)
    FROM public.club_members cm WHERE COALESCE(cm.promo_balance,0) <> 0;

  INSERT INTO _closing
  SELECT 'table_stack', 'table_seats.stack', ts.user_id, ts.club_id, round(COALESCE(ts.stack,0),2)
    FROM public.table_seats ts
   WHERE ts.left_at IS NULL AND COALESCE(ts.stack,0) <> 0
     AND NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.id = ts.table_id AND t.tournament_id IS NOT NULL);

  INSERT INTO _closing
  SELECT 'club_treasury', 'clubs.chip_treasury', NULL, c.id, round(COALESCE(c.chip_treasury,0),2)
    FROM public.clubs c WHERE COALESCE(c.chip_treasury,0) <> 0;
  INSERT INTO _closing
  SELECT 'club_pool', 'clubs.chip_pool', NULL, c.id, round(COALESCE(c.chip_pool,0),2)
    FROM public.clubs c WHERE COALESCE(c.chip_pool,0) <> 0;
  INSERT INTO _closing
  SELECT 'club_promo', 'clubs.promo_balance', NULL, c.id, round(COALESCE(c.promo_balance,0),2)
    FROM public.clubs c WHERE COALESCE(c.promo_balance,0) <> 0;
  INSERT INTO _closing
  SELECT 'club_insurance', 'clubs.insurance_balance', NULL, c.id, round(COALESCE(c.insurance_balance,0),2)
    FROM public.clubs c WHERE COALESCE(c.insurance_balance,0) <> 0;

  INSERT INTO _closing
  SELECT 'club_wallet', 'club_wallets.chip_balance', NULL, cw.club_id, round(COALESCE(cw.chip_balance,0),2)
    FROM public.club_wallets cw WHERE COALESCE(cw.chip_balance,0) <> 0;

  INSERT INTO _closing
  SELECT 'union_wallet', 'union_wallets.' || col, NULL, uw.union_id, round(bal,2)
    FROM public.union_wallets uw,
         LATERAL (VALUES
           ('chip_balance', COALESCE(uw.chip_balance,0)),
           ('rake_wallet', COALESCE(uw.rake_wallet,0)),
           ('bbj_wallet', COALESCE(uw.bbj_wallet,0)),
           ('promo_wallet', COALESCE(uw.promo_wallet,0)),
           ('insurance_wallet', COALESCE(uw.insurance_wallet,0)),
           ('spin_reserve_wallet', COALESCE(uw.spin_reserve_wallet,0))
         ) AS v(col, bal)
   WHERE bal <> 0;

  INSERT INTO _closing
  SELECT 'agent_wallet', 'agents.agent_wallet_balance', a.user_id, a.club_id, round(COALESCE(a.agent_wallet_balance,0),2)
    FROM public.agents a WHERE COALESCE(a.agent_wallet_balance,0) <> 0;
  INSERT INTO _closing
  SELECT 'agent_promo', 'agents.promo_wallet_balance', a.user_id, a.club_id, round(COALESCE(a.promo_wallet_balance,0),2)
    FROM public.agents a WHERE COALESCE(a.promo_wallet_balance,0) <> 0;
  INSERT INTO _closing
  SELECT 'agent_player_wallet', 'agents.player_wallet_balance', a.user_id, a.club_id, round(COALESCE(a.player_wallet_balance,0),2)
    FROM public.agents a WHERE COALESCE(a.player_wallet_balance,0) <> 0;

  INSERT INTO _closing
  SELECT 'bbj_pool', 'bbj_pools.' || col, b.union_id, b.club_id, round(bal,2)
    FROM public.bbj_pools b,
         LATERAL (VALUES
           ('main_balance', COALESCE(b.main_balance,0)),
           ('backup_balance', COALESCE(b.backup_balance,0)),
           ('promo_balance', COALESCE(b.promo_balance,0))
         ) AS v(col, bal)
   WHERE bal <> 0;

  INSERT INTO _closing
  SELECT 'spin_reserve', 'spin_bonus_pools.balance', NULL, s.club_id, round(COALESCE(s.balance,0),2)
    FROM public.spin_bonus_pools s WHERE COALESCE(s.balance,0) <> 0;

  INSERT INTO _closing
  SELECT 'frozen_wallet_pool', 'wallets.balance', w.user_id, NULL, round(COALESCE(w.balance,0),2)
    FROM public.wallets w WHERE COALESCE(w.balance,0) <> 0;

  SELECT count(*), COALESCE(round(sum(balance),2),0) INTO v_rows, v_total FROM _closing;
  SELECT jsonb_object_agg(account_type, totals) INTO v_by
    FROM (SELECT account_type,
                 jsonb_build_object('accounts', count(*), 'total', round(sum(balance),2)) AS totals
            FROM _closing GROUP BY account_type) x;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'closing-position capture found no accounts at all - refusing to record an empty position';
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object('dry_run', true, 'written', false,
      'epoch', v_epoch.name, 'accounts', v_rows, 'total', v_total, 'by_class', v_by,
      'frozen_now', public.fn_platform_frozen(),
      'note', 'run with p_dry_run => false inside the :55 freeze to record it');
  END IF;

  INSERT INTO public.ca_epoch_closing_positions
    (capture_ref, epoch_id, epoch_name, account_type, column_name, entity_id, club_id, balance, note)
  SELECT v_ref, v_epoch.id, v_epoch.name, c.account_type, c.column_name, c.entity_id, c.club_id, c.balance, p_note
    FROM _closing c;

  RETURN jsonb_build_object('written', true, 'capture_ref', v_ref,
    'epoch', v_epoch.name, 'accounts', v_rows, 'total', v_total, 'by_class', v_by,
    'next', 'compare against fn_ca_supply_snapshot() before the reset, then keep it forever');
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_capture_closing_position(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_capture_closing_position(text, boolean) TO service_role;

COMMENT ON FUNCTION public.fn_ca_capture_closing_position(text, boolean) IS
  'Records what every account held the moment before an epoch reset - roadmap 9.8 step 1. Covers exactly the classes fn_ca_supply_snapshot reads, so the two agree by construction. A real capture refuses unless the platform is frozen; p_dry_run reads and returns the same totals without writing.';

CREATE OR REPLACE FUNCTION public.fn_ca_closing_position_summary(p_capture_ref uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ref uuid := p_capture_ref;
  v_out jsonb;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'closing-position summary is operator-only';
  END IF;

  IF v_ref IS NULL THEN
    SELECT capture_ref INTO v_ref FROM public.ca_epoch_closing_positions
     ORDER BY captured_at DESC LIMIT 1;
  END IF;
  IF v_ref IS NULL THEN
    RETURN jsonb_build_object('found', false,
      'error', 'no closing position has ever been captured');
  END IF;

  SELECT jsonb_build_object(
      'found', true,
      'capture_ref', v_ref,
      'epoch', max(epoch_name),
      'captured_at', max(captured_at),
      'accounts', count(*),
      'total', round(sum(balance), 2),
      'by_class', (SELECT jsonb_object_agg(account_type,
                       jsonb_build_object('accounts', n, 'total', t))
                     FROM (SELECT account_type, count(*) AS n, round(sum(balance),2) AS t
                             FROM public.ca_epoch_closing_positions
                            WHERE capture_ref = v_ref GROUP BY account_type) g))
    INTO v_out
    FROM public.ca_epoch_closing_positions WHERE capture_ref = v_ref;

  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_closing_position_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_closing_position_summary(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_ca_closing_position_summary(uuid) IS
  'Reads a captured closing position back, per class and in total. What the restore migration of the epoch reset contract step 3 is written from, and what the capture is compared against fn_ca_supply_snapshot() with before anybody trusts it.';

DO $gate$
DECLARE
  v_src text; v_new text; v_hits integer;
  v_anchor text := '  -- measure the horse mint per user (credits from tournament-attached tables)';
  v_insert text :=
    '  /* THE CONTRACT''S REFUSALS (roadmap 9.8, added 2026-09-08). This function'   || E'\n' ||
    '     destroys balances; before 2026-09-08 nothing recorded them first, nothing' || E'\n' ||
    '     checked that play had stopped, and there was no restore path. */'          || E'\n' ||
    '  IF NOT p_dry_run THEN'                                                        || E'\n' ||
    '    IF NOT public.fn_platform_frozen() THEN'                                    || E'\n' ||
    '      RAISE EXCEPTION ''epoch reset refused: the platform is not frozen. It runs inside the :55 maintenance break.'''  || E'\n' ||
    '        USING ERRCODE = ''55006'';'                                             || E'\n' ||
    '    END IF;'                                                                    || E'\n' ||
    '    IF EXISTS (SELECT 1 FROM public.table_seats WHERE left_at IS NULL) THEN'     || E'\n' ||
    '      RAISE EXCEPTION ''epoch reset refused: % seat(s) are still occupied. Parked is not the same as empty - a stack zeroed under a seated player is a balance that no longer matches what they can see.'','  || E'\n' ||
    '        (SELECT count(*) FROM public.table_seats WHERE left_at IS NULL);'        || E'\n' ||
    '    END IF;'                                                                    || E'\n' ||
    '    IF NOT EXISTS ('                                                            || E'\n' ||
    '      SELECT 1 FROM public.ca_epoch_closing_positions cp'                        || E'\n' ||
    '       JOIN public.ca_financial_epochs e ON e.id = cp.epoch_id AND e.is_current' || E'\n' ||
    '       WHERE cp.captured_at > now() - interval ''15 minutes'''                   || E'\n' ||
    '    ) THEN'                                                                      || E'\n' ||
    '      RAISE EXCEPTION ''epoch reset refused: no closing position captured for the current epoch in the last 15 minutes. Run fn_ca_capture_closing_position(p_dry_run => false) first - it is the only evidence of what anybody held, and the only thing a restore can be written from.'';' || E'\n' ||
    '    END IF;'                                                                    || E'\n' ||
    '  END IF;'                                                                      || E'\n' ||
    E'\n';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_execute_epoch3_reset';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_execute_epoch3_reset not found - the gate must be re-read against what exists';
  END IF;

  IF position('THE CONTRACT''S REFUSALS' in v_src) > 0 THEN
    RAISE NOTICE 'reset gate already applied; skipping';
  ELSE
    v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'expected exactly one anchor in fn_ca_execute_epoch3_reset, found % - the function has changed and this gate must be re-read against it', v_hits;
    END IF;
    v_new := replace(v_src, v_anchor, v_insert || v_anchor);
    EXECUTE v_new;
  END IF;
END $gate$;