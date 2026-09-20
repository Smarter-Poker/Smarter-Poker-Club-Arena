-- PRIVATE FIXTURE ONLY: empty captured notification catalog supplement. UNRUN.
SET search_path=public;
-- Exact private ledger table metadata captured read-only 2026-09-17T02:09:07.874942+00:00.
CREATE TABLE public.ledger_reconcile_log (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "run_date" date DEFAULT CURRENT_DATE NOT NULL,
  "run_ts" timestamp with time zone DEFAULT now() NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid,
  "ledger_balance" numeric(18,2) NOT NULL,
  "stored_balance" numeric(18,2) NOT NULL,
  "drift" numeric(18,2) GENERATED ALWAYS AS ((stored_balance - ledger_balance)) STORED,
  "severity" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.ledger_reconcile_log ADD CONSTRAINT "ledger_reconcile_log_entity_type_check" CHECK ((entity_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'agent_wallet'::text, 'frozen_wallets_pool'::text, 'chip_circulation'::text, 'seat_stack_exit'::text, 'cashout_escrow_stuck'::text, 'negative_balance'::text, 'over_claimed_send'::text, 'insurance_bank'::text, 'insurance_offer_unresolved'::text, 'bomb_award_ledger_gap'::text, 'rake_law'::text])));
ALTER TABLE public.ledger_reconcile_log ADD CONSTRAINT "ledger_reconcile_log_pkey" PRIMARY KEY (id);
ALTER TABLE public.ledger_reconcile_log ADD CONSTRAINT "ledger_reconcile_log_severity_check" CHECK ((severity = ANY (ARRAY['ok'::text, 'warn'::text, 'critical'::text])));
CREATE INDEX idx_reconcile_run_date ON public.ledger_reconcile_log USING btree (run_date DESC);
ALTER TABLE public.ledger_reconcile_log OWNER TO postgres;
ALTER TABLE public.ledger_reconcile_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ledger_reconcile_log FROM PUBLIC,anon,authenticated,service_role;
GRANT ALL ON public.ledger_reconcile_log TO postgres,service_role;
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON public.ledger_reconcile_log TO anon,authenticated;
CREATE POLICY "reconcile_admin_read" ON public.ledger_reconcile_log AS PERMISSIVE FOR SELECT TO PUBLIC USING (((( SELECT auth.role() AS role) = 'service_role'::text) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'owner'::text, 'super_agent'::text])))))));
CREATE POLICY "reconcile_service_write" ON public.ledger_reconcile_log AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE OR REPLACE FUNCTION public.fn_ca_reconcile_log_to_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_class text; v_layer text; v_club uuid; v_kind text; v_illegal boolean;
BEGIN
  IF NEW.severity NOT IN ('warn','critical') THEN RETURN NEW; END IF;

  v_kind := NEW.metadata->>'kind';
  -- An over-rake takes chips off a player that the rules never owed the
  -- house. board_not_recorded and impossible_showdown really are evidence
  -- gaps; these three are money.
  v_illegal := NEW.entity_type = 'rake_law'
               AND v_kind IN ('no_flop_no_drop','over_cap','over_percent');

  v_class := CASE
    WHEN v_illegal THEN 'incorrect_rake'
    ELSE CASE NEW.entity_type
      WHEN 'club_treasury' THEN 'treasury_error'
      WHEN 'frozen_wallets_pool' THEN 'unauthorized_adjustment'
      WHEN 'seat_stack_exit' THEN 'missing_payment'
      WHEN 'negative_balance' THEN 'ledger_imbalance'
      WHEN 'insurance_bank' THEN 'settlement_error'
      WHEN 'insurance_offer_unresolved' THEN 'settlement_error'
      WHEN 'cashout_escrow_stuck' THEN 'settlement_error'
      WHEN 'over_claimed_send' THEN 'duplicate_payment'
      WHEN 'bomb_award_ledger_gap' THEN 'reporting_mismatch'
      WHEN 'rake_law' THEN 'reporting_mismatch'
      ELSE 'unknown' END
  END;

  v_layer := CASE
    WHEN v_illegal THEN 'settlement'
    WHEN NEW.entity_type IN ('bomb_award_ledger_gap','rake_law') THEN 'reporting'
    ELSE 'ledger' END;

  BEGIN v_club := NULLIF(NEW.metadata->>'club_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN v_club := NULL; END;
  IF v_club IS NULL AND NEW.entity_type = 'club_treasury' THEN v_club := NEW.entity_id; END IF;

  PERFORM public.fn_ca_raise_drift_incident(
    p_source => 'ledger_reconcile_log:' || COALESCE(NEW.metadata->>'source', v_kind, '?'),
    p_classification => v_class,
    p_severity => CASE WHEN v_illegal THEN 'critical'
                       WHEN NEW.severity = 'critical' THEN 'critical'
                       ELSE 'warning' END,
    p_dedupe_key => 'lrl:' || NEW.entity_type || ':' || COALESCE(NEW.entity_id::text,'-') || ':' ||
      COALESCE(NEW.metadata->>'exit_id', NEW.metadata->>'hand_history_id',
               NEW.metadata->>'hand_id', NEW.metadata->>'escrow_id', ''),
    p_discrepancy => COALESCE(NEW.stored_balance,0) - COALESCE(NEW.ledger_balance,0),
    p_expected => NEW.ledger_balance,
    p_actual => NEW.stored_balance,
    p_layer => v_layer,
    p_entity_type => NEW.entity_type,
    p_entity_id => NEW.entity_id,
    p_club_id => v_club,
    p_suspected_cause => COALESCE(NEW.metadata->>'rule', v_kind),
    p_metadata => COALESCE(NEW.metadata,'{}'::jsonb));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_reconcile_log_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_reconcile_log_to_incident() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_reconcile_log_to_incident() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_reconcile_log_to_incident() TO service_role;
CREATE TRIGGER trg_ca_reconcile_log_incident AFTER INSERT ON public.ledger_reconcile_log FOR EACH ROW EXECUTE FUNCTION fn_ca_reconcile_log_to_incident();
CREATE TABLE public.ca_guard_defs(proname text NOT NULL PRIMARY KEY,def_hash text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),declared_ref text,declared_at timestamptz);
CREATE TABLE public.ca_guard_def_history(id bigint NOT NULL DEFAULT nextval('public.ca_guard_def_history_id_seq'::regclass) PRIMARY KEY,proname text NOT NULL,def_hash text NOT NULL,def_text text NOT NULL,captured_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX ca_guard_def_history_proname_hash_idx ON public.ca_guard_def_history(proname,def_hash);
ALTER TABLE public.ca_guard_defs OWNER TO postgres; ALTER TABLE public.ca_guard_def_history OWNER TO postgres;
ALTER SEQUENCE public.ca_guard_def_history_id_seq OWNER TO postgres;
ALTER SEQUENCE public.ca_guard_def_history_id_seq OWNED BY public.ca_guard_def_history.id;
ALTER TABLE public.ca_guard_defs ENABLE ROW LEVEL SECURITY; ALTER TABLE public.ca_guard_def_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_guard_defs,public.ca_guard_def_history FROM PUBLIC,anon,authenticated,service_role; GRANT ALL ON public.ca_guard_defs,public.ca_guard_def_history TO postgres,service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_declare_guard_redefinition(p_proname text, p_ref text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hash text;
  v_def text;
BEGIN
  /* A DECLARED GUARD CHANGE IS RECORDED, NOT RAISED (2026-09-10).
     Call this from a migration that deliberately redefines a watched guard,
     in the SAME transaction as the redefinition, passing the migration name.
     It moves the baseline to the definition this transaction just produced,
     so fn_ca_guard_defs_watch has nothing to report. A change nobody declares
     still moves the hash away from the baseline and still raises. */
  IF COALESCE(btrim(p_ref), '') = '' THEN
    RAISE EXCEPTION 'a guard redefinition must name the migration that made it';
  END IF;
  IF NOT (p_proname = ANY (public.fn_ca_guard_watchlist())) THEN
    RAISE EXCEPTION 'fn_ca_declare_guard_redefinition called for %, which is not on the guard watchlist', p_proname;
  END IF;

  SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)),
         string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)
    INTO v_hash, v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_proname;

  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'guard function % does not exist; a declaration cannot baseline an absent guard', p_proname;
  END IF;

  -- keep the text so any later notice still has something to diff against
  INSERT INTO public.ca_guard_def_history (proname, def_hash, def_text)
  VALUES (p_proname, v_hash, v_def)
  ON CONFLICT (proname, def_hash) DO NOTHING;

  INSERT INTO public.ca_guard_defs (proname, def_hash, declared_ref, declared_at)
  VALUES (p_proname, v_hash, p_ref, now())
  ON CONFLICT (proname) DO UPDATE
    SET def_hash = EXCLUDED.def_hash,
        declared_ref = EXCLUDED.declared_ref,
        declared_at = EXCLUDED.declared_at,
        updated_at = now();

  RETURN v_hash;
