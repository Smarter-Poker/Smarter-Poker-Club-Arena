-- @live-proof: to_regclass('public.tournament_ticket_entry_targets') IS NOT NULL AND has_function_privilege('authenticated','public.fn_issue_tournament_entry_ticket(uuid,uuid,uuid,text,text,numeric)','EXECUTE') AND has_function_privilege('authenticated','public.fn_cashier_ticketable_tournaments(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_ca_use_cashier_entry_ticket(uuid,uuid,uuid)','EXECUTE') AND strpos(pg_get_functiondef('public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)'::regprocedure),'fn_issue_tournament_entry_ticket')>0 AND strpos(pg_get_functiondef('public.trg_ca_closed_target_pays_its_satellite_tickets()'::regprocedure),'fn_ca_settle_closed_cashier_entry_tickets')>0
-- 20261015132042_cashier_sends_a_ticket_into_one_tournament.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THE OWNER ASKED FOR (Dan, 2026-10-15, verbatim)
--
--   "SEND TICKET" SHOULD HAVE A DROP DOWN WHERE ANY AND ALL "FUTURE OR
--   CURRENTLY RUNNING TOURNAMENTS" SHOULD BE DISPLAYED TO "SELECT" AND AWARD
--   THAT USER A TICKET INTO THAT TOURNAMENT. FUNDS SHOULD BE SUBTRACTED FROM
--   THE SENDERS BALANCE.
--
-- THE SHAPE, AND WHY IT IS NOT A NEW KIND OF ENTRY-ONLY TICKET
--
-- tournament_tickets already has a noncash 'tournament_entry_only' mode, but
-- its CHECK constraint (tournament_tickets_satellite_entry_contract_check)
-- admits only SYSTEM-issued tickets with SATELLITE provenance, and every door
-- downstream of a ticket admission assumes that provenance: the refund and
-- cancellation doors (fn_settle_tournament_refund_exact, atomic_cancel_tournament,
-- fn_ca_return_satellite_entitlement_as_ticket) compare
-- tk.source_satellite_id = e.source_satellite_id with '='. A cashier ticket has
-- no satellite, so that comparison is NULL, and the cancellation of any
-- tournament holding one such entrant would raise "refund entitlement lost its
-- exact funded source" and roll back for EVERY entrant. Widening that rail
-- means rewriting a dozen 10-30k character money functions with no way to
-- execute them against production first. That is not a safe change.
--
-- So a cashier ticket is the ordinary escrowed ticket the cashier already
-- sends (fn_issue_tournament_ticket_phase2_core_20260831: the sender's player
-- wallet -> the ticket escrow, receipt 'tournament_ticket_issue'), bound to ONE
-- tournament by an immutable row in tournament_ticket_entry_targets:
--
--   fn_cashier_ticketable_tournaments(club)   the drop-down: every future or
--                                              running event of this club or
--                                              its union that still takes an
--                                              entry, priced by
--                                              fn_tournament_entry_split
--   fn_issue_tournament_entry_ticket(...)      prices the ticket from the
--                                              tournament (never the client),
--                                              escrows exactly that through the
--                                              existing core, binds it
--   fn_cashier_batch_transfer                  a 'ticket' item that carries
--                                              tournament_id routes to it; an
--                                              item without one is unchanged
--   fn_ca_use_cashier_entry_ticket             THE ENTRY: in one transaction
--                                              the escrow is released to the
--                                              holder's wallet in the ticket's
--                                              club and the holder is entered
--                                              through the SAME wallet door a
--                                              person (fn_register_for_tournament
--                                              chain) or a horse
--                                              (fn_register_horse_for_tournament
--                                              chain) uses. The wallet nets to
--                                              zero exactly or the whole entry
--                                              rolls back. From there the entrant
--                                              is an ordinary wallet entrant, so
--                                              every refund, unregistration,
--                                              cancellation and payout door works
--                                              unchanged.
--   fn_find_tournament_entry_ticket            offers the bound ticket when no
--   fn_register_for_tournament_with_ticket_    satellite ticket applies, and the
--     before_terminal_gate                     ticket door routes it, so the
--                                              existing Register button uses it
--                                              with no client change
--   fn_register_horse_for_tournament_before_   a horse with the same ticket is
--     terminal_gate, fn_horse_tournament_      steered to and entered through the
--     entry_ticket_hints                       same door (CLAUDE.md 10.5)
--   fn_redeem_tournament_ticket                refuses a bound ticket: it is an
--                                              entry, not chips
--   fn_cancel_tournament_ticket (unchanged)    the issuer can still cancel an
--                                              unused ticket and the escrow
--                                              returns to the issuer
--   fn_ca_settle_closed_cashier_entry_tickets  when the tournament finalizes its
--     via trg_ca_closed_target_pays_its_       pool, finishes or is cancelled
--     satellite_tickets                        before the ticket is used, in the
--                                              SAME transaction that closes it,
--                                              the value goes to the holder in
--                                              cash (the seat_or_cash rule of
--                                              20261012054804), or back to the
--                                              issuer if the holder has left the
--                                              club. No repair job: this is the
--                                              live path at the moment the ticket
--                                              stops being usable (CLAUDE.md 10.12).
--
-- Every value moves through the existing journaled convention: a
-- club_members.chip_balance write under app.ledger_category / counterparty
-- 'escrow' / the ticket id, exactly as fn_redeem_tournament_ticket and
-- fn_cancel_tournament_ticket do, with one receipt per ticket so
-- fn_ca_settlement_correctness_check reads it as it reads every other ticket.
--
-- The binding table carries no foreign key: tournaments is a hot table and a
-- foreign key would lock it (CLAUDE.md 2, rule 7). The issue door writes the
-- binding and the ticket in one transaction, and the binding is immutable.
--
-- Single transaction, lock_timeout set, every replaced body asserted against
-- the production md5 read on 2026-10-15 13:20 UTC.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $preimage$
DECLARE
  v_expect constant text[][] := ARRAY[
    ['public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)','0252faecc9c3e8dd506ccd00061243cb'],
    ['public.fn_redeem_tournament_ticket(uuid)','ab95c0907acccdedef0190acf242c8a3'],
    ['public.fn_find_tournament_entry_ticket(uuid)','a3a4c6317ae5510dc9b3e89bd48d9457'],
    ['public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)','086a533791e61600bb6ba3d58973a3b8'],
    ['public.fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean)','d9a34831bf01f85933a6c79f3662be33'],
    ['public.fn_horse_tournament_entry_ticket_hints(uuid)','670bdb77de7e7039ceed5c70c4e7ccbc'],
    ['public.trg_ca_closed_target_pays_its_satellite_tickets()','3fc780f946b5c9edb1d4513002693698'],
    -- Not replaced, but this migration relies on their exact behaviour.
    ['public.fn_issue_tournament_ticket_phase2_core_20260831(uuid,uuid,numeric,text,text)','267995c5bd9d6231c8506625c1bf3d73'],
    ['public.fn_cancel_tournament_ticket(uuid)','d3f65b7702d4b7f543891dd87c149353'],
    ['public.fn_tournament_entry_split(numeric,numeric,numeric,boolean)','89cc73d13fe8fbe6905233c8f9f74848'],
    ['public.fn_ca_satellite_ticket_target_is_closed(uuid)','70ec2081ea936a03caa244d46ecd10ff'],
    ['public.fn_register_for_tournament_before_terminal_seat_gate(uuid,boolean)','e65fe889128c1ce4306b1236cb44484a'],
    ['public.fn_register_horse_for_tournament_before_atomic_lifecycle_gate(uuid,uuid)','3717c2b05d58d51049181530338bf1e9']];
  v_actual text;
  i int;
BEGIN
  IF EXISTS (SELECT FROM supabase_migrations.schema_migrations
              WHERE version = '20261015132042') THEN
    RAISE EXCEPTION 'CASHIER_ENTRY_TICKET_HISTORY_REPLAY';
  END IF;
  IF to_regclass('public.tournament_ticket_entry_targets') IS NOT NULL THEN
    RAISE EXCEPTION 'CASHIER_ENTRY_TICKET_TABLE_ALREADY_EXISTS';
  END IF;
  FOR i IN 1 .. array_length(v_expect,1) LOOP
    SELECT md5(pg_get_functiondef(to_regprocedure(v_expect[i][1]))) INTO v_actual;
    IF v_actual IS DISTINCT FROM v_expect[i][2] THEN
      RAISE EXCEPTION 'CASHIER_ENTRY_TICKET_PREIMAGE_CHANGED: % is %',
        v_expect[i][1], v_actual;
    END IF;
  END LOOP;
