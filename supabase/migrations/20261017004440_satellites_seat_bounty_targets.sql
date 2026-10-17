-- 20261017004440_satellites_seat_bounty_targets.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- SATELLITES SEAT BOUNTY TARGETS (2026-10-16)
--
-- Dan, 2026-10-16: "EVERY TOURNAMENT WITH A 25 BUY IN OR HIGHER SHOULD HAVE
-- SATELLITES INTO IT." Until this migration a satellite could not feed a
-- bounty, PKO or mystery-bounty event. Both satellite settlement authorities
-- (fn_settle_satellite_tournament_pre_money_path_gate and
-- fn_ca_settle_satellite_cohort) refused such a target ("uses an unsupported
-- bounty or Spin entry split"), and fn_satellite_target_is_deliverable,
-- fn_ca_satellite_target_accepts_new_feeder and the engine's
-- satelliteTargetIsDeliverable refused to open a satellite into one. The
-- refusal was correct for the authority as written: its seat leg booked the
-- whole ticket as prize (satellite_in) and its seat row carried no
-- current_bounty, so trg_seed_bounty_head raised the bounty pool by a head
-- nobody paid for. That is the 2026-09-07 Sunday Funday High Roller PKO
-- shortfall (66 entrants owed 5,810.00 and handed 4,455.00).
--
-- WHAT A SEAT NOW IS. Exactly a paid entry, split by the same function the
-- paid door uses: fn_tournament_entry_split(buy_in, fee, bounty_amount,
-- is_bounty OR is_pko OR is_mystery_bounty) gives prize = buy_in - bounty,
-- bounty, fee = rake; the ticket is still buy_in + fee. For a target whose
-- split carries a bounty (and only then; a plain target is booked exactly as
-- before, byte for byte in what it writes):
--
--   * the seat row carries current_bounty = bounty (mystery_bounty_value 0,
--     as the paid door writes it), so trg_seed_bounty_head finds the head
--     already seeded and never books an unfunded head or files its alert;
--   * the pool-transfer leg names its split (entry_split_version 2,
--     entry_prize, entry_bounty, entry_fee), so the existing
--     fn_ca_escrow_on_seat_transfer_leg books gross_in = prize + bounty and
--     bounty_in = bounty, and the v2-tagged fee row books only the fee
--     (fn_ca_escrow_on_rake_record). This is the rail fn_award_satellite_seat
--     has used 54 times, never before with a bounty;
--   * the target's counters move by the split: prize_pool += n x prize,
--     bounty_pool += n x bounty, total_rake += n x fee, and the authority
--     proves the target escrow moved by exactly the same amounts;
--   * the seat's refund entitlement (fn_ca_capture_satellite_seat_entitlement)
--     returns prize, bounty and fee from the satellite_gross bucket, which
--     fn_ca_tournament_refund_plan already reads, so a cancelled or
--     unregistered bounty seat is returned exactly;
--   * a four-table-cap winner's noncash ticket carries entry_prize = prize and
--     entry_bounty = bounty; redemption (fn_ca_register_for_tournament_with_
--     ticket_for) and the ticket finder (fn_ca_find_tournament_entry_ticket_for)
--     prove it against the settlement header as target buy-in = prize +
--     bounty, then book it through the ticket door's existing bounty split;
--   * both receipts (fn_ca_satellite_settlement_receipt,
--     fn_ca_satellite_cohort_receipt) accept a bounty target and require
--     every delivered seat leg and ticket to carry the target's exact split.
--
-- The mystery chest inventory (fn_mystery_bounty_seed) is built from
-- tournaments.bounty_pool once entry closes, so a satellite seat now funds the
-- chests exactly as a paid entry does.
--
-- STILL REFUSED, by name: a Spin or premium-Spin target, a target whose bounty
-- flags are unknown (NULL), a split whose bounty exceeds the buy-in, and a
-- Diamond bounty target (fn_poker_diamond_tournament_seat_transfer has no
-- bounty part). A satellite is still never itself a bounty or Spin event (the
-- source rule in fn_ca_guard_new_satellite_target is unchanged).
--
-- ONE CORRECTION TO THE DESIGN AS FIRST WRITTEN. The target pre-check was to
-- require bounty_balance = tournaments.bounty_pool. Read from production on
-- 2026-10-16: every REGISTERING bounty event (89) holds bounty_balance =
-- bounty_pool, but every RUNNING one (3) holds bounty_balance = bounty_pool -
-- bounty_pool_paid, because a knockout pays from the bank and adds to
-- bounty_pool_paid. A late seat into a running PKO would have been refused
-- after its first knockout. The pre-check is bounty_pool - bounty_pool_paid.
--
-- Live path only: no sweep, no repair job, no compensating write (CLAUDE.md
-- 10.11, 10.12). Every function below is the exact production preimage (md5
-- of pg_get_functiondef read 2026-10-16) with the minimal change; the block
-- below refuses any other preimage, and the closing blocks prove every
-- postimage hash and that every grant is exactly production's (restated
-- below: no function gains or loses a caller). Regression: scripts/ci/test-satellite-bounty-seat-split.py
-- (PostgreSQL 17) runs the real postimages of the settlement authority, its
-- receipt, the escrow triggers and the refund plan end to end, and
-- tests/a-satellite-seats-a-bounty-target-like-a-paid-entry.law.test.ts pins
-- the rule.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_satellite_target_is_deliverable(uuid)'::regprocedure)) = 'a7d1e00b04527ee42ef2cce9cabf7991'
-- @live-proof: md5(pg_get_functiondef('public.fn_satellite_feeds_only_a_deliverable_target()'::regprocedure)) = '15f3578458940fc926837e96c4c8da67'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_satellite_target_accepts_new_feeder(uuid)'::regprocedure)) = '056d68f3cc832e90a22e0571154ab142'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_guard_new_satellite_target()'::regprocedure)) = '5634948d5e2f073ec4205176607e7c21'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_capture_satellite_seat_entitlement()'::regprocedure)) = 'f8404f55d30cc6ae4a317d49df14c4ee'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)'::regprocedure)) = 'b4ed52d3fbf81f55d935666357eb9781'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure)) = '377446dc1ccce91cbf8a7af0c713ec7f'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)) = 'c4b817ae5a6d328dc3118bdfc5d98c21'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure)) = 'df717a9f260a1318ffb28f114625008b'
-- @live-proof: md5(pg_get_functiondef('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure)) = '14eddc55fc178f81232f619fa764ee7e'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_settle_satellite_cohort(uuid,uuid[])'::regprocedure)) = 'e248788b7f4e0a4779444ba43ba2ae4b'

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $preimage$
DECLARE
  r record;
  v_md5 text;
BEGIN
  -- Each function must be today's production text (or, on a re-run, this
  -- migration's own postimage). Anything else refuses before a byte moves.
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_satellite_target_is_deliverable(uuid)',
     'dbd45692f53316d0142c0034fe0a7245','a7d1e00b04527ee42ef2cce9cabf7991'),
    ('public.fn_satellite_feeds_only_a_deliverable_target()',
     '4251f65adfd51a29967a346af7ae98f1','15f3578458940fc926837e96c4c8da67'),
    ('public.fn_ca_satellite_target_accepts_new_feeder(uuid)',
     '3933ec28773f12a1da9b02952ad99ed4','056d68f3cc832e90a22e0571154ab142'),
    ('public.fn_ca_guard_new_satellite_target()',
     '8e0149116be545a6b4ccc0bfe690c372','5634948d5e2f073ec4205176607e7c21'),
    ('public.fn_ca_capture_satellite_seat_entitlement()',
     '4cf7de45bec781bc708bcdf9f1ce9845','f8404f55d30cc6ae4a317d49df14c4ee'),
    ('public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)',
     '1faed89ef1c23d05f2b7f90715048efd','b4ed52d3fbf81f55d935666357eb9781'),
    ('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)',
     'bf8a5f20ef63427093a662c62edc5d65','377446dc1ccce91cbf8a7af0c713ec7f'),
    ('public.fn_ca_satellite_settlement_receipt(uuid,uuid)',
     '752a8d976b306c37db92a8b42863424b','c4b817ae5a6d328dc3118bdfc5d98c21'),
    ('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])',
     '6cdc896a54b4f3726b3c3aa444be7647','df717a9f260a1318ffb28f114625008b'),
    ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',
     '8fb5cdbc0fd4caae36d1e6191a1e9b6d','14eddc55fc178f81232f619fa764ee7e'),
    ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',
     '22063fc9eca98d335f633772aae2d19d','e248788b7f4e0a4779444ba43ba2ae4b')
  ) AS v(sig, pre, post) LOOP
    v_md5 := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_md5 IS DISTINCT FROM r.pre AND v_md5 IS DISTINCT FROM r.post THEN
      RAISE EXCEPTION 'SATELLITE_BOUNTY_TARGET_PREIMAGE_CHANGED: % is %, expected % or %',
        r.sig, v_md5, r.pre, r.post;
    END IF;
  END LOOP;
END
$preimage$;

