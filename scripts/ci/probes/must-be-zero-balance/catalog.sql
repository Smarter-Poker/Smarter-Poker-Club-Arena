-- Captured production catalog for the must_be_zero balance arm qualification.
--
-- Everything the detector actually reaches on a real run: the journal it reads,
-- the declaration table it is driven by, and the INCIDENT SURFACE it reports
-- through, at production's exact definitions (pg_get_functiondef, project
-- kuklfnapbkmacvwxktbh, read 2026-09-25). The incident filer is the real one on
-- purpose: the claim that a standing imbalance folds into ONE incident instead
-- of storming the board is a claim about that function, so a stub could not
-- prove it.
--
-- Stubbed, and only these: fn_ca_incident_notify and
-- fn_raise_server_financial_alert record their calls. Notification DELIVERY is
-- qualified by the production alert core probe, not here; what this probe needs
-- from them is that they are called, once, with the finding.

CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;

-- The journal. Only the columns the detector reads, plus the identity columns a
-- real leg carries, so a leg in this probe is shaped like a leg in production.
CREATE TABLE public.chip_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_type text,
  from_entity_id uuid,
  from_label text,
  to_type text,
  to_entity_id uuid,
  to_label text,
  amount numeric NOT NULL,
  category text,
  description text,
  club_id uuid,
  union_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  chain_seq bigserial
);
CREATE INDEX idx_chip_ledger_created_at ON public.chip_ledger USING btree (created_at);

-- The declaration. Exact shape of production's ca_ledger_accounts.
CREATE TABLE public.ca_ledger_accounts (
  account_type text PRIMARY KEY,
  side text NOT NULL,
  backing text,
  must_be_zero boolean NOT NULL DEFAULT false,
  notes text
);
INSERT INTO public.ca_ledger_accounts (account_type, side, backing, must_be_zero, notes) VALUES
 ('settlement_suspense','system','(none — flow account)',true,'must net to zero; never a place to hide drift'),
 ('chip_retirement','system','(none — sink of authorized burns)',false,'all burns credit this'),
 ('club_treasury','asset','clubs.chip_treasury',false,'club bank'),
 ('player_wallet','asset','club_members.chip_balance',false,'per (club,user)'),
 ('spin_reserve','liability','spin_bonus_pools.balance',false,'spin prize funding'),
 ('prize_liability','liability','tournaments.prize_pool (accounting counter)',false,'');