END
$preimage$;

-- The CREATE FUNCTION event guard requires every money writer to be registered
-- before it exists, in this same transaction.
INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES
 ('fn_issue_tournament_entry_ticket','approved',
  'Cashier Send Ticket into one tournament: prices from fn_tournament_entry_split of the tournament, escrows exactly that from the sender player wallet through fn_issue_tournament_ticket_phase2_core_20260831 (same authority, downline, journal and receipt), binds the ticket in tournament_ticket_entry_targets; idempotent on the retry key.'),
 ('fn_ca_use_cashier_entry_ticket','approved',
  'Enters the holder of a bound cashier ticket: releases the ticket escrow to the holder wallet in the ticket club (ticket_redeem journal, one tournament_ticket_redeem receipt) and enters through the ordinary wallet registration door of a person or a horse in the same transaction; the wallet must net to zero exactly or everything rolls back. Browser execution revoked.'),
 ('fn_ca_settle_closed_cashier_entry_tickets','approved',
  'When the bound tournament closes unused, pays each issued cashier entry ticket to its holder in the ticket club (ticket_redeem) or, if the holder left, back to the issuer (escrow_release); one receipt per ticket; runs inside the closing transaction. Browser execution revoked.')
ON CONFLICT (proname) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The binding
-- ---------------------------------------------------------------------------
CREATE TABLE public.tournament_ticket_entry_targets (
  ticket_id       uuid PRIMARY KEY,
  tournament_id   uuid NOT NULL,
  club_id         uuid NOT NULL,
  issued_by       uuid NOT NULL,
  holder_id       uuid NOT NULL,
  value           numeric(15,2) NOT NULL CHECK (value > 0),
  entry_prize     numeric(15,2) NOT NULL CHECK (entry_prize >= 0),
  entry_bounty    numeric(15,2) NOT NULL CHECK (entry_bounty >= 0),
  entry_fee       numeric(15,2) NOT NULL CHECK (entry_fee >= 0),
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournament_ticket_entry_targets_price_is_the_split
    CHECK (value = round(entry_prize + entry_bounty + entry_fee, 2)),
  CONSTRAINT tournament_ticket_entry_targets_holder_is_not_issuer
    CHECK (holder_id <> issued_by)
);
COMMENT ON TABLE public.tournament_ticket_entry_targets IS
  'Binds a cashier-sent tournament_tickets row to the ONE tournament it enters. Written only by fn_issue_tournament_entry_ticket in the same transaction as the ticket; immutable. No foreign keys by design: tournaments is hot (CLAUDE.md 2 rule 7). 20261015132042.';
CREATE INDEX tournament_ticket_entry_targets_by_tournament
  ON public.tournament_ticket_entry_targets (tournament_id);
CREATE INDEX tournament_ticket_entry_targets_by_holder
  ON public.tournament_ticket_entry_targets (holder_id, tournament_id);

ALTER TABLE public.tournament_ticket_entry_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_ticket_entry_targets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tournament_ticket_entry_targets TO authenticated;
GRANT ALL ON public.tournament_ticket_entry_targets TO service_role;
-- Same readers as cashier_tournament_tickets_read on tournament_tickets.
CREATE POLICY cashier_tournament_ticket_entry_targets_read
  ON public.tournament_ticket_entry_targets FOR SELECT TO authenticated
  USING (issued_by = (SELECT auth.uid())
         OR holder_id = (SELECT auth.uid())
         OR public.fn_club_cashier_scope(club_id,(SELECT auth.uid())) = 'all');

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_ticket_entry_target_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'a cashier ticket''s tournament binding is immutable'
    USING ERRCODE = '55000';
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_ticket_entry_target_is_immutable()
  FROM PUBLIC, anon, authenticated;
CREATE TRIGGER tournament_ticket_entry_targets_are_immutable
  BEFORE UPDATE OR DELETE ON public.tournament_ticket_entry_targets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_ticket_entry_target_is_immutable();