-- public.fn_satellite_target_is_deliverable(uuid)
CREATE OR REPLACE FUNCTION public.fn_satellite_target_is_deliverable(p_target_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Mirrors the admission refusal in both satellite settlement authorities
  -- exactly (2026-10-16): every flag must be KNOWN, never a premium Spin,
  -- and neither Spin spelling. A bounty, PKO or mystery-bounty target IS
  -- deliverable: its seat books prize, bounty and fee exactly like a paid
  -- entry. A Diamond target only without a bounty, because the Diamond seat
  -- transfer has no bounty part. A missing target is not deliverable either
  -- (the authority refuses it).
  SELECT COALESCE((
    SELECT t.is_bounty IS NOT NULL
       AND t.is_pko IS NOT NULL
       AND t.is_mystery_bounty IS NOT NULL
       AND t.is_premium_spin IS FALSE
       AND lower(COALESCE(t.variant, '')) <> 'spin'
       AND upper(COALESCE(t.tournament_type, '')) <> 'SPIN'
       AND (NOT (t.is_bounty OR t.is_pko OR t.is_mystery_bounty)
            OR NOT public.fn_poker_diamond_tournament(t.id))
      FROM public.tournaments t
     WHERE t.id = p_target_id
  ), false)
$function$;

-- public.fn_satellite_feeds_only_a_deliverable_target()
CREATE OR REPLACE FUNCTION public.fn_satellite_feeds_only_a_deliverable_target()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
  v_old_target uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_target := COALESCE(OLD.satellite_target_id, OLD.satellite_target);
  END IF;

  -- A satellite may only be opened into, or re-pointed at, a target whose
  -- seat the settlement authority can deliver.
  IF v_target IS NOT NULL
     AND (TG_OP = 'INSERT' OR v_target IS DISTINCT FROM v_old_target)
     AND NOT public.fn_satellite_target_is_deliverable(v_target) THEN
    RAISE EXCEPTION
      'satellite % cannot feed target %: the satellite settlement authority refuses a Spin entry split, unknown entry flags or a Diamond bounty',
      NEW.id, v_target
      USING ERRCODE = '22023',
            HINT = 'Pick a target that is not a Spin and whose bounty flags are set.';
  END IF;

  -- A tournament live satellites feed may not become one that refuses them.
  IF TG_OP = 'UPDATE'
     AND (NEW.is_bounty, NEW.is_pko, NEW.is_mystery_bounty, NEW.is_premium_spin,
          NEW.variant, NEW.tournament_type)
         IS DISTINCT FROM
         (OLD.is_bounty, OLD.is_pko, OLD.is_mystery_bounty, OLD.is_premium_spin,
          OLD.variant, OLD.tournament_type)
     AND NOT (NEW.is_bounty IS NOT NULL AND NEW.is_pko IS NOT NULL
              AND NEW.is_mystery_bounty IS NOT NULL AND NEW.is_premium_spin IS FALSE
              AND lower(COALESCE(NEW.variant, '')) <> 'spin'
              AND upper(COALESCE(NEW.tournament_type, '')) <> 'SPIN'
              AND (NOT (NEW.is_bounty OR NEW.is_pko OR NEW.is_mystery_bounty)
                   OR NOT public.fn_poker_diamond_tournament(NEW.id)))
     AND EXISTS (
       SELECT 1 FROM public.tournaments s
        WHERE COALESCE(s.satellite_target_id, s.satellite_target) = NEW.id
          AND s.id <> NEW.id
          AND upper(COALESCE(s.status, '')) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
     ) THEN
    RAISE EXCEPTION
      'tournament % is fed by a live satellite and cannot take a Spin entry split, unknown entry flags or a Diamond bounty',
      NEW.id
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;

-- public.fn_ca_satellite_target_accepts_new_feeder(uuid)
CREATE OR REPLACE FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(p_target_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 -- A chip bounty, PKO or mystery-bounty MTT accepts a feeder (2026-10-16):
 -- its seat is booked exactly like a paid entry. Flags must be known; a
 -- Spin or a satellite is never a target.
 SELECT COALESCE((SELECT t.format_contract IN ('mtt-v1','mtt-v2')
   AND t.is_bounty IS NOT NULL AND t.is_pko IS NOT NULL AND t.is_mystery_bounty IS NOT NULL
   AND t.is_premium_spin IS FALSE
   AND lower(btrim(COALESCE(t.variant,''))) NOT IN ('satellite','spin')
   AND lower(btrim(COALESCE(t.tournament_type,''))) NOT IN ('satellite','spin')
   AND t.satellite_target_id IS NULL AND t.satellite_target IS NULL
   AND public.fn_poker_diamond_tournament(t.id) IS FALSE
   FROM public.tournaments t WHERE t.id=p_target_id),false);
$function$;

-- public.fn_ca_guard_new_satellite_target()
CREATE OR REPLACE FUNCTION public.fn_ca_guard_new_satellite_target()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_abi text; v_target uuid:=COALESCE(NEW.satellite_target_id,NEW.satellite_target);
 v_target_row public.tournaments%ROWTYPE; v_supported boolean;
 v_supported_target boolean;  -- 2026-10-16: a bounty target accepts a feeder
 v_source_diamond boolean;  -- DIAMOND PHASE 9
BEGIN
 IF TG_OP='UPDATE' AND
   (NEW.satellite_target_id,NEW.satellite_target,NEW.is_bounty,NEW.is_pko,NEW.is_mystery_bounty,
    NEW.is_premium_spin,NEW.variant,NEW.tournament_type,NEW.club_id,NEW.union_id)
   IS NOT DISTINCT FROM
   (OLD.satellite_target_id,OLD.satellite_target,OLD.is_bounty,OLD.is_pko,OLD.is_mystery_bounty,
    OLD.is_premium_spin,OLD.variant,OLD.tournament_type,OLD.club_id,OLD.union_id) THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 -- DIAMOND PHASE 9: ASSETS NEVER CROSS, under every admission contract. A
 -- satellite and its target are the same asset or the row is refused by name.
 v_source_diamond:=EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=NEW.club_id AND c.asset='diamonds');
 IF v_target IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournaments x WHERE x.id=v_target) THEN
  IF v_source_diamond AND NOT public.fn_poker_diamond_tournament(v_target) THEN
   RAISE EXCEPTION 'SATELLITE_DIAMOND_SOURCE_CANNOT_FEED_A_CHIP_TARGET' USING ERRCODE='22023';
  ELSIF NOT v_source_diamond AND public.fn_poker_diamond_tournament(v_target) THEN
   RAISE EXCEPTION 'SATELLITE_CHIP_SOURCE_CANNOT_FEED_A_DIAMOND_TARGET' USING ERRCODE='22023';
  END IF;
 END IF;
 IF v_abi='legacy-capacity-v1' THEN RETURN NEW;END IF;
 IF NEW.satellite_target_id IS NOT NULL AND NEW.satellite_target IS NOT NULL
    AND NEW.satellite_target_id<>NEW.satellite_target THEN
  RAISE EXCEPTION 'SATELLITE_TARGET_POINTER_CONTRADICTION' USING ERRCODE='22023';
 END IF;
 -- Under READ COMMITTED the post-lock query sees a just-committed feeder.
 -- A repeatable snapshot could otherwise permit an incompatible target edit.
 IF current_setting('transaction_isolation')<>'read committed'
    AND (TG_OP='UPDATE' OR v_target IS NOT NULL) THEN
  RAISE EXCEPTION 'SATELLITE_CONTRACT_REQUIRES_READ_COMMITTED' USING ERRCODE='0A000';
 END IF;
 v_supported:=NEW.is_bounty IS FALSE AND NEW.is_pko IS FALSE AND NEW.is_mystery_bounty IS FALSE
   AND NEW.is_premium_spin IS FALSE
   AND lower(btrim(COALESCE(NEW.variant,''))) NOT IN
    ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
   AND lower(btrim(COALESCE(NEW.tournament_type,''))) NOT IN
    ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty');
 -- A satellite is never itself a bounty or Spin (v_supported, the SOURCE
 -- rule). As a TARGET a row needs only known flags, no Spin, and no bounty
 -- on a Diamond event, whose seat transfer has no bounty part (2026-10-16).
 v_supported_target:=NEW.is_bounty IS NOT NULL AND NEW.is_pko IS NOT NULL
   AND NEW.is_mystery_bounty IS NOT NULL AND NEW.is_premium_spin IS FALSE
   AND lower(btrim(COALESCE(NEW.variant,''))) <> 'spin'
   AND lower(btrim(COALESCE(NEW.tournament_type,''))) <> 'spin'
   AND (NOT (NEW.is_bounty OR NEW.is_pko OR NEW.is_mystery_bounty)
        OR NOT v_source_diamond);
 -- DIAMOND PHASE 9: a Diamond row is supported like a chip row; the asset rule
 -- above decides which targets it may feed, and a target fed by a live
 -- satellite may not change its asset.
 IF TG_OP='UPDATE' AND (NOT v_supported_target OR v_target IS NOT NULL
      OR v_source_diamond IS DISTINCT FROM
         EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=OLD.club_id AND c.asset='diamonds')
      OR lower(COALESCE(NEW.variant,''))='satellite' OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE')
   AND EXISTS(SELECT 1 FROM public.tournaments s WHERE s.format_contract='mtt-v2'
     AND (s.satellite_target_id=NEW.id OR s.satellite_target=NEW.id) AND s.id<>NEW.id
     AND upper(COALESCE(s.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')) THEN
  RAISE EXCEPTION 'SATELLITE_LIVE_TARGET_CANNOT_BECOME_UNSUPPORTED' USING ERRCODE='22023';
 END IF;
 IF v_target IS NULL AND (lower(COALESCE(NEW.variant,''))='satellite'
    OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE') THEN
  RAISE EXCEPTION 'SATELLITE_NEW_TARGET_REQUIRED' USING ERRCODE='22023';
 END IF;
 IF v_target IS NOT NULL THEN
  IF NOT v_supported THEN RAISE EXCEPTION 'SATELLITE_NEW_SOURCE_UNSUPPORTED' USING ERRCODE='22023';END IF;
  SELECT * INTO v_target_row FROM public.tournaments WHERE id=v_target FOR UPDATE;
  IF NOT FOUND OR NOT (CASE WHEN v_source_diamond  -- DIAMOND PHASE 9
       THEN public.fn_ca_diamond_satellite_target_accepts_new_feeder(v_target)
       ELSE public.fn_ca_satellite_target_accepts_new_feeder(v_target) END)
     OR (NEW.union_id IS NOT NULL AND v_target_row.union_id IS DISTINCT FROM NEW.union_id)
     OR (NEW.union_id IS NULL AND (v_target_row.club_id IS DISTINCT FROM NEW.club_id OR v_target_row.union_id IS NOT NULL)) THEN
   RAISE EXCEPTION 'SATELLITE_NEW_TARGET_UNSUPPORTED' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN NEW;
END $function$;

-- public.fn_ca_capture_satellite_seat_entitlement()
CREATE OR REPLACE FUNCTION public.fn_ca_capture_satellite_seat_entitlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_l public.chip_ledger%ROWTYPE;
  v_rows integer;
  v_prize numeric;
  v_bounty numeric;
  v_bucket text;
BEGIN
  IF NEW.delivery_kind IS DISTINCT FROM 'seat' THEN
    RETURN NULL;
  END IF;
  -- DIAMOND PHASE 9: a Diamond seat's refund entitlement is its target entry
  -- custody row - the Diamond refund authority returns it whole, as it
  -- returns a paid entry - so no chip entitlement is captured for it. The
  -- seat must carry its exact custody-to-custody evidence instead.
  IF public.fn_poker_diamond_tournament(NEW.tournament_id) THEN
    IF NEW.registration_id IS NULL OR NOT EXISTS (
         SELECT 1
           FROM public.poker_diamond_tournament_ledger li
           JOIN public.poker_diamond_custody c ON c.id = li.custody_id
          WHERE li.idempotency_key = 'poker-tournament-seat-in:' || NEW.idempotency_key
            AND li.kind = 'entry' AND li.user_id = NEW.user_id
            AND li.amount = NEW.amount AND li.registration_id = NEW.registration_id
            AND c.purpose = 'tournament_entry' AND c.user_id = NEW.user_id
            AND c.entry_key = 'entry:' || NEW.registration_id::text)
       OR NOT EXISTS (
         SELECT 1
           FROM public.poker_diamond_tournament_ledger lo
          WHERE lo.idempotency_key = 'poker-tournament-seat-out:' || NEW.idempotency_key
            AND lo.tournament_id = NEW.tournament_id AND lo.kind = 'prize'
            AND lo.user_id = NEW.user_id AND lo.amount = NEW.amount) THEN
      RAISE EXCEPTION
        'Diamond satellite seat award has no exact custody-to-custody evidence'
        USING ERRCODE = 'P0404';
    END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO v_h FROM public.tournament_satellite_settlements h
   WHERE h.tournament_id=NEW.tournament_id;
  SELECT * INTO v_l FROM public.chip_ledger l
   WHERE l.idempotency_key=NEW.idempotency_key||':pool_transfer'
     AND l.from_type='prize_liability'
     AND l.from_entity_id=NEW.tournament_id
     AND l.to_type='prize_liability'
     AND l.to_entity_id=v_h.target_id
     AND l.amount=NEW.amount;
  IF v_h.tournament_id IS NULL OR v_l.id IS NULL OR v_l.club_id IS NULL
     OR NEW.registration_id IS NULL
     OR v_h.ticket_cost IS DISTINCT FROM NEW.amount
     OR v_h.ticket_cost IS DISTINCT FROM
          round(v_h.target_buy_in+v_h.target_fee,2) THEN
    RAISE EXCEPTION
      'satellite seat award has no exact target contract and pool-transfer source'
      USING ERRCODE = 'P0404';
  END IF;
  -- A BOUNTY SEAT IS REFUNDED BY ITS SPLIT (2026-10-16). Its leg books
  -- prize plus bounty as gross and the bounty on the bounty rail
  -- (entry_split_version 2), so its entitlement returns exactly those
  -- parts from the satellite_gross bucket. A plain seat is unchanged.
  IF v_l.metadata->>'entry_split_version' = '2' THEN
    v_prize := (v_l.metadata->>'entry_prize')::numeric;
    v_bounty := (v_l.metadata->>'entry_bounty')::numeric;
    v_bucket := 'satellite_gross';
    IF v_prize IS NULL OR v_bounty IS NULL
       OR v_prize < 0 OR v_bounty < 0
       OR round(v_prize + v_bounty, 2) IS DISTINCT FROM v_h.target_buy_in
       OR (v_l.metadata->>'entry_fee')::numeric IS DISTINCT FROM v_h.target_fee THEN
      RAISE EXCEPTION
        'satellite bounty seat transfer does not carry its exact target entry split'
        USING ERRCODE = 'P0404';
    END IF;
  ELSE
    v_prize := v_h.target_buy_in;
    v_bounty := 0;
    v_bucket := 'satellite_in';
  END IF;
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    escrow_bucket,evidence_kind,created_at)
  VALUES(
    v_h.target_id,NEW.user_id,'satellite_seat','satellite_seat',
    v_l.club_id,NEW.amount,v_prize,v_bounty,v_h.target_fee,
    v_l.id,NEW.registration_id,NEW.tournament_id,NEW.place,
    v_bucket,'atomic_satellite_seat',transaction_timestamp())
  ON CONFLICT(source_ledger_id) DO NOTHING;
  SELECT count(*) INTO v_rows
    FROM public.tournament_refund_entitlements e
   WHERE e.source_ledger_id=v_l.id
     AND e.tournament_id=v_h.target_id AND e.user_id=NEW.user_id
     AND e.entitlement_kind='satellite_seat'
     AND e.charge_category='satellite_seat'
     AND e.refund_wallet_club_id=v_l.club_id
     AND e.gross=NEW.amount
     AND e.refund_prize=v_prize
     AND e.refund_bounty=v_bounty AND e.refund_fee=v_h.target_fee
     AND e.escrow_bucket=v_bucket
     AND e.registration_id=NEW.registration_id
     AND e.source_satellite_id=NEW.tournament_id
     AND e.source_award_place=NEW.place;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite seat entitlement identity conflicts with its source'
      USING ERRCODE = 'P0404';
  END IF;
  RETURN NULL;
END;
$function$;

-- public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)
CREATE OR REPLACE FUNCTION public.fn_ca_find_tournament_entry_ticket_for(p_tournament_id uuid, p_beneficiary_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid:=p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_is_bounty boolean;
  v_candidate_count integer:=0;
BEGIN
  IF p_tournament_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament and beneficiary ids are required'
      USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_found','ticket_id',NULL);
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
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;

  -- Presence and validity are separate facts. If an exact-price ticket exists
  -- but its issue proof or scope is unreadable, do not erase it through an
  -- inner join and silently charge the wallet instead.
  SELECT count(*) INTO v_candidate_count
    FROM public.tournament_tickets tk
   WHERE tk.holder_id=v_uid
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
        WHERE m.club_id=tk.club_id AND m.user_id=v_uid
          AND COALESCE(m.status,'active') IN ('active','approved'))
     AND (v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
     AND (v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(
       SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
     AND public.fn_tournament_club_for_user(
           v_uid,p_tournament_id,tk.club_id) IS NOT DISTINCT FROM tk.club_id;

  SELECT tk.* INTO v_ticket
    FROM public.tournament_tickets tk
   WHERE tk.holder_id=v_uid
     AND tk.status='issued'
     AND tk.redemption_mode='tournament_entry_only'
     AND tk.value=v_split.charge
     AND tk.entry_prize=v_split.prize
     AND tk.entry_bounty=v_split.bounty
     AND tk.entry_fee=v_split.rake
     AND EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=tk.club_id AND m.user_id=v_uid
          AND COALESCE(m.status,'active') IN ('active','approved'))
     AND (v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
     AND (v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(
       SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
     AND public.fn_tournament_club_for_user(
           v_uid,p_tournament_id,tk.club_id) IS NOT DISTINCT FROM tk.club_id
     AND (
       (tk.source_refund_entitlement_id IS NOT NULL
        AND tk.source_satellite_award_place IS NULL
        AND EXISTS(
          SELECT 1
            FROM public.tournament_refund_entitlements source_e
            JOIN public.chip_ledger issue_l
              ON issue_l.idempotency_key='tourney:'
                   ||source_e.tournament_id::text
                   ||':satellite-ticket-return:'||source_e.id::text
             AND issue_l.from_type='prize_liability'
             AND issue_l.from_entity_id=source_e.tournament_id
             AND issue_l.to_type='escrow' AND issue_l.to_entity_id=tk.id
             AND issue_l.club_id=tk.club_id AND issue_l.amount=tk.value
             AND issue_l.category='ticket_issue'
           WHERE source_e.id=tk.source_refund_entitlement_id
             AND source_e.user_id=v_uid
             AND source_e.entitlement_kind IN
                   ('satellite_seat','tournament_ticket')
             AND source_e.gross=tk.value
             AND source_e.refund_prize=tk.entry_prize
             AND source_e.refund_bounty=tk.entry_bounty
             AND source_e.refund_fee=tk.entry_fee
             AND source_e.source_satellite_id=tk.source_satellite_id
             AND source_e.tournament_id=tk.source_tournament_id
             AND NOT EXISTS(
               SELECT 1 FROM public.tournament_refund_tranches tr
                WHERE tr.entitlement_id=source_e.id)
             AND (SELECT count(*)
                    FROM public.chip_transactions issue_tx
                   WHERE issue_tx.transaction_type='tournament_ticket_issue'
                     AND issue_tx.club_id=tk.club_id
                     AND issue_tx.from_user_id IS NULL
                     AND issue_tx.to_user_id=v_uid
                     AND issue_tx.amount=tk.value
                     AND issue_tx.metadata->>'ticket_id'=tk.id::text
                     AND issue_tx.metadata->>'entitlement_id'=source_e.id::text
                     AND issue_tx.metadata->>'ledger_id'=issue_l.id::text)=1))
       OR
       (tk.source_refund_entitlement_id IS NULL
        AND tk.source_satellite_award_place IS NOT NULL
        AND tk.source_tournament_id=p_tournament_id
        AND EXISTS(
          SELECT 1
            FROM public.tournament_satellite_awards source_a
            JOIN public.tournament_satellite_settlements source_h
              ON source_h.tournament_id=source_a.tournament_id
             AND source_h.target_id=p_tournament_id
            JOIN public.tournament_payouts source_p
              ON source_p.id=source_a.payout_id
             AND source_p.tournament_id=source_a.tournament_id
             AND source_p.user_id=source_a.user_id
             AND (source_p."position"=source_a.place OR source_h.receipt_version>=3)
             AND source_p.amount=source_a.amount
             AND source_p.source=source_a.payout_source
             AND source_p.idempotency_key=source_a.idempotency_key
            JOIN public.chip_ledger issue_l
              ON issue_l.idempotency_key=source_a.idempotency_key
                                            ||':ticket_escrow'
             AND issue_l.from_type='prize_liability'
             AND issue_l.from_entity_id=source_a.tournament_id
             AND issue_l.to_type='escrow' AND issue_l.to_entity_id=tk.id
             AND issue_l.club_id=tk.club_id AND issue_l.amount=tk.value
             AND issue_l.category='ticket_issue'
             AND issue_l.tournament_id=source_a.tournament_id
             AND issue_l.metadata->>'kind'='direct_satellite_entry_ticket'
             AND issue_l.metadata->>'ticket_id'=tk.id::text
             AND issue_l.metadata->>'payout_id'=source_a.payout_id::text
             AND issue_l.metadata->>'satellite_target_id'=
                   p_tournament_id::text
             AND issue_l.metadata->>'user_id'=source_a.user_id::text
             AND COALESCE(issue_l.metadata->>'position',issue_l.metadata->>'award_slot')=source_a.place::text
           WHERE source_a.tournament_id=tk.source_satellite_id
             AND source_a.place=tk.source_satellite_award_place
             AND source_a.user_id=v_uid
             AND source_a.delivery_kind='ticket'
             AND source_a.ticket_id=tk.id
             AND source_a.amount=tk.value
             AND source_a.payout_source='satellite_ticket'
             AND source_h.ticket_cost=tk.value
             -- A bounty target's seat ticket carries its bounty slice: the
             -- target's buy-in is the ticket's prize plus bounty (2026-10-16).
             AND source_h.target_buy_in=round(tk.entry_prize+tk.entry_bounty,2)
             AND source_h.target_fee=tk.entry_fee
             AND NOT EXISTS(
               SELECT 1 FROM public.wallet_credit_idempotency wallet_key
                WHERE wallet_key.key=source_a.idempotency_key)
             AND (SELECT count(*)
                    FROM public.chip_transactions issue_tx
                   WHERE issue_tx.transaction_type='tournament_ticket_issue'
                     AND issue_tx.club_id=tk.club_id
                     AND issue_tx.from_user_id IS NULL
                     AND issue_tx.to_user_id=v_uid
                     AND issue_tx.amount=tk.value
                     AND issue_tx.metadata->>'ticket_id'=tk.id::text
                     AND issue_tx.metadata->>'source_tournament_id'=
                           p_tournament_id::text
                     AND issue_tx.metadata->>'source_satellite_id'=
                           source_a.tournament_id::text
                     AND issue_tx.metadata->>'source_award_place'=
                           source_a.place::text
                     AND issue_tx.metadata->>'payout_id'=source_a.payout_id::text
                     AND issue_tx.metadata->>'ledger_id'=issue_l.id::text
                     AND issue_tx.metadata->>'idempotency_key'=
                           source_a.idempotency_key)=1))
     )
   ORDER BY tk.created_at,tk.id
   LIMIT 1;

  IF v_ticket.id IS NULL THEN
    IF v_candidate_count>0 THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','matching_tournament_ticket_unavailable',
        'ticket_id',NULL);
    END IF;
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'ticket_id',v_ticket.id,'ticket_value',v_ticket.value,
    'entry_prize',v_ticket.entry_prize,
    'entry_bounty',v_ticket.entry_bounty,'entry_fee',v_ticket.entry_fee,
    'source_satellite_id',v_ticket.source_satellite_id);
END;
$function$;

-- public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)
CREATE OR REPLACE FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(p_tournament_id uuid, p_ticket_id uuid, p_beneficiary_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid:=p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_split record;
  v_username text;
  v_registration_id uuid;
  v_ledger_id uuid;
  v_tx_id uuid;
  v_entitlement_id uuid;
  v_resolved_club uuid;
  v_is_bounty boolean;
  v_late_open boolean:=false;
  v_start_chips integer:=0;
  v_seat jsonb;
  v_seat_reason text;
  v_players_before integer;
  v_wallet_rows_before bigint;
  v_wallet_rows_after bigint;
  v_rows integer;
  v_key text;
  v_ticket_use_token uuid:=gen_random_uuid();
  v_previous_ticket_use_token text:=
    current_setting('app.ca_satellite_ticket_use_token',true);
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_ticket_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament, ticket and beneficiary ids are required'
      USING ERRCODE='22004';
  END IF;

  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_ticket FROM public.tournament_tickets tk
   WHERE tk.id=p_ticket_id FOR UPDATE;
  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_found');
  END IF;
  IF v_ticket.holder_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_owned');
  END IF;
  IF v_ticket.redemption_mode IS DISTINCT FROM 'tournament_entry_only' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_is_wallet_only');
  END IF;

  IF v_ticket.source_refund_entitlement_id IS NOT NULL THEN
    SELECT count(*) INTO v_rows
      FROM public.tournament_refund_entitlements source_e
      JOIN public.chip_ledger issue_l
        ON issue_l.idempotency_key='tourney:'
             ||source_e.tournament_id::text
             ||':satellite-ticket-return:'||source_e.id::text
       AND issue_l.from_type='prize_liability'
       AND issue_l.from_entity_id=source_e.tournament_id
       AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
       AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
       AND issue_l.category='ticket_issue'
     WHERE source_e.id=v_ticket.source_refund_entitlement_id
       AND v_ticket.source_satellite_award_place IS NULL
       AND source_e.user_id=v_uid
       AND source_e.entitlement_kind IN ('satellite_seat','tournament_ticket')
       AND source_e.gross=v_ticket.value
       AND source_e.refund_prize=v_ticket.entry_prize
       AND source_e.refund_bounty=v_ticket.entry_bounty
       AND source_e.refund_fee=v_ticket.entry_fee
       AND source_e.source_satellite_id=v_ticket.source_satellite_id
       AND source_e.tournament_id=v_ticket.source_tournament_id
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=source_e.id)
       AND (SELECT count(*) FROM public.chip_transactions issue_tx
             WHERE issue_tx.transaction_type='tournament_ticket_issue'
               AND issue_tx.club_id=v_ticket.club_id
               AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
               AND issue_tx.amount=v_ticket.value
               AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
               AND issue_tx.metadata->>'entitlement_id'=source_e.id::text
               AND issue_tx.metadata->>'ledger_id'=issue_l.id::text)=1;
  ELSE
    -- A cap-blocked satellite winner never held a target registration, so its
    -- noncash ticket is sourced directly by the immutable satellite award.
    SELECT count(*) INTO v_rows
      FROM public.tournament_satellite_awards source_a
      JOIN public.tournament_satellite_settlements source_h
        ON source_h.tournament_id=source_a.tournament_id
      JOIN public.tournament_payouts source_p ON source_p.id=source_a.payout_id
      JOIN public.chip_ledger issue_l
        ON issue_l.idempotency_key=source_a.idempotency_key||':ticket_escrow'
       AND issue_l.from_type='prize_liability'
       AND issue_l.from_entity_id=source_a.tournament_id
       AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
       AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
       AND issue_l.category='ticket_issue'
       AND issue_l.tournament_id=source_a.tournament_id
       AND issue_l.metadata->>'kind'='direct_satellite_entry_ticket'
       AND issue_l.metadata->>'ticket_id'=v_ticket.id::text
       AND issue_l.metadata->>'payout_id'=source_a.payout_id::text
       AND issue_l.metadata->>'satellite_target_id'=
             v_ticket.source_tournament_id::text
       AND issue_l.metadata->>'user_id'=source_a.user_id::text
       AND COALESCE(issue_l.metadata->>'position',issue_l.metadata->>'award_slot')=source_a.place::text
     WHERE source_a.tournament_id=v_ticket.source_satellite_id
       AND source_a.place=v_ticket.source_satellite_award_place
       AND source_a.user_id=v_uid
       AND source_a.delivery_kind='ticket'
       AND source_a.ticket_id=v_ticket.id
       AND source_a.amount=v_ticket.value
       AND source_a.payout_source='satellite_ticket'
       AND source_p.tournament_id=source_a.tournament_id
       AND source_p.user_id=source_a.user_id
       AND (source_p."position"=source_a.place OR source_h.receipt_version>=3)
       AND source_p.amount=source_a.amount
       AND source_p.source=source_a.payout_source
       AND source_p.idempotency_key=source_a.idempotency_key
       AND source_h.target_id=v_ticket.source_tournament_id
       AND source_h.ticket_cost=v_ticket.value
       -- A bounty target's seat ticket carries its bounty slice: the
       -- target's buy-in is the ticket's prize plus bounty (2026-10-16).
       AND source_h.target_buy_in=round(v_ticket.entry_prize+v_ticket.entry_bounty,2)
       AND source_h.target_fee=v_ticket.entry_fee
       AND p_tournament_id=v_ticket.source_tournament_id
       AND NOT EXISTS(
         SELECT 1 FROM public.wallet_credit_idempotency wallet_key
          WHERE wallet_key.key=source_a.idempotency_key)
       AND (SELECT count(*) FROM public.chip_transactions issue_tx
             WHERE issue_tx.transaction_type='tournament_ticket_issue'
               AND issue_tx.club_id=v_ticket.club_id
               AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
               AND issue_tx.amount=v_ticket.value
               AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
               AND issue_tx.metadata->>'source_tournament_id'=
                     p_tournament_id::text
               AND issue_tx.metadata->>'source_satellite_id'=source_a.tournament_id::text
               AND issue_tx.metadata->>'source_award_place'=source_a.place::text
               AND issue_tx.metadata->>'payout_id'=source_a.payout_id::text
               AND issue_tx.metadata->>'ledger_id'=issue_l.id::text
               AND issue_tx.metadata->>'idempotency_key'=
                     source_a.idempotency_key)=1;
  END IF;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket has no exact noncash issue evidence'
      USING ERRCODE='P0404';
  END IF;

  IF v_ticket.status='redeemed' THEN
    SELECT count(*),min(e.id::text)::uuid,min(e.registration_id::text)::uuid
      INTO v_rows,v_entitlement_id,v_registration_id
      FROM public.tournament_refund_entitlements e
      JOIN public.tournament_players tp ON tp.id=e.registration_id
     WHERE e.source_ticket_id=v_ticket.id
       AND e.entitlement_kind='tournament_ticket'
       AND e.tournament_id=p_tournament_id
       AND e.user_id=v_uid
       AND tp.tournament_id=e.tournament_id AND tp.user_id=e.user_id;
    IF v_rows=1 AND v_entitlement_id IS NOT NULL
       AND v_registration_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok',true,'replayed',true,'ticket_id',v_ticket.id,
        'registration_id',v_registration_id,
        'entitlement_id',v_entitlement_id,'wallet_chips_credited',0);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','ticket_already_used');
  END IF;
  IF v_ticket.status<>'issued' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_available');
  END IF;

  IF NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)
     AND (lower(COALESCE(v_t.variant,''))='spin'
       OR (v_t.max_players IS NOT NULL
         AND v_t.max_players>0 AND v_t.max_players<=2)) THEN
    RETURN jsonb_build_object('ok',false,'reason','seat_first_variant');
  END IF;
  IF v_t.status='RUNNING' THEN
    v_late_open:=public.fn_tournament_late_registration_open(p_tournament_id)
                 AND NOT COALESCE(v_t.prize_pool_finalized,false);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED','REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','target_pool_finalized');
  END IF;
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_full');
  END IF;
  IF EXISTS(SELECT 1 FROM public.tournament_players tp
             WHERE tp.tournament_id=p_tournament_id AND tp.user_id=v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','already_registered');
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.club_members m
     WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
       AND COALESCE(m.status,'active') IN ('active','approved')) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_membership_inactive');
  END IF;
  IF v_t.union_id IS NULL AND v_t.club_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_mismatch');
  END IF;
  IF v_t.union_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id AND NOT EXISTS(
    SELECT 1 FROM public.union_clubs uc
     WHERE uc.union_id=v_t.union_id AND uc.club_id=v_ticket.club_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_union_mismatch');
  END IF;
  v_resolved_club:=public.fn_tournament_club_for_user(
    v_uid,p_tournament_id,v_ticket.club_id);
  IF v_resolved_club IS DISTINCT FROM v_ticket.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_source_club_unavailable');
  END IF;

  IF COALESCE(v_t.authorized_to_register,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_registration_approvals a
        WHERE a.tournament_id=p_tournament_id AND a.user_id=v_uid)
     AND NOT public.is_club_admin(v_ticket.club_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized_to_register');
  END IF;
  IF COALESCE(v_t.is_vip_only,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.profiles pr
        WHERE pr.id=v_uid AND COALESCE(pr.is_vip,false)
          AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at>now()))
     AND NOT EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
          AND m.role IN ('owner','co_owner','admin','agent')) THEN
    RETURN jsonb_build_object('ok',false,'reason','vip_only');
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
     OR v_split.charge<=0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2)
     OR v_ticket.value IS DISTINCT FROM v_split.charge
     OR v_ticket.entry_prize IS DISTINCT FROM v_split.prize
     OR v_ticket.entry_bounty IS DISTINCT FROM v_split.bounty
     OR v_ticket.entry_fee IS DISTINCT FROM v_split.rake THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_entry_contract_mismatch');
  END IF;

  IF COALESCE(v_t.early_bird_enabled,false)
     AND now()<v_t.start_time AND COALESCE(v_t.early_bird_chips,0)>0 THEN
    v_start_chips:=v_t.early_bird_chips;
  END IF;
  SELECT COALESCE(NULLIF(p.display_name,''),NULLIF(p.username,''),'Player')
    INTO v_username FROM public.profiles p WHERE p.id=v_uid;
  v_username:=COALESCE(v_username,'Player');

  PERFORM public.fn_ca_escrow_apply(p_tournament_id,'ticket admission prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  SELECT count(*) INTO v_wallet_rows_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     -- A running bounty event's bank is its pool less what knockouts have
     -- already paid from it, so a late ticket seat compares against that
     -- (2026-10-16), as both settlement authorities do.
     OR v_escrow_before.bounty_balance IS DISTINCT FROM
          round(COALESCE(v_t.bounty_pool,0)-COALESCE(v_t.bounty_pool_paid,0),2)
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance THEN
    RAISE EXCEPTION 'ticket admission found divergent tournament escrow'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_players(
    tournament_id,user_id,username,chips,status,current_bounty,
    mystery_bounty_value,bounties_collected,bounty_winnings,
    club_id,is_satellite_qualifier,source_satellite_id)
  VALUES(
    p_tournament_id,v_uid,v_username,v_start_chips,'registered',
    v_split.bounty,0,0,0,v_ticket.club_id,true,v_ticket.source_satellite_id)
  RETURNING id INTO v_registration_id;

  v_key:='ticket:'||v_ticket.id::text||':tournament:'
         ||p_tournament_id::text||':entry';
  INSERT INTO public.chip_ledger(
    performed_by,from_type,from_entity_id,from_label,
    to_type,to_entity_id,to_label,amount,category,club_id,tournament_id,
    idempotency_key,settlement_id,actor_service,description,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(
    v_uid,'escrow',v_ticket.id,'tournament entry ticket',
    'prize_liability',p_tournament_id,'tournaments escrow',
    v_ticket.value,'ticket_redeem',v_ticket.club_id,p_tournament_id,
    v_key,'ticket-entry:'||v_ticket.id::text,
    'fn_register_for_tournament_with_ticket',
    'Tournament-entry ticket committed to tournament admission',
    jsonb_build_object(
      'kind','tournament_entry_ticket_admission','ticket_id',v_ticket.id,
      'user_id',v_uid,'registration_id',v_registration_id,
      'source_tournament_id',v_ticket.source_tournament_id,
      'source_satellite_id',v_ticket.source_satellite_id,
      'entry_prize',v_ticket.entry_prize,
      'entry_bounty',v_ticket.entry_bounty,'entry_fee',v_ticket.entry_fee),
    v_ticket.value,0,
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance,2),
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance+v_ticket.value,2))
  RETURNING id INTO v_ledger_id;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'tournament-entry ticket admission',
    p_gross_in=>v_ticket.value,p_bounty_in=>v_ticket.entry_bounty);
  IF v_ticket.entry_fee>0 THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_ticket.club_id,v_ticket.entry_fee,v_ticket.value,1,
      0,true,p_tournament_id,'fn_register_for_tournament_with_ticket',
      jsonb_build_object(
        'kind','tournament_ticket_entry_fee','user_id',v_uid,
        'registration_id',v_registration_id,'ticket_id',v_ticket.id));
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before+1,
         prize_pool=round(v_t.prize_pool+v_ticket.entry_prize,2),
         bounty_pool=round(v_t.bounty_pool+v_ticket.entry_bounty,2),
         total_rake=round(v_t.total_rake+v_ticket.entry_fee,2),
         updated_at=now()
   WHERE id=p_tournament_id
     -- Before the start the canonical roster trigger has already counted
     -- the row inserted above. A RUNNING field is not counted on INSERT
     -- (20260922141704): this door publishes that count itself, as the
     -- wallet doors do. Expect exactly the state the trigger left.
     AND current_players IS NOT DISTINCT FROM CASE
       WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before+1
       ELSE v_players_before
     END
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'ticket admission tournament cache changed'
      USING ERRCODE='55000';
  END IF;

  INSERT INTO public.tournament_ticket_admission_authorizations(
    token,ticket_id,tournament_id,user_id,registration_id)
  VALUES(
    v_ticket_use_token,v_ticket.id,p_tournament_id,v_uid,v_registration_id);

  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',v_ticket_use_token::text,true);
  UPDATE public.tournament_tickets
     SET status='redeemed',redeemed_at=transaction_timestamp()
   WHERE id=v_ticket.id AND status='issued';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',
    COALESCE(v_previous_ticket_use_token,''),true);
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket changed during admission'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.tournament_ticket_admission_authorizations a
     WHERE a.token=v_ticket_use_token) THEN
    RAISE EXCEPTION
      'tournament-entry ticket authorization was not consumed by admission'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    source_ticket_id,escrow_bucket,evidence_kind,created_at)
  VALUES(
    p_tournament_id,v_uid,'tournament_ticket','tournament_ticket',
    v_ticket.club_id,v_ticket.value,v_ticket.entry_prize,
    v_ticket.entry_bounty,v_ticket.entry_fee,v_ledger_id,
    v_registration_id,v_ticket.source_satellite_id,NULL,v_ticket.id,
    'ticket_gross','atomic_tournament_ticket',transaction_timestamp())
  RETURNING id INTO v_entitlement_id;

  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_ticket.club_id,v_uid,NULL,v_ticket.value,
    'tournament_ticket_entry','Tournament-Entry Ticket Used',NULL,
    jsonb_build_object(
      'ticket_id',v_ticket.id,'holder_id',v_uid,
      'target_tournament_id',p_tournament_id,
      'registration_id',v_registration_id,
      'entitlement_id',v_entitlement_id,'ledger_id',v_ledger_id,
      'idempotency_key',v_key,'wallet_chips_credited',0))
  RETURNING id INTO v_tx_id;

  IF v_late_open THEN
    BEGIN
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    EXCEPTION WHEN SQLSTATE '55000' THEN
      PERFORM public.fn_create_late_registration_capacity(p_tournament_id);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    END;
    v_seat_reason:=v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean,false)
       AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
      PERFORM public.fn_create_late_registration_capacity(p_tournament_id);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
      v_seat_reason:=v_seat->>'reason';
      IF NOT COALESCE((v_seat->>'ok')::boolean,false)
         AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
        RAISE EXCEPTION
          'Late ticket admission could not seat the player (%)',
          COALESCE(v_seat_reason,'unknown') USING ERRCODE='55000';
      END IF;
    END IF;
    -- The wake reasons are a closed list (fn_emit_tournament_manager_wake
    -- and tournament_manager_wakes_reason_check); the engine acts on
    -- 'late_registration'. A reason outside it rolled back every late
    -- ticket entry (20261012).
    PERFORM public.fn_emit_tournament_manager_wake(
      p_tournament_id,'late_registration');
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT count(*) INTO v_wallet_rows_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_after.prize_balance IS DISTINCT FROM
       round(v_escrow_before.prize_balance+v_ticket.entry_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
       round(v_escrow_before.bounty_balance+v_ticket.entry_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
       round(v_escrow_before.fee_balance+v_ticket.entry_fee,2)
     OR v_wallet_rows_after IS DISTINCT FROM v_wallet_rows_before THEN
    RAISE EXCEPTION 'ticket admission did not preserve exact noncash rails'
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_ticket.id,
    'registration_id',v_registration_id,'entitlement_id',v_entitlement_id,
    'ledger_id',v_ledger_id,'transaction_id',v_tx_id,
    'ticket_value',v_ticket.value,'wallet_chips_credited',0,
    'prize_contribution',v_ticket.entry_prize,
    'bounty_contribution',v_ticket.entry_bounty,
    'fee_contribution',v_ticket.entry_fee,'late_registration',v_late_open,
    'seat',v_seat);
END;
$function$;

-- public.fn_ca_satellite_settlement_receipt(uuid,uuid)
CREATE OR REPLACE FUNCTION public.fn_ca_satellite_settlement_receipt(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_source record;
  v_target record;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_rake_settlement record;
  v_field_size integer;
  v_position_count integer;
  v_rows integer;
  v_expected_rows integer;
  v_amount numeric;
  v_rake numeric;
  v_awards jsonb := '[]'::jsonb;
  v_seats jsonb := '[]'::jsonb;
  v_remainder jsonb := NULL;
  v_winner_amount numeric := 0;
  v_source_table_ids uuid[];
  v_source_seat_ids uuid[];
  v_durable_released_ids uuid[];
  v_durable_released_count integer;
  v_diamond boolean := false;              -- DIAMOND PHASE 9
  v_entry_prize numeric;                   -- 2026-10-16: the target entry split
  v_entry_bounty numeric;                  -- 2026-10-16: the target entry split
BEGIN
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite receipt requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'satellite % has no immutable settlement header',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'satellite % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '55000';
  END IF;
  IF v_h.receipt_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'satellite % has unsupported receipt version %',
      p_tournament_id, v_h.receipt_version USING ERRCODE = 'P0404';
  END IF;

  v_diamond := public.fn_poker_diamond_tournament(p_tournament_id);  -- DIAMOND PHASE 9
  -- Target lifecycle state is intentionally absent from replay. A target may
  -- close after commit without changing what was already delivered.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_h.target_id)
   ORDER BY CASE WHEN t.id = v_h.target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.ended_at,
         t.current_players, t.on_break, t.break_started_at, t.break_ends_at
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'satellite % source row is missing',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_source.status, '')) <> 'COMPLETED'
     OR COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE
     OR v_source.ended_at IS NULL
     OR v_source.ended_at IS DISTINCT FROM v_h.source_closed_at
     OR v_source.current_players IS DISTINCT FROM 0
     OR v_source.on_break IS DISTINCT FROM false
     OR v_source.break_started_at IS NOT NULL
     OR v_source.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'satellite % receipt is not attached to one completed close',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % no longer identifies as a satellite',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_source.satellite_target_id, v_source.satellite_target)
       IS DISTINCT FROM v_h.target_id
     OR v_source.prize_pool IS NULL
     OR v_source.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_source.prize_pool, 2) IS DISTINCT FROM v_h.pool
     OR COALESCE(v_source.satellite_seats, 0) IS DISTINCT FROM v_h.advertised_seats
     OR v_h.pool < v_h.advertised_seats * v_h.ticket_cost
     OR floor(v_h.pool / v_h.ticket_cost)::integer IS DISTINCT FROM v_h.ticket_award_count
     OR round(v_h.pool - v_h.ticket_award_count * v_h.ticket_cost, 2)
          IS DISTINCT FROM v_h.remainder THEN
    RAISE EXCEPTION 'satellite % immutable receipt disagrees with its locked contract',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id,t.buy_in_amount,t.buy_in_fee,t.bounty_amount,t.is_bounty,
         t.is_pko,t.is_mystery_bounty,t.is_premium_spin,t.variant,
         t.tournament_type,t.club_id
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_h.target_id
   FOR SHARE;
  -- A delivered seat or ticket into a bounty target carries the target's
  -- own entry split (2026-10-16). The economic columns are immutable after
  -- the first seat or ticket, so the split read now is the one booked.
  SELECT s.prize, s.bounty INTO v_entry_prize, v_entry_bounty
    FROM public.fn_tournament_entry_split(
      v_h.target_buy_in, v_h.target_fee, v_target.bounty_amount,
      COALESCE(v_target.is_bounty,false) OR COALESCE(v_target.is_pko,false)
        OR COALESCE(v_target.is_mystery_bounty,false)) s;
  IF v_target.id IS NULL
     OR v_h.target_was_missing IS DISTINCT FROM false
     OR v_h.target_contract_version IS NOT NULL
     OR ((v_h.seat_count > 0 OR v_h.entry_ticket_count > 0) AND (
          v_target.buy_in_amount IS DISTINCT FROM v_h.target_buy_in
       OR COALESCE(v_target.buy_in_fee,0) IS DISTINCT FROM v_h.target_fee
       OR v_entry_prize IS NULL OR v_entry_bounty IS NULL
       OR v_entry_prize < 0 OR v_entry_bounty < 0
       OR round(v_entry_prize + v_entry_bounty, 2)
            IS DISTINCT FROM v_h.target_buy_in
       OR (v_diamond AND v_entry_bounty <> 0)
       OR COALESCE(v_target.is_premium_spin,false)
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN')) THEN
    RAISE EXCEPTION 'satellite % immutable receipt lost its locked target row',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- The header is the immutable settlement-time contract. Replay proves that
  -- exact value through its award, transfer and fee evidence. The terminal
  -- hardening migration also freezes the target's economic columns after its
  -- first actual seat, so cancellation and unregister use the same split.

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_h.target_id)
   ORDER BY tp.tournament_id, tp.id FOR SHARE;
  SELECT count(*), count(DISTINCT tp.position)
    INTO v_field_size, v_position_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_field_size <> v_h.field_size
     OR v_position_count <> v_h.field_size
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND (tp.position IS NULL OR tp.position < 1 OR tp.position > v_h.field_size)
    ) OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.position = 1 AND tp.status::text = 'winner'
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position > 1
          AND tp.status::text IS DISTINCT FROM 'eliminated'
     ) THEN
    RAISE EXCEPTION 'satellite % receipt has no exact final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A satellite is not terminal while its felt still owns live seats. The
  -- header freezes every source table and seat identity, plus the subset that
  -- this settlement itself released. Replay requires the exact same durable
  -- rows, every table closed at zero and no live seat left behind.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_durable_released_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND ts.left_at IS NOT DISTINCT FROM v_h.settled_at
     AND ts.status IS NOT DISTINCT FROM 'left'
     AND ts.leave_pending IS FALSE
     AND ts.is_sitting_out IS FALSE
     AND ts.is_away IS FALSE
     AND ts.sit_out_at IS NULL
     AND ts.scheduled_leave_hands IS NULL;
  v_durable_released_count := cardinality(v_durable_released_ids);
  IF v_source_table_ids IS DISTINCT FROM v_h.source_table_ids
     OR cardinality(v_source_table_ids) IS DISTINCT FROM v_h.source_table_count
     OR v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR cardinality(v_source_seat_ids) IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % source table or seat closeout differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  IF v_rows <> v_h.ticket_award_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'seat')
          <> v_h.seat_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'cash')
          <> v_h.cash_ticket_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'ticket')
          <> v_h.entry_ticket_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
         JOIN public.tournament_players tp
           ON tp.tournament_id = p_tournament_id AND tp.position = a.place
        WHERE a.tournament_id = p_tournament_id
          AND (a.place > v_h.ticket_award_count
            OR a.user_id IS DISTINCT FROM tp.user_id
            OR a.amount IS DISTINCT FROM v_h.ticket_cost)
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position BETWEEN 1 AND v_h.ticket_award_count
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_satellite_awards a
             WHERE a.tournament_id = p_tournament_id
               AND a.place = tp.position AND a.user_id = tp.user_id)
     ) THEN
    RAISE EXCEPTION 'satellite % has incomplete or non-contiguous award lines',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Every line has one exact payout row. Cash lines additionally prove the
  -- wallet credit and closed obligation; seats prove the registration and
  -- source-to-target funding leg below.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id = a.payout_id
     WHERE a.tournament_id = p_tournament_id
       AND (p.id IS NULL
         OR p.tournament_id IS DISTINCT FROM p_tournament_id
         OR p.user_id IS DISTINCT FROM a.user_id
         OR p."position" IS DISTINCT FROM a.place
         OR p.amount IS DISTINCT FROM a.amount
         OR p.source IS DISTINCT FROM a.payout_source
         OR p.idempotency_key IS DISTINCT FROM a.idempotency_key)
  ) THEN
    RAISE EXCEPTION 'satellite % award line has no exact payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_obligations o ON o.id = a.obligation_id
      LEFT JOIN public.wallet_credit_idempotency k ON k.key = a.idempotency_key
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'cash'
       AND (o.id IS NULL
         OR o.tournament_id IS DISTINCT FROM p_tournament_id
         OR o.kind IS DISTINCT FROM a.obligation_kind
         OR o.place IS DISTINCT FROM a.place
         OR o.user_id IS DISTINCT FROM a.user_id
         OR o.amount_owed IS DISTINCT FROM a.amount
         OR o.amount_paid IS DISTINCT FROM a.amount
         OR o.settled_at IS NULL
         OR k.key IS NULL
         OR k.user_id IS DISTINCT FROM a.user_id
         OR k.amount IS DISTINCT FROM a.amount)
  ) THEN
    RAISE EXCEPTION 'satellite % cash ticket has no exact wallet/debt evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A cap-blocked full award remains the source pool's money but is held in a
  -- noncash, target-scoped ticket escrow. Prove the immutable award identity,
  -- exact issue journal and absence of a wallet credit on every replay.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id=a.payout_id
      LEFT JOIN public.tournament_tickets tk ON tk.id=a.ticket_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key=a.idempotency_key||':ticket_escrow'
       AND l.to_type='escrow' AND l.to_entity_id=a.ticket_id
     WHERE a.tournament_id=p_tournament_id
       AND a.delivery_kind='ticket'
       AND (tk.id IS NULL
         OR tk.issued_by IS DISTINCT FROM
              '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
         OR tk.holder_id IS DISTINCT FROM a.user_id
         OR tk.value IS DISTINCT FROM a.amount
         OR tk.status NOT IN ('issued','redeemed')
         OR tk.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
         OR tk.source_tournament_id IS DISTINCT FROM v_h.target_id
         OR tk.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR tk.source_refund_entitlement_id IS NOT NULL
         OR tk.source_satellite_award_place IS DISTINCT FROM a.place
         OR tk.entry_prize IS DISTINCT FROM v_entry_prize
         OR tk.entry_bounty IS DISTINCT FROM v_entry_bounty
         OR tk.entry_fee IS DISTINCT FROM v_h.target_fee
         OR p.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR p.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR p.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR p.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR l.id IS NULL
         OR l.status IS DISTINCT FROM 'posted'
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'escrow'
         OR l.to_entity_id IS DISTINCT FROM tk.id
         OR l.amount IS DISTINCT FROM a.amount
         OR l.category IS DISTINCT FROM 'ticket_issue'
         OR l.club_id IS DISTINCT FROM tk.club_id
         OR l.tournament_id IS DISTINCT FROM p_tournament_id
         OR l.settlement_id IS DISTINCT FROM
              'satellite-ticket:'||tk.id::text
         OR l.actor_service IS DISTINCT FROM 'fn_settle_satellite_tournament'
         OR l.pre_from_balance IS DISTINCT FROM
              round(v_h.pool-(a.place-1)*v_h.ticket_cost,2)
         OR l.post_from_balance IS DISTINCT FROM
              round(v_h.pool-a.place*v_h.ticket_cost,2)
         OR l.pre_to_balance IS DISTINCT FROM 0::numeric
         OR l.post_to_balance IS DISTINCT FROM a.amount
         OR l.metadata->>'kind' IS DISTINCT FROM
              'direct_satellite_entry_ticket'
         OR l.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR l.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR l.metadata->>'payout_id' IS DISTINCT FROM a.payout_id::text
         OR l.metadata->>'satellite_id' IS DISTINCT FROM p_tournament_id::text
         OR l.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR l.metadata->>'user_id' IS DISTINCT FROM a.user_id::text
         OR l.metadata->>'position' IS DISTINCT FROM a.place::text
         OR (l.metadata->>'entry_prize')::numeric IS DISTINCT FROM
              v_entry_prize
         OR (l.metadata->>'entry_bounty')::numeric IS DISTINCT FROM v_entry_bounty
         OR (l.metadata->>'entry_fee')::numeric IS DISTINCT FROM v_h.target_fee
         OR l.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR EXISTS (
           SELECT 1 FROM public.wallet_credit_idempotency wallet_key
            WHERE wallet_key.key=a.idempotency_key)
         OR (SELECT count(*)
               FROM public.chip_transactions issue_tx
              WHERE issue_tx.transaction_type='tournament_ticket_issue'
                AND issue_tx.club_id=tk.club_id
                AND issue_tx.from_user_id IS NULL
                AND issue_tx.to_user_id=a.user_id
                AND issue_tx.amount=a.amount
                AND issue_tx.metadata->>'ticket_id'=tk.id::text
                AND issue_tx.metadata->>'escrow_entity_id'=tk.id::text
                AND issue_tx.metadata->>'holder_id'=a.user_id::text
                AND (issue_tx.metadata->>'value')::numeric=a.amount
                AND issue_tx.metadata->>'redemption_mode'=
                      'tournament_entry_only'
                AND issue_tx.metadata->>'source_tournament_id'=
                      v_h.target_id::text
                AND issue_tx.metadata->>'source_satellite_id'=
                      p_tournament_id::text
                AND issue_tx.metadata->>'source_award_place'=a.place::text
                AND issue_tx.metadata->>'payout_id'=a.payout_id::text
                AND issue_tx.metadata->>'ledger_id'=l.id::text
                AND issue_tx.metadata->>'idempotency_key'=a.idempotency_key
                AND issue_tx.metadata->>'wallet_chips_credited'='0') <> 1)
  ) OR (SELECT count(*) FROM public.tournament_tickets tk
         WHERE tk.source_satellite_id=p_tournament_id
           AND tk.source_satellite_award_place IS NOT NULL)
       <> v_h.entry_ticket_count
    OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type='prize_liability'
           AND l.from_entity_id=p_tournament_id
           AND l.category='ticket_issue'
           AND l.metadata->>'kind'='direct_satellite_entry_ticket')
       <> v_h.entry_ticket_count THEN
    RAISE EXCEPTION
      'satellite % direct ticket has no exact noncash escrow evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- DIAMOND PHASE 9: a Diamond seat is proved by its Diamond evidence - the
  -- satellite's prize-bank row out, the target's funded entry row in with
  -- the target's own parts, and the entry custody row named for the
  -- registration - never by a chip transfer leg or a chip fee row, which a
  -- Diamond seat does not write.
  IF v_diamond AND (EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.poker_diamond_tournament_ledger lo
        ON lo.idempotency_key = 'poker-tournament-seat-out:' || a.idempotency_key
      LEFT JOIN public.poker_diamond_tournament_ledger li
        ON li.idempotency_key = 'poker-tournament-seat-in:' || a.idempotency_key
      LEFT JOIN public.poker_diamond_custody c
        ON c.id = li.custody_id
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
         OR target_player.user_id IS DISTINCT FROM a.user_id
         OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
         OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR lo.id IS NULL
         OR lo.tournament_id IS DISTINCT FROM p_tournament_id
         OR lo.kind IS DISTINCT FROM 'prize'
         OR lo.user_id IS DISTINCT FROM a.user_id
         OR lo.amount IS DISTINCT FROM v_h.ticket_cost
         OR li.id IS NULL
         OR li.tournament_id IS DISTINCT FROM v_h.target_id
         OR li.kind IS DISTINCT FROM 'entry'
         OR li.user_id IS DISTINCT FROM a.user_id
         OR li.amount IS DISTINCT FROM v_h.ticket_cost
         OR li.prize_part IS DISTINCT FROM v_h.target_buy_in
         OR li.bounty_part IS DISTINCT FROM 0
         OR li.fee_part IS DISTINCT FROM v_h.target_fee
         OR li.registration_id IS DISTINCT FROM a.registration_id
         OR li.wallet_journal_id IS DISTINCT FROM lo.wallet_journal_id
         OR c.id IS NULL
         OR c.user_id IS DISTINCT FROM a.user_id
         OR c.purpose IS DISTINCT FROM 'tournament_entry'
         OR c.target_id IS DISTINCT FROM v_h.target_id
         OR c.entry_key IS DISTINCT FROM 'entry:' || a.registration_id::text)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_satellite_id = p_tournament_id
            AND tk.holder_id = tp.user_id
            AND tk.source_tournament_id = tp.tournament_id
            AND tk.status = 'redeemed'
            AND tk.redeemed_at IS NOT NULL
            AND tk.source_satellite_award_place IS NOT NULL)
  ) OR (SELECT count(*) FROM public.poker_diamond_tournament_ledger lo
         WHERE lo.tournament_id = p_tournament_id
           AND lo.kind = 'prize'
           AND lo.idempotency_key LIKE 'poker-tournament-seat-out:tourney:'
                                       || p_tournament_id::text || ':seat:%')
       <> v_h.seat_count) THEN
    RAISE EXCEPTION 'satellite % has malformed or extra Diamond seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF NOT v_diamond AND (EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key = 'tourney:' || p_tournament_id::text
                               || ':seat:' || a.user_id::text || ':pool_transfer'
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
           OR target_player.user_id IS DISTINCT FROM a.user_id
           OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
           OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR l.id IS NULL
         OR l.amount IS DISTINCT FROM v_h.ticket_cost
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM v_h.target_id
         OR l.category IS DISTINCT FROM 'tournament_buyin'
         OR l.metadata->>'registration_id' IS DISTINCT FROM a.registration_id::text
         -- A bounty seat's leg names its exact split; a plain seat's never does.
         OR l.metadata->>'entry_split_version' IS DISTINCT FROM
              (CASE WHEN v_entry_bounty > 0 THEN '2' END)
         OR (v_entry_bounty > 0 AND (
              (l.metadata->>'entry_prize')::numeric IS DISTINCT FROM v_entry_prize
           OR (l.metadata->>'entry_bounty')::numeric IS DISTINCT FROM v_entry_bounty
           OR (l.metadata->>'entry_fee')::numeric IS DISTINCT FROM v_h.target_fee)))
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_satellite_id = p_tournament_id
            AND tk.holder_id = tp.user_id
            AND tk.source_tournament_id = tp.tournament_id
            AND tk.status = 'redeemed'
            AND tk.redeemed_at IS NOT NULL
            AND tk.source_satellite_award_place IS NOT NULL)
  ) OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type = 'prize_liability'
           AND l.from_entity_id = p_tournament_id
           AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                          || ':seat:%:pool_transfer')
       <> v_h.seat_count) THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), round(COALESCE(sum(r.rake_amount), 0), 2)
    INTO v_rows, v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = v_h.target_id
     AND r.is_tournament
     AND r.source = 'fn_award_satellite_seat'
     AND r.metadata->>'satellite_id' = p_tournament_id::text;
  IF NOT v_diamond AND (v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR v_rake IS DISTINCT FROM round(v_h.seat_count * v_h.target_fee, 2)
     OR (SELECT count(DISTINCT r.metadata->>'registration_id')
           FROM public.rake_records r
          WHERE r.tournament_id = v_h.target_id
            AND r.is_tournament
            AND r.source = 'fn_award_satellite_seat'
            AND r.metadata->>'satellite_id' = p_tournament_id::text)
          <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_h.target_id
          AND r.is_tournament
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text
          AND (r.rake_amount IS DISTINCT FROM v_h.target_fee
            OR r.pot_size IS DISTINCT FROM v_h.ticket_cost
            OR r.metadata->>'kind' IS DISTINCT FROM 'satellite_seat_entry_fee'
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_satellite_awards a
               WHERE a.tournament_id = p_tournament_id
                 AND a.delivery_kind = 'seat'
                 AND a.user_id::text = r.metadata->>'user_id'
                 AND a.registration_id::text = r.metadata->>'registration_id'))
     ) OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.delivery_kind = 'seat'
          AND v_h.target_fee > 0
          AND (SELECT count(*)
                 FROM public.rake_records r
                WHERE r.tournament_id = v_h.target_id
                  AND r.is_tournament
                  AND r.source = 'fn_award_satellite_seat'
                  AND r.metadata->>'kind' = 'satellite_seat_entry_fee'
                  AND r.metadata->>'satellite_id' = p_tournament_id::text
                  AND r.metadata->>'user_id' = a.user_id::text
                  AND r.metadata->>'registration_id' = a.registration_id::text
                  AND r.rake_amount = v_h.target_fee
                  AND r.pot_size = v_h.ticket_cost) <> 1
     )) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
              AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed);
  IF v_rows <> (v_h.cash_ticket_count
                + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'satellite % has missing or extra obligation evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.remainder > 0 THEN
    IF (SELECT count(*) FROM public.tournament_satellite_remainders r
         WHERE r.tournament_id = p_tournament_id) <> 1
       OR NOT EXISTS (
      SELECT 1
        FROM public.tournament_players bubble
        JOIN public.tournament_satellite_remainders r
          ON r.tournament_id = p_tournament_id
         AND r.user_id = bubble.user_id
         AND r.place = v_h.bubble_position
         AND r.amount = v_h.remainder
        JOIN public.tournament_payouts p
          ON p.id = r.payout_id
         AND p.tournament_id = p_tournament_id
         AND p.user_id = bubble.user_id
         AND p."position" IS NOT DISTINCT FROM r.payout_position
         AND p.amount = v_h.remainder
         AND p.source = r.payout_source
         AND p.idempotency_key = r.idempotency_key
        JOIN public.tournament_obligations o
          ON o.id = r.obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = r.obligation_kind
         AND o.place IS NOT DISTINCT FROM r.obligation_place
         AND o.user_id = bubble.user_id
         AND o.amount_owed = v_h.remainder
         AND o.amount_paid = v_h.remainder
         AND o.settled_at IS NOT NULL
        JOIN public.wallet_credit_idempotency k
          ON k.key = r.idempotency_key
         AND k.user_id = bubble.user_id
         AND k.amount = v_h.remainder
       WHERE bubble.tournament_id = p_tournament_id
         AND bubble.user_id = v_h.bubble_user_id
         AND bubble.position = v_h.bubble_position
         AND (
           (r.evidence_kind = 'atomic'
             AND r.payout_position IS NOT DISTINCT FROM r.place
             AND r.obligation_place IS NOT DISTINCT FROM r.place
             AND r.idempotency_key = 'tourney:' || p_tournament_id::text
                 || ':satellite_remainder:place:' || r.place::text)
           OR r.evidence_kind = 'legacy_20260908_682')
    ) THEN
      RAISE EXCEPTION 'satellite % has no exact single-bubble remainder payment',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_remainder := jsonb_build_object(
      'user_id', v_h.bubble_user_id,
      'position', v_h.bubble_position,
      'amount', v_h.remainder);
  ELSIF EXISTS (SELECT 1 FROM public.tournament_satellite_remainders r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source = 'satellite_remainder'
     ) THEN
    RAISE EXCEPTION 'satellite % has remainder evidence when remainder is zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_expected_rows := v_h.ticket_award_count
                     + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END;
  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_rows, v_amount
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_rows <> v_expected_rows OR v_amount IS DISTINCT FROM v_h.pool THEN
    RAISE EXCEPTION
      'satellite % payout evidence has % rows / % chips, expected % / %',
      p_tournament_id, v_rows, v_amount, v_expected_rows, v_h.pool
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.prize IS DISTINCT FROM CASE
         WHEN tp.position BETWEEN 1 AND v_h.ticket_award_count THEN v_h.ticket_cost
         WHEN v_h.remainder > 0 AND tp.position = v_h.bubble_position
           THEN v_h.remainder
         ELSE 0::numeric
       END
  ) THEN
    RAISE EXCEPTION 'satellite % prize cache disagrees with its receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.prize_out IS DISTINCT FROM v_h.pool
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.closed_at IS DISTINCT FROM v_h.source_escrow_closed_at
     OR v_source_escrow.close_note IS DISTINCT FROM v_h.source_escrow_close_note
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION 'satellite % did not close every escrow bank at zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_rake_settlement
    FROM public.tournament_rake_settlements s
   WHERE s.tournament_id = p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  IF v_diamond THEN
    -- DIAMOND PHASE 9: a Diamond satellite's fee is its fee bank, settled to
    -- the house, not a rake_records sum.
    SELECT e.fee_balance + e.fee_out INTO v_rake
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF v_rake_settlement.tournament_id IS NULL
     OR v_rake_settlement.settled_at IS NULL
     OR v_rake_settlement.amount IS DISTINCT FROM v_rake
     OR (v_rake > 0 AND v_rake_settlement.attributed_at IS NULL AND NOT v_deferred) THEN
    RAISE EXCEPTION 'satellite % rake has no exact terminal settlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'delivery_kind', a.delivery_kind,
           'payout_id', a.payout_id,
           'registration_id', a.registration_id,
           'ticket_id', a.ticket_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_awards
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'registration_id', a.registration_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_seats
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id
     AND a.delivery_kind = 'seat';

  v_winner_amount := CASE WHEN v_h.ticket_award_count > 0
                          THEN v_h.ticket_cost ELSE v_h.remainder END;
  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', 'COMPLETED',
    'tournament_id', p_tournament_id,
    'target_id', v_h.target_id,
    'winner_id', v_h.winner_id,
    'field_size', v_h.field_size,
    'pool', v_h.pool,
    'ticket_cost', v_h.ticket_cost,
    'ticket_award_count', v_h.ticket_award_count,
    'seat_count', v_h.seat_count,
    'cash_ticket_count', v_h.cash_ticket_count,
    'entry_ticket_count', v_h.entry_ticket_count,
    'awards', v_awards,
    'seats', v_seats,
    'remainder', v_remainder,
    'winner_amount', v_winner_amount,
    'source_table_count', v_h.source_table_count,
    'source_seat_count', v_h.source_seat_count,
    'released_seat_count', v_h.released_seat_count,
    'source_closeout', jsonb_build_object(
      'source_table_count', v_h.source_table_count,
      'source_table_ids', to_jsonb(v_h.source_table_ids),
      'source_seat_count', v_h.source_seat_count,
      'source_seat_ids', to_jsonb(v_h.source_seat_ids),
      'released_seat_count', v_h.released_seat_count,
      'released_seat_ids', to_jsonb(v_h.released_seat_ids),
      'closed_at', v_h.source_closed_at,
      'escrow_closed_at', v_h.source_escrow_closed_at,
      'escrow_close_note', v_h.source_escrow_close_note),
    'settled_at', v_h.settled_at,
    'receipt_version', v_h.receipt_version,
    'accounting',v_accounting);
