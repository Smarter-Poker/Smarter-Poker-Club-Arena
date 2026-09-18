-- 20260918080939_a_fee_whose_producer_died_can_still_be_attributed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A FEE WHOSE PRODUCER DIED CAN STILL BE ATTRIBUTED FROM ITS OWN EVIDENCE.
--
-- WHAT THIS IS FOR (measured on production 2026-09-18)
--
-- 649 live tournaments hold 2,673 entry fees, 5,340.61 chips, charged before
-- the accounting cutover at 2026-09-17 18:24:02.831517+00. None of them has a
-- batch row, so fn_accounting_tournament_fee_net_plan refuses every one with
-- tournament_fee_sources_require_reconciliation, fn_settle_tournament_rake
-- turns that refusal fatal, and 553 events sit decided by the cards with their
-- winners unpaid.
--
-- The hole is not evidence and it is not terms. Both are present:
--
--   * all 2,405 non-Spin records match exactly one tournament_refund_entitlements
--     row under the producer's own exactness rule, zero missing, zero ambiguous;
--   * all 268 Spin fees carry three contributor keys, three exactly matched paid
--     entries and one immutable reserve row;
--   * accounting_agreement_history opens at 2026-09-14 12:09:27+00, three days
--     before the cutover, and 2,122 of its 2,237 observations precede it across
--     all five clubs. 2,445 of the records were charged while their club's terms
--     already existed.
--
-- The hole is PROVENANCE. fn_capture_accounting_tournament_fee refuses unless
-- r.created_at = transaction_timestamp() and r.created_at >= cutoff, and refuses
-- any contributor charged before the cutover. fn_stamp_accounting_tournament_fee
-- refuses on the same two rules before it can reach its own legacy_unverified
-- branch, which is why these records carry no batch row at all.
--
-- Those rules say: a fee is captured by its producer, inside its transaction.
-- That is the right rule for a live charge and it is unsatisfiable once the
-- transaction has ended. So the estate has no authority at all for a fee whose
-- producing transaction ended without capturing it, however complete its
-- evidence. That gap is structural, not incidental to this outage: a crash
-- between charge and capture leaves the same hole. This is that authority.
--
-- WHAT IT MAY NOT DO
--
-- It relaxes NO evidence rule. Every check fn_capture_accounting_tournament_fee
-- makes is made here, against the same rows, with the same arithmetic. Only the
-- two provenance rules are absent, and their absence is replaced by conditions
-- the producer never needed: the record must predate the cutover, must have no
-- batch, and its event must still be live. A settled event's books are closed.
--
-- It cannot pay anybody. It writes attribution, never money. What pays is
-- fn_recognize_accounting_tournament_fees, through the ordinary settlement path,
-- from the source rows this writes.
--
-- WHY IT IS ON THE BAND-AID REGISTER
--
-- CLAUDE.md 10.12 forbids repair machinery, and check-no-new-band-aids reads
-- `reconcile` as a repair-shaped name. It is registered rather than renamed,
-- because renaming a thing to walk past a gate Dan asked for is worse than
-- owning it. Its root fix already shipped: ca_fee_cutover_is_drained refuses to
-- arm a cutover that would strand a live game, so this backlog is the last one.
-- docs/BAND-AIDS-REGISTER.md carries the row and the deletion condition.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, ~28s on this database.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. The producer is the one this was written against, the
--    tables are the ones it writes, and the backlog is real.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_md5 text;
  v_cutoff timestamptz;
  v_stranded int;