-- ---------------------------------------------------------------------------
-- Can this tournament still take an entry, and at what price?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_cashier_ticket_target_state(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_is_bounty boolean;
  v_late boolean := false;
  v_entries integer;
BEGIN
  /* The same gates the ticket and wallet entry doors apply, read without
     taking any lock of their own: open for entry (ANNOUNCED or REGISTERING,
     or RUNNING inside late registration), pool not finalized, not full, not a
     seat-first format, not a Diamond event, and a finite nonzero price. */
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF public.fn_poker_diamond_tournament(v_t.id) THEN
    RETURN jsonb_build_object('ok',false,'reason','diamond_tournament');
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF v_t.status = 'RUNNING' THEN
    v_late := public.fn_tournament_late_registration_open(v_t.id);
    IF NOT v_late THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_closed');
    END IF;
  ELSIF v_t.status NOT IN ('ANNOUNCED','REGISTERING') THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF lower(COALESCE(v_t.variant,'')) = 'spin'
     OR (v_t.max_players IS NOT NULL AND v_t.max_players > 0
         AND v_t.max_players <= 2) THEN
    IF NOT public.fn_ca_tournament_is_unlimited(v_t.id) THEN
      RETURN jsonb_build_object('ok',false,'reason','seat_first_variant');
    END IF;
  END IF;
  IF v_t.max_players IS NOT NULL AND v_t.max_players > 0 THEN
    SELECT count(*) INTO v_entries FROM public.tournament_players tp
     WHERE tp.tournament_id = v_t.id;
    IF GREATEST(COALESCE(v_t.current_players,0), v_entries) >= v_t.max_players
       AND NOT public.fn_ca_tournament_is_unlimited(v_t.id) THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_full');
    END IF;
  END IF;
  v_is_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize < 0 OR v_split.bounty < 0 OR v_split.rake < 0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize + v_split.bounty + v_split.rake, 2) THEN
    RETURN jsonb_build_object('ok',false,'reason','no_finite_ticket_contract');
  END IF;
  IF v_split.charge <= 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','free_tournament');
  END IF;
  IF v_split.charge > 1e9 OR v_split.charge <> round(v_split.charge,2) THEN
    RETURN jsonb_build_object('ok',false,'reason','no_finite_ticket_contract');
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'tournament_id',v_t.id,'name',v_t.name,
    'start_time',v_t.start_time,'status',v_t.status,
    'late_registration',v_late,
    'price',v_split.charge,'entry_prize',v_split.prize,
    'entry_bounty',v_split.bounty,'entry_fee',v_split.rake,
    'club_id',v_t.club_id,'union_id',v_t.union_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_cashier_ticket_target_state(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_cashier_ticket_target_in_club(
  p_tournament_id uuid, p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  /* The scope the ticket finder already uses: the club's own event, or an
     event of a union this club belongs to (the host club of a union event is
     in its own union without a union_clubs row). */
  SELECT COALESCE((
    SELECT (t.union_id IS NULL AND t.club_id = p_club_id)
        OR (t.union_id IS NOT NULL
            AND (t.club_id = p_club_id OR EXISTS (
                  SELECT 1 FROM public.union_clubs uc
                   WHERE uc.union_id = t.union_id AND uc.club_id = p_club_id)))
      FROM public.tournaments t WHERE t.id = p_tournament_id), false);
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_cashier_ticket_target_in_club(uuid,uuid)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. The drop-down
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cashier_ticketable_tournaments(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_role text;
  v_id uuid;
  v_state jsonb;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Not Authenticated');
  END IF;
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Choose A Club');
  END IF;
  -- The same roles fn_issue_tournament_ticket_phase2_core_20260831 lets issue.
  SELECT role INTO v_role FROM public.club_members
   WHERE club_id = p_club_id AND user_id = v_me
     AND COALESCE(status,'active') IN ('active','approved');
  IF v_role IS NULL OR v_role NOT IN
       ('owner','co_owner','admin','super_agent','agent','sub_agent') THEN
    RETURN jsonb_build_object('success',false,'error','Your Role Cannot Issue Tickets');
  END IF;

  FOR v_id IN
    SELECT t.id FROM public.tournaments t
     WHERE t.status IN ('ANNOUNCED','REGISTERING','RUNNING')
       AND NOT COALESCE(t.prize_pool_finalized,false)
       AND public.fn_ca_cashier_ticket_target_in_club(t.id, p_club_id)
     ORDER BY t.start_time NULLS LAST, t.id
     LIMIT 500
  LOOP
    v_state := public.fn_ca_cashier_ticket_target_state(v_id);
    IF COALESCE((v_state->>'ok')::boolean,false) THEN
      v_rows := v_rows || jsonb_build_array(
        (v_state - 'ok' - 'club_id' - 'union_id')
        || jsonb_build_object(
             'is_union_event',(v_state->>'union_id') IS NOT NULL,
             'current_players',(SELECT t.current_players FROM public.tournaments t WHERE t.id=v_id),
             'max_players',(SELECT t.max_players FROM public.tournaments t WHERE t.id=v_id)));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success',true,'club_id',p_club_id,
    'tournaments',v_rows,'count',jsonb_array_length(v_rows));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cashier_ticketable_tournaments(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cashier_ticketable_tournaments(uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The money door
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_issue_tournament_entry_ticket(
  p_club_id uuid, p_holder_id uuid, p_tournament_id uuid,
  p_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text,
  p_expected_price numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_key text := nullif(btrim(coalesce(p_idempotency_key,'')),'');
  v_note text := nullif(btrim(coalesce(p_note,'')),'');
  v_bind public.tournament_ticket_entry_targets%ROWTYPE;
  v_state jsonb;
  v_price numeric;
  v_name text;
  v_ticket_note text;
  v_result jsonb;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_ticket_id uuid;
  v_balance numeric;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Not Authenticated');
  END IF;
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Ticket');
  END IF;
  IF p_club_id IS NULL OR p_holder_id IS NULL OR p_holder_id = v_me THEN
    RETURN jsonb_build_object('success',false,'error','Choose Another Active Member');
  END IF;
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Choose A Tournament');
  END IF;

  -- The core's own lock order: club hierarchy, then the retry key.
  PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ticket:'||v_key,0));

  -- A replay returns the original, whatever the tournament's price is now.
  SELECT * INTO v_bind FROM public.tournament_ticket_entry_targets b
   WHERE b.idempotency_key = v_key;
  IF v_bind.ticket_id IS NOT NULL THEN
    IF v_bind.club_id IS DISTINCT FROM p_club_id
       OR v_bind.issued_by IS DISTINCT FROM v_me
       OR v_bind.holder_id IS DISTINCT FROM p_holder_id
       OR v_bind.tournament_id IS DISTINCT FROM p_tournament_id THEN
      RETURN jsonb_build_object('success',false,'error','That Retry Key Belongs To A Different Ticket');
    END IF;
    SELECT (ct.metadata->>'issuer_balance_after')::numeric INTO v_balance
      FROM public.chip_transactions ct
     WHERE ct.metadata->>'idempotency_key' = v_key
       AND ct.transaction_type = 'tournament_ticket_issue'
     LIMIT 1;
    RETURN jsonb_build_object('success',true,'replayed',true,
      'ticket_id',v_bind.ticket_id,'your_balance',v_balance,
      'tournament_id',v_bind.tournament_id,
      'tournament_name',(SELECT t.name FROM public.tournaments t WHERE t.id=v_bind.tournament_id),
      'price',v_bind.value,'entry_prize',v_bind.entry_prize,
      'entry_bounty',v_bind.entry_bounty,'entry_fee',v_bind.entry_fee);
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_transactions ct
              WHERE ct.metadata->>'idempotency_key' = v_key) THEN
    RETURN jsonb_build_object('success',false,'error','That Retry Key Is Already In Use');
  END IF;

  -- One unused ticket per player per tournament, decided under one lock so
  -- two cashiers cannot both send it.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'cashier-entry-ticket:'||p_tournament_id::text||':'||p_holder_id::text,0));

  /* Hold the tournament row still between reading its state and writing the
     binding, so a target that closes concurrently either closes first (and
     this door refuses) or closes after this commits (and its own closing
     transaction pays this ticket). A share lock for a few milliseconds. */
  PERFORM 1 FROM public.tournaments t WHERE t.id = p_tournament_id FOR SHARE;
  v_state := public.fn_ca_cashier_ticket_target_state(p_tournament_id);
  IF NOT COALESCE((v_state->>'ok')::boolean,false) THEN
    RETURN jsonb_build_object('success',false,'error',
      CASE v_state->>'reason'
        WHEN 'tournament_not_found' THEN 'Tournament Not Found'
        WHEN 'registration_closed' THEN 'Registration For That Tournament Is Closed'
        WHEN 'tournament_full' THEN 'That Tournament Is Full'
        WHEN 'seat_first_variant' THEN 'That Format Is Entered By Taking A Seat, Not By Ticket'
        WHEN 'free_tournament' THEN 'That Tournament Is Free To Enter'
        WHEN 'diamond_tournament' THEN 'Diamond Tournaments Do Not Take Chip Tickets'
        ELSE 'That Tournament Cannot Take A Ticket' END,
      'reason',v_state->>'reason');
  END IF;
  v_price := (v_state->>'price')::numeric;
  v_name := v_state->>'name';
  IF p_expected_price IS NOT NULL AND p_expected_price IS DISTINCT FROM v_price THEN
    RETURN jsonb_build_object('success',false,
      'error','The Ticket Price Changed, Review It And Send Again',
      'reason','price_changed','price',v_price);
  END IF;
  IF NOT public.fn_ca_cashier_ticket_target_in_club(p_tournament_id, p_club_id)
     OR public.fn_tournament_club_for_user(p_holder_id, p_tournament_id, p_club_id)
          IS DISTINCT FROM p_club_id THEN
    RETURN jsonb_build_object('success',false,
      'error','That Tournament Is Not Open To This Club','reason','not_visible_to_club');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id AND tp.user_id = p_holder_id) THEN
    RETURN jsonb_build_object('success',false,
      'error','That Player Is Already Registered For That Tournament','reason','already_registered');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_ticket_entry_targets b
               JOIN public.tournament_tickets tk ON tk.id = b.ticket_id
              WHERE b.tournament_id = p_tournament_id AND b.holder_id = p_holder_id
                AND tk.status = 'issued') THEN
    RETURN jsonb_build_object('success',false,
      'error','That Player Already Holds A Ticket For That Tournament','reason','already_holds_ticket');
  END IF;

  v_ticket_note := left('Entry Ticket: ' || COALESCE(NULLIF(btrim(v_name),''),'Tournament')
                        || COALESCE(' (' || v_note || ')',''), 300);

  -- The existing door: same authority and downline checks, same journal, same
  -- escrow, same receipt. It refuses with success=false and moves nothing.
  v_result := public.fn_issue_tournament_ticket_phase2_core_20260831(
    p_club_id, p_holder_id, v_price, v_ticket_note, v_key);
  IF NOT COALESCE((v_result->>'success')::boolean,false) THEN
    RETURN v_result;
  END IF;
  IF COALESCE((v_result->>'replayed')::boolean,false) THEN
    RAISE EXCEPTION 'cashier entry ticket key % replayed without a binding', v_key
      USING ERRCODE = 'P0404';
  END IF;
  v_ticket_id := (v_result->>'ticket_id')::uuid;
  SELECT * INTO v_ticket FROM public.tournament_tickets tk WHERE tk.id = v_ticket_id;
  IF v_ticket.id IS NULL OR v_ticket.status IS DISTINCT FROM 'issued'
     OR v_ticket.redemption_mode IS DISTINCT FROM 'wallet_chips'
     OR v_ticket.club_id IS DISTINCT FROM p_club_id
     OR v_ticket.issued_by IS DISTINCT FROM v_me
     OR v_ticket.holder_id IS DISTINCT FROM p_holder_id
     OR v_ticket.value IS DISTINCT FROM v_price THEN
    RAISE EXCEPTION 'cashier entry ticket % was not escrowed exactly', v_ticket_id
      USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_ticket_entry_targets(
    ticket_id, tournament_id, club_id, issued_by, holder_id, value,
    entry_prize, entry_bounty, entry_fee, idempotency_key)
  VALUES (
    v_ticket_id, p_tournament_id, p_club_id, v_me, p_holder_id, v_price,
    (v_state->>'entry_prize')::numeric, (v_state->>'entry_bounty')::numeric,
    (v_state->>'entry_fee')::numeric, v_key);

  RETURN v_result || jsonb_build_object(
    'tournament_id',p_tournament_id,'tournament_name',v_name,
    'start_time',v_state->'start_time','price',v_price,
    'entry_prize',(v_state->>'entry_prize')::numeric,
    'entry_bounty',(v_state->>'entry_bounty')::numeric,
    'entry_fee',(v_state->>'entry_fee')::numeric);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_issue_tournament_entry_ticket(uuid,uuid,uuid,text,text,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_issue_tournament_entry_ticket(uuid,uuid,uuid,text,text,numeric)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The finder for a bound ticket
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_find_cashier_entry_ticket_for(
  p_tournament_id uuid, p_beneficiary_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_is_bounty boolean;
  v_tk public.tournament_tickets%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_beneficiary_id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;
  v_is_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);
  /* Exact contract only. If the tournament's price moved after the ticket was
     sent, the ticket does not match, the player enters from their wallet like
     anyone else, and the ticket is paid out when the tournament closes. */
  SELECT tk.* INTO v_tk
    FROM public.tournament_ticket_entry_targets b
    JOIN public.tournament_tickets tk ON tk.id = b.ticket_id
   WHERE b.tournament_id = p_tournament_id
     AND b.holder_id = p_beneficiary_id
     AND tk.holder_id = p_beneficiary_id
     AND tk.status = 'issued'
     AND tk.redemption_mode = 'wallet_chips'
     AND tk.club_id = b.club_id AND tk.issued_by = b.issued_by
     AND tk.value = b.value
     AND b.value = v_split.charge
     AND b.entry_prize = v_split.prize
     AND b.entry_bounty = v_split.bounty
     AND b.entry_fee = v_split.rake
     AND EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = tk.club_id AND m.user_id = p_beneficiary_id
                    AND COALESCE(m.status,'active') IN ('active','approved'))
     AND public.fn_tournament_club_for_user(
           p_beneficiary_id, p_tournament_id, tk.club_id) IS NOT DISTINCT FROM tk.club_id
   ORDER BY tk.created_at, tk.id
   LIMIT 1;
  IF v_tk.id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'ticket_id',v_tk.id,'ticket_value',v_tk.value,
    'entry_prize',v_split.prize,'entry_bounty',v_split.bounty,
    'entry_fee',v_split.rake,'source_satellite_id',NULL,
    'ticket_kind','cashier_entry_ticket');
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_find_cashier_entry_ticket_for(uuid,uuid)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The entry
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_use_cashier_entry_ticket(
  p_tournament_id uuid, p_ticket_id uuid, p_beneficiary_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_tk public.tournament_tickets%ROWTYPE;
  v_bind public.tournament_ticket_entry_targets%ROWTYPE;
  v_split record;
  v_is_bounty boolean;
  v_is_horse boolean;
  v_before numeric;
  v_after_credit numeric;
  v_after numeric;
  v_context jsonb;
  v_setting text;
  v_prev_paying text := current_setting('app.ca_entry_paying_club', true);
  v_result jsonb;
  v_reason text;
  v_registration uuid;
  v_receipt uuid;
BEGIN
  IF p_tournament_id IS NULL OR p_ticket_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament, ticket and beneficiary ids are required'
      USING ERRCODE = '22004';
  END IF;

  -- The satellite ticket door's lock order: settlement lane, the shared
  -- admission lock, the admission contract, the tournament, then the ticket.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_tk FROM public.tournament_tickets tk WHERE tk.id = p_ticket_id FOR UPDATE;
  IF v_tk.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_found');
  END IF;
  SELECT * INTO v_bind FROM public.tournament_ticket_entry_targets b
   WHERE b.ticket_id = v_tk.id;
  IF v_bind.ticket_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','not_a_cashier_entry_ticket');
  END IF;
  IF v_tk.holder_id IS DISTINCT FROM v_uid OR v_bind.holder_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_owned');
  END IF;
  IF v_bind.tournament_id IS DISTINCT FROM p_tournament_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_for_another_tournament');
  END IF;
  IF v_tk.redemption_mode IS DISTINCT FROM 'wallet_chips'
     OR v_tk.club_id IS DISTINCT FROM v_bind.club_id
     OR v_tk.issued_by IS DISTINCT FROM v_bind.issued_by
     OR v_tk.value IS DISTINCT FROM v_bind.value THEN
    RAISE EXCEPTION 'cashier entry ticket % does not match its binding', v_tk.id
      USING ERRCODE = 'P0404';
  END IF;

  IF v_tk.status = 'redeemed' THEN
    -- An ambiguous-response retry: the entry already happened.
    SELECT ct.id INTO v_receipt FROM public.chip_transactions ct
     WHERE ct.transaction_type = 'tournament_ticket_redeem'
       AND ct.metadata->>'ticket_id' = v_tk.id::text
       AND ct.metadata->>'reason' = 'tournament_entry'
     LIMIT 1;
    SELECT tp.id INTO v_registration FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.user_id = v_uid
     ORDER BY tp.registered_at DESC NULLS LAST LIMIT 1;
    IF v_receipt IS NOT NULL AND v_registration IS NOT NULL THEN
      RETURN jsonb_build_object('ok',true,'replayed',true,'ticket_id',v_tk.id,
        'registration_id',v_registration,'ticket_value',v_tk.value,
        'wallet_chips_credited',0);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','ticket_already_used');
  END IF;
  IF v_tk.status <> 'issued' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_available');
  END IF;

  v_is_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);
  IF v_split.charge IS DISTINCT FROM v_bind.value
     OR v_split.prize IS DISTINCT FROM v_bind.entry_prize
     OR v_split.bounty IS DISTINCT FROM v_bind.entry_bounty
     OR v_split.rake IS DISTINCT FROM v_bind.entry_fee THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_entry_contract_mismatch');
  END IF;
  IF public.fn_tournament_club_for_user(v_uid, p_tournament_id, v_tk.club_id)
       IS DISTINCT FROM v_tk.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_source_club_unavailable');
  END IF;

  SELECT COALESCE(p.is_horse,false) INTO v_is_horse FROM public.profiles p WHERE p.id = v_uid;
  v_is_horse := COALESCE(v_is_horse,false);
  IF NOT v_is_horse AND auth.uid() IS DISTINCT FROM v_uid THEN
    -- A person is entered only by their own session; a horse has no browser
    -- and is entered by the engine (CLAUDE.md 10.5, the input device).
    RAISE EXCEPTION 'a cashier entry ticket is used by its own holder'
      USING ERRCODE = '42501';
  END IF;

  SELECT m.chip_balance INTO v_before FROM public.club_members m
   WHERE m.club_id = v_tk.club_id AND m.user_id = v_uid
     AND COALESCE(m.status,'active') IN ('active','approved')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_membership_inactive');
  END IF;
  v_before := COALESCE(v_before,0);

  BEGIN
    -- (a) Escrow -> the holder's wallet in the ticket's club, journaled and
    --     receipted exactly as fn_redeem_tournament_ticket does it.
    SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),'')) INTO v_context
      FROM unnest(ARRAY['app.ledger_category','app.ledger_counterparty',
                        'app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
    PERFORM set_config('app.ledger_tournament','',true);
    PERFORM set_config('app.ledger_category','ticket_redeem',true);
    PERFORM set_config('app.ledger_counterparty','escrow',true);
    PERFORM set_config('app.ledger_counterparty_entity',v_tk.id::text,true);
    UPDATE public.club_members
       SET chip_balance = COALESCE(chip_balance,0) + v_tk.value, updated_at = now()
     WHERE club_id = v_tk.club_id AND user_id = v_uid
       AND COALESCE(status,'active') IN ('active','approved')
     RETURNING chip_balance INTO v_after_credit;
    FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
      PERFORM set_config(v_setting,v_context->>v_setting,true);
    END LOOP;
    IF v_after_credit IS DISTINCT FROM round(v_before + v_tk.value,2) THEN
      RAISE EXCEPTION 'cashier entry ticket % credit did not land exactly', v_tk.id
        USING ERRCODE = 'P0404';
    END IF;
    UPDATE public.tournament_tickets
       SET status = 'redeemed', redeemed_at = now()
     WHERE id = v_tk.id AND status = 'issued';
    INSERT INTO public.chip_transactions(
      club_id,from_user_id,to_user_id,amount,transaction_type,notes,
      balance_after,metadata)
    VALUES(
      v_tk.club_id,NULL,v_uid,v_tk.value,'tournament_ticket_redeem',
      'Tournament Ticket Used For Entry',v_after_credit,
      jsonb_build_object(
        'ticket_id',v_tk.id,'issuer_id',v_tk.issued_by,'holder_id',v_uid,
        'escrow_action','release_to_holder','reason','tournament_entry',
        'target_tournament_id',p_tournament_id,
        'holder_balance_after',v_after_credit))
    RETURNING id INTO v_receipt;
    INSERT INTO public.wallet_transactions(
      user_id,wallet_type,type,amount,category,description,balance_after)
    VALUES(
      v_uid,'PLAYER','credit',v_tk.value,'transfer',
      'Tournament Ticket Used For Entry',v_after_credit);

    -- (b) The ordinary entry door, paid from that same wallet.
    PERFORM set_config('app.ca_entry_paying_club',
      p_tournament_id::text||':'||v_uid::text||':'||v_tk.club_id::text, true);
    IF v_is_horse THEN
      v_result := public.fn_register_horse_for_tournament_before_atomic_lifecycle_gate(
        p_tournament_id, v_uid);
    ELSE
      v_result := public.fn_register_for_tournament_before_terminal_seat_gate(
        p_tournament_id, false);
    END IF;
    PERFORM set_config('app.ca_entry_paying_club', COALESCE(v_prev_paying,''), true);
    IF NOT COALESCE((v_result->>'ok')::boolean,false) THEN
      RAISE EXCEPTION USING ERRCODE = 'CT001',
        MESSAGE = COALESCE(NULLIF(v_result->>'reason',''),'registration_refused');
    END IF;

    -- (c) The wallet nets to zero exactly, in the ticket's club, or nothing
    --     happened.
    SELECT m.chip_balance INTO v_after FROM public.club_members m
     WHERE m.club_id = v_tk.club_id AND m.user_id = v_uid;
    SELECT tp.id INTO v_registration FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.user_id = v_uid
       AND tp.id = (v_result->>'registration_id')::uuid;
    IF v_after IS DISTINCT FROM v_before OR v_registration IS NULL
       OR (v_result->>'cost')::numeric IS DISTINCT FROM v_tk.value THEN
      RAISE EXCEPTION 'cashier entry ticket % entry was not paid exactly from its own credit (% -> %)',
        v_tk.id, v_before, v_after USING ERRCODE = 'P0404';
    END IF;
  EXCEPTION WHEN SQLSTATE 'CT001' THEN
    v_reason := SQLERRM;
    PERFORM set_config('app.ca_entry_paying_club', COALESCE(v_prev_paying,''), true);
    RETURN jsonb_build_object('ok',false,'reason',v_reason,'ticket_id',v_tk.id);
  END;

  RETURN v_result || jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_tk.id,
    'registration_id',v_registration,'ticket_value',v_tk.value,
    'ticket_kind','cashier_entry_ticket','redeem_transaction_id',v_receipt,
    'wallet_chips_credited',0);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_use_cashier_entry_ticket(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. A tournament that closes before the ticket is used
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_settle_closed_cashier_entry_tickets(
  p_target_id uuid, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bind public.tournament_ticket_entry_targets%ROWTYPE;
  v_tk public.tournament_tickets%ROWTYPE;
  v_context jsonb;
  v_setting text;
  v_after numeric;
  v_paid integer := 0;
  v_returned integer := 0;
  v_amount numeric := 0;
  v_unpaid jsonb := '[]'::jsonb;
BEGIN
  /* A cashier entry ticket admits its holder to ONE tournament, only while it
     still takes entries. In the transaction that finalizes, finishes or
     cancels it, every still-unused ticket for it is settled here, once: to the
     holder's wallet in the ticket's club (seat_or_cash, as a satellite seat
     whose target closed, 20261012054804), or, if the holder is no longer an
     active member, back to the issuer exactly as fn_cancel_tournament_ticket
     would. A ticket neither can receive is named on a critical alert and
     stays escrowed for the issuer to cancel. Horses are paid exactly so. */
  IF p_target_id IS NULL
     OR NOT public.fn_ca_satellite_ticket_target_is_closed(p_target_id) THEN
    RETURN jsonb_build_object('ok',true,'paid',0,'returned',0,'amount',0);
  END IF;
  FOR v_bind IN
    SELECT b.* FROM public.tournament_ticket_entry_targets b
      JOIN public.tournament_tickets tk ON tk.id = b.ticket_id
     WHERE b.tournament_id = p_target_id AND tk.status = 'issued'
     ORDER BY b.ticket_id
  LOOP
    BEGIN
      SELECT * INTO v_tk FROM public.tournament_tickets tk
       WHERE tk.id = v_bind.ticket_id FOR UPDATE;
      IF v_tk.status IS DISTINCT FROM 'issued' THEN
        CONTINUE;
      END IF;
      SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),'')) INTO v_context
        FROM unnest(ARRAY['app.ledger_category','app.ledger_counterparty',
                          'app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
      PERFORM set_config('app.ledger_tournament','',true);
      PERFORM set_config('app.ledger_counterparty','escrow',true);
      PERFORM set_config('app.ledger_counterparty_entity',v_tk.id::text,true);

      PERFORM set_config('app.ledger_category','ticket_redeem',true);
      v_after := NULL;
      UPDATE public.club_members
         SET chip_balance = COALESCE(chip_balance,0) + v_tk.value, updated_at = now()
       WHERE club_id = v_tk.club_id AND user_id = v_tk.holder_id
         AND COALESCE(status,'active') IN ('active','approved')
       RETURNING chip_balance INTO v_after;
      IF v_after IS NOT NULL THEN
        FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
          PERFORM set_config(v_setting,v_context->>v_setting,true);
        END LOOP;
        UPDATE public.tournament_tickets
           SET status = 'redeemed', redeemed_at = now()
         WHERE id = v_tk.id AND status = 'issued';
        INSERT INTO public.chip_transactions(
          club_id,from_user_id,to_user_id,amount,transaction_type,notes,
          balance_after,metadata)
        VALUES(
          v_tk.club_id,NULL,v_tk.holder_id,v_tk.value,'tournament_ticket_redeem',
          'Tournament Ticket Paid In Cash: Entry Closed',v_after,
          jsonb_build_object(
            'ticket_id',v_tk.id,'issuer_id',v_tk.issued_by,'holder_id',v_tk.holder_id,
            'escrow_action','release_to_holder','reason','target_entry_closed',
            'target_tournament_id',p_target_id,'source',p_source,
            'holder_balance_after',v_after));
        INSERT INTO public.wallet_transactions(
          user_id,wallet_type,type,amount,category,description,balance_after)
        VALUES(
          v_tk.holder_id,'PLAYER','credit',v_tk.value,'transfer',
          'Tournament Ticket Paid In Cash: Entry Closed',v_after);
        v_paid := v_paid + 1;
        v_amount := round(v_amount + v_tk.value,2);
        CONTINUE;
      END IF;

      PERFORM set_config('app.ledger_category','escrow_release',true);
      UPDATE public.club_members
         SET chip_balance = COALESCE(chip_balance,0) + v_tk.value, updated_at = now()
       WHERE club_id = v_tk.club_id AND user_id = v_tk.issued_by
         AND COALESCE(status,'active') IN ('active','approved')
       RETURNING chip_balance INTO v_after;
      FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
        PERFORM set_config(v_setting,v_context->>v_setting,true);
      END LOOP;
      IF v_after IS NULL THEN
        v_unpaid := v_unpaid || jsonb_build_array(jsonb_build_object(
          'ticket_id',v_tk.id,'reason','holder_and_issuer_not_active'));
        INSERT INTO public.financial_alerts(severity,source,message,context)
        VALUES('critical','fn_ca_settle_closed_cashier_entry_tickets',
          'A Cashier Tournament Ticket For A Closed Tournament Has No Active Holder Or Issuer',
          jsonb_build_object('target_id',p_target_id,'ticket_id',v_tk.id,
            'holder_id',v_tk.holder_id,'issuer_id',v_tk.issued_by,'value',v_tk.value));
        CONTINUE;
      END IF;
      UPDATE public.tournament_tickets
         SET status = 'cancelled', cancelled_at = now()
       WHERE id = v_tk.id AND status = 'issued';
      INSERT INTO public.chip_transactions(
        club_id,from_user_id,to_user_id,amount,transaction_type,notes,
        balance_after,metadata)
      VALUES(
        v_tk.club_id,NULL,v_tk.issued_by,v_tk.value,'tournament_ticket_cancel',
        'Tournament Ticket Returned: Entry Closed',v_after,
        jsonb_build_object(
          'ticket_id',v_tk.id,'issuer_id',v_tk.issued_by,'holder_id',v_tk.holder_id,
          'escrow_action','refund_to_issuer','reason','target_entry_closed_holder_left',
          'target_tournament_id',p_target_id,'source',p_source,
          'issuer_balance_after',v_after));
      v_returned := v_returned + 1;
      v_amount := round(v_amount + v_tk.value,2);
    EXCEPTION WHEN OTHERS THEN
      v_unpaid := v_unpaid || jsonb_build_array(jsonb_build_object(
        'ticket_id',v_bind.ticket_id,'reason','refused',
        'sqlstate',SQLSTATE,'message',SQLERRM));
      INSERT INTO public.financial_alerts(severity,source,message,context)
      VALUES('critical','fn_ca_settle_closed_cashier_entry_tickets',
        'A Cashier Tournament Ticket For A Closed Tournament Could Not Be Settled',
        jsonb_build_object('target_id',p_target_id,'ticket_id',v_bind.ticket_id,
          'sqlstate',SQLSTATE,'message',SQLERRM));
    END;
  END LOOP;
  RETURN jsonb_build_object('ok',jsonb_array_length(v_unpaid)=0,
    'paid',v_paid,'returned',v_returned,'amount',v_amount,'unpaid',v_unpaid);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_settle_closed_cashier_entry_tickets(uuid,text)
  FROM PUBLIC, anon, authenticated;

-- The closing transaction's existing trigger function now settles both kinds.
CREATE OR REPLACE FUNCTION public.trg_ca_closed_target_pays_its_satellite_tickets()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.fn_ca_pay_closed_target_tickets_in_cash(
    NEW.id,'target_entry_closed');
  -- 20261015132042: a cashier ticket bound to this tournament and never used.
  PERFORM public.fn_ca_settle_closed_cashier_entry_tickets(
    NEW.id,'target_entry_closed');
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. The existing doors learn the bound ticket
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_find_tournament_entry_ticket(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid:=auth.uid();
  v_found jsonb;
  v_cashier jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION
      'fn_find_tournament_entry_ticket requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  v_found := public.fn_ca_find_tournament_entry_ticket_for(
    p_tournament_id,v_uid);
  -- A satellite ticket, or a refusal, keeps precedence. Otherwise a cashier
  -- ticket bound to this tournament (20261015132042) is offered.
  IF COALESCE((v_found->>'ok')::boolean,false)
     AND v_found->>'ticket_id' IS NULL THEN
    v_cashier := public.fn_ca_find_cashier_entry_ticket_for(p_tournament_id,v_uid);
    IF v_cashier->>'ticket_id' IS NOT NULL THEN
      RETURN v_cashier;
    END IF;
  END IF;
  RETURN v_found;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_with_ticket_before_terminal_gate(p_tournament_id uuid, p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION
      'fn_register_for_tournament_with_ticket requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  -- 20261015132042: a cashier ticket bound to one tournament enters through
  -- its own door; every other ticket keeps the satellite admission core.
  IF EXISTS (SELECT 1 FROM public.tournament_ticket_entry_targets b
              WHERE b.ticket_id=p_ticket_id) THEN
    RETURN public.fn_ca_use_cashier_entry_ticket(
      p_tournament_id,p_ticket_id,v_uid);
  END IF;
  RETURN public.fn_ca_register_for_tournament_with_ticket_for(
    p_tournament_id,p_ticket_id,v_uid);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament_before_terminal_gate(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_is_horse boolean;
  v_ticket_lookup jsonb;
  v_ticket_id uuid;
  v_ticket_registration_count integer:=0;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_allow_wallet_charge IS NULL THEN
    RAISE EXCEPTION 'tournament, horse and wallet authority are required'
      USING ERRCODE='22004';
  END IF;

  -- Ticket return, ticket admission and terminal settlement use this order.
  -- Holding both locks through the no-ticket decision prevents a concurrent
  -- unregister from issuing a ticket between selection and a wallet debit.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  SELECT is_horse INTO v_is_horse
    FROM public.profiles WHERE id=p_user_id;
  IF NOT COALESCE(v_is_horse,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_a_horse');
  END IF;

  -- An ambiguous-response retry arrives after the issued ticket has become
  -- redeemed. Recover that exact ticket id from the active immutable entry
  -- entitlement and let the admission core prove and replay the receipt.
  SELECT count(*),min(e.source_ticket_id::text)::uuid
    INTO v_ticket_registration_count,v_ticket_id
    FROM public.tournament_refund_entitlements e
    JOIN public.tournament_players tp ON tp.id=e.registration_id
   WHERE e.tournament_id=p_tournament_id
     AND e.user_id=p_user_id
     AND e.entitlement_kind='tournament_ticket'
     AND e.source_ticket_id IS NOT NULL
     AND tp.tournament_id=e.tournament_id
     AND tp.user_id=e.user_id
     AND tp.status::text IN ('registered','playing');
  IF v_ticket_registration_count>1 THEN
    RAISE EXCEPTION
      'horse ticket admission has multiple active immutable entitlements'
      USING ERRCODE='P0404';
  END IF;
  IF v_ticket_registration_count=1 AND v_ticket_id IS NOT NULL THEN
    RETURN public.fn_ca_register_for_tournament_with_ticket_for(
      p_tournament_id,v_ticket_id,p_user_id);
  END IF;

  v_ticket_lookup:=public.fn_ca_find_tournament_entry_ticket_for(
    p_tournament_id,p_user_id);
  IF COALESCE((v_ticket_lookup->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_ticket_lookup;
  END IF;
  v_ticket_id:=NULLIF(v_ticket_lookup->>'ticket_id','')::uuid;
  IF v_ticket_id IS NOT NULL THEN
    RETURN public.fn_ca_register_for_tournament_with_ticket_for(
      p_tournament_id,v_ticket_id,p_user_id);
  END IF;

  -- 20261015132042: a cashier ticket bound to this tournament enters the
  -- horse through the same door it enters a person (CLAUDE.md 10.5).
  v_ticket_lookup:=public.fn_ca_find_cashier_entry_ticket_for(
    p_tournament_id,p_user_id);
  v_ticket_id:=NULLIF(v_ticket_lookup->>'ticket_id','')::uuid;
  IF v_ticket_id IS NOT NULL THEN
    RETURN public.fn_ca_use_cashier_entry_ticket(
      p_tournament_id,v_ticket_id,p_user_id);
  END IF;

  IF p_allow_wallet_charge IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','hinted_tournament_ticket_no_longer_available');
  END IF;
  RETURN public.fn_register_horse_for_tournament_before_atomic_lifecycle_gate(
    p_tournament_id,p_user_id);
END;
$function$;
-- Restated, unchanged from production: the engine-only horse gate.
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_horse_tournament_entry_ticket_hints(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_is_bounty boolean;
  v_holder_ids jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'tournament id is required' USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_found','holder_ids','[]'::jsonb);
  END IF;
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2) THEN
    RAISE EXCEPTION 'tournament % has no finite ticket contract',p_tournament_id
      USING ERRCODE='P0404';
  END IF;
  IF v_split.charge=0 THEN
    RETURN jsonb_build_object('ok',true,'holder_ids','[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(candidate.holder_id ORDER BY candidate.holder_id),
                  '[]'::jsonb)
    INTO v_holder_ids
    FROM (
      SELECT tk.holder_id
        FROM public.tournament_tickets tk
        JOIN public.profiles p ON p.id=tk.holder_id
       WHERE COALESCE(p.is_horse,false)
         AND tk.status='issued'
         AND tk.redemption_mode='tournament_entry_only'
         AND tk.value=v_split.charge
         AND tk.entry_prize=v_split.prize
         AND tk.entry_bounty=v_split.bounty
         AND tk.entry_fee=v_split.rake
         AND (tk.source_refund_entitlement_id IS NOT NULL
              OR tk.source_tournament_id=p_tournament_id)
         AND EXISTS(
           SELECT 1 FROM public.club_members m
            WHERE m.club_id=tk.club_id AND m.user_id=tk.holder_id
              AND COALESCE(m.status,'active') IN ('active','approved'))
         AND (v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
         AND (v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(
           SELECT 1 FROM public.union_clubs uc
            WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
         AND public.fn_tournament_club_for_user(
               tk.holder_id,p_tournament_id,tk.club_id)
               IS NOT DISTINCT FROM tk.club_id
      UNION
      -- 20261015132042: a horse holding a cashier ticket bound to this
      -- tournament is steered to it exactly as a satellite ticket holder is.
      SELECT b.holder_id
        FROM public.tournament_ticket_entry_targets b
        JOIN public.tournament_tickets tk ON tk.id=b.ticket_id
        JOIN public.profiles p ON p.id=b.holder_id
       WHERE b.tournament_id=p_tournament_id
         AND COALESCE(p.is_horse,false)
         AND tk.status='issued'
         AND tk.holder_id=b.holder_id
         AND b.value=v_split.charge
         AND b.entry_prize=v_split.prize
         AND b.entry_bounty=v_split.bounty
         AND b.entry_fee=v_split.rake
         AND EXISTS(
           SELECT 1 FROM public.club_members m
            WHERE m.club_id=tk.club_id AND m.user_id=tk.holder_id
              AND COALESCE(m.status,'active') IN ('active','approved'))
         AND public.fn_tournament_club_for_user(
               tk.holder_id,p_tournament_id,tk.club_id)
               IS NOT DISTINCT FROM tk.club_id
    ) candidate;
  RETURN jsonb_build_object('ok',true,'holder_ids',v_holder_ids);
END;
$function$;
-- Restated, unchanged from production: engine telemetry for the horse fleet.
REVOKE ALL ON FUNCTION public.fn_horse_tournament_entry_ticket_hints(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_tournament_entry_ticket_hints(uuid) TO service_role;

-- A bound ticket is an entry, not chips.
CREATE OR REPLACE FUNCTION public.fn_redeem_tournament_ticket(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid:=auth.uid();
  v_t public.tournament_tickets%ROWTYPE;
  v_after numeric;
  v_context jsonb;
  v_setting text;
  v_receipt public.chip_transactions%ROWTYPE;
  v_issue public.chip_transactions%ROWTYPE;
  v_escrow_entity uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Not Authenticated');
  END IF;
  IF p_ticket_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','Choose A Ticket');
  END IF;

  SELECT * INTO v_t FROM public.tournament_tickets
   WHERE id=p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'error','Ticket Not Found');
  END IF;
  IF v_t.redemption_mode='tournament_entry_only' THEN
    RETURN jsonb_build_object(
      'success',false,
      'error','Tournament-Entry Tickets Can Only Be Used To Enter A Tournament');
  END IF;
  -- 20261015132042: a cashier ticket bound to one tournament is used by
  -- registering for it. If that tournament closes unused, the closing
  -- transaction pays its holder in cash.
  IF EXISTS (SELECT 1 FROM public.tournament_ticket_entry_targets b
              WHERE b.ticket_id=p_ticket_id) THEN
    RETURN jsonb_build_object(
      'success',false,
      'error','This Ticket Is Used By Registering For Its Tournament');
  END IF;
  IF v_t.holder_id IS DISTINCT FROM v_me THEN
    RETURN jsonb_build_object('success',false,'error','This Ticket Is Not Yours');
  END IF;
  IF v_t.status='redeemed' THEN
    SELECT * INTO v_receipt FROM public.chip_transactions
     WHERE transaction_type='tournament_ticket_redeem'
       AND metadata->>'ticket_id'=p_ticket_id::text LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success',true,'replayed',true,'value',v_t.value,
        'your_balance',(v_receipt.metadata->>'holder_balance_after')::numeric,
        'transaction_id',v_receipt.id);
    END IF;
  END IF;
  IF v_t.status<>'issued' THEN
    RETURN jsonb_build_object(
      'success',false,'error','Ticket Already '||initcap(v_t.status));
  END IF;

  SELECT * INTO v_issue FROM public.chip_transactions
   WHERE transaction_type='tournament_ticket_issue'
     AND metadata->>'ticket_id'=p_ticket_id::text LIMIT 1;
  IF FOUND AND v_issue.metadata ? 'escrow_entity_id' THEN
    IF v_issue.club_id IS DISTINCT FROM v_t.club_id
       OR v_issue.from_user_id IS DISTINCT FROM v_t.issued_by
       OR v_issue.to_user_id IS DISTINCT FROM v_t.holder_id
       OR v_issue.amount IS DISTINCT FROM v_t.value
       OR v_issue.metadata->>'escrow_entity_id'
            IS DISTINCT FROM p_ticket_id::text THEN
      RAISE EXCEPTION 'Ticket escrow receipt does not match its entitlement'
        USING ERRCODE='22023';
    END IF;
    v_escrow_entity:=p_ticket_id;
  END IF;
  SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),''))
    INTO v_context
    FROM unnest(ARRAY[
      'app.ledger_category','app.ledger_counterparty',
      'app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
  PERFORM set_config('app.ledger_tournament','',true);
  PERFORM set_config('app.ledger_category','ticket_redeem',true);
  PERFORM set_config('app.ledger_counterparty','escrow',true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',COALESCE(v_escrow_entity::text,''),true);
  UPDATE public.club_members
     SET chip_balance=COALESCE(chip_balance,0)+v_t.value,updated_at=now()
   WHERE club_id=v_t.club_id AND user_id=v_me
     AND COALESCE(status,'active') IN ('active','approved')
   RETURNING chip_balance INTO v_after;
  FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
    PERFORM set_config(v_setting,v_context->>v_setting,true);
  END LOOP;
  IF v_after IS NULL THEN
    RETURN jsonb_build_object(
      'success',false,'error','You Are No Longer A Member Of That Club');
  END IF;

  UPDATE public.tournament_tickets
     SET status='redeemed',redeemed_at=now()
   WHERE id=p_ticket_id;
  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_t.club_id,NULL,v_me,v_t.value,'tournament_ticket_redeem',
    'Tournament Ticket Redeemed: Escrow Released',v_after,
    jsonb_build_object(
      'ticket_id',p_ticket_id,'issuer_id',v_t.issued_by,
      'holder_id',v_t.holder_id,'escrow_action','release_to_holder',
      'holder_balance_after',v_after))
  RETURNING * INTO v_receipt;

  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,balance_after)
  VALUES(
    v_me,'PLAYER','credit',v_t.value,'transfer',
    'Tournament Ticket Redeemed: Escrow Released',v_after);

  RETURN jsonb_build_object(
    'success',true,'replayed',false,'value',v_t.value,
    'your_balance',v_after,'transaction_id',v_receipt.id);
END;
$function$;

-- A 'ticket' batch item may name a tournament; one that does not is unchanged.
CREATE OR REPLACE FUNCTION public.fn_cashier_batch_transfer(p_club_id uuid, p_kind text, p_items jsonb, p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me uuid := auth.uid();
  v_item jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_user_id uuid;
  v_amount numeric;
  v_destination text;
  v_reason text;
  v_op_id uuid;
  v_ticket_key text;
  v_tournament_id uuid;
  v_seen uuid[] := '{}'::uuid[];
begin
  if v_me is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_club_id is null or p_batch_id is null then
    return jsonb_build_object('success',false,'error','Club And Batch Retry Key Are Required');
  end if;
  if p_kind not in ('send','ticket') then
    return jsonb_build_object('success',false,'error','Choose Send Or Ticket');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 25 then
    return jsonb_build_object('success',false,'error','A Batch Must Contain Between 1 And 25 Recipients');
  end if;

  -- Validate the complete envelope before the first item can move money.
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item->>'user_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('success',false,'error','Every Batch Item Needs A Valid Recipient And Amount');
    end if;
    -- 20261015132042: a tournament ticket is priced by its tournament, so its
    -- amount is optional; when sent it is the price the cashier saw.
    if p_kind='ticket' and v_item ? 'tournament_id'
       and jsonb_typeof(v_item->'tournament_id') <> 'null' then
      if coalesce(v_item->>'tournament_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return jsonb_build_object('success',false,'error','Every Tournament Ticket Needs A Valid Tournament');
      end if;
      if v_item ? 'amount' and jsonb_typeof(v_item->'amount') <> 'null'
         and coalesce(v_item->>'amount','') !~ '^[0-9]+([.][0-9]+)?$' then
        return jsonb_build_object('success',false,'error','Every Batch Item Needs A Valid Recipient And Amount');
      end if;
    elsif coalesce(v_item->>'amount','') !~ '^[0-9]+([.][0-9]+)?$' then
      return jsonb_build_object('success',false,'error','Every Batch Item Needs A Valid Recipient And Amount');
    end if;
    v_user_id := (v_item->>'user_id')::uuid;
    v_amount := nullif(v_item->>'amount','')::numeric;
    if v_user_id = any(v_seen) then
      return jsonb_build_object('success',false,'error','A Recipient May Appear Only Once Per Batch');
    end if;
    v_seen := array_append(v_seen, v_user_id);
    if v_amount is not null
       and (v_amount <= 0 or v_amount > 1e9 or v_amount <> round(v_amount,2)) then
      return jsonb_build_object('success',false,'error','Every Amount Must Be Positive And Use Hundredths At Most');
    end if;
    if p_kind='send' and coalesce(v_item->>'op_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('success',false,'error','Every Send Needs Its Own Retry Key');
    end if;
    if p_kind='ticket' and nullif(btrim(coalesce(v_item->>'idempotency_key','')),'') is null then
      return jsonb_build_object('success',false,'error','Every Ticket Needs Its Own Retry Key');
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_user_id := (v_item->>'user_id')::uuid;
    v_amount := nullif(v_item->>'amount','')::numeric;
    v_tournament_id := case when p_kind='ticket' and jsonb_typeof(v_item->'tournament_id')='string'
                            then (v_item->>'tournament_id')::uuid end;
    begin
      if p_kind='send' then
        v_destination := coalesce(nullif(v_item->>'destination',''),'player_wallet');
        v_reason := nullif(v_item->>'reason','');
        v_op_id := (v_item->>'op_id')::uuid;
        v_result := public.fn_agent_wallet_send(
          p_club_id,v_user_id,v_amount,v_destination,v_reason,v_op_id
        );
      elsif v_tournament_id is not null then
        v_ticket_key := v_item->>'idempotency_key';
        v_result := public.fn_issue_tournament_entry_ticket(
          p_club_id,v_user_id,v_tournament_id,nullif(v_item->>'note',''),
          v_ticket_key,v_amount
        );
      else
        v_ticket_key := v_item->>'idempotency_key';
        v_result := public.fn_issue_tournament_ticket(
          p_club_id,v_user_id,v_amount,nullif(v_item->>'note',''),v_ticket_key
        );
      end if;
    exception when others then
      v_result := jsonb_build_object(
        'success',false,'error','Transfer Failed','error_code',sqlstate
      );
    end;
    v_results := v_results || jsonb_build_array(
      jsonb_build_object('user_id',v_user_id) || coalesce(v_result,'{}'::jsonb)
    );
  end loop;

  return jsonb_build_object(
    'success',true,
    'batch_id',p_batch_id,
    'results',v_results,
    'processed',jsonb_array_length(v_results)
  );
end
$function$;

-- ---------------------------------------------------------------------------
-- Postimage
-- ---------------------------------------------------------------------------
DO $postimage$
BEGIN
  IF to_regclass('public.tournament_ticket_entry_targets') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class
              WHERE oid='public.tournament_ticket_entry_targets'::regclass)
     OR has_table_privilege('authenticated','public.tournament_ticket_entry_targets','INSERT')
     OR has_table_privilege('authenticated','public.tournament_ticket_entry_targets','UPDATE')
     OR has_table_privilege('anon','public.tournament_ticket_entry_targets','SELECT')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
                     WHERE tgrelid='public.tournament_ticket_entry_targets'::regclass
                       AND tgname='tournament_ticket_entry_targets_are_immutable')
     OR NOT has_function_privilege('authenticated',
          'public.fn_cashier_ticketable_tournaments(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated',
          'public.fn_issue_tournament_entry_ticket(uuid,uuid,uuid,text,text,numeric)','EXECUTE')
     OR has_function_privilege('anon',
          'public.fn_issue_tournament_entry_ticket(uuid,uuid,uuid,text,text,numeric)','EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_ca_use_cashier_entry_ticket(uuid,uuid,uuid)','EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_ca_settle_closed_cashier_entry_tickets(uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_ca_find_cashier_entry_ticket_for(uuid,uuid)','EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_ca_cashier_ticket_target_state(uuid)','EXECUTE')
     -- Replaced bodies keep their grants: the ticket gates stay owner-only.
     OR has_function_privilege('authenticated',
          'public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)','EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean)','EXECUTE')
     OR NOT has_function_privilege('authenticated',
          'public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated',
          'public.fn_redeem_tournament_ticket(uuid)','EXECUTE')
     OR strpos(pg_get_functiondef('public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid)'::regprocedure),
               'fn_issue_tournament_entry_ticket')=0
     OR strpos(pg_get_functiondef('public.fn_redeem_tournament_ticket(uuid)'::regprocedure),
               'tournament_ticket_entry_targets')=0
     OR strpos(pg_get_functiondef('public.fn_find_tournament_entry_ticket(uuid)'::regprocedure),
               'fn_ca_find_cashier_entry_ticket_for')=0
     OR strpos(pg_get_functiondef('public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)'::regprocedure),
               'fn_ca_use_cashier_entry_ticket')=0
     OR strpos(pg_get_functiondef('public.fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean)'::regprocedure),
               'fn_ca_use_cashier_entry_ticket')=0
     OR strpos(pg_get_functiondef('public.fn_horse_tournament_entry_ticket_hints(uuid)'::regprocedure),
               'tournament_ticket_entry_targets')=0
     OR strpos(pg_get_functiondef('public.trg_ca_closed_target_pays_its_satellite_tickets()'::regprocedure),
               'fn_ca_settle_closed_cashier_entry_tickets')=0
     OR (SELECT count(*) FROM pg_trigger
          WHERE tgrelid='public.tournaments'::regclass
            AND tgname='zz_closed_target_pays_its_satellite_tickets'
            AND NOT tgisinternal)<>1
     OR (SELECT count(*) FROM public.ca_money_rpc_registry
          WHERE proname IN ('fn_issue_tournament_entry_ticket',
                            'fn_ca_use_cashier_entry_ticket',
                            'fn_ca_settle_closed_cashier_entry_tickets')
            AND status='approved')<>3 THEN
    RAISE EXCEPTION 'CASHIER_ENTRY_TICKET_POSTIMAGE_REFUSED';
  END IF;
END
$postimage$;

COMMIT;