END;
$function$;

-- public.fn_ca_satellite_cohort_receipt(uuid,uuid[])
CREATE OR REPLACE FUNCTION public.fn_ca_satellite_cohort_receipt(p_tournament_id uuid, p_observed_qualifier_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_source record;
  v_target record;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_rake_settlement record;
  v_field_size integer;
  v_position_count integer;
  v_rows integer;
  v_expected_rows integer;
  v_amount numeric;
  v_rake numeric;
  v_awards jsonb := '[]'::jsonb;
  v_seats jsonb := '[]'::jsonb;
  v_remainder jsonb := NULL;
  v_source_table_ids uuid[];
  v_source_seat_ids uuid[];
  v_durable_released_ids uuid[];
  v_durable_released_count integer;
  v_diamond boolean := false;              -- DIAMOND PHASE 9
  v_entry_prize numeric;                   -- 2026-10-16: the target entry split
  v_entry_bounty numeric;                  -- 2026-10-16: the target entry split
BEGIN
  -- Browser receipt reads take the same outer locks as manager/finish reads.
  -- Acquire them before the header or any target row, never after a row lock.
  -- Reading an already committed receipt does not require an activated ABI.
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);
  IF p_tournament_id IS NULL OR p_observed_qualifier_ids IS NULL THEN
    RAISE EXCEPTION 'satellite receipt requires tournament and observed qualifier ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'satellite % has no immutable settlement header',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_h.receipt_version IS DISTINCT FROM 3 OR v_h.winner_id IS NOT NULL
     OR v_h.qualifier_ids IS DISTINCT FROM p_observed_qualifier_ids THEN
    RAISE EXCEPTION 'satellite cohort receipt identity differs' USING ERRCODE='55000';
  END IF;

  v_diamond := public.fn_poker_diamond_tournament(p_tournament_id);  -- DIAMOND PHASE 9
  -- Target lifecycle state is intentionally absent from replay. A target may
  -- close after commit without changing what was already delivered.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_h.target_id)
   ORDER BY CASE WHEN t.id = v_h.target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.ended_at,
         t.current_players, t.on_break, t.break_started_at, t.break_ends_at
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'satellite % source row is missing',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_source.status, '')) <> 'COMPLETED'
     OR COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE
     OR v_source.ended_at IS NULL
     OR v_source.ended_at IS DISTINCT FROM v_h.source_closed_at
     OR v_source.current_players IS DISTINCT FROM 0
     OR v_source.on_break IS DISTINCT FROM false
     OR v_source.break_started_at IS NOT NULL
     OR v_source.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'satellite % receipt is not attached to one completed close',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % no longer identifies as a satellite',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_source.satellite_target_id, v_source.satellite_target)
       IS DISTINCT FROM v_h.target_id
     OR v_source.prize_pool IS NULL
     OR v_source.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_source.prize_pool, 2) IS DISTINCT FROM v_h.pool
     OR COALESCE(v_source.satellite_seats, 0) IS DISTINCT FROM v_h.advertised_seats
     OR v_h.pool < v_h.advertised_seats * v_h.ticket_cost
     OR floor(v_h.pool / v_h.ticket_cost)::integer IS DISTINCT FROM v_h.ticket_award_count
     OR round(v_h.pool - v_h.ticket_award_count * v_h.ticket_cost, 2)
          IS DISTINCT FROM v_h.remainder THEN
    RAISE EXCEPTION 'satellite % immutable receipt disagrees with its locked contract',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id,t.buy_in_amount,t.buy_in_fee,t.bounty_amount,t.is_bounty,
         t.is_pko,t.is_mystery_bounty,t.is_premium_spin,t.variant,
         t.tournament_type,t.club_id
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_h.target_id
   FOR SHARE;
  -- A delivered seat or ticket into a bounty target carries the target's
  -- own entry split (2026-10-16). The economic columns are immutable after
  -- the first seat or ticket, so the split read now is the one booked.
  SELECT s.prize, s.bounty INTO v_entry_prize, v_entry_bounty
    FROM public.fn_tournament_entry_split(
      v_h.target_buy_in, v_h.target_fee, v_target.bounty_amount,
      COALESCE(v_target.is_bounty,false) OR COALESCE(v_target.is_pko,false)
        OR COALESCE(v_target.is_mystery_bounty,false)) s;
  IF v_target.id IS NULL
     OR v_h.target_was_missing IS DISTINCT FROM false
     OR v_h.target_contract_version IS NOT NULL
     OR ((v_h.seat_count > 0 OR v_h.entry_ticket_count > 0) AND (
          v_target.buy_in_amount IS DISTINCT FROM v_h.target_buy_in
       OR COALESCE(v_target.buy_in_fee,0) IS DISTINCT FROM v_h.target_fee
       OR v_entry_prize IS NULL OR v_entry_bounty IS NULL
       OR v_entry_prize < 0 OR v_entry_bounty < 0
       OR round(v_entry_prize + v_entry_bounty, 2)
            IS DISTINCT FROM v_h.target_buy_in
       OR (v_diamond AND v_entry_bounty <> 0)
       OR COALESCE(v_target.is_premium_spin,false)
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN')) THEN
    RAISE EXCEPTION 'satellite % immutable receipt lost its locked target row',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- The header is the immutable settlement-time contract. Replay proves that
  -- exact value through its award, transfer and fee evidence. The terminal
  -- hardening migration also freezes the target's economic columns after its
  -- first actual seat, so cancellation and unregister use the same split.

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_h.target_id)
   ORDER BY tp.tournament_id, tp.id FOR SHARE;
  PERFORM public.fn_ca_assert_satellite_cohort_standings(p_tournament_id);

  -- A satellite is not terminal while its felt still owns live seats. The
  -- header freezes every source table and seat identity, plus the subset that
  -- this settlement itself released. Replay requires the exact same durable
  -- rows, every table closed at zero and no live seat left behind.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_durable_released_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND ts.left_at IS NOT DISTINCT FROM v_h.settled_at
     AND ts.status IS NOT DISTINCT FROM 'left'
     AND ts.leave_pending IS FALSE
     AND ts.is_sitting_out IS FALSE
     AND ts.is_away IS FALSE
     AND ts.sit_out_at IS NULL
     AND ts.scheduled_leave_hands IS NULL;
  v_durable_released_count := cardinality(v_durable_released_ids);
  IF v_source_table_ids IS DISTINCT FROM v_h.source_table_ids
     OR cardinality(v_source_table_ids) IS DISTINCT FROM v_h.source_table_count
     OR v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR cardinality(v_source_seat_ids) IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % source table or seat closeout differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  IF v_rows <> v_h.ticket_award_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'seat')
          <> v_h.seat_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'cash')
          <> v_h.cash_ticket_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'ticket')
          <> v_h.entry_ticket_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
         JOIN public.tournament_players tp
           ON tp.tournament_id = p_tournament_id AND tp.user_id = a.user_id
        WHERE a.tournament_id = p_tournament_id
          AND (a.place > v_h.ticket_award_count
            OR tp.user_id IS NULL
            OR a.user_id IS DISTINCT FROM CASE WHEN a.place<=cardinality(v_h.qualifier_ids)
                 THEN v_h.qualifier_ids[a.place]
                 ELSE (SELECT x.user_id FROM public.tournament_players x WHERE x.tournament_id=p_tournament_id AND x.position=a.place) END
            OR a.amount IS DISTINCT FROM v_h.ticket_cost)
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND (tp.user_id=ANY(v_h.qualifier_ids) OR tp.position BETWEEN cardinality(v_h.qualifier_ids)+1 AND v_h.ticket_award_count)
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_satellite_awards a
             WHERE a.tournament_id = p_tournament_id
               AND a.user_id = tp.user_id)
     ) THEN
    RAISE EXCEPTION 'satellite % has incomplete or non-contiguous award lines',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Every line has one exact payout row. Cash lines additionally prove the
  -- wallet credit and closed obligation; seats prove the registration and
  -- source-to-target funding leg below.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id = a.payout_id
     WHERE a.tournament_id = p_tournament_id
       AND (p.id IS NULL
         OR p.tournament_id IS DISTINCT FROM p_tournament_id
         OR p.user_id IS DISTINCT FROM a.user_id
         OR p."position" IS DISTINCT FROM (SELECT tp.position FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id AND tp.user_id=a.user_id)
         OR p.amount IS DISTINCT FROM a.amount
         OR p.source IS DISTINCT FROM a.payout_source
         OR p.idempotency_key IS DISTINCT FROM a.idempotency_key)
  ) THEN
    RAISE EXCEPTION 'satellite % award line has no exact payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_obligations o ON o.id = a.obligation_id
      LEFT JOIN public.wallet_credit_idempotency k ON k.key = a.idempotency_key
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'cash'
       AND (o.id IS NULL
         OR o.tournament_id IS DISTINCT FROM p_tournament_id
         OR o.kind IS DISTINCT FROM a.obligation_kind
         OR o.place IS DISTINCT FROM a.place
         OR o.user_id IS DISTINCT FROM a.user_id
         OR o.amount_owed IS DISTINCT FROM a.amount
         OR o.amount_paid IS DISTINCT FROM a.amount
         OR o.settled_at IS NULL
         OR k.key IS NULL
         OR k.user_id IS DISTINCT FROM a.user_id
         OR k.amount IS DISTINCT FROM a.amount)
  ) THEN
    RAISE EXCEPTION 'satellite % cash ticket has no exact wallet/debt evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A cap-blocked full award remains the source pool's money but is held in a
  -- noncash, target-scoped ticket escrow. Prove the immutable award identity,
  -- exact issue journal and absence of a wallet credit on every replay.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id=a.payout_id
      LEFT JOIN public.tournament_tickets tk ON tk.id=a.ticket_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key=a.idempotency_key||':ticket_escrow'
       AND l.to_type='escrow' AND l.to_entity_id=a.ticket_id
     WHERE a.tournament_id=p_tournament_id
       AND a.delivery_kind='ticket'
       AND (tk.id IS NULL
         OR tk.issued_by IS DISTINCT FROM
              '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
         OR tk.holder_id IS DISTINCT FROM a.user_id
         OR tk.value IS DISTINCT FROM a.amount
         OR tk.status NOT IN ('issued','redeemed')
         OR tk.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
         OR tk.source_tournament_id IS DISTINCT FROM v_h.target_id
         OR tk.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR tk.source_refund_entitlement_id IS NOT NULL
         OR tk.source_satellite_award_place IS DISTINCT FROM a.place
         OR tk.entry_prize IS DISTINCT FROM v_entry_prize
         OR tk.entry_bounty IS DISTINCT FROM v_entry_bounty
         OR tk.entry_fee IS DISTINCT FROM v_h.target_fee
         OR p.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR p.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR p.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR p.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR l.id IS NULL
         OR l.status IS DISTINCT FROM 'posted'
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'escrow'
         OR l.to_entity_id IS DISTINCT FROM tk.id
         OR l.amount IS DISTINCT FROM a.amount
         OR l.category IS DISTINCT FROM 'ticket_issue'
         OR l.club_id IS DISTINCT FROM tk.club_id
         OR l.tournament_id IS DISTINCT FROM p_tournament_id
         OR l.settlement_id IS DISTINCT FROM
              'satellite-ticket:'||tk.id::text
         OR l.actor_service IS DISTINCT FROM 'fn_settle_satellite_tournament'
         OR l.pre_from_balance IS DISTINCT FROM
              round(v_h.pool-(a.place-1)*v_h.ticket_cost,2)
         OR l.post_from_balance IS DISTINCT FROM
              round(v_h.pool-a.place*v_h.ticket_cost,2)
         OR l.pre_to_balance IS DISTINCT FROM 0::numeric
         OR l.post_to_balance IS DISTINCT FROM a.amount
         OR l.metadata->>'kind' IS DISTINCT FROM
              'direct_satellite_entry_ticket'
         OR l.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR l.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR l.metadata->>'payout_id' IS DISTINCT FROM a.payout_id::text
         OR l.metadata->>'satellite_id' IS DISTINCT FROM p_tournament_id::text
         OR l.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR l.metadata->>'user_id' IS DISTINCT FROM a.user_id::text
         OR l.metadata->>'award_slot' IS DISTINCT FROM a.place::text
         OR (l.metadata->>'entry_prize')::numeric IS DISTINCT FROM
              v_entry_prize
         OR (l.metadata->>'entry_bounty')::numeric IS DISTINCT FROM v_entry_bounty
         OR (l.metadata->>'entry_fee')::numeric IS DISTINCT FROM v_h.target_fee
         OR l.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR EXISTS (
           SELECT 1 FROM public.wallet_credit_idempotency wallet_key
            WHERE wallet_key.key=a.idempotency_key)
         OR (SELECT count(*)
               FROM public.chip_transactions issue_tx
              WHERE issue_tx.transaction_type='tournament_ticket_issue'
                AND issue_tx.club_id=tk.club_id
                AND issue_tx.from_user_id IS NULL
                AND issue_tx.to_user_id=a.user_id
                AND issue_tx.amount=a.amount
                AND issue_tx.metadata->>'ticket_id'=tk.id::text
                AND issue_tx.metadata->>'escrow_entity_id'=tk.id::text
                AND issue_tx.metadata->>'holder_id'=a.user_id::text
                AND (issue_tx.metadata->>'value')::numeric=a.amount
                AND issue_tx.metadata->>'redemption_mode'=
                      'tournament_entry_only'
                AND issue_tx.metadata->>'source_tournament_id'=
                      v_h.target_id::text
                AND issue_tx.metadata->>'source_satellite_id'=
                      p_tournament_id::text
                AND issue_tx.metadata->>'source_award_place'=a.place::text
                AND issue_tx.metadata->>'payout_id'=a.payout_id::text
                AND issue_tx.metadata->>'ledger_id'=l.id::text
                AND issue_tx.metadata->>'idempotency_key'=a.idempotency_key
                AND issue_tx.metadata->>'wallet_chips_credited'='0') <> 1)
  ) OR (SELECT count(*) FROM public.tournament_tickets tk
         WHERE tk.source_satellite_id=p_tournament_id
           AND tk.source_satellite_award_place IS NOT NULL)
       <> v_h.entry_ticket_count
    OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type='prize_liability'
           AND l.from_entity_id=p_tournament_id
           AND l.category='ticket_issue'
           AND l.metadata->>'kind'='direct_satellite_entry_ticket')
       <> v_h.entry_ticket_count THEN
    RAISE EXCEPTION
      'satellite % direct ticket has no exact noncash escrow evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- DIAMOND PHASE 9: a Diamond seat is proved by its Diamond evidence - the
  -- satellite's prize-bank row out, the target's funded entry row in with
  -- the target's own parts, and the entry custody row named for the
  -- registration - never by a chip transfer leg or a chip fee row, which a
  -- Diamond seat does not write.
  IF v_diamond AND (EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.poker_diamond_tournament_ledger lo
        ON lo.idempotency_key = 'poker-tournament-seat-out:' || a.idempotency_key
      LEFT JOIN public.poker_diamond_tournament_ledger li
        ON li.idempotency_key = 'poker-tournament-seat-in:' || a.idempotency_key
      LEFT JOIN public.poker_diamond_custody c
        ON c.id = li.custody_id
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
         OR target_player.user_id IS DISTINCT FROM a.user_id
         OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
         OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR lo.id IS NULL
         OR lo.tournament_id IS DISTINCT FROM p_tournament_id
         OR lo.kind IS DISTINCT FROM 'prize'
         OR lo.user_id IS DISTINCT FROM a.user_id
         OR lo.amount IS DISTINCT FROM v_h.ticket_cost
         OR li.id IS NULL
         OR li.tournament_id IS DISTINCT FROM v_h.target_id
         OR li.kind IS DISTINCT FROM 'entry'
         OR li.user_id IS DISTINCT FROM a.user_id
         OR li.amount IS DISTINCT FROM v_h.ticket_cost
         OR li.prize_part IS DISTINCT FROM v_h.target_buy_in
         OR li.bounty_part IS DISTINCT FROM 0
         OR li.fee_part IS DISTINCT FROM v_h.target_fee
         OR li.registration_id IS DISTINCT FROM a.registration_id
         OR li.wallet_journal_id IS DISTINCT FROM lo.wallet_journal_id
         OR c.id IS NULL
         OR c.user_id IS DISTINCT FROM a.user_id
         OR c.purpose IS DISTINCT FROM 'tournament_entry'
         OR c.target_id IS DISTINCT FROM v_h.target_id
         OR c.entry_key IS DISTINCT FROM 'entry:' || a.registration_id::text)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_satellite_id = p_tournament_id
            AND tk.holder_id = tp.user_id
            AND tk.source_tournament_id = tp.tournament_id
            AND tk.status = 'redeemed'
            AND tk.redeemed_at IS NOT NULL
            AND tk.source_satellite_award_place IS NOT NULL)
  ) OR (SELECT count(*) FROM public.poker_diamond_tournament_ledger lo
         WHERE lo.tournament_id = p_tournament_id
           AND lo.kind = 'prize'
           AND lo.idempotency_key LIKE 'poker-tournament-seat-out:tourney:'
                                       || p_tournament_id::text || ':seat:%')
       <> v_h.seat_count) THEN
    RAISE EXCEPTION 'satellite % has malformed or extra Diamond seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF NOT v_diamond AND (EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key = 'tourney:' || p_tournament_id::text
                               || ':seat:' || a.user_id::text || ':pool_transfer'
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
           OR target_player.user_id IS DISTINCT FROM a.user_id
           OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
           OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR l.id IS NULL
         OR l.amount IS DISTINCT FROM v_h.ticket_cost
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM v_h.target_id
         OR l.category IS DISTINCT FROM 'tournament_buyin'
         OR l.metadata->>'registration_id' IS DISTINCT FROM a.registration_id::text
         -- A bounty seat's leg names its exact split; a plain seat's never does.
         OR l.metadata->>'entry_split_version' IS DISTINCT FROM
              (CASE WHEN v_entry_bounty > 0 THEN '2' END)
         OR (v_entry_bounty > 0 AND (
              (l.metadata->>'entry_prize')::numeric IS DISTINCT FROM v_entry_prize
           OR (l.metadata->>'entry_bounty')::numeric IS DISTINCT FROM v_entry_bounty
           OR (l.metadata->>'entry_fee')::numeric IS DISTINCT FROM v_h.target_fee)))
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_satellite_id = p_tournament_id
            AND tk.holder_id = tp.user_id
            AND tk.source_tournament_id = tp.tournament_id
            AND tk.status = 'redeemed'
            AND tk.redeemed_at IS NOT NULL
            AND tk.source_satellite_award_place IS NOT NULL)
  ) OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type = 'prize_liability'
           AND l.from_entity_id = p_tournament_id
           AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                          || ':seat:%:pool_transfer')
       <> v_h.seat_count) THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), round(COALESCE(sum(r.rake_amount), 0), 2)
    INTO v_rows, v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = v_h.target_id
     AND r.is_tournament
     AND r.source = 'fn_award_satellite_seat'
     AND r.metadata->>'satellite_id' = p_tournament_id::text;
  IF NOT v_diamond AND (v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR v_rake IS DISTINCT FROM round(v_h.seat_count * v_h.target_fee, 2)
     OR (SELECT count(DISTINCT r.metadata->>'registration_id')
           FROM public.rake_records r
          WHERE r.tournament_id = v_h.target_id
            AND r.is_tournament
            AND r.source = 'fn_award_satellite_seat'
            AND r.metadata->>'satellite_id' = p_tournament_id::text)
          <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_h.target_id
          AND r.is_tournament
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text
          AND (r.rake_amount IS DISTINCT FROM v_h.target_fee
            OR r.pot_size IS DISTINCT FROM v_h.ticket_cost
            OR r.metadata->>'kind' IS DISTINCT FROM 'satellite_seat_entry_fee'
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_satellite_awards a
               WHERE a.tournament_id = p_tournament_id
                 AND a.delivery_kind = 'seat'
                 AND a.user_id::text = r.metadata->>'user_id'
                 AND a.registration_id::text = r.metadata->>'registration_id'))
     ) OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.delivery_kind = 'seat'
          AND v_h.target_fee > 0
          AND (SELECT count(*)
                 FROM public.rake_records r
                WHERE r.tournament_id = v_h.target_id
                  AND r.is_tournament
                  AND r.source = 'fn_award_satellite_seat'
                  AND r.metadata->>'kind' = 'satellite_seat_entry_fee'
                  AND r.metadata->>'satellite_id' = p_tournament_id::text
                  AND r.metadata->>'user_id' = a.user_id::text
                  AND r.metadata->>'registration_id' = a.registration_id::text
                  AND r.rake_amount = v_h.target_fee
                  AND r.pot_size = v_h.ticket_cost) <> 1
     )) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
              AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed);
  IF v_rows <> (v_h.cash_ticket_count
                + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'satellite % has missing or extra obligation evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.remainder > 0 THEN
    IF (SELECT count(*) FROM public.tournament_satellite_remainders r
         WHERE r.tournament_id = p_tournament_id) <> 1
       OR NOT EXISTS (
      SELECT 1
        FROM public.tournament_players bubble
        JOIN public.tournament_satellite_remainders r
          ON r.tournament_id = p_tournament_id
         AND r.user_id = bubble.user_id
         AND r.place = v_h.bubble_position
         AND r.amount = v_h.remainder
        JOIN public.tournament_payouts p
          ON p.id = r.payout_id
         AND p.tournament_id = p_tournament_id
         AND p.user_id = bubble.user_id
         AND p."position" IS NOT DISTINCT FROM r.payout_position
         AND p.amount = v_h.remainder
         AND p.source = r.payout_source
         AND p.idempotency_key = r.idempotency_key
        JOIN public.tournament_obligations o
          ON o.id = r.obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = r.obligation_kind
         AND o.place IS NOT DISTINCT FROM r.obligation_place
         AND o.user_id = bubble.user_id
         AND o.amount_owed = v_h.remainder
         AND o.amount_paid = v_h.remainder
         AND o.settled_at IS NOT NULL
        JOIN public.wallet_credit_idempotency k
          ON k.key = r.idempotency_key
         AND k.user_id = bubble.user_id
         AND k.amount = v_h.remainder
       WHERE bubble.tournament_id = p_tournament_id
         AND bubble.user_id = v_h.bubble_user_id
         AND bubble.position = v_h.bubble_position
         AND (
           (r.evidence_kind = 'atomic'
             AND r.payout_position IS NOT DISTINCT FROM r.place
             AND r.obligation_place IS NOT DISTINCT FROM r.place
             AND r.idempotency_key = 'tourney:' || p_tournament_id::text
                 || ':satellite_remainder:place:' || r.place::text)
           OR r.evidence_kind = 'legacy_20260908_682')
    ) THEN
      RAISE EXCEPTION 'satellite % has no exact single-bubble remainder payment',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_remainder := jsonb_build_object(
      'user_id', v_h.bubble_user_id,
      'position', v_h.bubble_position,
      'amount', v_h.remainder);
  ELSIF EXISTS (SELECT 1 FROM public.tournament_satellite_remainders r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source = 'satellite_remainder'
     ) THEN
    RAISE EXCEPTION 'satellite % has remainder evidence when remainder is zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_expected_rows := v_h.ticket_award_count
                     + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END;
  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_rows, v_amount
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_rows <> v_expected_rows OR v_amount IS DISTINCT FROM v_h.pool THEN
    RAISE EXCEPTION
      'satellite % payout evidence has % rows / % chips, expected % / %',
      p_tournament_id, v_rows, v_amount, v_expected_rows, v_h.pool
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.prize IS DISTINCT FROM CASE
         WHEN EXISTS(SELECT 1 FROM public.tournament_satellite_awards a WHERE a.tournament_id=p_tournament_id AND a.user_id=tp.user_id) THEN v_h.ticket_cost
         WHEN v_h.remainder > 0 AND tp.position = v_h.bubble_position
           THEN v_h.remainder
         ELSE 0::numeric
       END
  ) THEN
    RAISE EXCEPTION 'satellite % prize cache disagrees with its receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.prize_out IS DISTINCT FROM v_h.pool
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.closed_at IS DISTINCT FROM v_h.source_escrow_closed_at
     OR v_source_escrow.close_note IS DISTINCT FROM v_h.source_escrow_close_note
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION 'satellite % did not close every escrow bank at zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_rake_settlement
    FROM public.tournament_rake_settlements s
   WHERE s.tournament_id = p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  IF v_diamond THEN
    -- DIAMOND PHASE 9: a Diamond satellite's fee is its fee bank, settled to
    -- the house, not a rake_records sum.
    SELECT e.fee_balance + e.fee_out INTO v_rake
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF v_rake_settlement.tournament_id IS NULL
     OR v_rake_settlement.settled_at IS NULL
     OR v_rake_settlement.amount IS DISTINCT FROM v_rake
     OR (v_rake > 0 AND v_rake_settlement.attributed_at IS NULL AND NOT v_deferred) THEN
    RAISE EXCEPTION 'satellite % rake has no exact terminal settlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'award_slot', a.place,
           'position', (SELECT tp.position FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id AND tp.user_id=a.user_id),
           'amount', a.amount,
           'delivery_kind', a.delivery_kind,
           'payout_id', a.payout_id,
           'registration_id', a.registration_id,
           'ticket_id', a.ticket_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_awards
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'award_slot', a.place,
           'position', (SELECT tp.position FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id AND tp.user_id=a.user_id),
           'amount', a.amount,
           'registration_id', a.registration_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_seats
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id
     AND a.delivery_kind = 'seat';

  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', 'COMPLETED',
    'tournament_id', p_tournament_id,
    'target_id', v_h.target_id,
    'qualifier_ids', v_h.qualifier_ids,
    'field_size', v_h.field_size,
    'pool', v_h.pool,
    'ticket_cost', v_h.ticket_cost,
    'ticket_award_count', v_h.ticket_award_count,
    'seat_count', v_h.seat_count,
    'cash_ticket_count', v_h.cash_ticket_count,
    'entry_ticket_count', v_h.entry_ticket_count,
    'awards', v_awards,
    'seats', v_seats,
    'remainder', v_remainder,
    'source_table_count', v_h.source_table_count,
    'source_seat_count', v_h.source_seat_count,
    'released_seat_count', v_h.released_seat_count,
    'source_closeout', jsonb_build_object(
      'source_table_count', v_h.source_table_count,
      'source_table_ids', to_jsonb(v_h.source_table_ids),
      'source_seat_count', v_h.source_seat_count,
      'source_seat_ids', to_jsonb(v_h.source_seat_ids),
      'released_seat_count', v_h.released_seat_count,
      'released_seat_ids', to_jsonb(v_h.released_seat_ids),
      'closed_at', v_h.source_closed_at,
      'escrow_closed_at', v_h.source_escrow_closed_at,
      'escrow_close_note', v_h.source_escrow_close_note),
    'settled_at', v_h.settled_at,
    'receipt_version', v_h.receipt_version,
    'accounting',v_accounting);