-- The incident surface.
CREATE TABLE public.ca_drift_incidents (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  detected_at timestamp with time zone DEFAULT now() NOT NULL,
  deadline_at timestamp with time zone DEFAULT (now() + '00:20:00'::interval) NOT NULL,
  classification text DEFAULT 'unknown'::text NOT NULL,
  severity text DEFAULT 'critical'::text NOT NULL,
  layer text DEFAULT 'unknown'::text NOT NULL,
  status text DEFAULT 'open'::text NOT NULL,
  source text NOT NULL,
  dedupe_key text NOT NULL,
  union_id uuid,
  club_id uuid,
  entity_type text,
  entity_id uuid,
  table_id uuid,
  tournament_id uuid,
  hand_id uuid,
  settlement_id text,
  wallet_ids uuid[],
  transaction_ids uuid[],
  currency text DEFAULT 'club_chips'::text NOT NULL,
  expected_amount numeric,
  actual_amount numeric,
  discrepancy_amount numeric DEFAULT 0 NOT NULL,
  ledger_balanced boolean,
  suspected_cause text,
  auto_repair_status text DEFAULT 'manual_needed'::text NOT NULL,
  escalation_level integer DEFAULT 0 NOT NULL,
  past_target boolean DEFAULT false NOT NULL,
  occurrences integer DEFAULT 1 NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  acknowledged_by uuid,
  acknowledged_at timestamp with time zone,
  assigned_to uuid,
  root_cause text,
  correction_ref text,
  resolution text,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  closure_basis text,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX ux_ca_drift_incidents_open_dedupe
  ON public.ca_drift_incidents (dedupe_key) WHERE status <> 'resolved';

CREATE TABLE public.ca_incident_events (
  id bigserial PRIMARY KEY,
  incident_id uuid NOT NULL,
  kind text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ca_detector_registry (
  source text PRIMARY KEY,
  owner text,
  sla_hours integer,
  status text DEFAULT 'active' NOT NULL,
  auto_resolve_hours integer,
  retired_by text,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ca_detector_registry (source, owner, sla_hours, status, auto_resolve_hours, note, updated_at)
VALUES ('fn_ca_suspense_regression_check','chip standard',24,'active',24,
        'seeded at Phase 6.3 from the sources on record; transient: clears after 24h unseen',
        '2026-09-05 20:36:18.911227+00');
CREATE TABLE public.ca_incident_file_failures (
  id bigserial PRIMARY KEY,
  source text, dedupe_key text, classification text, severity text,
  discrepancy numeric, sqlstate text, message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Entity tables fn_ca_is_midway_scope reads. Empty: a platform-substrate
-- finding carries no entity dimension, which is exactly the arm it must let
-- through, and an empty table proves it is not being let through by accident.
CREATE TABLE public.clubs (id uuid PRIMARY KEY, union_id uuid);
CREATE TABLE public.union_clubs (club_id uuid, union_id uuid);
CREATE TABLE public.tables (id uuid PRIMARY KEY, club_id uuid);
CREATE TABLE public.tournaments (id uuid PRIMARY KEY, club_id uuid);

-- Recording stubs. Delivery is out of scope; being called is not.
CREATE TABLE public.probe_notifications (incident_id uuid, kind text, body text, urgent boolean);
CREATE FUNCTION public.fn_ca_incident_notify(p_incident_id uuid, p_kind text, p_body text, p_urgent boolean)
 RETURNS void LANGUAGE sql SECURITY DEFINER AS
 $$INSERT INTO public.probe_notifications VALUES ($1,$2,$3,$4)$$;
CREATE TABLE public.probe_financial_alerts (severity text, source text, message text, context jsonb);
CREATE FUNCTION public.fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb)
 RETURNS void LANGUAGE sql SECURITY DEFINER AS
 $$INSERT INTO public.probe_financial_alerts VALUES ($1,$2,$3,$4)$$;

-- PRODUCTION DEFINITION, byte-exact.
CREATE OR REPLACE FUNCTION public.fn_ca_stable_dedupe_key(p_key text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  /* Strips a trailing period label: :2026-09-06, :2026-09-06-18, :2026-36.
     Used ONLY together with an equal discrepancy, so an hourly bucket that
     reports a different number is never folded into another one. */
  SELECT regexp_replace($1, ':([0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]{2})?|[0-9]{4}-[0-9]{1,2})$', '')
$function$;

-- PRODUCTION DEFINITION, byte-exact.
CREATE OR REPLACE FUNCTION public.fn_ca_is_midway_scope(p_union_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    -- THE FOUR ESTATES (Dan, 2026-09-03): Midway Union with Club JAQK and
    -- SHARK CLUB inside it, and Deep Stack Society standing alone. Until
    -- chip standard Phase 4.3 (2026-09-04) this scope was Midway only, so an
    -- incident about Deep Stack Society's money - its jackpot reserve running
    -- dry, a payout that could not reconcile - was dropped before it was
    -- filed. Deep Stack is an estate; its incidents file.
    -- platform-substrate incidents: no entity dimension anywhere = global
    -- checks (supply, suspense, guards, crons, diamonds) that protect every
    -- union including Midway. These always file.
    (p_union_id IS NULL AND p_club_id IS NULL AND p_table_id IS NULL
     AND p_tournament_id IS NULL
     AND COALESCE(p_metadata->>'union_id','') = ''
     AND COALESCE(p_metadata->>'club_id','') = '')
    OR p_union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    OR p_club_id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
    OR EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = p_club_id
         AND c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    )
    OR EXISTS (
      SELECT 1 FROM public.union_clubs uc
       WHERE uc.club_id = p_club_id
         AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    )
    OR EXISTS (
      SELECT 1 FROM public.tables t
      JOIN public.clubs c ON c.id = t.club_id
       WHERE t.id = p_table_id
         AND (
           c.id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )
    OR EXISTS (
      SELECT 1 FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
       WHERE t.id = p_tournament_id
         AND (
           c.id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )
    OR COALESCE(p_metadata->>'union_id', '') = 'fade0000-0000-0000-0000-000000000001'
    OR EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id::text = COALESCE(p_metadata->>'club_id', '')
         AND (
           c.id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )), false);
$function$;

-- THE GUARD DECLARATION SURFACE. fn_ca_suspense_regression_check is on
-- fn_ca_guard_watchlist(), so a migration that redefines it must declare the
-- redefinition in the same transaction or fn_ca_guard_defs_watch opens an INFO
-- notice a human has to close by hand
-- (tests/a-declared-guard-change-is-recorded-not-raised.law.test.ts).
-- fn_ca_declare_guard_redefinition below is production's exact definition. The
-- watchlist is a fixture holding only the guard under test: which other names
-- are watched is the watchlist migration's business, not this probe's.
CREATE TABLE public.ca_guard_defs (
  proname text NOT NULL PRIMARY KEY,
  def_hash text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  declared_ref text,
  declared_at timestamp with time zone
);
CREATE TABLE public.ca_guard_def_history (
  id bigserial PRIMARY KEY,
  proname text NOT NULL,
  def_hash text NOT NULL,
  def_text text NOT NULL,
  captured_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE (proname, def_hash)
);
CREATE FUNCTION public.fn_ca_guard_watchlist() RETURNS text[]
 LANGUAGE sql IMMUTABLE AS $$SELECT ARRAY['fn_ca_suspense_regression_check']::text[]$$;

-- PRODUCTION DEFINITION, byte-exact.
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