BEGIN
  -- The three bodies this authority was written against. If any of them has
  -- changed, its evidence rules may have changed, and a mirror of a body that
  -- no longer exists is worse than no mirror at all.
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5 FROM pg_proc p
   WHERE p.oid = 'public.fn_capture_accounting_tournament_fee(uuid,jsonb)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'e83638c8e5401469c336fe378505fbac' THEN
    RAISE EXCEPTION 'precondition: fn_capture_accounting_tournament_fee is md5 %, not the body whose evidence rules this mirrors', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5 FROM pg_proc p
   WHERE p.oid = 'public.fn_stamp_accounting_tournament_fee(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '7e7495ff6800996d72b5ab27008a33a6' THEN
    RAISE EXCEPTION 'precondition: fn_stamp_accounting_tournament_fee is md5 %, not the body whose evidence assembly this mirrors', v_md5;
  END IF;
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5 FROM pg_proc p
   WHERE p.oid = 'public.fn_accounting_tournament_fee_net_plan(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'd8231a3f9219ecacb5ae68ee3aebe435' THEN
    RAISE EXCEPTION 'precondition: fn_accounting_tournament_fee_net_plan is md5 %, not the body whose acceptance test this satisfies', v_md5;
  END IF;

  IF to_regclass('public.accounting_tournament_fee_batches') IS NULL
   OR to_regclass('public.accounting_tournament_fee_sources') IS NULL THEN
    RAISE EXCEPTION 'precondition: the accounting fee tables are missing';
  END IF;
  IF to_regclass('public.ca_stranded_fee_reconciliations') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition: ca_stranded_fee_reconciliations already exists';
  END IF;

  SELECT starts_at INTO v_cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
  IF v_cutoff IS NULL THEN RAISE EXCEPTION 'precondition: the cutover singleton row is missing'; END IF;

  SELECT stranded_tournaments INTO v_stranded FROM public.fn_ca_fee_cutover_stranded_by(v_cutoff);
  IF COALESCE(v_stranded,0) <= 0 THEN
    RAISE EXCEPTION 'precondition: no live tournament is stranded by the installed cutover, so this authority has nothing to be for';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE AUDIT ROW. Every use is recorded and no use can be edited away.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_stranded_fee_reconciliations(
  rake_record_id    uuid PRIMARY KEY REFERENCES public.rake_records(id),
  tournament_id     uuid NOT NULL,
  rake_amount       numeric NOT NULL CHECK (rake_amount > 0 AND rake_amount = round(rake_amount,2)),
  contributor_count integer NOT NULL CHECK (contributor_count > 0),
  source_ids        uuid[] NOT NULL CHECK (cardinality(source_ids) > 0),
  charged_at        timestamptz NOT NULL,
  cutover_at        timestamptz NOT NULL,
  reconciled_at     timestamptz NOT NULL DEFAULT transaction_timestamp(),
  reconciled_by     uuid NOT NULL DEFAULT COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
  CHECK (charged_at < cutover_at),
  CHECK (cardinality(source_ids) = contributor_count)
);

COMMENT ON TABLE public.ca_stranded_fee_reconciliations IS
  'One row per tournament fee captured after its producing transaction ended. Append only. The population it exists for is closed: ca_fee_cutover_is_drained stops another from being created.';

CREATE OR REPLACE FUNCTION public.fn_ca_stranded_fee_reconciliations_immutable()
RETURNS trigger LANGUAGE plpgsql AS $imm$
BEGIN
  RAISE EXCEPTION 'ca_stranded_fee_reconciliations is append only' USING ERRCODE = '55000';
END
$imm$;

CREATE TRIGGER ca_stranded_fee_reconciliations_immutable
  BEFORE UPDATE OR DELETE ON public.ca_stranded_fee_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_stranded_fee_reconciliations_immutable();

CREATE TRIGGER ca_stranded_fee_reconciliations_no_truncate
  BEFORE TRUNCATE ON public.ca_stranded_fee_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_stranded_fee_reconciliations_immutable();