END;
$function$;

-- public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)
CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_source record;
  v_target record;
  v_target_after record;
  v_winner public.tournament_players%ROWTYPE;
  v_finisher public.tournament_players%ROWTYPE;
  v_existing_target public.tournament_players%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow_after public.tournament_escrow%ROWTYPE;
  v_existing_header public.tournament_satellite_settlements%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_observed_target_id uuid;
  v_target_id uuid;
  v_target_open boolean := false;
  v_pool numeric;
  v_target_buy_in numeric;
  v_target_fee numeric;
  v_target_is_bounty boolean;              -- 2026-10-16: the target entry split
  v_entry_prize numeric;                   -- 2026-10-16: the target entry split
  v_entry_bounty numeric;                  -- 2026-10-16: the target entry split
  v_ticket_cost numeric;
  v_advertised_seats integer;
  v_ticket_award_count integer;
  v_seat_count integer := 0;
  v_cash_ticket_count integer := 0;
  v_entry_ticket_count integer := 0;
  v_remainder numeric;
  v_bubble_position integer;
  v_bubble_user_id uuid;
  v_field_size integer;
  v_target_count integer := 0;
  v_target_count_before integer := 0;
  v_target_live_count integer := 0;
  v_target_live_count_before integer := 0;
  v_target_counter_before integer := 0;
  v_target_counter_after integer := 0;
  v_target_slots integer := 0;
  v_live_count integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_place integer;
  v_cap_user_id uuid;
  v_cap_load integer;
  v_rows integer;
  v_registration_id uuid;
  v_admitted public.tournament_players%ROWTYPE;
  v_ticket_id uuid;
  v_ticket_club_id uuid;
  v_ticket_ledger_id uuid;
  v_ticket_transaction_id uuid;
  v_payout_id uuid;
  v_pool_before numeric;
  v_rake_result jsonb;
  v_credited boolean;
  v_payout_count integer;
  v_paid numeric;
  v_delivery_kind text;
  v_payout_key text;
  v_plan jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
  v_diamond boolean := false;              -- DIAMOND PHASE 9
  v_diamond_seat jsonb;                    -- DIAMOND PHASE 9
  v_target_prize_before numeric;           -- DIAMOND PHASE 9
  v_target_fee_before numeric;             -- DIAMOND PHASE 9
  v_target_bounty_before numeric;          -- DIAMOND PHASE 9
  v_target_custody_before numeric;         -- DIAMOND PHASE 9
  v_unit_cents integer;                    -- DIAMOND PHASE 9