END;
$function$;
ALTER FUNCTION public.fn_ca_declare_guard_redefinition(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_declare_guard_redefinition(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_declare_guard_redefinition(text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors (2026-09-12).
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules (2026-09-12).
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The seat guards that know a tournament seat (2026-09-13).
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- The Diamond tournament money doors (Phase 8, 2026-09-14): an entry
      -- into custody, an add to it, its refund, its unregistration and
      -- cancellation, the drain, the prize, the fee, the close, the shadow.
      'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
      'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
      'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
      'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
      -- The two guards Phase 8 taught new names, and the two chip readers it
      -- routes by asset. The wallet guard is the one thing between a browser
      -- and profiles.diamonds.
      'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
      'fn_ca_escrow_can_pay','fn_ca_tournament_escrow',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$;
ALTER FUNCTION public.fn_ca_guard_watchlist() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_watchlist() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_watchlist() TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_escalate_reconcile_criticals(p_lookback interval DEFAULT '36:00:00'::interval)
 RETURNS TABLE(considered integer, filed integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r        record;
  v_seen   integer := 0;
  v_filed  integer := 0;
  v_id     uuid;
  v_class  text;
BEGIN
  FOR r IN
    -- Newest row per entity. An entity critical for a week must not raise
    -- seven incidents; fn_ca_raise_drift_incident counts the recurrence.
    /* THE NEWEST ROW DECIDES, NOT THE NEWEST CRITICAL ROW (2026-09-08).
       The severity filter used to sit in this WHERE, so DISTINCT ON picked
       the newest CRITICAL row per entity rather than the newest row - and
       an entity whose latest reading is ok kept re-escalating its last
       critical for the whole lookback. Deep Stack Society read ok at
       13:01:35 and was escalated again at 13:52 from a 2026-09-07 row.
       Every fix in this repo was being undone on the board for 36 hours. */
    SELECT * FROM (
      SELECT DISTINCT ON (l.entity_type, l.entity_id)
             l.entity_type, l.entity_id, l.drift, l.ledger_balance,
             l.stored_balance, l.run_date, l.metadata, l.severity
        FROM public.ledger_reconcile_log l
       WHERE l.created_at >= now() - p_lookback
       ORDER BY l.entity_type, l.entity_id, l.created_at DESC
    ) newest WHERE newest.severity = 'critical'
  LOOP
    v_seen := v_seen + 1;

    -- Map onto the classifications the estate already routes on rather than
    -- inventing one; an unknown value silently becomes 'unknown' upstream.
    v_class := CASE r.entity_type
      WHEN 'club_treasury'       THEN 'treasury_error'
      WHEN 'frozen_wallets_pool' THEN 'unauthorized_adjustment'
      ELSE 'ledger_imbalance'
    END;

    v_id := public.fn_ca_raise_drift_incident(
      -- the same source the trigger files under, so one detector owns it
      'ledger_reconcile_log:' || COALESCE(r.metadata->>'source', r.entity_type),
      v_class,
      'critical',
      -- the same key fn_ca_reconcile_log_to_incident builds, so this folds
      -- onto the incident that already exists rather than twinning it
      'lrl:' || r.entity_type || ':' || COALESCE(r.entity_id::text, '-') || ':' ||
        COALESCE(r.metadata->>'exit_id', r.metadata->>'hand_history_id',
                 r.metadata->>'hand_id', r.metadata->>'escrow_id', ''),
      COALESCE(r.drift, 0),
      r.ledger_balance,
      r.stored_balance,
      -- MUST be one of ledger/projection/cache/reporting/settlement/unknown.
      -- 'database' is not, and passing it is what made 901 calls vanish.
      'ledger',
      r.entity_type,
      r.entity_id,
      CASE WHEN r.entity_type = 'club_treasury' THEN r.entity_id END,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'reconcile_ledger_nightly reported a critical drift for this '
        || r.entity_type || ': the stored balance and the journal disagree.',
      false,
      COALESCE(r.metadata, '{}'::jsonb)
        || jsonb_build_object('run_date', r.run_date,
                              'escalated_by', 'fn_ca_escalate_reconcile_criticals')
    );

    -- NULL means the incident was not filed. Today that is almost always
    -- fn_ca_is_midway_scope declining an entity outside the piloted union,
    -- which is deliberate; anything else now leaves a row in
    -- ca_incident_file_failures instead of disappearing.
    IF v_id IS NOT NULL THEN
      v_filed := v_filed + 1;
    END IF;
  END LOOP;

  considered := v_seen;
  filed := v_filed;
  RETURN NEXT;
END;
$function$;
ALTER FUNCTION public.fn_ca_escalate_reconcile_criticals(interval) OWNER TO postgres; REVOKE ALL ON FUNCTION public.fn_ca_escalate_reconcile_criticals(interval) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_ca_escalate_reconcile_criticals(interval) TO service_role;
INSERT INTO public.ca_guard_defs(proname,def_hash,declared_ref,declared_at) VALUES ('fn_ca_financial_alert_to_incident','3771aeef9008e35c6af3d03f220ebb3b','migration 20260914092500_tournament_finish_incident_identity','2026-09-14 09:25:00Z'),('fn_ca_raise_drift_incident','bd239239efefc237fd69f3217ceab367',NULL,NULL);
INSERT INTO public.ca_guard_def_history(proname,def_hash,def_text) SELECT d.proname,d.def_hash,pg_get_functiondef(p.oid) FROM public.ca_guard_defs d JOIN pg_proc p ON p.pronamespace='public'::regnamespace AND p.proname=d.proname;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_declare_guard_redefinition(text,text)'::regprocedure))<>'3a3746dc6e0a5b7a1db97805588c0eb8' OR md5(pg_get_functiondef('public.fn_ca_guard_watchlist()'::regprocedure))<>'92ee208d0887728444bda396d0b4d442' THEN RAISE EXCEPTION 'captured core supplement drift'; END IF; END $$;