ALTER TABLE public.ca_stranded_fee_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_stranded_fee_reconciliations FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. THE AUTHORITY. Same evidence, same arithmetic, different provenance.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_reconcile_stranded_tournament_fee(p_rake_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $reconcile$
DECLARE
  r public.rake_records%ROWTYPE; t record; e record; l record; tp record;
  item jsonb; row_plan record; cutoff timestamptz; manifest jsonb;
  contributors jsonb := '[]'; actual_union uuid; expected_kind text;
  expected_entitlement text; expected_category text; source_type text;
  uid uuid; reg uuid; count_rows int; reserve_id uuid; fingerprint text;
  total_weight numeric := 0; total_cents bigint; floor_total bigint;
  remainder_cents bigint; credit numeric; allocated numeric := 0;
  contract jsonb; new_id uuid; result_ids uuid[] := '{}';
  seen_players uuid[] := '{}'; seen_entitlements uuid[] := '{}';
  player uuid; club uuid; registration uuid; ledger_id uuid;
  entitlement_id uuid; charged_at timestamptz; weight numeric;
BEGIN
  SELECT * INTO r FROM public.rake_records WHERE id = p_rake_record_id FOR UPDATE;
  IF NOT FOUND OR r.is_tournament IS DISTINCT FROM true OR r.tournament_id IS NULL
   OR r.hand_id IS NOT NULL OR r.rake_amount IS NULL OR r.rake_amount <= 0
   OR r.rake_amount <> round(r.rake_amount, 2) OR r.rake_amount::text IN ('NaN','Infinity','-Infinity')
  THEN RAISE EXCEPTION 'positive_chip_tournament_fee_required' USING ERRCODE = '23514'; END IF;

  -- The producer's own lock, so this can never race a live capture.
  PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_fee:'||r.id::text, 0));

  -- ENTRY CONDITIONS, narrower than the producer's in every direction.
  SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
  IF cutoff IS NULL THEN
    RAISE EXCEPTION 'fee_cutover_missing' USING ERRCODE = '55000'; END IF;
  IF r.created_at >= cutoff THEN
    RAISE EXCEPTION 'tournament_fee_is_the_producers_to_capture' USING ERRCODE = '55000',
      HINT = 'This record was charged at or after the cutover. Its own transaction owned its capture.'; END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_tournament_fee_batches WHERE rake_record_id = r.id) THEN
    RAISE EXCEPTION 'tournament_fee_already_has_a_batch' USING ERRCODE = '23505'; END IF;

  SELECT id, club_id, union_id, is_private, tournament_type, status INTO t
    FROM public.tournaments WHERE id = r.tournament_id FOR SHARE;
  IF NOT FOUND OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
    RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE = '23514'; END IF;
  -- A settled event's books are closed. This may only complete a live one.
  IF upper(COALESCE(t.status::text,'')) NOT IN ('RUNNING','BREAK','REGISTERING','COMPLETING') THEN
    RAISE EXCEPTION 'tournament_fee_event_is_not_live' USING ERRCODE = '55000'; END IF;

  actual_union := CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
  fingerprint  := public.fn_accounting_tournament_fee_fingerprint(r);

  -- EVIDENCE ASSEMBLY, byte for byte the rule fn_stamp_accounting_tournament_fee uses.
  IF r.source = 'fn_spin_book_entry' THEN
    IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions)) <> 3 THEN
      RAISE EXCEPTION 'spin_fee_exact_paid_contributors_required' USING ERRCODE = '23514'; END IF;
    FOR item IN SELECT jsonb_build_object('player_id', key, 'weight', value)
                  FROM jsonb_each_text(r.player_contributions) ORDER BY key LOOP
      SELECT * INTO tp FROM public.tournament_players
       WHERE tournament_id = r.tournament_id AND user_id = (item->>'player_id')::uuid;
      IF NOT FOUND OR tp.club_id IS NULL THEN
        RAISE EXCEPTION 'spin_fee_entry_club_missing' USING ERRCODE = '23514'; END IF;
      SELECT count(*) INTO count_rows FROM public.tournament_refund_entitlements x
       WHERE x.tournament_id = r.tournament_id AND x.user_id = (item->>'player_id')::uuid
         AND x.entitlement_kind = 'wallet_charge' AND x.charge_category = 'tournament_buyin'
         AND x.created_at = tp.registered_at AND x.gross = (item->>'weight')::numeric;
      IF count_rows <> 1 THEN
        RAISE EXCEPTION 'spin_fee_exact_charge_ambiguous' USING ERRCODE = '23514'; END IF;
      SELECT * INTO e FROM public.tournament_refund_entitlements x
       WHERE x.tournament_id = r.tournament_id AND x.user_id = (item->>'player_id')::uuid
         AND x.entitlement_kind = 'wallet_charge' AND x.charge_category = 'tournament_buyin'
         AND x.created_at = tp.registered_at AND x.gross = (item->>'weight')::numeric;
      contributors := contributors || jsonb_build_array(jsonb_build_object(
        'player_id', e.user_id, 'club_id', e.refund_wallet_club_id, 'registration_id', tp.id,
        'charge_ledger_id', e.source_ledger_id, 'entitlement_id', e.id,
        'charged_at', e.created_at, 'weight', (item->>'weight')::numeric));
    END LOOP;
    SELECT count(*) INTO count_rows FROM public.spin_reserve_ledger s
     WHERE s.tournament_id = r.tournament_id AND s.kind = 'contribution';
    IF count_rows <> 1 THEN
      RAISE EXCEPTION 'spin_fee_exact_reserve_required' USING ERRCODE = '23514'; END IF;
    SELECT id INTO reserve_id FROM public.spin_reserve_ledger s
     WHERE s.tournament_id = r.tournament_id AND s.kind = 'contribution';
  ELSE
    IF NOT COALESCE(r.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false) THEN
      RAISE EXCEPTION 'tournament_fee_exact_player_required' USING ERRCODE = '23514'; END IF;
    uid := (r.metadata->>'user_id')::uuid;
    expected_entitlement := CASE r.source
      WHEN 'fn_register_for_tournament' THEN 'wallet_charge'
      WHEN 'fn_register_horse_for_tournament' THEN 'wallet_charge'
      WHEN 'process_tournament_rebuy' THEN 'wallet_charge'
      WHEN 'fn_award_satellite_seat' THEN 'satellite_seat'
      WHEN 'fn_register_for_tournament_with_ticket' THEN 'tournament_ticket' END;
    expected_category := CASE WHEN r.source = 'process_tournament_rebuy' THEN 'rebuy' ELSE 'tournament_buyin' END;
    IF expected_entitlement IS NULL THEN
      RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE = '55000'; END IF;
    reg := NULLIF(r.metadata->>'registration_id','')::uuid;
    IF reg IS NULL AND r.source = 'process_tournament_rebuy' THEN
      SELECT id INTO reg FROM public.tournament_players
       WHERE tournament_id = r.tournament_id AND user_id = uid; END IF;
    IF reg IS NULL THEN
      RAISE EXCEPTION 'tournament_fee_exact_registration_required' USING ERRCODE = '23514'; END IF;
    SELECT count(*) INTO count_rows FROM public.tournament_refund_entitlements x
     WHERE x.tournament_id = r.tournament_id AND x.user_id = uid AND x.created_at = r.created_at
       AND x.refund_fee = r.rake_amount AND x.entitlement_kind = expected_entitlement
       AND (CASE WHEN expected_entitlement = 'wallet_charge' THEN x.charge_category = expected_category
                 ELSE x.registration_id = reg END);
    IF count_rows <> 1 THEN
      RAISE EXCEPTION 'tournament_fee_exact_charge_ambiguous' USING ERRCODE = '23514'; END IF;
    SELECT * INTO e FROM public.tournament_refund_entitlements x
     WHERE x.tournament_id = r.tournament_id AND x.user_id = uid AND x.created_at = r.created_at
       AND x.refund_fee = r.rake_amount AND x.entitlement_kind = expected_entitlement
       AND (CASE WHEN expected_entitlement = 'wallet_charge' THEN x.charge_category = expected_category
                 ELSE x.registration_id = reg END);
    contributors := jsonb_build_array(jsonb_build_object(
      'player_id', e.user_id, 'club_id', e.refund_wallet_club_id, 'registration_id', reg,
      'charge_ledger_id', e.source_ledger_id, 'entitlement_id', e.id,
      'charged_at', e.created_at, 'weight', r.rake_amount));
  END IF;

  manifest := jsonb_build_object('union_id', actual_union, 'game_type', lower(t.tournament_type),
    'contributors', contributors, 'spin_reserve_id', reserve_id);

  -- EVIDENCE VERIFICATION, every check fn_capture_accounting_tournament_fee makes.
  -- The two provenance rules it applies are the only ones deliberately absent:
  -- the record need not have been created in this transaction, and a
  -- contributor's charge need not follow the cutover. Nothing else is relaxed.
  expected_kind := CASE r.source
    WHEN 'fn_register_for_tournament' THEN 'tournament_entry_fee'
    WHEN 'fn_register_horse_for_tournament' THEN 'tournament_entry_fee'
    WHEN 'fn_award_satellite_seat' THEN 'satellite_seat_entry_fee'
    WHEN 'fn_register_for_tournament_with_ticket' THEN 'tournament_ticket_entry_fee'
    WHEN 'fn_spin_book_entry' THEN 'spin_rake'
    WHEN 'process_tournament_rebuy' THEN r.metadata->>'kind' END;
  IF expected_kind IS NULL OR r.metadata->>'kind' IS DISTINCT FROM expected_kind
   OR (r.source = 'process_tournament_rebuy' AND expected_kind NOT IN ('tournament_rebuy_fee','tournament_reentry_fee'))
  THEN RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE = '55000'; END IF;

  count_rows := jsonb_array_length(manifest->'contributors');
  IF (r.source = 'fn_spin_book_entry' AND count_rows <> 3)
   OR (r.source <> 'fn_spin_book_entry' AND count_rows <> 1) THEN
    RAISE EXCEPTION 'tournament_fee_contributor_count_invalid' USING ERRCODE = '23514'; END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(manifest->'contributors') LOOP
    player := (item->>'player_id')::uuid; club := (item->>'club_id')::uuid;
    registration := (item->>'registration_id')::uuid; ledger_id := (item->>'charge_ledger_id')::uuid;
    entitlement_id := (item->>'entitlement_id')::uuid; charged_at := (item->>'charged_at')::timestamptz;
    weight := (item->>'weight')::numeric;
    IF player IS NULL OR club IS NULL OR registration IS NULL OR ledger_id IS NULL
     OR entitlement_id IS NULL OR charged_at IS NULL OR NOT isfinite(charged_at)
     OR charged_at > r.created_at
     OR weight IS NULL OR weight <= 0 OR weight <> round(weight,2)
     OR weight::text IN ('NaN','Infinity','-Infinity')
     OR player = ANY(seen_players) OR entitlement_id = ANY(seen_entitlements)
    THEN RAISE EXCEPTION 'tournament_fee_contributor_invalid' USING ERRCODE = '23514'; END IF;
    seen_players := array_append(seen_players, player);
    seen_entitlements := array_append(seen_entitlements, entitlement_id);

    SELECT * INTO e  FROM public.tournament_refund_entitlements WHERE id = entitlement_id;
    SELECT * INTO l  FROM public.chip_ledger WHERE id = ledger_id;
    SELECT * INTO tp FROM public.tournament_players WHERE id = registration;
    IF e.id IS NULL OR l.id IS NULL OR tp.id IS NULL
     OR e.tournament_id IS DISTINCT FROM r.tournament_id OR e.user_id IS DISTINCT FROM player
     OR e.refund_wallet_club_id IS DISTINCT FROM club OR e.source_ledger_id IS DISTINCT FROM ledger_id
     OR e.created_at IS DISTINCT FROM charged_at
     OR tp.tournament_id IS DISTINCT FROM r.tournament_id OR tp.user_id IS DISTINCT FROM player
     OR tp.club_id IS DISTINCT FROM club
     OR l.created_at IS DISTINCT FROM charged_at OR l.amount IS DISTINCT FROM e.gross
    THEN RAISE EXCEPTION 'tournament_fee_charge_evidence_mismatch' USING ERRCODE = '23514'; END IF;

    IF r.source = 'fn_spin_book_entry' THEN
      IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR e.charge_category IS DISTINCT FROM 'tournament_buyin'
       OR e.gross IS DISTINCT FROM weight OR l.from_type IS DISTINCT FROM 'player_wallet'
       OR l.from_entity_id IS DISTINCT FROM player OR l.to_type IS DISTINCT FROM 'prize_liability'
       OR l.to_entity_id IS DISTINCT FROM r.tournament_id OR l.club_id IS DISTINCT FROM club
       OR l.category IS DISTINCT FROM 'tournament_buyin'
       OR (r.player_contributions->>player::text)::numeric IS DISTINCT FROM weight
      THEN RAISE EXCEPTION 'spin_fee_charge_evidence_mismatch' USING ERRCODE = '23514'; END IF;
    ELSE
      IF e.refund_fee IS DISTINCT FROM r.rake_amount OR weight IS DISTINCT FROM r.rake_amount
       OR r.metadata->>'user_id' IS DISTINCT FROM player::text
      THEN RAISE EXCEPTION 'tournament_fee_amount_evidence_mismatch' USING ERRCODE = '23514'; END IF;
      IF r.source IN ('fn_register_for_tournament','fn_register_horse_for_tournament','process_tournament_rebuy') THEN
        source_type := CASE WHEN r.source = 'process_tournament_rebuy' THEN 'rebuy' ELSE 'tournament_buyin' END;
        IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR e.charge_category IS DISTINCT FROM source_type
         OR l.from_type IS DISTINCT FROM 'player_wallet' OR l.from_entity_id IS DISTINCT FROM player
         OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
         OR l.club_id IS DISTINCT FROM club OR l.category IS DISTINCT FROM source_type
         OR (r.source <> 'process_tournament_rebuy' AND r.metadata->>'registration_id' IS DISTINCT FROM registration::text)
        THEN RAISE EXCEPTION 'tournament_fee_wallet_evidence_mismatch' USING ERRCODE = '23514'; END IF;
      ELSIF r.source = 'fn_register_for_tournament_with_ticket' THEN
        IF e.entitlement_kind IS DISTINCT FROM 'tournament_ticket' OR e.registration_id IS DISTINCT FROM registration
         OR e.source_ticket_id IS NULL OR r.metadata->>'ticket_id' IS DISTINCT FROM e.source_ticket_id::text
         OR r.metadata->>'registration_id' IS DISTINCT FROM registration::text
         OR l.from_type IS DISTINCT FROM 'escrow' OR l.from_entity_id IS DISTINCT FROM e.source_ticket_id
         OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
         OR l.category IS DISTINCT FROM 'ticket_redeem'
        THEN RAISE EXCEPTION 'tournament_fee_ticket_evidence_mismatch' USING ERRCODE = '23514'; END IF;
      ELSE
        IF e.entitlement_kind IS DISTINCT FROM 'satellite_seat' OR e.registration_id IS DISTINCT FROM registration
         OR e.source_satellite_id IS NULL OR r.metadata->>'satellite_id' IS DISTINCT FROM e.source_satellite_id::text
         OR r.metadata->>'registration_id' IS DISTINCT FROM registration::text
         OR l.from_type IS DISTINCT FROM 'prize_liability' OR l.from_entity_id IS DISTINCT FROM e.source_satellite_id
         OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
         OR l.category IS DISTINCT FROM 'tournament_buyin'
        THEN RAISE EXCEPTION 'tournament_fee_satellite_evidence_mismatch' USING ERRCODE = '23514'; END IF;
      END IF;
    END IF;
    total_weight := total_weight + weight;
  END LOOP;

  IF r.source = 'fn_spin_book_entry' THEN
    IF (SELECT count(DISTINCT (x->>'weight')::numeric) FROM jsonb_array_elements(manifest->'contributors') x) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger s
        WHERE s.id = (manifest->>'spin_reserve_id')::uuid AND s.tournament_id = r.tournament_id
          AND s.kind = 'contribution' AND s.seats = 3 AND s.house_rake = r.rake_amount
          AND s.amount = total_weight - r.rake_amount AND s.buy_in = total_weight/3)
    THEN RAISE EXCEPTION 'spin_fee_reserve_evidence_mismatch' USING ERRCODE = '23514'; END IF;
  END IF;

  -- ALLOCATION AND CONTRACT, the producer's arithmetic unchanged: largest
  -- remainder to whole cents, UUID order breaking exact fractional ties.
  total_cents := (r.rake_amount * 100)::bigint;
  SELECT sum(floor(total_cents * (x->>'weight')::numeric / total_weight)) INTO floor_total
    FROM jsonb_array_elements(manifest->'contributors') x;
  remainder_cents := total_cents - floor_total;

  INSERT INTO public.accounting_tournament_fee_batches
    (rake_record_id, tournament_id, source_fingerprint, rake_amount, source_manifest)
  VALUES (r.id, r.tournament_id, fingerprint, r.rake_amount,
    manifest || jsonb_build_object(
      'reconciled_at', transaction_timestamp(),
      'reconciled_by', 'fn_ca_reconcile_stranded_tournament_fee',
      'reconciliation_note', 'charged before the fee cutover; captured from its own recorded evidence'));

  FOR row_plan IN
    SELECT x, floor(total_cents * (x->>'weight')::numeric / total_weight)
      + CASE WHEN row_number() OVER (
          ORDER BY total_cents * (x->>'weight')::numeric / total_weight
            - floor(total_cents * (x->>'weight')::numeric / total_weight) DESC, x->>'player_id'
        ) <= remainder_cents THEN 1 ELSE 0 END AS cents
      FROM jsonb_array_elements(manifest->'contributors') x ORDER BY x->>'player_id'
  LOOP
    item := row_plan.x; credit := row_plan.cents / 100.0;
    contract := public.fn_accounting_earning_contract((item->>'club_id')::uuid,
      (item->>'player_id')::uuid, credit, actual_union, (item->>'charged_at')::timestamptz);
    IF contract->>'player_id' IS DISTINCT FROM item->>'player_id'
     OR contract->>'club_id' IS DISTINCT FROM item->>'club_id'
     OR (contract->>'rake_credit')::numeric IS DISTINCT FROM credit
     OR NULLIF(contract->>'union_id','')::uuid IS DISTINCT FROM actual_union
     OR (contract->>'terms_at')::timestamptz IS DISTINCT FROM (item->>'charged_at')::timestamptz
    THEN RAISE EXCEPTION 'tournament_fee_contract_scope_mismatch' USING ERRCODE = '23514'; END IF;
    INSERT INTO public.accounting_tournament_fee_sources
      (rake_record_id, tournament_id, player_id, club_id, union_id, coordinator_union_id,
       game_type, registration_id, source_charge_ledger_id, source_entitlement_id,
       charged_at, rake_credit, contract)
    VALUES (r.id, r.tournament_id, (item->>'player_id')::uuid, (item->>'club_id')::uuid, actual_union,
      NULLIF(contract->>'coordinator_union_id','')::uuid, manifest->>'game_type',
      (item->>'registration_id')::uuid, (item->>'charge_ledger_id')::uuid,
      (item->>'entitlement_id')::uuid, (item->>'charged_at')::timestamptz, credit, contract)
    RETURNING id INTO new_id;
    result_ids := array_append(result_ids, new_id);
    allocated := allocated + credit;
  END LOOP;

  IF allocated IS DISTINCT FROM r.rake_amount THEN
    RAISE EXCEPTION 'tournament_fee_credit_not_conserved' USING ERRCODE = '23514'; END IF;

  -- The plan's own test, applied to this record before the caller moves on.
  IF EXISTS (SELECT 1 FROM public.rake_records q
               JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id = q.id
              WHERE q.id = r.id
                AND (b.status IS DISTINCT FROM 'captured'
                  OR b.tournament_id IS DISTINCT FROM r.tournament_id
                  OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(q)
                  OR b.rake_amount IS DISTINCT FROM q.rake_amount
                  OR b.rake_amount IS DISTINCT FROM (SELECT sum(s.rake_credit)
                       FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id = q.id)))
  THEN RAISE EXCEPTION 'tournament_fee_reconciled_batch_would_not_satisfy_the_plan' USING ERRCODE = '23514'; END IF;

  INSERT INTO public.ca_stranded_fee_reconciliations
    (rake_record_id, tournament_id, rake_amount, contributor_count, source_ids, charged_at, cutover_at)
  VALUES (r.id, r.tournament_id, r.rake_amount, array_length(result_ids,1), result_ids, r.created_at, cutoff);

  RETURN jsonb_build_object('accounting_version', 2, 'status', 'captured', 'reconciled', true,
    'rake_record_id', r.id, 'tournament_id', r.tournament_id, 'source_ids', result_ids,
    'rake_credit', allocated, 'payable', false);