BEGIN
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  -- Every terminal money authority takes this transaction lock before any
  -- row lock. Cash and satellite finishes can pay the same wallets, so one
  -- shared first lock prevents opposite recipient orders from deadlocking.
  -- THAT LOCK IS F, THE FINISH LANE (2026-09-17): exclusive among finishes,
  -- shared with every hand and rolling authority of other tournaments. A
  -- satellite writes its target's rows too, so it holds T(satellite) and
  -- T(target) exclusively, in uuid order, with G shared; the global lane
  -- calls inside re-enter it. No target resolvable: the global lane as before.
  PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);

  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- A committed header wins before target admission is inspected. Replays can
  -- never turn a previously delivered seat into cash because a target closed.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  SELECT COALESCE(t.satellite_target_id, t.satellite_target)
    INTO v_observed_target_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_observed_target_id IS NULL OR v_observed_target_id = p_tournament_id THEN
    RAISE EXCEPTION 'satellite % has no distinct target', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- During the rolling cutover the legacy seat door still takes target before
  -- source. Match that order until stage two removes it; the global lock also
  -- serializes this authority with every new terminal payer.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_observed_target_id)
   ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = '55000';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_target_id := COALESCE(v_source.satellite_target_id, v_source.satellite_target);
  IF v_target_id IS DISTINCT FROM v_observed_target_id THEN
    RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- A concurrent caller may have committed while this caller waited above.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
  END IF;

  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % is not a satellite', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(v_source.status, '')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'satellite % cannot first-settle from status %',
      p_tournament_id, v_source.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'satellite % prize pool is not finalized; guarantee funding is not proven',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.is_bounty, false)
     OR COALESCE(v_source.is_pko, false)
     OR COALESCE(v_source.is_mystery_bounty, false)
     OR COALESCE(v_source.is_premium_spin, false)
     OR lower(COALESCE(v_source.variant, '')) = 'spin'
     OR upper(COALESCE(v_source.tournament_type, '')) = 'SPIN' THEN
    RAISE EXCEPTION 'satellite % mixes another payout authority', p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  v_pool := v_source.prize_pool;
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_pool IS NULL OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0 OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'satellite % has invalid whole-cent pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  IF v_advertised_seats < 0 THEN
    RAISE EXCEPTION 'satellite % has invalid advertised seat count %',
      p_tournament_id, v_advertised_seats USING ERRCODE = '22003';
  END IF;

  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin,
         t.bounty_amount, t.bounty_pool, t.bounty_pool_paid,
         t.max_players, t.current_players, t.current_level,
         t.late_reg_levels, t.rebuy_levels, t.prize_pool_finalized,
         t.prize_pool, t.total_rake
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_target_id
   FOR UPDATE;
  IF v_target.id IS NULL THEN
    -- PostgreSQL cannot row-lock an absent target. Refuse the settlement so a
    -- concurrent same-id target insert can never race a cash substitution.
    RAISE EXCEPTION
      'satellite % target % is missing; absence cannot authorize cash substitution',
      p_tournament_id, v_target_id USING ERRCODE = 'P0404';
  END IF;
  -- DIAMOND PHASE 9: ASSETS NEVER CROSS. A Diamond satellite seats only a
  -- Diamond target and a chip satellite only a chip target; either crossing
  -- is refused by name here, before any money, roster or escrow row moves.
  v_diamond := public.fn_ca_assert_satellite_asset(p_tournament_id, v_target_id);
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
  IF v_target_buy_in IS NULL
     OR v_target_buy_in::text IN ('NaN','Infinity','-Infinity')
     OR v_target_buy_in < 0
     OR v_target_buy_in IS DISTINCT FROM round(v_target_buy_in, 2)
     OR v_target_fee IS NULL
     OR v_target_fee::text IN ('NaN','Infinity','-Infinity')
     OR v_target_fee < 0
     OR v_target_fee IS DISTINCT FROM round(v_target_fee, 2) THEN
    RAISE EXCEPTION 'satellite % target has an invalid whole-cent entry contract',
      p_tournament_id USING ERRCODE = '22003';
  END IF;
  v_ticket_cost := round(v_target_buy_in + v_target_fee, 2);
  IF v_ticket_cost <= 0 THEN
    RAISE EXCEPTION 'satellite % target ticket has no positive value',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  -- A SEAT INTO A BOUNTY TARGET IS BOOKED EXACTLY LIKE A PAID ENTRY
  -- (2026-10-16). The ticket is the target's whole buy-in plus fee. A paid
  -- entry splits that charge through fn_tournament_entry_split into prize,
  -- bounty and fee; a seat delivered here is split the same way, by the
  -- same function, so the bounty slice lands on the bounty rail with a
  -- funded head and never on the prize ladder (the 2026-09-07 PKO
  -- shortfall). A Spin target, a premium Spin and a target whose flags are
  -- unknown are still refused: the split cannot be known for them. A
  -- Diamond bounty target is refused too: the Diamond seat transfer has no
  -- bounty part to carry the slice.
  IF (
       v_target.is_bounty IS NULL
       OR v_target.is_pko IS NULL
       OR v_target.is_mystery_bounty IS NULL
       OR v_target.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'
     ) THEN
    RAISE EXCEPTION
      'satellite % target % uses an unsupported Spin or unknown entry split',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  v_target_is_bounty := v_target.is_bounty OR v_target.is_pko
                        OR v_target.is_mystery_bounty;
  IF v_target_is_bounty AND v_diamond THEN
    RAISE EXCEPTION
      'satellite % Diamond target % carries a bounty the Diamond seat transfer cannot fund',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  SELECT s.prize, s.bounty INTO v_entry_prize, v_entry_bounty
    FROM public.fn_tournament_entry_split(
      v_target_buy_in, v_target_fee, v_target.bounty_amount,
      v_target_is_bounty) s;
  IF v_entry_prize IS NULL OR v_entry_bounty IS NULL
     OR v_entry_prize < 0 OR v_entry_bounty < 0
     OR round(v_entry_prize + v_entry_bounty, 2)
          IS DISTINCT FROM v_target_buy_in THEN
    RAISE EXCEPTION
      'satellite % target % has a misconfigured bounty split (prize %, bounty %, buy-in %)',
      p_tournament_id, v_target_id, v_entry_prize, v_entry_bounty,
      v_target_buy_in USING ERRCODE = '22023';
  END IF;
  IF v_pool < v_advertised_seats * v_ticket_cost THEN
    RAISE EXCEPTION
      'satellite % finalized pool % does not fund its % advertised tickets at % each',
      p_tournament_id, v_pool, v_advertised_seats, v_ticket_cost
      USING ERRCODE = 'P0403';
  END IF;

  -- Open and own only the source escrow before the delivery plan is known. A
  -- cash-only plan must not touch a completed target's immutable escrow merely
  -- to prove that no seat will be delivered there.
  -- DIAMOND PHASE 9: a Diamond satellite's escrow shadow opens from its own
  -- ledger with its exact parts, as the Diamond terminal writer opens one.
  IF v_diamond THEN
    PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  END IF;
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.closed_at IS NOT NULL
     OR v_source_escrow.close_note IS NOT NULL
     OR v_source_escrow.prize_balance IS DISTINCT FROM v_pool
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS NULL
     OR v_source_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v_source_escrow.fee_balance < 0
     OR v_source_escrow.fee_balance IS DISTINCT FROM round(v_source_escrow.fee_balance, 2)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION
      'satellite % escrow does not hold exactly its locked pool (pool %, prize %, bounty %, fee %)',
      p_tournament_id, v_pool, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;

  -- Keep the same root lock order used by every terminal authority: tournament,
  -- tournament roster, source tables, then source seats. The identities are
  -- frozen before any payer runs and become part of the immutable header.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id)
                    FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
    INTO v_source_seat_ids, v_released_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_table_count := cardinality(v_source_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);
  v_released_seat_count := cardinality(v_released_seat_ids);
  IF v_source_table_count < 1 THEN
    RAISE EXCEPTION 'satellite % has no source table to close', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_field_size FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*),
         count(*) FILTER (
           WHERE tp.status::text IN ('registered','playing'))
    INTO v_target_count, v_target_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = v_target_id;
  v_target_count_before := v_target_count;
  v_target_live_count_before := v_target_live_count;
  -- Before start, current_players is the live lobby count maintained by the
  -- canonical roster trigger. Once RUNNING, it is the immutable total entrant
  -- count and must not shrink when a player is eliminated.
  v_target_counter_before := CASE
    WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
      THEN v_target_live_count_before
    ELSE v_target_count_before
  END;
  IF v_field_size < 1 THEN
    RAISE EXCEPTION 'satellite % has no final field', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND (tp.status IS NULL
         OR tp.status::text NOT IN ('playing','winner','eliminated'))
  ) THEN
    RAISE EXCEPTION 'satellite % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Apart from the one explicitly adopted historical miss below, a new
  -- settlement must start with no money, target-seat or cache fragments.
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
                            AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed))
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.prize, 0) <> 0)
     OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id = p_tournament_id
          AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                       || ':seat:%:pool_transfer')
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = v_target_id
          AND tp.source_satellite_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_target_id
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text) THEN
    RAISE EXCEPTION 'satellite % has partial or legacy settlement evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'satellite % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'satellite % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
           OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL
     OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'observed winner % does not match the locked last survivor in satellite %',
      p_observed_winner_id, p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = 1 AND tp.user_id IS DISTINCT FROM v_winner.user_id
  ) THEN
    RAISE EXCEPTION 'satellite % assigns first place to another player',
      p_tournament_id USING ERRCODE = '23505';
  END IF;

  UPDATE public.tournament_players
     SET status = 'winner', position = 1,
         eliminated_at = NULL, elimination_sequence = NULL
   WHERE id = v_winner.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not promote exactly one winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_eliminated_count <> v_field_size - 1
     OR v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION
      'satellite % has no complete durable elimination sequence (%/% of %)',
      p_tournament_id, v_sequenced_count, v_distinct_sequence_count,
      v_eliminated_count USING ERRCODE = 'P0404';
  END IF;

  -- No evidence exists, so numeric positions can be rebuilt from the durable
  -- transition order without relabelling a payment.
  UPDATE public.tournament_players tp
     SET position = NULL
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  WITH ranked AS (
    SELECT tp.id,
           row_number() OVER (
             ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tp.tournament_id, tp.user_id), tp.eliminated_at) DESC NULLS LAST, tp.elimination_sequence DESC, tp.id ASC
           )::integer + 1 AS final_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
  )
  UPDATE public.tournament_players tp
     SET position = ranked.final_position
    FROM ranked
   WHERE tp.id = ranked.id;

  SELECT count(*), count(DISTINCT tp.position)
    INTO v_rows, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.position BETWEEN 1 AND v_field_size;
  IF v_rows <> v_field_size OR v_distinct_sequence_count <> v_field_size THEN
    RAISE EXCEPTION 'satellite % could not prove contiguous final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer;
  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  -- DIAMOND PHASE 9: WHERE THE UNIT DIVIDES - NOWHERE. The prize bank is a
  -- sum of whole ledger parts and the ticket is the target's whole buy-in
  -- plus its whole fee, so seats times ticket and the remainder are whole
  -- Diamonds and the flooring residue (the remainder less its floor at the
  -- unit) is exactly zero. It lands nowhere: a pool, ticket or remainder
  -- that is not its own floor at the unit is refused by name, before any
  -- Diamond moves.
  IF v_diamond THEN
    v_unit_cents := public.fn_ca_tournament_unit_cents(p_tournament_id);
    IF public.fn_ca_unit_floor_cents(round(v_pool * 100)::bigint, v_unit_cents)
         <> round(v_pool * 100)::bigint
       OR public.fn_ca_unit_floor_cents(round(v_ticket_cost * 100)::bigint, v_unit_cents)
         <> round(v_ticket_cost * 100)::bigint
       OR public.fn_ca_unit_floor_cents(round(v_remainder * 100)::bigint, v_unit_cents)
         <> round(v_remainder * 100)::bigint THEN
      RAISE EXCEPTION
        'diamond_satellite_does_not_divide_into_whole_diamonds: satellite % pool % ticket % remainder %',
        p_tournament_id, v_pool, v_ticket_cost, v_remainder USING ERRCODE = '23514';
    END IF;
  END IF;
  IF v_remainder < 0 OR v_remainder >= v_ticket_cost THEN
    RAISE EXCEPTION 'satellite % derived invalid residual % below ticket %',
      p_tournament_id, v_remainder, v_ticket_cost USING ERRCODE = '23514';
  END IF;
  IF (v_ticket_award_count
      + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END) > v_field_size THEN
    RAISE EXCEPTION
      'satellite % pool needs % ticket/remainder finishers but field has %',
      p_tournament_id,
      v_ticket_award_count + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END,
      v_field_size USING ERRCODE = '23514';
  END IF;
  IF v_remainder > 0 THEN
    v_bubble_position := v_ticket_award_count + 1;
    SELECT tp.user_id INTO v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_position;
    IF NOT FOUND OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'satellite % has no single bubble at place %',
        p_tournament_id, v_bubble_position USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- Decide a complete immutable delivery plan while target and roster locks are
  -- held. Only explicit terminal or full states become cash. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF (NOT public.fn_ca_tournament_is_unlimited(v_target_id)
      AND COALESCE(v_target.max_players, 0) < 0)
     OR v_target.late_reg_levels < 0
     OR v_target.rebuy_levels < 0 THEN
    RAISE EXCEPTION
      'satellite % target % has invalid admission bounds',
      p_tournament_id, v_target_id USING ERRCODE = '22003';
  END IF;
  IF NOT public.fn_ca_tournament_is_unlimited(v_target_id)
     AND v_target.max_players IS NOT NULL AND v_target.max_players > 0
     AND v_target_count >= v_target.max_players THEN
    v_target_open := false;
  ELSIF COALESCE(v_target.prize_pool_finalized, false) THEN
    v_target_open := false;
  ELSIF upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING') THEN
    v_target_open := true;
  ELSIF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
    IF v_target.current_level < 0 THEN
      RAISE EXCEPTION
        'satellite % target % has invalid RUNNING admission level',
        p_tournament_id, v_target_id USING ERRCODE = '55000';
    END IF;
    -- The target row and both rosters are already locked. Delegate the actual
    -- RUNNING admission decision to the same canonical authority used by every
    -- other late-registration path, including its minutes-based fallback.
    v_target_open :=
      public.fn_tournament_late_registration_open(v_target_id);
  ELSIF upper(COALESCE(v_target.status, '')) IN
        ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
    v_target_open := false;
  ELSE
    RAISE EXCEPTION
      'satellite % target % admission state % is ambiguous',
      p_tournament_id, v_target_id, v_target.status
      USING ERRCODE = '55000';
  END IF;
  IF v_target_open THEN
    v_target_slots := CASE
      WHEN public.fn_ca_tournament_is_unlimited(v_target_id)
        OR v_target.max_players IS NULL OR v_target.max_players = 0
        THEN v_ticket_award_count
      ELSE GREATEST(v_target.max_players - v_target_count, 0)
    END;
  END IF;

  -- The booking and live-seat triggers serialize every four-table decision on
  -- this same user key. Take all winner keys in UUID order before classifying
  -- anyone, so a concurrent seat cannot race a direct-ticket disposition and
  -- two multi-award satellites cannot deadlock by taking the keys oppositely.
  FOR v_cap_user_id IN
    SELECT tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.position BETWEEN 1 AND v_ticket_award_count
     ORDER BY tp.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('table_cap:'||v_cap_user_id::text,0));
  END LOOP;

  IF v_ticket_award_count > 0 THEN
    FOR v_place IN 1..v_ticket_award_count LOOP
      SELECT * INTO v_finisher FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position = v_place;
      IF v_finisher.id IS NULL THEN
        RAISE EXCEPTION 'satellite % has no finisher at ticket place %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_delivery_kind := 'cash';
      SELECT * INTO v_existing_target FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.user_id = v_finisher.user_id;
      IF FOUND THEN
        IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE THEN
          v_delivery_kind := 'cash';
        ELSIF v_existing_target.source_satellite_id IS NULL THEN
          RAISE EXCEPTION
            'satellite % cannot prove origin of target seat held by place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSIF v_existing_target.source_satellite_id = p_tournament_id THEN
          RAISE EXCEPTION
            'satellite % has an unreceipted target seat already delivered to place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSE
          v_delivery_kind := 'cash';
        END IF;
      ELSIF v_target_open AND v_seat_count < v_target_slots THEN
        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id)
          -- THE DYING SATELLITE IS NOT A GAME (2026-10-17). This settlement
          -- releases the winner's seats at this satellite in this same
          -- transaction, so those seats cannot be the games that cap the
          -- winner. Counting them held Sunday Deep Stack Satellite 10 RUNNING
          -- and unpaid for two hours on 2026-10-16 while its sole survivor
          -- "sat" at the table this settlement was about to close. The
          -- subtraction mirrors clause (1) of fn_concurrent_game_load exactly,
          -- so it removes only seats that clause counted.
          - (SELECT count(*)::int
               FROM public.table_seats zts
               JOIN public.tables zt ON zt.id = zts.table_id
              WHERE zts.user_id = v_finisher.user_id
                AND zts.left_at IS NULL
                AND zt.status <> 'closed'
                AND zt.tournament_id = p_tournament_id
                AND NOT EXISTS (
                  SELECT 1 FROM public.tournaments ztr
                   WHERE ztr.id = zt.tournament_id
                     AND ztr.status IN ('COMPLETING','COMPLETED','CANCELLED')));
        IF v_cap_load>=4 THEN
          IF v_diamond THEN
            -- A CAPPED DIAMOND WINNER IS PAID, NOT HELD (2026-10-17). The
            -- refusal this replaces promised "the engine retries", but a
            -- winner seated at four long events keeps the satellite RUNNING,
            -- undealt and unpaid for hours - a deadlock, not a rule. The
            -- duplicate-qualification rule already pays a Diamond ticket's
            -- value as money through the same pay door (fn_credit_and_log ->
            -- fn_poker_diamond_tournament_pay); the capped winner takes
            -- exactly that path, whole Diamonds, obligation opened and
            -- closed in this transaction, so the event always finishes and
            -- the winner is always paid at once.
            v_delivery_kind := 'cash';
          ELSE
          -- The cap remains absolute. The winner receives the funded entry as
          -- a noncash tournament ticket instead of a fifth game or wallet chips.
          v_delivery_kind := 'ticket';
          END IF;
        ELSE
          v_delivery_kind := 'seat';
        END IF;
      END IF;

      IF v_delivery_kind = 'seat' THEN
        v_seat_count := v_seat_count + 1;
      ELSIF v_delivery_kind = 'ticket' THEN
        v_entry_ticket_count := v_entry_ticket_count + 1;
      ELSE
        v_cash_ticket_count := v_cash_ticket_count + 1;
      END IF;
      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', v_place,
        'user_id', v_finisher.user_id,
        'delivery_kind', v_delivery_kind));
    END LOOP;
  END IF;
  IF v_seat_count + v_cash_ticket_count + v_entry_ticket_count
       <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % did not classify every funded ticket',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- Closed/full/independently-held tickets are cash substitutions and do not
  -- touch target aggregates. Validate those mutable target banks only when
  -- this exact plan will add at least one real registration.
  -- DIAMOND PHASE 9: a Diamond target's money is its Diamond ledger and its
  -- custody, not a chip escrow. A satellite does not open its shadow (its own
  -- terminal does); the aggregates it publishes must be exactly its banks
  -- before a seat is added, and its banks exactly its custody.
  IF v_seat_count > 0 AND v_diamond THEN
    SELECT e.prize_balance, e.fee_balance, e.bounty_balance
      INTO v_target_prize_before, v_target_fee_before, v_target_bounty_before
      FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e;
    v_target_custody_before := public.fn_poker_diamond_tournament_custody(v_target_id)::numeric;
    IF v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS DISTINCT FROM v_target_prize_before
       OR v_target.total_rake IS DISTINCT FROM v_target_fee_before
       OR v_target_bounty_before IS DISTINCT FROM 0::numeric
       OR v_target_prize_before + v_target_fee_before IS DISTINCT FROM v_target_custody_before THEN
      RAISE EXCEPTION
        'satellite % cannot deliver a Diamond target seat against malformed aggregate or bank state',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;
  IF v_seat_count > 0 AND NOT v_diamond THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
    -- it belongs after seat classification and only on the actual seat path.
    PERFORM public.fn_ca_escrow_apply(
      v_target_id, 'atomic satellite settlement target seat lock');
    SELECT * INTO v_target_escrow FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
  END IF;
  IF v_seat_count > 0 AND NOT v_diamond AND (
       v_target.current_players IS NULL
       OR v_target.current_players < 0
       OR v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS NULL
       OR v_target.prize_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_target.prize_pool < 0
       OR v_target.prize_pool IS DISTINCT FROM round(v_target.prize_pool, 2)
       OR v_target.total_rake IS NULL
       OR v_target.total_rake::text IN ('NaN','Infinity','-Infinity')
       OR v_target.total_rake < 0
       OR v_target.total_rake IS DISTINCT FROM round(v_target.total_rake, 2)
       OR (v_target_fee > 0 AND v_target.club_id IS NULL)
       OR v_target_escrow.tournament_id IS NULL
       OR v_target_escrow.enforced IS DISTINCT FROM true
       OR v_target_escrow.closed_at IS NOT NULL
       OR v_target_escrow.close_note IS NOT NULL
       OR v_target_escrow.prize_balance IS NULL
       OR v_target_escrow.prize_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.prize_balance < 0
       OR v_target_escrow.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance, 2)
       OR v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance
       -- A bounty target's bounty bank is exactly its published pool less
       -- what knockouts have already paid from it (2026-10-16).
       OR v_target_escrow.bounty_balance IS DISTINCT FROM
            (CASE WHEN v_target_is_bounty
                  THEN round(COALESCE(v_target.bounty_pool, 0)
                             - COALESCE(v_target.bounty_pool_paid, 0), 2)
                  ELSE 0::numeric END)
       OR v_target_escrow.fee_balance IS NULL
       OR v_target_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.fee_balance < 0
       OR v_target_escrow.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance, 2)
       OR v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance
       OR EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
             'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
             'refund_prize','refund_bounty','refund_fee',
             'reserve_out','reserve_in'
           ]::text[]) AS component(name)
           CROSS JOIN LATERAL (
             SELECT (to_jsonb(v_target_escrow)->>component.name)::numeric AS amount
           ) AS persisted
          WHERE persisted.amount IS NULL
             OR CASE
                  WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                    THEN true
                  ELSE persisted.amount < 0
                    OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
                END
       )
     ) THEN
    RAISE EXCEPTION
      'satellite % cannot deliver a target seat against malformed aggregate or escrow state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, entry_ticket_count,
     remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (p_tournament_id, v_target_id, false, NULL,
     p_observed_winner_id, v_field_size, v_advertised_seats, v_pool,
     v_target_buy_in, v_target_fee, v_ticket_cost, v_ticket_award_count,
     v_seat_count, v_cash_ticket_count, v_entry_ticket_count, v_remainder,
     v_bubble_user_id, v_bubble_position,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at, v_closeout_at, v_source_escrow_close_note, v_closeout_at);

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status, '')) IN ('RUNNING','COMPLETING')
     AND COALESCE(prize_pool_finalized, false);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    v_place := (v_plan_item->>'place')::integer;
    v_delivery_kind := v_plan_item->>'delivery_kind';
    SELECT * INTO v_finisher FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_place
       AND tp.user_id = (v_plan_item->>'user_id')::uuid;
    IF v_finisher.id IS NULL THEN
      RAISE EXCEPTION 'satellite % delivery plan lost finisher at place %',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;

    IF v_delivery_kind = 'seat' THEN
      -- A bounty seat carries its funded head on the row, exactly as the
      -- paid door writes it (flat bounty on the head, mystery value drawn
      -- later from the chest inventory), so trg_seed_bounty_head finds it
      -- already seeded and never raises an unfunded head (2026-10-16).
      IF v_entry_bounty > 0 THEN
        INSERT INTO public.tournament_players
          (tournament_id, user_id, username, chips, status,
           is_satellite_qualifier, source_satellite_id,
           current_bounty, mystery_bounty_value, bounties_collected,
           bounty_winnings)
        VALUES
          (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
           true, p_tournament_id, v_entry_bounty, 0, 0, 0)
        RETURNING * INTO v_admitted;
      ELSE
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         is_satellite_qualifier, source_satellite_id)
      VALUES
        (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
         true, p_tournament_id)
      RETURNING * INTO v_admitted;
      END IF;
      v_registration_id := v_admitted.id;
      -- The admission trigger selects the member club for a union entrant.
      -- It is the funding/refund identity used by ordinary ticket admission.
      IF v_admitted.club_id IS NULL
         OR v_admitted.tournament_id IS DISTINCT FROM v_target_id
         OR v_admitted.user_id IS DISTINCT FROM v_finisher.user_id
         OR v_admitted.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR v_admitted.is_satellite_qualifier IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'satellite seat returned inconsistent registration identity'
          USING ERRCODE='P0404';
      END IF;
      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
      IF v_diamond THEN
        -- DIAMOND PHASE 9: THE SEAT IS A CUSTODY-TO-CUSTODY MOVEMENT. The
        -- whole ticket leaves the satellite's prize bank (a release movement
        -- on each drained entry row) and becomes the winner's funded entry
        -- in the target (a new tournament_entry custody row, its reserve
        -- movement, and the entry ledger row carrying the target's own prize
        -- and fee parts). No wallet moves and the register does not move;
        -- the chip transfer leg and the chip fee row are not written. It is
        -- written before any chair is taken: a Diamond tournament chair is
        -- admitted only against an active funded entry (P0810).
        v_diamond_seat := public.fn_poker_diamond_tournament_seat_transfer(
          p_tournament_id, v_target_id, v_finisher.user_id, v_registration_id,
          v_ticket_cost, v_target_buy_in, v_target_fee,
          'tourney:' || p_tournament_id::text || ':seat:' || v_finisher.user_id::text);
        IF COALESCE((v_diamond_seat->>'success')::boolean, false) IS NOT TRUE
           OR COALESCE((v_diamond_seat->>'idempotent')::boolean, false) THEN
          RAISE EXCEPTION 'satellite % Diamond seat % was not delivered exactly once',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        END IF;
      END IF;

      IF NOT v_diamond THEN  -- DIAMOND PHASE 9: the chip transfer and fee legs
      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'prize_liability', v_target_id, 'tournaments.prize_pool+total_rake',
         v_ticket_cost, 'tournament_buyin', v_admitted.club_id, p_tournament_id,
         'tourney:' || p_tournament_id::text || ':seat:'
            || v_finisher.user_id::text || ':pool_transfer',
         'satellite:' || p_tournament_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s delivered as target seat (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'satellite_seat_pool_transfer',
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'registration_id', v_registration_id,
           'seat_value', v_ticket_cost,
           'moved', v_ticket_cost,
           'unbacked', 0)
         -- A bounty seat's leg names its split (entry_split_version 2), so
         -- fn_ca_escrow_on_seat_transfer_leg books prize plus bounty as gross
         -- and the bounty on the bounty rail, as a paid entry is booked.
         || CASE WHEN v_entry_bounty > 0 THEN jsonb_build_object(
              'entry_split_version', 2,
              'entry_prize', v_entry_prize,
              'entry_bounty', v_entry_bounty,
              'entry_fee', v_target_fee)
            ELSE '{}'::jsonb END,
         v_pool_before, round(v_pool_before - v_ticket_cost, 2));

      -- The transfer leg puts the complete ticket into target satellite-in.
      -- A positive fee row reclassifies only that fee from target prize to
      -- target fee escrow. A zero-fee target needs no synthetic rake record.
      IF v_target_fee > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source, metadata)
        VALUES
          (NULL, NULL, v_target.club_id, v_target_fee, v_ticket_cost, 1,
           0, true, v_target_id, 'fn_award_satellite_seat',
           jsonb_build_object(
             'kind', 'satellite_seat_entry_fee',
             'recorded_by', 'fn_settle_satellite_tournament',
             'user_id', v_finisher.user_id,
             'position', v_place,
             'satellite_id', p_tournament_id,
             'registration_id', v_registration_id)
           -- A split leg's gross already excludes the fee, so its fee row
           -- moves only the fee into fee escrow (fn_ca_escrow_on_rake_record).
           || CASE WHEN v_entry_bounty > 0
                   THEN jsonb_build_object('entry_split_version', 2)
                   ELSE '{}'::jsonb END);
      END IF;
      END IF;  -- DIAMOND PHASE 9: the chip transfer and fee legs

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_seat', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'registration_id', v_registration_id,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'pool_transfer', v_ticket_cost,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, registration_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'seat', v_ticket_cost,
         v_payout_id, 'satellite_seat', v_payout_key, v_registration_id);
    ELSIF v_delivery_kind = 'ticket' THEN
      -- A four-table cap is not an economic failure and cannot turn a funded
      -- satellite award into wallet chips. Resolve the exact target club and
      -- escrow the funded award in a target-scoped, noncash ticket instead.
      v_ticket_club_id := public.fn_tournament_club_for_user(
        v_finisher.user_id, v_target_id,
        COALESCE(v_target.club_id, v_source.club_id));
      -- A UNION TICKET IS ISSUED AT THE CLUB THE WINNER PLAYS FROM
      -- (2026-09-10): a union-hosted target accepts a ticket at any member
      -- club of its union, exactly as redemption already does. Demanding the
      -- house club refused every capped winner of a union satellite.
      IF v_ticket_club_id IS NULL
         OR (v_target.club_id IS NOT NULL
             AND v_ticket_club_id IS DISTINCT FROM v_target.club_id
             AND NOT EXISTS (
               SELECT 1 FROM public.tournaments tt
               JOIN public.union_clubs uc ON uc.union_id = tt.union_id
              WHERE tt.id = v_target_id AND uc.club_id = v_ticket_club_id)) THEN
        RAISE EXCEPTION
          'satellite % ticket place % has no exact target club',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_ticket_id := gen_random_uuid();
      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_ticket', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_tickets
        (id, club_id, issued_by, holder_id, value, status, note,
         redemption_mode, source_tournament_id, source_satellite_id,
         source_refund_entitlement_id, source_satellite_award_place,
         entry_prize, entry_bounty, entry_fee, created_at)
      VALUES
        (v_ticket_id, v_ticket_club_id,
         '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         v_finisher.user_id, v_ticket_cost, 'issued',
         'Four-Table Cap Satellite Award: Tournament Entry Only',
         'tournament_entry_only', v_target_id, p_tournament_id,
         NULL, v_place, v_entry_prize, v_entry_bounty, v_target_fee,
         transaction_timestamp());

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance,
         pre_to_balance, post_to_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'escrow', v_ticket_id, 'satellite tournament entry ticket',
         v_ticket_cost, 'ticket_issue', v_ticket_club_id, p_tournament_id,
         v_payout_key || ':ticket_escrow',
         'satellite-ticket:' || v_ticket_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s held as noncash target entry (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'direct_satellite_entry_ticket',
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'payout_id', v_payout_id,
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'entry_prize', v_entry_prize,
           'entry_bounty', v_entry_bounty,
           'entry_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2),
         0, v_ticket_cost)
      RETURNING id INTO v_ticket_ledger_id;

      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type,
         notes, balance_after, metadata)
      VALUES
        (v_ticket_club_id, NULL, v_finisher.user_id, v_ticket_cost,
         'tournament_ticket_issue',
         'Satellite Award Held As Tournament-Entry Ticket', NULL,
         jsonb_build_object(
           'ticket_id', v_ticket_id,
           'escrow_entity_id', v_ticket_id,
           'holder_id', v_finisher.user_id,
           'value', v_ticket_cost,
           'redemption_mode', 'tournament_entry_only',
           'source_tournament_id', v_target_id,
           'source_satellite_id', p_tournament_id,
           'source_award_place', v_place,
           'payout_id', v_payout_id,
           'ledger_id', v_ticket_ledger_id,
           'idempotency_key', v_payout_key,
           'wallet_chips_credited', 0))
      RETURNING id INTO v_ticket_transaction_id;

      PERFORM public.fn_ca_escrow_apply(
        p_tournament_id, 'direct satellite entry ticket out',
        p_prize_out => v_ticket_cost);

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, ticket_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'ticket',
         v_ticket_cost, v_payout_id, 'satellite_ticket', v_payout_key,
         v_ticket_id);
    ELSIF v_delivery_kind = 'cash' THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'seat', v_place, v_finisher.user_id,
         v_ticket_cost, 0, 'engine.fn_settle_satellite_tournament', NULL)
      RETURNING * INTO v_obligation;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      v_credited := public.fn_credit_and_log(
        p_user_id => v_finisher.user_id,
        p_amount => v_ticket_cost,
        p_idempotency_key => v_payout_key,
        p_category => 'prize',
        p_description => 'Satellite ticket paid in cash because target admission was definitively unavailable',
        p_related_entity_id => p_tournament_id,
        p_wallet_type => 'PLAYER',
        p_table_id => NULL,
        p_hand_id => NULL,
        p_payout_position => v_place,
        p_payout_source => 'satellite_ticket');
      IF v_credited IS NOT TRUE THEN
        RAISE EXCEPTION 'satellite % cash ticket % was not a new exact credit',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_obligations o
         SET amount_paid = v_ticket_cost, settled_at = now(), updated_at = now()
       WHERE o.id = v_obligation.id
         AND o.amount_owed = v_ticket_cost AND o.amount_paid = 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'satellite % could not close cash ticket debt %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      SELECT p.id INTO v_payout_id FROM public.tournament_payouts p
       WHERE p.idempotency_key = v_payout_key
         AND p.tournament_id = p_tournament_id
         AND p.user_id = v_finisher.user_id
         AND p."position" = v_place
         AND p.amount = v_ticket_cost
         AND p.source = 'satellite_ticket';
      IF v_payout_id IS NULL THEN
        RAISE EXCEPTION 'satellite % cash ticket % has no payout row',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key,
         obligation_id, obligation_kind)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'cash', v_ticket_cost,
         v_payout_id, 'satellite_ticket', v_payout_key,
         v_obligation.id, 'seat');
    ELSE
      RAISE EXCEPTION 'satellite % has unknown delivery kind % at place %',
        p_tournament_id, v_delivery_kind, v_place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_seat_count > 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE tp.status::text IN ('registered','playing'))
      INTO v_target_count, v_target_live_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
    v_target_counter_after := CASE
      WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
        THEN v_target_live_count
      ELSE v_target_count
    END;
    IF v_target_count IS DISTINCT FROM v_target_count_before + v_seat_count
       OR v_target_live_count IS DISTINCT FROM
            v_target_live_count_before + v_seat_count
       OR v_target_counter_after IS DISTINCT FROM
            v_target_counter_before + v_seat_count THEN
      RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournaments
       SET current_players = v_target.current_players + v_seat_count,
           prize_pool = round(COALESCE(prize_pool, 0)
                              + v_seat_count * v_entry_prize, 2),
           bounty_pool = CASE WHEN v_entry_bounty > 0
                              THEN round(COALESCE(bounty_pool, 0)
                                         + v_seat_count * v_entry_bounty, 2)
                              ELSE bounty_pool END,
           total_rake = round(COALESCE(total_rake, 0)
                             + v_seat_count * v_target_fee, 2),
           updated_at = now()
     WHERE id = v_target_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not update target aggregate receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT t.id, t.current_players, t.prize_pool, t.total_rake, t.bounty_pool
      INTO v_target_after
      FROM public.tournaments t
     WHERE t.id = v_target_id;
    SELECT * INTO v_target_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
    IF v_target_after.id IS NULL
       OR v_target_after.current_players IS DISTINCT FROM
            v_target.current_players + v_seat_count
       OR v_target_after.current_players IS DISTINCT FROM v_target_counter_after
       OR v_target_after.prize_pool IS DISTINCT FROM
            round(v_target.prize_pool + v_seat_count * v_entry_prize, 2)
       OR v_target_after.bounty_pool IS DISTINCT FROM
            (CASE WHEN v_entry_bounty > 0
                  THEN round(COALESCE(v_target.bounty_pool, 0)
                             + v_seat_count * v_entry_bounty, 2)
                  ELSE v_target.bounty_pool END)
       OR v_target_after.total_rake IS DISTINCT FROM
            round(v_target.total_rake + v_seat_count * v_target_fee, 2)
       OR (NOT v_diamond AND (v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
       OR v_target_escrow_after.enforced IS DISTINCT FROM v_target_escrow.enforced
       OR v_target_escrow_after.gross_in IS DISTINCT FROM
            round(v_target_escrow.gross_in
                  + CASE WHEN v_entry_bounty > 0
                         THEN v_seat_count * (v_entry_prize + v_entry_bounty)
                         ELSE 0 END, 2)
       OR v_target_escrow_after.fee_entries_in IS DISTINCT FROM v_target_escrow.fee_entries_in
       OR v_target_escrow_after.satellite_fee_in IS DISTINCT FROM
            round(v_target_escrow.satellite_fee_in
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.bounty_in IS DISTINCT FROM
            round(v_target_escrow.bounty_in + v_seat_count * v_entry_bounty, 2)
       OR v_target_escrow_after.overlay_in IS DISTINCT FROM v_target_escrow.overlay_in
       OR v_target_escrow_after.satellite_in IS DISTINCT FROM
            round(v_target_escrow.satellite_in
                  + CASE WHEN v_entry_bounty > 0 THEN 0
                         ELSE v_seat_count * v_target_buy_in END, 2)
       OR v_target_escrow_after.prize_out IS DISTINCT FROM v_target_escrow.prize_out
       OR v_target_escrow_after.bounty_out IS DISTINCT FROM v_target_escrow.bounty_out
       OR v_target_escrow_after.fee_out IS DISTINCT FROM v_target_escrow.fee_out
       OR v_target_escrow_after.refund_prize IS DISTINCT FROM v_target_escrow.refund_prize
       OR v_target_escrow_after.refund_bounty IS DISTINCT FROM v_target_escrow.refund_bounty
       OR v_target_escrow_after.refund_fee IS DISTINCT FROM v_target_escrow.refund_fee
       OR v_target_escrow_after.reserve_out IS DISTINCT FROM v_target_escrow.reserve_out
       OR v_target_escrow_after.reserve_in IS DISTINCT FROM v_target_escrow.reserve_in
       OR v_target_escrow_after.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance
                  + v_seat_count * v_entry_prize, 2)
       OR v_target_escrow_after.bounty_balance IS DISTINCT FROM
            round(v_target_escrow.bounty_balance + v_seat_count * v_entry_bounty, 2)
       OR v_target_escrow_after.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.opened_at IS DISTINCT FROM v_target_escrow.opened_at
       OR v_target_escrow_after.opened_from IS DISTINCT FROM v_target_escrow.opened_from
       OR v_target_escrow_after.closed_at IS DISTINCT FROM v_target_escrow.closed_at
       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note))
       -- DIAMOND PHASE 9: a Diamond target proves the delta on its own banks:
       -- each seat added exactly its buy-in to the prize bank, its fee to the
       -- fee bank and its ticket to custody, and the aggregates follow them.
       OR (v_diamond AND (
            (SELECT e.prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM v_target_prize_before + v_seat_count * v_target_buy_in
         OR (SELECT e.fee_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM v_target_fee_before + v_seat_count * v_target_fee
         OR (SELECT e.bounty_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM 0::numeric
         OR public.fn_poker_diamond_tournament_custody(v_target_id)::numeric
              IS DISTINCT FROM v_target_custody_before + v_seat_count * v_ticket_cost
         OR v_target_after.prize_pool IS DISTINCT FROM
              (SELECT e.prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
         OR v_target_after.total_rake IS DISTINCT FROM
              (SELECT e.fee_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e))) THEN
      RAISE EXCEPTION
        'satellite % target aggregate or escrow delta is not the exact delivered seat value',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF v_remainder > 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'satellite_remainder', v_bubble_position,
       v_bubble_user_id, v_remainder, 0,
       'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obligation;

    v_payout_key := 'tourney:' || p_tournament_id::text
                    || ':satellite_remainder:place:'
                    || v_bubble_position::text;
    v_credited := public.fn_credit_and_log(
      p_user_id => v_bubble_user_id,
      p_amount => v_remainder,
      p_idempotency_key => v_payout_key,
      p_category => 'prize',
      p_description => 'Satellite pool remainder paid to the single bubble',
      p_related_entity_id => p_tournament_id,
      p_wallet_type => 'PLAYER',
      p_table_id => NULL,
      p_hand_id => NULL,
      p_payout_position => v_bubble_position,
      p_payout_source => 'satellite_remainder');
    IF v_credited IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite % remainder credit was not a new exact credit',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_obligations
       SET amount_paid = v_remainder, settled_at = now(), updated_at = now()
     WHERE id = v_obligation.id
       AND tournament_id = p_tournament_id
       AND kind = 'satellite_remainder' AND place = v_bubble_position
       AND user_id = v_bubble_user_id
       AND amount_owed = v_remainder
       AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not close one exact remainder debt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT p.id INTO v_payout_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user_id
       AND p."position" = v_bubble_position
       AND p.amount = v_remainder
       AND p.source = 'satellite_remainder'
       AND p.idempotency_key = v_payout_key;
    IF v_payout_id IS NULL THEN
      RAISE EXCEPTION 'satellite % remainder has no exact payout row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    INSERT INTO public.tournament_satellite_remainders
      (tournament_id, user_id, place, amount,
       payout_id, payout_source, payout_position, idempotency_key,
       obligation_id, obligation_kind, obligation_place, evidence_kind)
    VALUES
      (p_tournament_id, v_bubble_user_id, v_bubble_position, v_remainder,
       v_payout_id, 'satellite_remainder', v_bubble_position, v_payout_key,
       v_obligation.id, 'satellite_remainder', v_bubble_position, 'atomic');
  END IF;

  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_players SET prize = v_ticket_cost
   WHERE tournament_id = p_tournament_id
     AND position BETWEEN 1 AND v_ticket_award_count;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % stamped % ticket caches, expected %',
      p_tournament_id, v_rows, v_ticket_award_count USING ERRCODE = 'P0404';
  END IF;
  IF v_remainder > 0 THEN
    UPDATE public.tournament_players SET prize = v_remainder
     WHERE tournament_id = p_tournament_id
       AND user_id = v_bubble_user_id AND position = v_bubble_position;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not stamp the single bubble cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_payout_count <> (v_ticket_award_count
                        + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END)
     OR v_paid IS DISTINCT FROM v_pool THEN
    RAISE EXCEPTION 'satellite % paid % of locked pool % across % rows',
      p_tournament_id, v_paid, v_pool, v_payout_count
      USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id, 'engine.fn_settle_satellite_tournament');
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF COALESCE((v_rake_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_rake_result->>'amount')::numeric, 0) > 0
         AND COALESCE((v_rake_result->>'attributed')::boolean, false) IS NOT TRUE AND NOT v_deferred) THEN
    RAISE EXCEPTION 'satellite % rake did not settle and attribute exactly: %',
      p_tournament_id, v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION
      'satellite % settlement leaves escrow prize %, bounty %, fee %',
      p_tournament_id, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0404';
  END IF;

  -- The atomic authority, not the legacy lifecycle observer, owns the escrow
  -- close. Stamp the exact zero proof before publishing COMPLETED so the
  -- receipt remains valid after that observer is retired by the terminal
  -- cutover migration.
  UPDATE public.tournament_escrow
     SET closed_at = v_closeout_at,
         close_note = v_source_escrow_close_note,
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND closed_at IS NULL
     AND close_note IS NULL
     AND prize_balance = 0
     AND bounty_balance = 0
     AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Source felt closure is part of the money commit. This runs after tickets,
  -- the single Bubble remainder, rake and escrow so any table/seat refusal
  -- rolls all of those effects back. The pre-payer identity arrays prevent a
  -- concurrent table or seat from appearing outside the receipt.
  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '55000';
  END IF;

  -- Elimination already gave predeparted seats a durable departure time. Close
  -- only their mutable occupancy flags here; never rewrite that historical time
  -- or fire left_at-specific effects a second time.
  UPDATE public.table_seats ts
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_source_seat_ids)
     AND ts.left_at IS NOT NULL
     AND (ts.status IS DISTINCT FROM 'left'
       OR ts.leave_pending IS DISTINCT FROM false
       OR ts.is_sitting_out IS DISTINCT FROM false
       OR ts.is_away IS DISTINCT FROM false
       OR ts.sit_out_at IS NOT NULL
       OR ts.scheduled_leave_hands IS NOT NULL);

  -- Mark the game terminal only after its seats are released, but before its
  -- tables close. The existing table-status trigger treats a close under a
  -- COMPLETING tournament as an accidental live-game close and files an
  -- incident. COMPLETED is therefore the canonical parent-before-child order.
  -- A later table-close refusal still rolls this status and all money back.
  UPDATE public.tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true,
         current_players = 0, on_break = false,
         break_started_at = NULL, break_ends_at = NULL, updated_at = now()
   WHERE id = p_tournament_id AND upper(COALESCE(status, '')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_closeout_at,
         updated_at = now()
   WHERE tb.id = ANY(v_source_table_ids)
     AND tb.tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_source_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  RETURN public.fn_ca_satellite_settlement_receipt(
    p_tournament_id, p_observed_winner_id);
END;
$function$;

-- public.fn_ca_settle_satellite_cohort(uuid,uuid[])
CREATE OR REPLACE FUNCTION public.fn_ca_settle_satellite_cohort(p_tournament_id uuid, p_observed_qualifier_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_source record;
  v_target record;
  v_target_after record;
  v_qualifier_ids uuid[];
  v_award_users uuid[];
  v_entitlements jsonb;
  v_finisher public.tournament_players%ROWTYPE;
  v_existing_target public.tournament_players%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow_after public.tournament_escrow%ROWTYPE;
  v_existing_header public.tournament_satellite_settlements%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_observed_target_id uuid;
  v_target_id uuid;
  v_target_open boolean := false;
  v_pool numeric;
  v_target_buy_in numeric;
  v_target_fee numeric;
  v_target_is_bounty boolean;              -- 2026-10-16: the target entry split
  v_entry_prize numeric;                   -- 2026-10-16: the target entry split
  v_entry_bounty numeric;                  -- 2026-10-16: the target entry split
  v_ticket_cost numeric;
  v_advertised_seats integer;
  v_ticket_award_count integer;
  v_seat_count integer := 0;
  v_cash_ticket_count integer := 0;
  v_entry_ticket_count integer := 0;
  v_remainder numeric;
  v_bubble_position integer;
  v_bubble_user_id uuid;
  v_field_size integer;
  v_target_count integer := 0;
  v_target_count_before integer := 0;
  v_target_live_count integer := 0;
  v_target_live_count_before integer := 0;
  v_target_counter_before integer := 0;
  v_target_counter_after integer := 0;
  v_target_slots integer := 0;
  v_live_count integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_place integer;
  v_cap_user_id uuid;
  v_cap_load integer;
  v_rows integer;
  v_registration_id uuid;
  v_admitted public.tournament_players%ROWTYPE;
  v_ticket_id uuid;
  v_ticket_club_id uuid;
  v_ticket_ledger_id uuid;
  v_ticket_transaction_id uuid;
  v_payout_id uuid;
  v_pool_before numeric;
  v_rake_result jsonb;
  v_credited boolean;
  v_payout_count integer;
  v_paid numeric;
  v_delivery_kind text;
  v_seat_receipt jsonb;
  v_payout_key text;
  v_plan jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
  v_diamond boolean := false;              -- DIAMOND PHASE 9
  v_diamond_seat jsonb;                    -- DIAMOND PHASE 9
  v_target_prize_before numeric;           -- DIAMOND PHASE 9
  v_target_fee_before numeric;             -- DIAMOND PHASE 9
  v_target_bounty_before numeric;          -- DIAMOND PHASE 9
  v_target_custody_before numeric;         -- DIAMOND PHASE 9
  v_unit_cents integer;                    -- DIAMOND PHASE 9
BEGIN
  IF public.fn_ca_lock_mtt_admission_contract() IS DISTINCT FROM 'unlimited-mtt-v2' THEN
    RAISE EXCEPTION 'satellite cohort admission is not activated' USING ERRCODE='55000';
  END IF;
  -- Every terminal money authority takes this transaction lock before any
  -- row lock. Cash and satellite finishes can pay the same wallets, so one
  -- shared first lock prevents opposite recipient orders from deadlocking.
  -- THAT LOCK IS F, THE FINISH LANE (2026-09-17): exclusive among finishes,
  -- shared with every hand and rolling authority of other tournaments. A
  -- satellite writes its target's rows too, so it holds T(satellite) and
  -- T(target) exclusively, in uuid order, with G shared; the global lane
  -- calls inside re-enter it. No target resolvable: the global lane as before.
  PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);

  IF p_tournament_id IS NULL OR p_observed_qualifier_ids IS NULL OR cardinality(p_observed_qualifier_ids)<1
     OR p_observed_qualifier_ids IS DISTINCT FROM (SELECT array_agg(DISTINCT u ORDER BY u) FROM unnest(p_observed_qualifier_ids) u)
     OR array_position(p_observed_qualifier_ids,NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'satellite settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- A committed header wins before target admission is inspected. Replays can
  -- never turn a previously delivered seat into cash because a target closed.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_cohort_receipt(
      p_tournament_id, p_observed_qualifier_ids);
  END IF;

  SELECT COALESCE(t.satellite_target_id, t.satellite_target)
    INTO v_observed_target_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_observed_target_id IS NULL OR v_observed_target_id = p_tournament_id THEN
    RAISE EXCEPTION 'satellite % has no distinct target', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- During the rolling cutover the legacy seat door still takes target before
  -- source. Match that order until stage two removes it; the global lock also
  -- serializes this authority with every new terminal payer.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_observed_target_id)
   ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = '55000';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_target_id := COALESCE(v_source.satellite_target_id, v_source.satellite_target);
  IF v_target_id IS DISTINCT FROM v_observed_target_id THEN
    RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- A concurrent caller may have committed while this caller waited above.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_cohort_receipt(
      p_tournament_id, p_observed_qualifier_ids);
  END IF;

  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
  END IF;

  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % is not a satellite', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(v_source.status, '')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'satellite % cannot first-settle from status %',
      p_tournament_id, v_source.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'satellite % prize pool is not finalized; guarantee funding is not proven',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.is_bounty, false)
     OR COALESCE(v_source.is_pko, false)
     OR COALESCE(v_source.is_mystery_bounty, false)
     OR COALESCE(v_source.is_premium_spin, false)
     OR lower(COALESCE(v_source.variant, '')) = 'spin'
     OR upper(COALESCE(v_source.tournament_type, '')) = 'SPIN' THEN
    RAISE EXCEPTION 'satellite % mixes another payout authority', p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  IF (SELECT to_jsonb(t)->>'format_contract' FROM public.tournaments t WHERE id=p_tournament_id)
       IS DISTINCT FROM 'mtt-v2'
     OR NOT public.fn_ca_tournament_is_unlimited(v_target_id)
     OR EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=v_target_id
       AND (t.satellite_target_id IS NOT NULL OR t.satellite_target IS NOT NULL
         OR upper(coalesce(t.tournament_type,''))='SATELLITE'
         OR lower(coalesce(t.variant,''))='satellite')) THEN
    RAISE EXCEPTION 'satellite cohort requires recorded new MTT source and ordinary unlimited MTT target' USING ERRCODE='55000';
  END IF;
  v_entitlements:=public.fn_materialize_satellite_entitlements_locked(p_tournament_id);
  IF (v_entitlements->>'ok')::boolean IS DISTINCT FROM true
     OR (v_entitlements->>'ready')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'satellite cohort final funded entitlements unproven: %',v_entitlements USING ERRCODE='P0404';
  END IF;

  v_pool := v_source.prize_pool;
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_pool IS NULL OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0 OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'satellite % has invalid whole-cent pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  IF v_advertised_seats < 0 THEN
    RAISE EXCEPTION 'satellite % has invalid advertised seat count %',
      p_tournament_id, v_advertised_seats USING ERRCODE = '22003';
  END IF;

  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin,
         t.bounty_amount, t.bounty_pool, t.bounty_pool_paid,
         t.max_players, t.current_players, t.current_level,
         t.late_reg_levels, t.rebuy_levels, t.prize_pool_finalized,
         t.prize_pool, t.total_rake
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_target_id
   FOR UPDATE;
  IF v_target.id IS NULL THEN
    -- PostgreSQL cannot row-lock an absent target. Refuse the settlement so a
    -- concurrent same-id target insert can never race a cash substitution.
    RAISE EXCEPTION
      'satellite % target % is missing; absence cannot authorize cash substitution',
      p_tournament_id, v_target_id USING ERRCODE = 'P0404';
  END IF;
  -- DIAMOND PHASE 9: ASSETS NEVER CROSS. A Diamond satellite seats only a
  -- Diamond target and a chip satellite only a chip target; either crossing
  -- is refused by name here, before any money, roster or escrow row moves.
  v_diamond := public.fn_ca_assert_satellite_asset(p_tournament_id, v_target_id);
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
  IF v_target_buy_in IS NULL
     OR v_target_buy_in::text IN ('NaN','Infinity','-Infinity')
     OR v_target_buy_in < 0
     OR v_target_buy_in IS DISTINCT FROM round(v_target_buy_in, 2)
     OR v_target_fee IS NULL
     OR v_target_fee::text IN ('NaN','Infinity','-Infinity')
     OR v_target_fee < 0
     OR v_target_fee IS DISTINCT FROM round(v_target_fee, 2) THEN
    RAISE EXCEPTION 'satellite % target has an invalid whole-cent entry contract',
      p_tournament_id USING ERRCODE = '22003';
  END IF;
  v_ticket_cost := round(v_target_buy_in + v_target_fee, 2);
  IF v_ticket_cost <= 0 THEN
    RAISE EXCEPTION 'satellite % target ticket has no positive value',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  -- A SEAT INTO A BOUNTY TARGET IS BOOKED EXACTLY LIKE A PAID ENTRY
  -- (2026-10-16). The ticket is the target's whole buy-in plus fee. A paid
  -- entry splits that charge through fn_tournament_entry_split into prize,
  -- bounty and fee; a seat delivered here is split the same way, by the
  -- same function, so the bounty slice lands on the bounty rail with a
  -- funded head and never on the prize ladder (the 2026-09-07 PKO
  -- shortfall). A Spin target, a premium Spin and a target whose flags are
  -- unknown are still refused: the split cannot be known for them. A
  -- Diamond bounty target is refused too: the Diamond seat transfer has no
  -- bounty part to carry the slice.
  IF (
       v_target.is_bounty IS NULL
       OR v_target.is_pko IS NULL
       OR v_target.is_mystery_bounty IS NULL
       OR v_target.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'
     ) THEN
    RAISE EXCEPTION
      'satellite % target % uses an unsupported Spin or unknown entry split',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  v_target_is_bounty := v_target.is_bounty OR v_target.is_pko
                        OR v_target.is_mystery_bounty;
  IF v_target_is_bounty AND v_diamond THEN
    RAISE EXCEPTION
      'satellite % Diamond target % carries a bounty the Diamond seat transfer cannot fund',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  SELECT s.prize, s.bounty INTO v_entry_prize, v_entry_bounty
    FROM public.fn_tournament_entry_split(
      v_target_buy_in, v_target_fee, v_target.bounty_amount,
      v_target_is_bounty) s;
  IF v_entry_prize IS NULL OR v_entry_bounty IS NULL
     OR v_entry_prize < 0 OR v_entry_bounty < 0
     OR round(v_entry_prize + v_entry_bounty, 2)
          IS DISTINCT FROM v_target_buy_in THEN
    RAISE EXCEPTION
      'satellite % target % has a misconfigured bounty split (prize %, bounty %, buy-in %)',
      p_tournament_id, v_target_id, v_entry_prize, v_entry_bounty,
      v_target_buy_in USING ERRCODE = '22023';
  END IF;
  IF v_pool < v_advertised_seats * v_ticket_cost THEN
    RAISE EXCEPTION
      'satellite % finalized pool % does not fund its % advertised tickets at % each',
      p_tournament_id, v_pool, v_advertised_seats, v_ticket_cost
      USING ERRCODE = 'P0403';
  END IF;

  -- Open and own only the source escrow before the delivery plan is known. A
  -- cash-only plan must not touch a completed target's immutable escrow merely
  -- to prove that no seat will be delivered there.
  -- DIAMOND PHASE 9: a Diamond satellite's escrow shadow opens from its own
  -- ledger with its exact parts, as the Diamond terminal writer opens one.
  IF v_diamond THEN
    PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  END IF;
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.closed_at IS NOT NULL
     OR v_source_escrow.close_note IS NOT NULL
     OR v_source_escrow.prize_balance IS DISTINCT FROM v_pool
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS NULL
     OR v_source_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v_source_escrow.fee_balance < 0
     OR v_source_escrow.fee_balance IS DISTINCT FROM round(v_source_escrow.fee_balance, 2)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION
      'satellite % escrow does not hold exactly its locked pool (pool %, prize %, bounty %, fee %)',
      p_tournament_id, v_pool, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;

  -- Keep the same root lock order used by every terminal authority: tournament,
  -- tournament roster, source tables, then source seats. The identities are
  -- frozen before any payer runs and become part of the immutable header.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id)
                    FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
    INTO v_source_seat_ids, v_released_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_table_count := cardinality(v_source_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);
  v_released_seat_count := cardinality(v_released_seat_ids);
  IF v_source_table_count < 1 THEN
    RAISE EXCEPTION 'satellite % has no source table to close', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_field_size FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*),
         count(*) FILTER (
           WHERE tp.status::text IN ('registered','playing'))
    INTO v_target_count, v_target_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = v_target_id;
  v_target_count_before := v_target_count;
  v_target_live_count_before := v_target_live_count;
  -- Before start, current_players is the live lobby count maintained by the
  -- canonical roster trigger. Once RUNNING, it is the immutable total entrant
  -- count and must not shrink when a player is eliminated.
  v_target_counter_before := CASE
    WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
      THEN v_target_live_count_before
    ELSE v_target_count_before
  END;
  IF v_field_size < 1 THEN
    RAISE EXCEPTION 'satellite % has no final field', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND (tp.status IS NULL
         OR tp.status::text NOT IN ('playing','winner','eliminated'))
  ) THEN
    RAISE EXCEPTION 'satellite % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Apart from the one explicitly adopted historical miss below, a new
  -- settlement must start with no money, target-seat or cache fragments.
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
                            AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed))
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.prize, 0) <> 0)
     OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id = p_tournament_id
          AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                       || ':seat:%:pool_transfer')
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = v_target_id
          AND tp.source_satellite_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_target_id
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text) THEN
    RAISE EXCEPTION 'satellite % has partial or legacy settlement evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT array_agg(tp.user_id ORDER BY tp.user_id),count(*) INTO v_qualifier_ids,v_live_count
    FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
      AND tp.status::text='playing' AND tp.chips>0;
  IF v_qualifier_ids IS DISTINCT FROM p_observed_qualifier_ids
     OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
          AND tp.status::text IN ('playing','winner') AND (tp.chips IS NULL OR tp.chips<=0 OR tp.status::text='winner'))
     OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates c WHERE c.tournament_id=p_tournament_id AND c.state='pending')
     OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c JOIN public.tables t ON t.id=c.table_id
          WHERE t.tournament_id=p_tournament_id AND c.post_commit_completed_at IS NULL) THEN
    RAISE EXCEPTION 'satellite cohort differs or accepted hand/elimination remains unresolved' USING ERRCODE='55000';
  END IF;
  v_ticket_award_count:=floor(v_pool/v_ticket_cost)::integer;
  IF v_ticket_award_count<2 OR v_live_count>v_ticket_award_count
     OR (v_entitlements->>'ticket_value')::numeric IS DISTINCT FROM v_ticket_cost
     OR (v_entitlements->>'source_pool')::numeric IS DISTINCT FROM v_pool
     OR (SELECT count(*) FROM public.tournament_satellite_entitlements e
          WHERE e.tournament_id=p_tournament_id AND e.award_kind='seat_or_cash'
            AND e.ticket_value=v_ticket_cost AND e.remainder_value=0)<>v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite has not reached its frozen full-ticket depth' USING ERRCODE='55000';
  END IF;
  SELECT count(*),count(elimination_sequence),count(DISTINCT elimination_sequence)
    INTO v_eliminated_count,v_sequenced_count,v_distinct_sequence_count
    FROM public.tournament_players WHERE tournament_id=p_tournament_id AND status='eliminated';
  IF v_eliminated_count<>v_field_size-v_live_count
     OR v_sequenced_count<>v_eliminated_count OR v_distinct_sequence_count<>v_eliminated_count THEN
    RAISE EXCEPTION 'satellite cohort lacks exact causal eliminated standings' USING ERRCODE='P0404';
  END IF;
  -- No ranked place is assigned to a survivor. Same-hand overflow awardees
  -- retain the already accepted elimination sequence, including the bubble.
  UPDATE public.tournament_players SET status='winner',position=NULL,eliminated_at=NULL,
    elimination_sequence=NULL WHERE tournament_id=p_tournament_id AND user_id=ANY(v_qualifier_ids);
  UPDATE public.tournament_players SET position=NULL WHERE tournament_id=p_tournament_id AND status='eliminated';
  WITH ranked AS (SELECT id,row_number() OVER(ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tournament_id, user_id), eliminated_at) DESC NULLS LAST, elimination_sequence DESC)::integer+v_live_count final_position
       FROM public.tournament_players WHERE tournament_id=p_tournament_id AND status='eliminated')
  UPDATE public.tournament_players tp SET position=r.final_position FROM ranked r WHERE tp.id=r.id;
  SELECT v_qualifier_ids||coalesce(array_agg(tp.user_id ORDER BY tp.position),ARRAY[]::uuid[])
    INTO v_award_users FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
      AND tp.position BETWEEN v_live_count+1 AND v_ticket_award_count;
  IF cardinality(v_award_users)<>v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite cohort has missing full-ticket recipients' USING ERRCODE='P0404';
  END IF;

  v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer;
  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  -- DIAMOND PHASE 9: WHERE THE UNIT DIVIDES - NOWHERE. The prize bank is a
  -- sum of whole ledger parts and the ticket is the target's whole buy-in
  -- plus its whole fee, so seats times ticket and the remainder are whole
  -- Diamonds and the flooring residue (the remainder less its floor at the
  -- unit) is exactly zero. It lands nowhere: a pool, ticket or remainder
  -- that is not its own floor at the unit is refused by name, before any
  -- Diamond moves.
  IF v_diamond THEN
    v_unit_cents := public.fn_ca_tournament_unit_cents(p_tournament_id);
    IF public.fn_ca_unit_floor_cents(round(v_pool * 100)::bigint, v_unit_cents)
         <> round(v_pool * 100)::bigint
       OR public.fn_ca_unit_floor_cents(round(v_ticket_cost * 100)::bigint, v_unit_cents)
         <> round(v_ticket_cost * 100)::bigint
       OR public.fn_ca_unit_floor_cents(round(v_remainder * 100)::bigint, v_unit_cents)
         <> round(v_remainder * 100)::bigint THEN
      RAISE EXCEPTION
        'diamond_satellite_does_not_divide_into_whole_diamonds: satellite % pool % ticket % remainder %',
        p_tournament_id, v_pool, v_ticket_cost, v_remainder USING ERRCODE = '23514';
    END IF;
  END IF;
  IF v_remainder < 0 OR v_remainder >= v_ticket_cost THEN
    RAISE EXCEPTION 'satellite % derived invalid residual % below ticket %',
      p_tournament_id, v_remainder, v_ticket_cost USING ERRCODE = '23514';
  END IF;
  IF (v_ticket_award_count
      + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END) > v_field_size THEN
    RAISE EXCEPTION
      'satellite % pool needs % ticket/remainder finishers but field has %',
      p_tournament_id,
      v_ticket_award_count + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END,
      v_field_size USING ERRCODE = '23514';
  END IF;
  IF v_remainder > 0 THEN
    v_bubble_position := v_ticket_award_count + 1;
    SELECT tp.user_id INTO v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_position;
    IF NOT FOUND OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'satellite % has no single bubble at place %',
        p_tournament_id, v_bubble_position USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- Decide a complete immutable delivery plan while target and roster locks are
  -- held. Only explicit terminal or full states become cash. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF COALESCE(v_target.max_players, 0) < 0
     OR v_target.late_reg_levels < 0
     OR v_target.rebuy_levels < 0 THEN
    RAISE EXCEPTION
      'satellite % target % has invalid admission bounds',
      p_tournament_id, v_target_id USING ERRCODE = '22003';
  END IF;
  IF NOT public.fn_ca_tournament_is_unlimited(v_target_id) AND v_target.max_players IS NOT NULL AND v_target.max_players > 0
     AND v_target_count >= v_target.max_players THEN
    v_target_open := false;
  ELSIF COALESCE(v_target.prize_pool_finalized, false) THEN
    v_target_open := false;
  ELSIF upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING') THEN
    v_target_open := true;
  ELSIF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
    IF v_target.current_level < 0 THEN
      RAISE EXCEPTION
        'satellite % target % has invalid RUNNING admission level',
        p_tournament_id, v_target_id USING ERRCODE = '55000';
    END IF;
    -- The target row and both rosters are already locked. Delegate the actual
    -- RUNNING admission decision to the same canonical authority used by every
    -- other late-registration path, including its minutes-based fallback.
    v_target_open :=
      public.fn_tournament_late_registration_open(v_target_id);
  ELSIF upper(COALESCE(v_target.status, '')) IN
        ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
    v_target_open := false;
  ELSE
    RAISE EXCEPTION
      'satellite % target % admission state % is ambiguous',
      p_tournament_id, v_target_id, v_target.status
      USING ERRCODE = '55000';
  END IF;
  IF v_target_open THEN
    v_target_slots := CASE
      WHEN public.fn_ca_tournament_is_unlimited(v_target_id) OR v_target.max_players IS NULL OR v_target.max_players = 0
        THEN v_ticket_award_count
      ELSE GREATEST(v_target.max_players - v_target_count, 0)
    END;
  END IF;

  -- The booking and live-seat triggers serialize every four-table decision on
  -- this same user key. Take all winner keys in UUID order before classifying
  -- anyone, so a concurrent seat cannot race a direct-ticket disposition and
  -- two multi-award satellites cannot deadlock by taking the keys oppositely.
  FOR v_cap_user_id IN
    SELECT tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.user_id=ANY(v_award_users)
     ORDER BY tp.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('table_cap:'||v_cap_user_id::text,0));
  END LOOP;

  IF v_ticket_award_count > 0 THEN
    FOR v_place IN 1..v_ticket_award_count LOOP
      SELECT * INTO v_finisher FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.user_id = v_award_users[v_place];
      IF v_finisher.id IS NULL THEN
        RAISE EXCEPTION 'satellite % has no finisher at ticket place %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_delivery_kind := 'cash';
      SELECT * INTO v_existing_target FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.user_id = v_finisher.user_id;
      IF FOUND THEN
        IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE THEN
          v_delivery_kind := 'cash';
        ELSIF v_existing_target.source_satellite_id IS NULL THEN
          RAISE EXCEPTION
            'satellite % cannot prove origin of target seat held by place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSIF v_existing_target.source_satellite_id = p_tournament_id THEN
          RAISE EXCEPTION
            'satellite % has an unreceipted target seat already delivered to place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSE
          v_delivery_kind := 'cash';
        END IF;
      ELSIF v_target_open AND v_seat_count < v_target_slots THEN
        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id)
          -- THE DYING SATELLITE IS NOT A GAME (2026-10-17). This settlement
          -- releases the winner's seats at this satellite in this same
          -- transaction, so those seats cannot be the games that cap the
          -- winner. Counting them held Sunday Deep Stack Satellite 10 RUNNING
          -- and unpaid for two hours on 2026-10-16 while its sole survivor
          -- "sat" at the table this settlement was about to close. The
          -- subtraction mirrors clause (1) of fn_concurrent_game_load exactly,
          -- so it removes only seats that clause counted.
          - (SELECT count(*)::int
               FROM public.table_seats zts
               JOIN public.tables zt ON zt.id = zts.table_id
              WHERE zts.user_id = v_finisher.user_id
                AND zts.left_at IS NULL
                AND zt.status <> 'closed'
                AND zt.tournament_id = p_tournament_id
                AND NOT EXISTS (
                  SELECT 1 FROM public.tournaments ztr
                   WHERE ztr.id = zt.tournament_id
                     AND ztr.status IN ('COMPLETING','COMPLETED','CANCELLED')));
        IF v_cap_load>=4 THEN
          IF v_diamond THEN
            -- A CAPPED DIAMOND WINNER IS PAID, NOT HELD (2026-10-17). The
            -- refusal this replaces promised "the engine retries", but a
            -- winner seated at four long events keeps the satellite RUNNING,
            -- undealt and unpaid for hours - a deadlock, not a rule. The
            -- duplicate-qualification rule already pays a Diamond ticket's
            -- value as money through the same pay door (fn_credit_and_log ->
            -- fn_poker_diamond_tournament_pay); the capped winner takes
            -- exactly that path, whole Diamonds, obligation opened and
            -- closed in this transaction, so the event always finishes and
            -- the winner is always paid at once.
            v_delivery_kind := 'cash';
          ELSE
          -- The cap remains absolute. The winner receives the funded entry as
          -- a noncash tournament ticket instead of a fifth game or wallet chips.
          v_delivery_kind := 'ticket';
          END IF;
        ELSE
          v_delivery_kind := 'seat';
        END IF;
      END IF;

      IF v_delivery_kind = 'seat' THEN
        v_seat_count := v_seat_count + 1;
      ELSIF v_delivery_kind = 'ticket' THEN
        v_entry_ticket_count := v_entry_ticket_count + 1;
      ELSE
        v_cash_ticket_count := v_cash_ticket_count + 1;
      END IF;
      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', v_place,
        'user_id', v_finisher.user_id,
        'delivery_kind', v_delivery_kind));
    END LOOP;
  END IF;
  IF v_seat_count + v_cash_ticket_count + v_entry_ticket_count
       <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % did not classify every funded ticket',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- Closed/full/independently-held tickets are cash substitutions and do not
  -- touch target aggregates. Validate those mutable target banks only when
  -- this exact plan will add at least one real registration.
  -- DIAMOND PHASE 9: a Diamond target's money is its Diamond ledger and its
  -- custody, not a chip escrow. A satellite does not open its shadow (its own
  -- terminal does); the aggregates it publishes must be exactly its banks
  -- before a seat is added, and its banks exactly its custody.
  IF v_seat_count > 0 AND v_diamond THEN
    SELECT e.prize_balance, e.fee_balance, e.bounty_balance
      INTO v_target_prize_before, v_target_fee_before, v_target_bounty_before
      FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e;
    v_target_custody_before := public.fn_poker_diamond_tournament_custody(v_target_id)::numeric;
    IF v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS DISTINCT FROM v_target_prize_before
       OR v_target.total_rake IS DISTINCT FROM v_target_fee_before
       OR v_target_bounty_before IS DISTINCT FROM 0::numeric
       OR v_target_prize_before + v_target_fee_before IS DISTINCT FROM v_target_custody_before THEN
      RAISE EXCEPTION
        'satellite % cannot deliver a Diamond target seat against malformed aggregate or bank state',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;
  IF v_seat_count > 0 AND NOT v_diamond THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
    -- it belongs after seat classification and only on the actual seat path.
    PERFORM public.fn_ca_escrow_apply(
      v_target_id, 'atomic satellite settlement target seat lock');
    SELECT * INTO v_target_escrow FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
  END IF;
  IF v_seat_count > 0 AND NOT v_diamond AND (
       v_target.current_players IS NULL
       OR v_target.current_players < 0
       OR v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS NULL
       OR v_target.prize_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_target.prize_pool < 0
       OR v_target.prize_pool IS DISTINCT FROM round(v_target.prize_pool, 2)
       OR v_target.total_rake IS NULL
       OR v_target.total_rake::text IN ('NaN','Infinity','-Infinity')
       OR v_target.total_rake < 0
       OR v_target.total_rake IS DISTINCT FROM round(v_target.total_rake, 2)
       OR (v_target_fee > 0 AND v_target.club_id IS NULL)
       OR v_target_escrow.tournament_id IS NULL
       OR v_target_escrow.enforced IS DISTINCT FROM true
       OR v_target_escrow.closed_at IS NOT NULL
       OR v_target_escrow.close_note IS NOT NULL
       OR v_target_escrow.prize_balance IS NULL
       OR v_target_escrow.prize_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.prize_balance < 0
       OR v_target_escrow.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance, 2)
       OR v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance
       -- A bounty target's bounty bank is exactly its published pool less
       -- what knockouts have already paid from it (2026-10-16).
       OR v_target_escrow.bounty_balance IS DISTINCT FROM
            (CASE WHEN v_target_is_bounty
                  THEN round(COALESCE(v_target.bounty_pool, 0)
                             - COALESCE(v_target.bounty_pool_paid, 0), 2)
                  ELSE 0::numeric END)
       OR v_target_escrow.fee_balance IS NULL
       OR v_target_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.fee_balance < 0
       OR v_target_escrow.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance, 2)
       OR v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance
       OR EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
             'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
             'refund_prize','refund_bounty','refund_fee',
             'reserve_out','reserve_in'
           ]::text[]) AS component(name)
           CROSS JOIN LATERAL (
             SELECT (to_jsonb(v_target_escrow)->>component.name)::numeric AS amount
           ) AS persisted
          WHERE persisted.amount IS NULL
             OR CASE
                  WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                    THEN true
                  ELSE persisted.amount < 0
                    OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
                END
       )
     ) THEN
    RAISE EXCEPTION
      'satellite % cannot deliver a target seat against malformed aggregate or escrow state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, qualifier_ids, receipt_version, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, entry_ticket_count,
     remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (p_tournament_id, v_target_id, false, NULL,
     NULL, v_qualifier_ids, 3, v_field_size, v_advertised_seats, v_pool,
     v_target_buy_in, v_target_fee, v_ticket_cost, v_ticket_award_count,
     v_seat_count, v_cash_ticket_count, v_entry_ticket_count, v_remainder,
     v_bubble_user_id, v_bubble_position,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at, v_closeout_at, v_source_escrow_close_note, v_closeout_at);

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status, '')) IN ('RUNNING','COMPLETING')
     AND COALESCE(prize_pool_finalized, false);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    v_place := (v_plan_item->>'place')::integer;
    v_delivery_kind := v_plan_item->>'delivery_kind';
    SELECT * INTO v_finisher FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = (v_plan_item->>'user_id')::uuid;
    IF v_finisher.id IS NULL THEN
      RAISE EXCEPTION 'satellite % delivery plan lost finisher at place %',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;

    IF v_delivery_kind = 'seat' THEN
      -- A bounty seat carries its funded head on the row, exactly as the
      -- paid door writes it (flat bounty on the head, mystery value drawn
      -- later from the chest inventory), so trg_seed_bounty_head finds it
      -- already seeded and never raises an unfunded head (2026-10-16).
      IF v_entry_bounty > 0 THEN
        INSERT INTO public.tournament_players
          (tournament_id, user_id, username, chips, status,
           is_satellite_qualifier, source_satellite_id,
           current_bounty, mystery_bounty_value, bounties_collected,
           bounty_winnings)
        VALUES
          (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
           true, p_tournament_id, v_entry_bounty, 0, 0, 0)
        RETURNING * INTO v_admitted;
      ELSE
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         is_satellite_qualifier, source_satellite_id)
      VALUES
        (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
         true, p_tournament_id)
      RETURNING * INTO v_admitted;
      END IF;
      v_registration_id := v_admitted.id;
      -- The admission trigger selects the member club for a union entrant.
      -- It is the funding/refund identity used by ordinary ticket admission.
      IF v_admitted.club_id IS NULL
         OR v_admitted.tournament_id IS DISTINCT FROM v_target_id
         OR v_admitted.user_id IS DISTINCT FROM v_finisher.user_id
         OR v_admitted.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR v_admitted.is_satellite_qualifier IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'satellite seat returned inconsistent registration identity'
          USING ERRCODE='P0404';
      END IF;
      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
      IF v_diamond THEN
        -- DIAMOND PHASE 9: THE SEAT IS A CUSTODY-TO-CUSTODY MOVEMENT. The
        -- whole ticket leaves the satellite's prize bank (a release movement
        -- on each drained entry row) and becomes the winner's funded entry
        -- in the target (a new tournament_entry custody row, its reserve
        -- movement, and the entry ledger row carrying the target's own prize
        -- and fee parts). No wallet moves and the register does not move;
        -- the chip transfer leg and the chip fee row are not written. It is
        -- written before any chair is taken: a Diamond tournament chair is
        -- admitted only against an active funded entry (P0810).
        v_diamond_seat := public.fn_poker_diamond_tournament_seat_transfer(
          p_tournament_id, v_target_id, v_finisher.user_id, v_registration_id,
          v_ticket_cost, v_target_buy_in, v_target_fee,
          'tourney:' || p_tournament_id::text || ':seat:' || v_finisher.user_id::text);
        IF COALESCE((v_diamond_seat->>'success')::boolean, false) IS NOT TRUE
           OR COALESCE((v_diamond_seat->>'idempotent')::boolean, false) THEN
          RAISE EXCEPTION 'satellite % Diamond seat % was not delivered exactly once',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        END IF;
      END IF;

      /* EVERY ADMITTED ENTRANT IS DEALT IN (2026-09-25).

         The INSERT above writes status 'registered' with a zero stack and
         leaves the chair to whoever launches the target. That is correct while
         the target is ANNOUNCED or REGISTERING: startLifecycle reads the
         roster with status IN ('registered','playing') and
         createTablesAndSeatPlayers seats every one of them.

         A target that is already RUNNING has no such moment. Its tables exist,
         so the engine takes the resume branch that adopts them and never calls
         createTablesAndSeatPlayers again, and nothing else comes back for a
         roster row parked at 'registered'. The sibling ticket-funded admission
         path does not have this hole: fn_ca_register_for_tournament_with_ticket_for
         takes the chair through fn_seat_late_registrant in the same
         transaction that admits the entry. This door did not.

         Measured: satellite 95b5fd70 delivered place 1 into RUNNING target
         c7f21a83 ("Sunday Funday Six-Card Closer") at 2026-09-22 14:08:23.
         The winner has held a paid registration and no stack ever since. From
         the very next sample at 14:10:02 the tournament chip-conservation
         sentinel reported the event holding 120,000 against 150,000 issued to
         its five entrants, and it has reported the same -30,000 for 473
         consecutive samples with hands_dealt = 0 in every one of them - no
         chips moved, one starting stack was simply never created. Exactly one
         entrant on the whole estate is in that state, and this is the door it
         came through.

         So the chair is taken HERE, through the same canonical authority every
         other late-registration path uses, inside the transaction that books
         the admission. fn_ca_lock_tournament_seat_acquisition takes the global
         lane shared and then the target's rolling lane; this transaction
         already holds the global lane exclusively and already holds v_target
         FOR UPDATE, so the acquisition order is unchanged (G before T) and no
         new lane is introduced. A refusal raises rather than leaving a
         registration the tournament will never deal in: the satellite
         settlement is atomic, so the whole delivery is rolled back and retried
         rather than half-made.

         A maintenance freeze is one such refusal:
         fn_ca_lock_tournament_seat_acquisition answers
         {"ok": false, "reason": "platform_frozen"} and this raises, so a
         satellite that finishes inside the hourly break settles after the thaw
         instead of admitting a winner the frozen platform cannot seat. That is
         the same answer every other seat door gives during a break, and this
         settlement is idempotent on its own receipt. */
      IF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
        v_seat_receipt := public.fn_seat_late_registrant(
          v_target_id, v_finisher.user_id);
        IF COALESCE((v_seat_receipt->>'ok')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION
            'satellite % admitted place % to RUNNING target % and could not deal them in: % - Aborting So No Unseatable Entry Is Booked',
            p_tournament_id, v_place, v_target_id, v_seat_receipt
            USING ERRCODE = '55000';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM public.table_seats ts
            JOIN public.tables tb ON tb.id = ts.table_id
           WHERE tb.tournament_id = v_target_id
             AND ts.user_id = v_finisher.user_id
             AND ts.left_at IS NULL) THEN
          RAISE EXCEPTION
            'satellite % target seat for place % reported success but left no live chair in %',
            p_tournament_id, v_place, v_target_id
            USING ERRCODE = '55000';
        END IF;
      END IF;

      IF NOT v_diamond THEN  -- DIAMOND PHASE 9: the chip transfer and fee legs
      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'prize_liability', v_target_id, 'tournaments.prize_pool+total_rake',
         v_ticket_cost, 'tournament_buyin', v_admitted.club_id, p_tournament_id,
         'tourney:' || p_tournament_id::text || ':seat:'
            || v_finisher.user_id::text || ':pool_transfer',
         'satellite:' || p_tournament_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket award slot %s delivered as target seat (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'satellite_seat_pool_transfer',
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'award_slot', v_place,
           'registration_id', v_registration_id,
           'seat_value', v_ticket_cost,
           'moved', v_ticket_cost,
           'unbacked', 0)
         -- A bounty seat's leg names its split (entry_split_version 2), so
         -- fn_ca_escrow_on_seat_transfer_leg books prize plus bounty as gross
         -- and the bounty on the bounty rail, as a paid entry is booked.
         || CASE WHEN v_entry_bounty > 0 THEN jsonb_build_object(
              'entry_split_version', 2,
              'entry_prize', v_entry_prize,
              'entry_bounty', v_entry_bounty,
              'entry_fee', v_target_fee)
            ELSE '{}'::jsonb END,
         v_pool_before, round(v_pool_before - v_ticket_cost, 2));

      -- The transfer leg puts the complete ticket into target satellite-in.
      -- A positive fee row reclassifies only that fee from target prize to
      -- target fee escrow. A zero-fee target needs no synthetic rake record.
      IF v_target_fee > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source, metadata)
        VALUES
          (NULL, NULL, v_target.club_id, v_target_fee, v_ticket_cost, 1,
           0, true, v_target_id, 'fn_award_satellite_seat',
           jsonb_build_object(
             'kind', 'satellite_seat_entry_fee',
             'recorded_by', 'fn_settle_satellite_tournament',
             'user_id', v_finisher.user_id,
             'award_slot', v_place,
             'satellite_id', p_tournament_id,
             'registration_id', v_registration_id)
           -- A split leg's gross already excludes the fee, so its fee row
           -- moves only the fee into fee escrow (fn_ca_escrow_on_rake_record).
           || CASE WHEN v_entry_bounty > 0
                   THEN jsonb_build_object('entry_split_version', 2)
                   ELSE '{}'::jsonb END);
      END IF;
      END IF;  -- DIAMOND PHASE 9: the chip transfer and fee legs

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_finisher.position, v_ticket_cost,
         'satellite_seat', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'registration_id', v_registration_id,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'pool_transfer', v_ticket_cost,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, registration_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'seat', v_ticket_cost,
         v_payout_id, 'satellite_seat', v_payout_key, v_registration_id);
    ELSIF v_delivery_kind = 'ticket' THEN
      -- A four-table cap is not an economic failure and cannot turn a funded
      -- satellite award into wallet chips. Resolve the exact target club and
      -- escrow the funded award in a target-scoped, noncash ticket instead.
      v_ticket_club_id := public.fn_tournament_club_for_user(
        v_finisher.user_id, v_target_id,
        COALESCE(v_target.club_id, v_source.club_id));
      -- A UNION TICKET IS ISSUED AT THE CLUB THE WINNER PLAYS FROM
      -- (2026-09-10): a union-hosted target accepts a ticket at any member
      -- club of its union, exactly as redemption already does. Demanding the
      -- house club refused every capped winner of a union satellite.
      IF v_ticket_club_id IS NULL
         OR (v_target.club_id IS NOT NULL
             AND v_ticket_club_id IS DISTINCT FROM v_target.club_id
             AND NOT EXISTS (
               SELECT 1 FROM public.tournaments tt
               JOIN public.union_clubs uc ON uc.union_id = tt.union_id
              WHERE tt.id = v_target_id AND uc.club_id = v_ticket_club_id)) THEN
        RAISE EXCEPTION
          'satellite % ticket place % has no exact target club',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_ticket_id := gen_random_uuid();
      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_finisher.position, v_ticket_cost,
         'satellite_ticket', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_tickets
        (id, club_id, issued_by, holder_id, value, status, note,
         redemption_mode, source_tournament_id, source_satellite_id,
         source_refund_entitlement_id, source_satellite_award_place,
         entry_prize, entry_bounty, entry_fee, created_at)
      VALUES
        (v_ticket_id, v_ticket_club_id,
         '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         v_finisher.user_id, v_ticket_cost, 'issued',
         'Four-Table Cap Satellite Award: Tournament Entry Only',
         'tournament_entry_only', v_target_id, p_tournament_id,
         NULL, v_place, v_entry_prize, v_entry_bounty, v_target_fee,
         transaction_timestamp());

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance,
         pre_to_balance, post_to_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'escrow', v_ticket_id, 'satellite tournament entry ticket',
         v_ticket_cost, 'ticket_issue', v_ticket_club_id, p_tournament_id,
         v_payout_key || ':ticket_escrow',
         'satellite-ticket:' || v_ticket_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket award slot %s held as noncash target entry (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'direct_satellite_entry_ticket',
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'payout_id', v_payout_id,
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'award_slot', v_place,
           'entry_prize', v_entry_prize,
           'entry_bounty', v_entry_bounty,
           'entry_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2),
         0, v_ticket_cost)
      RETURNING id INTO v_ticket_ledger_id;

      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type,
         notes, balance_after, metadata)
      VALUES
        (v_ticket_club_id, NULL, v_finisher.user_id, v_ticket_cost,
         'tournament_ticket_issue',
         'Satellite Award Held As Tournament-Entry Ticket', NULL,
         jsonb_build_object(
           'ticket_id', v_ticket_id,
           'escrow_entity_id', v_ticket_id,
           'holder_id', v_finisher.user_id,
           'value', v_ticket_cost,
           'redemption_mode', 'tournament_entry_only',
           'source_tournament_id', v_target_id,
           'source_satellite_id', p_tournament_id,
           'source_award_place', v_place,
           'payout_id', v_payout_id,
           'ledger_id', v_ticket_ledger_id,
           'idempotency_key', v_payout_key,
           'wallet_chips_credited', 0))
      RETURNING id INTO v_ticket_transaction_id;

      PERFORM public.fn_ca_escrow_apply(
        p_tournament_id, 'direct satellite entry ticket out',
        p_prize_out => v_ticket_cost);

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, ticket_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'ticket',
         v_ticket_cost, v_payout_id, 'satellite_ticket', v_payout_key,
         v_ticket_id);
    ELSIF v_delivery_kind = 'cash' THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'seat', v_place, v_finisher.user_id,
         v_ticket_cost, 0, 'engine.fn_settle_satellite_tournament', NULL)
      RETURNING * INTO v_obligation;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      v_credited := public.fn_credit_and_log(
        p_user_id => v_finisher.user_id,
        p_amount => v_ticket_cost,
        p_idempotency_key => v_payout_key,
        p_category => 'prize',
        p_description => 'Satellite ticket paid in cash because target admission was definitively unavailable',
        p_related_entity_id => p_tournament_id,
        p_wallet_type => 'PLAYER',
        p_table_id => NULL,
        p_hand_id => NULL,
        p_payout_position => v_finisher.position,
        p_payout_source => 'satellite_ticket');
      IF v_credited IS NOT TRUE THEN
        RAISE EXCEPTION 'satellite % cash ticket % was not a new exact credit',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_obligations o
         SET amount_paid = v_ticket_cost, settled_at = now(), updated_at = now()
       WHERE o.id = v_obligation.id
         AND o.amount_owed = v_ticket_cost AND o.amount_paid = 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'satellite % could not close cash ticket debt %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      SELECT p.id INTO v_payout_id FROM public.tournament_payouts p
       WHERE p.idempotency_key = v_payout_key
         AND p.tournament_id = p_tournament_id
         AND p.user_id = v_finisher.user_id
         AND p."position" IS NOT DISTINCT FROM v_finisher.position
         AND p.amount = v_ticket_cost
         AND p.source = 'satellite_ticket';
      IF v_payout_id IS NULL THEN
        RAISE EXCEPTION 'satellite % cash ticket % has no payout row',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key,
         obligation_id, obligation_kind)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'cash', v_ticket_cost,
         v_payout_id, 'satellite_ticket', v_payout_key,
         v_obligation.id, 'seat');
    ELSE
      RAISE EXCEPTION 'satellite % has unknown delivery kind % at place %',
        p_tournament_id, v_delivery_kind, v_place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_seat_count > 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE tp.status::text IN ('registered','playing'))
      INTO v_target_count, v_target_live_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
    v_target_counter_after := CASE
      WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
        THEN v_target_live_count
      ELSE v_target_count
    END;
    IF v_target_count IS DISTINCT FROM v_target_count_before + v_seat_count
       OR v_target_live_count IS DISTINCT FROM
            v_target_live_count_before + v_seat_count
       OR v_target_counter_after IS DISTINCT FROM
            v_target_counter_before + v_seat_count THEN
      RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournaments
       SET current_players = v_target.current_players + v_seat_count,
           prize_pool = round(COALESCE(prize_pool, 0)
                              + v_seat_count * v_entry_prize, 2),
           bounty_pool = CASE WHEN v_entry_bounty > 0
                              THEN round(COALESCE(bounty_pool, 0)
                                         + v_seat_count * v_entry_bounty, 2)
                              ELSE bounty_pool END,
           total_rake = round(COALESCE(total_rake, 0)
                             + v_seat_count * v_target_fee, 2),
           updated_at = now()
     WHERE id = v_target_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not update target aggregate receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT t.id, t.current_players, t.prize_pool, t.total_rake, t.bounty_pool
      INTO v_target_after
      FROM public.tournaments t
     WHERE t.id = v_target_id;
    SELECT * INTO v_target_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
    IF v_target_after.id IS NULL
       OR v_target_after.current_players IS DISTINCT FROM
            v_target.current_players + v_seat_count
       OR v_target_after.current_players IS DISTINCT FROM v_target_counter_after
       OR v_target_after.prize_pool IS DISTINCT FROM
            round(v_target.prize_pool + v_seat_count * v_entry_prize, 2)
       OR v_target_after.bounty_pool IS DISTINCT FROM
            (CASE WHEN v_entry_bounty > 0
                  THEN round(COALESCE(v_target.bounty_pool, 0)
                             + v_seat_count * v_entry_bounty, 2)
                  ELSE v_target.bounty_pool END)
       OR v_target_after.total_rake IS DISTINCT FROM
            round(v_target.total_rake + v_seat_count * v_target_fee, 2)
       OR (NOT v_diamond AND (v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
       OR v_target_escrow_after.enforced IS DISTINCT FROM v_target_escrow.enforced
       OR v_target_escrow_after.gross_in IS DISTINCT FROM
            round(v_target_escrow.gross_in
                  + CASE WHEN v_entry_bounty > 0
                         THEN v_seat_count * (v_entry_prize + v_entry_bounty)
                         ELSE 0 END, 2)
       OR v_target_escrow_after.fee_entries_in IS DISTINCT FROM v_target_escrow.fee_entries_in
       OR v_target_escrow_after.satellite_fee_in IS DISTINCT FROM
            round(v_target_escrow.satellite_fee_in
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.bounty_in IS DISTINCT FROM
            round(v_target_escrow.bounty_in + v_seat_count * v_entry_bounty, 2)
       OR v_target_escrow_after.overlay_in IS DISTINCT FROM v_target_escrow.overlay_in
       OR v_target_escrow_after.satellite_in IS DISTINCT FROM
            round(v_target_escrow.satellite_in
                  + CASE WHEN v_entry_bounty > 0 THEN 0
                         ELSE v_seat_count * v_target_buy_in END, 2)
       OR v_target_escrow_after.prize_out IS DISTINCT FROM v_target_escrow.prize_out
       OR v_target_escrow_after.bounty_out IS DISTINCT FROM v_target_escrow.bounty_out
       OR v_target_escrow_after.fee_out IS DISTINCT FROM v_target_escrow.fee_out
       OR v_target_escrow_after.refund_prize IS DISTINCT FROM v_target_escrow.refund_prize
       OR v_target_escrow_after.refund_bounty IS DISTINCT FROM v_target_escrow.refund_bounty
       OR v_target_escrow_after.refund_fee IS DISTINCT FROM v_target_escrow.refund_fee
       OR v_target_escrow_after.reserve_out IS DISTINCT FROM v_target_escrow.reserve_out
       OR v_target_escrow_after.reserve_in IS DISTINCT FROM v_target_escrow.reserve_in
       OR v_target_escrow_after.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance
                  + v_seat_count * v_entry_prize, 2)
       OR v_target_escrow_after.bounty_balance IS DISTINCT FROM
            round(v_target_escrow.bounty_balance + v_seat_count * v_entry_bounty, 2)
       OR v_target_escrow_after.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.opened_at IS DISTINCT FROM v_target_escrow.opened_at
       OR v_target_escrow_after.opened_from IS DISTINCT FROM v_target_escrow.opened_from
       OR v_target_escrow_after.closed_at IS DISTINCT FROM v_target_escrow.closed_at
       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note))
       -- DIAMOND PHASE 9: a Diamond target proves the delta on its own banks:
       -- each seat added exactly its buy-in to the prize bank, its fee to the
       -- fee bank and its ticket to custody, and the aggregates follow them.
       OR (v_diamond AND (
            (SELECT e.prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM v_target_prize_before + v_seat_count * v_target_buy_in
         OR (SELECT e.fee_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM v_target_fee_before + v_seat_count * v_target_fee
         OR (SELECT e.bounty_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM 0::numeric
         OR public.fn_poker_diamond_tournament_custody(v_target_id)::numeric
              IS DISTINCT FROM v_target_custody_before + v_seat_count * v_ticket_cost
         OR v_target_after.prize_pool IS DISTINCT FROM
              (SELECT e.prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
         OR v_target_after.total_rake IS DISTINCT FROM
              (SELECT e.fee_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e))) THEN
      RAISE EXCEPTION
        'satellite % target aggregate or escrow delta is not the exact delivered seat value',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF v_remainder > 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'satellite_remainder', v_bubble_position,
       v_bubble_user_id, v_remainder, 0,
       'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obligation;

    v_payout_key := 'tourney:' || p_tournament_id::text
                    || ':satellite_remainder:place:'
                    || v_bubble_position::text;
    v_credited := public.fn_credit_and_log(
      p_user_id => v_bubble_user_id,
      p_amount => v_remainder,
      p_idempotency_key => v_payout_key,
      p_category => 'prize',
      p_description => 'Satellite pool remainder paid to the single bubble',
      p_related_entity_id => p_tournament_id,
      p_wallet_type => 'PLAYER',
      p_table_id => NULL,
      p_hand_id => NULL,
      p_payout_position => v_bubble_position,
      p_payout_source => 'satellite_remainder');
    IF v_credited IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite % remainder credit was not a new exact credit',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_obligations
       SET amount_paid = v_remainder, settled_at = now(), updated_at = now()
     WHERE id = v_obligation.id
       AND tournament_id = p_tournament_id
       AND kind = 'satellite_remainder' AND place = v_bubble_position
       AND user_id = v_bubble_user_id
       AND amount_owed = v_remainder
       AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not close one exact remainder debt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT p.id INTO v_payout_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user_id
       AND p."position" = v_bubble_position
       AND p.amount = v_remainder
       AND p.source = 'satellite_remainder'
       AND p.idempotency_key = v_payout_key;
    IF v_payout_id IS NULL THEN
      RAISE EXCEPTION 'satellite % remainder has no exact payout row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    INSERT INTO public.tournament_satellite_remainders
      (tournament_id, user_id, place, amount,
       payout_id, payout_source, payout_position, idempotency_key,
       obligation_id, obligation_kind, obligation_place, evidence_kind)
    VALUES
      (p_tournament_id, v_bubble_user_id, v_bubble_position, v_remainder,
       v_payout_id, 'satellite_remainder', v_bubble_position, v_payout_key,
       v_obligation.id, 'satellite_remainder', v_bubble_position, 'atomic');
  END IF;

  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_players SET prize = v_ticket_cost
   WHERE tournament_id = p_tournament_id
     AND user_id=ANY(v_award_users);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % stamped % ticket caches, expected %',
      p_tournament_id, v_rows, v_ticket_award_count USING ERRCODE = 'P0404';
  END IF;
  IF v_remainder > 0 THEN
    UPDATE public.tournament_players SET prize = v_remainder
     WHERE tournament_id = p_tournament_id
       AND user_id = v_bubble_user_id AND position = v_bubble_position;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not stamp the single bubble cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_payout_count <> (v_ticket_award_count
                        + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END)
     OR v_paid IS DISTINCT FROM v_pool THEN
    RAISE EXCEPTION 'satellite % paid % of locked pool % across % rows',
      p_tournament_id, v_paid, v_pool, v_payout_count
      USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id, 'engine.fn_settle_satellite_tournament');
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF COALESCE((v_rake_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_rake_result->>'amount')::numeric, 0) > 0
         AND COALESCE((v_rake_result->>'attributed')::boolean, false) IS NOT TRUE AND NOT v_deferred) THEN
    RAISE EXCEPTION 'satellite % rake did not settle and attribute exactly: %',
      p_tournament_id, v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION
      'satellite % settlement leaves escrow prize %, bounty %, fee %',
      p_tournament_id, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0404';
  END IF;

  -- The atomic authority, not the legacy lifecycle observer, owns the escrow
  -- close. Stamp the exact zero proof before publishing COMPLETED so the
  -- receipt remains valid after that observer is retired by the terminal
  -- cutover migration.
  UPDATE public.tournament_escrow
     SET closed_at = v_closeout_at,
         close_note = v_source_escrow_close_note,
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND closed_at IS NULL
     AND close_note IS NULL
     AND prize_balance = 0
     AND bounty_balance = 0
     AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Source felt closure is part of the money commit. This runs after tickets,
  -- the single Bubble remainder, rake and escrow so any table/seat refusal
  -- rolls all of those effects back. The pre-payer identity arrays prevent a
  -- concurrent table or seat from appearing outside the receipt.
  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '55000';
  END IF;

  -- Elimination already gave predeparted seats a durable departure time. Close
  -- only their mutable occupancy flags here; never rewrite that historical time
  -- or fire left_at-specific effects a second time.
  UPDATE public.table_seats ts
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_source_seat_ids)
     AND ts.left_at IS NOT NULL
     AND (ts.status IS DISTINCT FROM 'left'
       OR ts.leave_pending IS DISTINCT FROM false
       OR ts.is_sitting_out IS DISTINCT FROM false
       OR ts.is_away IS DISTINCT FROM false
       OR ts.sit_out_at IS NOT NULL
       OR ts.scheduled_leave_hands IS NOT NULL);

  -- Mark the game terminal only after its seats are released, but before its
  -- tables close. The existing table-status trigger treats a close under a
  -- COMPLETING tournament as an accidental live-game close and files an
  -- incident. COMPLETED is therefore the canonical parent-before-child order.
  -- A later table-close refusal still rolls this status and all money back.
  UPDATE public.tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true,
         current_players = 0, on_break = false,
         break_started_at = NULL, break_ends_at = NULL, updated_at = now()
   WHERE id = p_tournament_id AND upper(COALESCE(status, '')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_closeout_at,
         updated_at = now()
   WHERE tb.id = ANY(v_source_table_ids)
     AND tb.tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_source_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  RETURN public.fn_ca_satellite_cohort_receipt(
    p_tournament_id, p_observed_qualifier_ids);
END;
$function$;

-- Who may call each function: exactly production's grants, restated.
REVOKE ALL ON FUNCTION public.fn_satellite_target_is_deliverable(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_satellite_target_is_deliverable(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_satellite_feeds_only_a_deliverable_target() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_target_accepts_new_feeder(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_guard_new_satellite_target() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_capture_satellite_seat_entitlement() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_settlement_receipt(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_cohort_receipt(uuid,uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_settle_satellite_cohort(uuid,uuid[]) FROM PUBLIC, anon, authenticated, service_role;

DO $postimage$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_satellite_target_is_deliverable(uuid)',
     'dbd45692f53316d0142c0034fe0a7245','a7d1e00b04527ee42ef2cce9cabf7991'),
    ('public.fn_satellite_feeds_only_a_deliverable_target()',
     '4251f65adfd51a29967a346af7ae98f1','15f3578458940fc926837e96c4c8da67'),
    ('public.fn_ca_satellite_target_accepts_new_feeder(uuid)',
     '3933ec28773f12a1da9b02952ad99ed4','056d68f3cc832e90a22e0571154ab142'),
    ('public.fn_ca_guard_new_satellite_target()',
     '8e0149116be545a6b4ccc0bfe690c372','5634948d5e2f073ec4205176607e7c21'),
    ('public.fn_ca_capture_satellite_seat_entitlement()',
     '4cf7de45bec781bc708bcdf9f1ce9845','f8404f55d30cc6ae4a317d49df14c4ee'),
    ('public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)',
     '1faed89ef1c23d05f2b7f90715048efd','b4ed52d3fbf81f55d935666357eb9781'),
    ('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)',
     'bf8a5f20ef63427093a662c62edc5d65','377446dc1ccce91cbf8a7af0c713ec7f'),
    ('public.fn_ca_satellite_settlement_receipt(uuid,uuid)',
     '752a8d976b306c37db92a8b42863424b','c4b817ae5a6d328dc3118bdfc5d98c21'),
    ('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])',
     '6cdc896a54b4f3726b3c3aa444be7647','df717a9f260a1318ffb28f114625008b'),
    ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',
     '8fb5cdbc0fd4caae36d1e6191a1e9b6d','14eddc55fc178f81232f619fa764ee7e'),
    ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',
     '22063fc9eca98d335f633772aae2d19d','e248788b7f4e0a4779444ba43ba2ae4b')
  ) AS v(sig, pre, post) LOOP
    v_md5 := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_md5 IS DISTINCT FROM r.post THEN
      RAISE EXCEPTION 'SATELLITE_BOUNTY_TARGET_POSTIMAGE_CHANGED: % is %, expected %',
        r.sig, v_md5, r.post;
    END IF;
  END LOOP;
END
$postimage$;

DO $acl$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_satellite_target_is_deliverable(uuid)','{postgres=X/postgres,service_role=X/postgres}'),
    ('public.fn_satellite_feeds_only_a_deliverable_target()','{postgres=X/postgres}'),
    ('public.fn_ca_satellite_target_accepts_new_feeder(uuid)','{postgres=X/postgres}'),
    ('public.fn_ca_guard_new_satellite_target()','{postgres=X/postgres}'),
    ('public.fn_ca_capture_satellite_seat_entitlement()','{postgres=X/postgres}'),
    ('public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)','{postgres=X/postgres}'),
    ('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)','{postgres=X/postgres}'),
    ('public.fn_ca_satellite_settlement_receipt(uuid,uuid)','{postgres=X/postgres}'),
    ('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])','{postgres=X/postgres}'),
    ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)','{postgres=X/postgres,service_role=X/postgres}'),
    ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])','{postgres=X/postgres}')
  ) AS v(sig, acl) LOOP
    IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = r.sig::regprocedure)
       IS DISTINCT FROM r.acl THEN
      RAISE EXCEPTION 'SATELLITE_BOUNTY_TARGET_ACL_CHANGED: % is %, expected %', r.sig,
        (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = r.sig::regprocedure), r.acl;
    END IF;
  END LOOP;
END
$acl$;

COMMIT;
