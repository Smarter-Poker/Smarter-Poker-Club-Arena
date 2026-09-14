-- Exact live guard declaration and watchlist; guard table columns and indexes.
CREATE SEQUENCE ca_guard_def_history_id_seq;
CREATE TABLE ca_guard_def_history(
id bigint DEFAULT nextval('ca_guard_def_history_id_seq'::regclass) NOT NULL,
proname text NOT NULL,
def_hash text NOT NULL,
def_text text NOT NULL,
captured_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE ca_guard_defs(
proname text NOT NULL,
def_hash text NOT NULL,
updated_at timestamp with time zone DEFAULT now() NOT NULL,
declared_ref text,
declared_at timestamp with time zone
);
ALTER TABLE ca_guard_defs ADD CONSTRAINT ca_guard_defs_pkey PRIMARY KEY (proname);
ALTER TABLE ca_guard_def_history ADD CONSTRAINT ca_guard_def_history_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX ca_guard_def_history_proname_hash_idx ON ca_guard_def_history(proname,def_hash);
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
$function$

;
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
$function$

;