END
$reconcile$;

REVOKE ALL ON FUNCTION public.fn_ca_reconcile_stranded_tournament_fee(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_ca_reconcile_stranded_tournament_fee(uuid) IS
  'Captures a tournament fee charged before the accounting cutover, from the evidence its own producer recorded. Every evidence rule fn_capture_accounting_tournament_fee applies is applied here; only its two provenance rules are absent, because they cannot be satisfied once the producing transaction has ended. Refuses a post-cutover record, a record that already has a batch, and any event that is no longer live.';

-- ---------------------------------------------------------------------------
-- 3. POSTCONDITIONS. The authority exists, it refuses what it must, and it
--    works: proved here on one real record, which stays reconciled.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_proof   constant uuid := '9bbbdb85-8240-45c2-8490-ce85b2ebf00c';
  v_cutoff  timestamptz;
  v_post    uuid;
  v_res     jsonb;
  v_msg     text;
  v_refused boolean;
  v_sum     numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_reconcile_stranded_tournament_fee(uuid)'::regprocedure
       AND p.prosecdef) THEN
    RAISE EXCEPTION 'postcondition: the authority is missing or is not SECURITY DEFINER';
  END IF;
  IF has_function_privilege('authenticated','public.fn_ca_reconcile_stranded_tournament_fee(uuid)','EXECUTE')
   OR has_function_privilege('anon','public.fn_ca_reconcile_stranded_tournament_fee(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'postcondition: a browser role can execute the authority';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal
         AND t.tgrelid = 'public.ca_stranded_fee_reconciliations'::regclass
         AND t.tgenabled IN ('O','A')) <> 2 THEN
    RAISE EXCEPTION 'postcondition: the audit table is not append only';
  END IF;

  SELECT starts_at INTO v_cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;

  -- A record the producer owns is refused, and refused by THIS rule.
  SELECT id INTO v_post FROM public.rake_records
   WHERE is_tournament AND rake_amount > 0 AND created_at >= v_cutoff ORDER BY created_at LIMIT 1;
  IF v_post IS NOT NULL THEN
    v_refused := false;
    BEGIN
      PERFORM public.fn_ca_reconcile_stranded_tournament_fee(v_post);
    EXCEPTION WHEN SQLSTATE '55000' THEN
      v_refused := true; GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'postcondition: the authority accepted a record its producer owns';
    END IF;
    IF v_msg IS DISTINCT FROM 'tournament_fee_is_the_producers_to_capture' THEN
      RAISE EXCEPTION 'postcondition: a post-cutover record was refused by something else: %', v_msg;
    END IF;
  END IF;

  -- The happy path, on one record verified by hand before this was written.
  -- Absent on a fresh replay, where there is no backlog to prove against.
  IF EXISTS (SELECT 1 FROM public.rake_records WHERE id = v_proof) THEN
    v_res := public.fn_ca_reconcile_stranded_tournament_fee(v_proof);
    IF v_res->>'status' IS DISTINCT FROM 'captured'
     OR COALESCE((v_res->>'reconciled')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'postcondition: the proof record did not come back captured: %', v_res;
    END IF;

    SELECT sum(s.rake_credit) INTO v_sum
      FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id = v_proof;
    IF v_sum IS DISTINCT FROM (SELECT rake_amount FROM public.rake_records WHERE id = v_proof) THEN
      RAISE EXCEPTION 'postcondition: the proof record''s credit is not conserved: % allocated', v_sum;
    END IF;

    -- The plan's own acceptance test, for this record, verbatim.
    IF EXISTS (SELECT 1 FROM public.rake_records q
                 JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id = q.id
                WHERE q.id = v_proof
                  AND (b.status IS DISTINCT FROM 'captured'
                    OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(q)
                    OR b.rake_amount IS DISTINCT FROM q.rake_amount)) THEN
      RAISE EXCEPTION 'postcondition: the reconciled batch does not satisfy the plan';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.ca_stranded_fee_reconciliations WHERE rake_record_id = v_proof) THEN
      RAISE EXCEPTION 'postcondition: the use was not recorded';
    END IF;

    -- Calling it twice does not write twice.
    v_refused := false;
    BEGIN
      PERFORM public.fn_ca_reconcile_stranded_tournament_fee(v_proof);
    EXCEPTION WHEN SQLSTATE '23505' THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'postcondition: the authority captured the same fee twice';
    END IF;
  END IF;
END
$post$;

COMMIT;
