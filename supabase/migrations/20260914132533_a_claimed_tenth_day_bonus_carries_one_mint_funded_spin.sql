-- The tenth claimed Daily Bonus milestone awards one 100-diamond spin ticket.
-- Dan, September 14: it must be claimed before use. The Mint pays ONLY the
-- 100-diamond entry to the selected Union/Club owner. All winnings retain the
-- Promo Wallet first, Main Bank shortfall path. The one-time welcome remains
-- separate: once per member per host and no owner intake on that welcome.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='90s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_daily_bonus_open_day(uuid,date)'::regprocedure)) <> '882721aa139248bf5a6b16885ac7408b' THEN RAISE EXCEPTION 'Live predecessor changed: fn_ca_daily_bonus_open_day'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_daily_bonus_claim(integer,uuid,uuid,date,jsonb)'::regprocedure)) <> '0517a06eb3650660bcf327be774c02c4' THEN RAISE EXCEPTION 'Live predecessor changed: fn_ca_daily_bonus_claim'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_daily_bonus_status()'::regprocedure)) <> 'a9c60246d81544d33d7f9d603acd34c7' THEN RAISE EXCEPTION 'Live predecessor changed: fn_ca_daily_bonus_status'; END IF;
 IF md5(pg_get_functiondef('public.fn_wheel_spin_core(uuid,uuid,text,boolean)'::regprocedure)) <> '802ef4dfd37e0d15d1775a80c43bcf6f' THEN RAISE EXCEPTION 'Live predecessor changed: fn_wheel_spin_core'; END IF;
 IF md5(pg_get_functiondef('public.fn_wheel_spin_result(public.wheel_spins)'::regprocedure)) <> '585c03683b2dddf43419e19d9d5cf86e' THEN RAISE EXCEPTION 'Live predecessor changed: fn_wheel_spin_result'; END IF;
 IF md5(pg_get_functiondef('public.fn_diamond_games_spent_today(uuid,uuid)'::regprocedure)) <> '7d5f8cd069693bc327d5c35f86c2057d' THEN RAISE EXCEPTION 'Live predecessor changed: fn_diamond_games_spent_today'; END IF;
 IF md5(pg_get_functiondef('public.fn_wheel_welcome_state(uuid)'::regprocedure)) <> '278f42ab6751bceaaa562bc068ad86fa' THEN RAISE EXCEPTION 'Live predecessor changed: fn_wheel_welcome_state'; END IF;
 IF md5(pg_get_functiondef('public.fn_wheel_welcome_room(uuid)'::regprocedure)) <> 'd95bfbb661565b36686087f44e86831a' THEN RAISE EXCEPTION 'Live predecessor changed: fn_wheel_welcome_room'; END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_wheel_spin_core','approved','Sealed wheel settlement: player-paid, once-per-host welcome, or claimed Daily Bonus entry. Mint funds only a fixed 100-diamond ticket entry; chip prizes draw Promo then the host Main Bank. Exact request replay, locked host and ticket, append-only spin receipt.'),
 ('fn_wheel_daily_bonus_spin','approved','Authenticated holder redeems one claimed tenth-day Daily Bonus ticket. No caller-supplied amount. Delegates to the private core; Mint entry, host payout and immutable ticket redemption share one transaction.'),
 ('fn_diamond_bonus_spin_ticket_guard','approved','Private ticket trigger validates a saved claim and the current member/host, then calls canonical Mint for exactly 100 entry diamonds to the host owner. Canonical Mint policy, freeze, issuance register and journal apply. Deferred settlement requires the matching spin receipt.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;


CREATE TABLE public.diamond_bonus_spin_tickets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  claim_id uuid NOT NULL UNIQUE,
  bonus_date date NOT NULL,
  streak integer NOT NULL CHECK (streak > 0 AND streak % 10 = 0),
  entry_diamonds integer NOT NULL DEFAULT 100 CHECK (entry_diamonds = 100),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  club_id uuid,
  host_id uuid,
  host_kind text CHECK (host_kind IN ('union','club')),
  owner_id uuid,
  commit_id uuid UNIQUE,
  client_seed text,
  mint_op_id text UNIQUE,
  funded_at timestamptz,
  redeemed_spin_id uuid UNIQUE,
  redeemed_at timestamptz,
  CHECK ((funded_at IS NULL AND club_id IS NULL AND host_id IS NULL AND host_kind IS NULL
          AND owner_id IS NULL AND commit_id IS NULL AND client_seed IS NULL AND mint_op_id IS NULL)
      OR (funded_at IS NOT NULL AND club_id IS NOT NULL AND host_id IS NOT NULL AND host_kind IS NOT NULL
          AND owner_id IS NOT NULL AND commit_id IS NOT NULL AND length(client_seed)>0 AND mint_op_id IS NOT NULL)),
  CHECK ((redeemed_spin_id IS NULL) = (redeemed_at IS NULL)),
  CHECK (redeemed_spin_id IS NULL OR funded_at IS NOT NULL)
);
ALTER TABLE public.diamond_bonus_spin_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_bonus_spin_tickets FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.diamond_bonus_spin_tickets TO service_role;
ALTER TABLE public.wheel_spins ADD COLUMN bonus_ticket_id uuid;
CREATE UNIQUE INDEX wheel_spins_one_bonus_ticket ON public.wheel_spins(bonus_ticket_id) WHERE bonus_ticket_id IS NOT NULL;

CREATE FUNCTION public.fn_ca_daily_bonus_spin_tile(p_streak integer)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $fn$
 SELECT CASE WHEN p_streak > 0 AND p_streak % 10 = 0 THEN
 jsonb_build_array(jsonb_build_object('slot',7,'kind','free_spin','label','100 Diamond Bonus Spin',
 'vip_only',false,'quantity',1,'base_diamonds',0,'diamonds',0,'entry_diamonds',100,'funded_by','mint'))
 ELSE '[]'::jsonb END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_spin_tile(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_spin_tile(integer) TO service_role;

-- Only a claimed reward can create this credit. Only its owner's settled spin
-- can consume it. The canonical Mint's existing database-trigger door funds the
-- fixed entry, under its policy and kill switch; no caller-supplied amount exists.
CREATE FUNCTION public.fn_diamond_bonus_spin_ticket_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE h record; m jsonb; c public.ca_daily_bonus_claims; s public.wheel_spins;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bonus Spin Tickets Are Permanent Receipts'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO c FROM public.ca_daily_bonus_claims WHERE id=NEW.claim_id;
  IF c.id IS NULL OR c.user_id IS DISTINCT FROM NEW.user_id OR c.bonus_date IS DISTINCT FROM NEW.bonus_date
     OR c.slot<>7 OR c.granted->>'kind' IS DISTINCT FROM 'free_spin'
     OR c.granted->>'ticket_id' IS DISTINCT FROM NEW.id::text
     OR c.granted->>'funded_by' IS DISTINCT FROM 'mint'
     OR (c.granted->>'entry_diamonds')::integer IS DISTINCT FROM 100
     OR (c.granted->>'quantity')::integer IS DISTINCT FROM 1
     OR (c.result->>'streak')::integer IS DISTINCT FROM NEW.streak
     OR NEW.funded_at IS NOT NULL OR NEW.redeemed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A Bonus Spin Requires Its Claimed Daily Reward';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.user_id,NEW.claim_id,NEW.bonus_date,NEW.streak,NEW.entry_diamonds,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.claim_id,OLD.bonus_date,OLD.streak,OLD.entry_diamonds,OLD.created_at)
    OR OLD.redeemed_spin_id IS NOT NULL THEN
  RAISE EXCEPTION 'A Bonus Spin Receipt Cannot Be Rewritten';
 END IF;
 IF auth.uid() IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'That Bonus Spin Belongs To Another Player' USING ERRCODE='42501'; END IF;
 IF OLD.funded_at IS NULL THEN
  IF NEW.funded_at IS NULL OR NEW.redeemed_spin_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid Bonus Spin Funding Transition'; END IF;
  SELECT * INTO h FROM public.fn_wheel_host(NEW.club_id);
  IF h.host_id IS DISTINCT FROM NEW.host_id OR h.host_kind IS DISTINCT FROM NEW.host_kind
     OR public.fn_diamond_game_owner(h.host_id,h.host_kind) IS DISTINCT FROM NEW.owner_id
     OR NOT EXISTS(SELECT 1 FROM public.club_members WHERE club_id=NEW.club_id AND user_id=NEW.user_id AND COALESCE(status,'active') IN('active','approved'))
     OR NOT EXISTS(SELECT 1 FROM public.wheel_seed_commits WHERE id=NEW.commit_id AND user_id=NEW.user_id AND consumed_by IS NULL AND expires_at>=now()) THEN
    RAISE EXCEPTION 'Bonus Spin Funding Does Not Match Its Member And Host';
  END IF;
  NEW.mint_op_id := 'daily-bonus-spin:'||NEW.id::text;
  NEW.funded_at := transaction_timestamp();
  m := public.fn_ca_mint('diamonds','player',NEW.owner_id,100,
        'Daily Bonus 100 Diamond Spin Entry For Claimed Ticket '||NEW.id::text,NEW.mint_op_id,'promotional');
  IF NOT COALESCE((m->>'ok')::boolean,false) OR (m->>'amount')::numeric IS DISTINCT FROM 100
     OR m->>'target_id' IS DISTINCT FROM NEW.owner_id::text THEN
   RAISE EXCEPTION 'Daily Bonus Spin Funding Is Unavailable: %',COALESCE(m->>'reason','mint_refused') USING ERRCODE='PDS01';
  END IF;
 ELSE
  IF (NEW.club_id,NEW.host_id,NEW.host_kind,NEW.owner_id,NEW.commit_id,NEW.client_seed,NEW.mint_op_id,NEW.funded_at)
     IS DISTINCT FROM (OLD.club_id,OLD.host_id,OLD.host_kind,OLD.owner_id,OLD.commit_id,OLD.client_seed,OLD.mint_op_id,OLD.funded_at)
     OR NEW.redeemed_spin_id IS NULL THEN RAISE EXCEPTION 'Bonus Spin Funding Cannot Be Changed'; END IF;
  SELECT * INTO s FROM public.wheel_spins WHERE id=NEW.redeemed_spin_id;
  IF s.id IS NULL OR s.bonus_ticket_id IS DISTINCT FROM NEW.id OR s.user_id IS DISTINCT FROM NEW.user_id
     OR s.club_id IS DISTINCT FROM NEW.club_id OR s.host_id IS DISTINCT FROM NEW.host_id
     OR s.commit_id IS DISTINCT FROM NEW.commit_id OR s.client_seed IS DISTINCT FROM NEW.client_seed
     OR s.is_welcome OR s.spin_price_diamonds<>100 OR s.diamond_accrual<>100 THEN
    RAISE EXCEPTION 'Bonus Spin Redemption Does Not Match Its Funded Entry';
  END IF;
  NEW.redeemed_at := transaction_timestamp();
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_spin_ticket_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_spin_ticket_guard() TO service_role;
CREATE TRIGGER diamond_bonus_spin_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON public.diamond_bonus_spin_tickets
FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_bonus_spin_ticket_guard();

CREATE FUNCTION public.fn_diamond_bonus_spin_settled() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM public.diamond_bonus_spin_tickets WHERE id=NEW.id AND funded_at IS NOT NULL AND redeemed_spin_id IS NULL) THEN
  RAISE EXCEPTION 'Mint Funding And Bonus Spin Redemption Must Commit Together';
 END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_spin_settled() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_spin_settled() TO service_role;
CREATE CONSTRAINT TRIGGER diamond_bonus_spin_settled AFTER UPDATE ON public.diamond_bonus_spin_tickets
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_bonus_spin_settled();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
 ('diamond_bonus_spin_tickets','diamond_bonus_spin_ticket_guard','Claimed tenth-day reward funds exactly 100 Mint diamonds to the selected host owner; receipt fields and settled identity are immutable.'),
 ('diamond_bonus_spin_tickets','diamond_bonus_spin_settled','Mint-funded entry and its wheel redemption must commit atomically; a funded ticket cannot be left unspent.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;


CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_open_day(p_user_id uuid, p_today date)
 RETURNS ca_daily_bonus_days
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row        public.ca_daily_bonus_days;
  v_yesterday  public.ca_daily_bonus_days;
  v_last       public.ca_daily_bonus_days;
  v_shield     public.feature_purchases;
  v_streak     integer;
  v_cycle_day  integer;
  v_streak_day integer;
  v_tiles      jsonb;
  v_mystery    jsonb;
  v_protected  boolean := false;
  v_shield_id  uuid := NULL;
BEGIN
  SELECT * INTO v_row FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today;
  IF FOUND THEN
    IF p_today=(now() AT TIME ZONE 'America/Chicago')::date AND v_row.streak % 10=0
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_row.tiles) t WHERE (t->>'slot')::integer=7) THEN
      UPDATE public.ca_daily_bonus_days SET tiles=tiles||public.fn_ca_daily_bonus_spin_tile(v_row.streak)
       WHERE user_id=p_user_id AND bonus_date=p_today RETURNING * INTO v_row;
    END IF;
    RETURN v_row;
  END IF;

  -- The streak advances only across consecutive CLAIMED days. An opened but
  -- unclaimed yesterday is a gap, exactly like a day never opened.
  SELECT * INTO v_yesterday FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today - 1;
  IF FOUND AND v_yesterday.first_claimed_at IS NOT NULL THEN
    v_streak := v_yesterday.streak + 1;
  ELSE
    -- PHASE 3, THE SHIELD. Exactly one missed day, and a shield in hand: the
    -- shield is spent here, at the moment the gap would have reset the
    -- streak, and the streak carries on from the last claimed day. Two missed
    -- days are a reset; a shield covers one day, never a holiday.
    SELECT * INTO v_last FROM public.ca_daily_bonus_days
     WHERE user_id = p_user_id AND bonus_date < p_today AND first_claimed_at IS NOT NULL
     ORDER BY bonus_date DESC LIMIT 1;
    IF FOUND AND v_last.bonus_date = p_today - 2 THEN
      SELECT * INTO v_shield FROM public.feature_purchases f
       WHERE f.user_id = p_user_id AND f.feature = 'streak_shield'
         AND f.uses_remaining > 0 AND (f.expires_at IS NULL OR f.expires_at > now())
       ORDER BY f.expires_at NULLS LAST, f.created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED;
      IF FOUND THEN
        UPDATE public.feature_purchases SET uses_remaining = uses_remaining - 1 WHERE id = v_shield.id;
        v_streak    := v_last.streak + 1;
        v_protected := true;
        v_shield_id := v_shield.id;
      END IF;
    END IF;
    IF NOT v_protected THEN
      v_streak := 1;
    END IF;
  END IF;

  v_cycle_day := ((v_streak - 1) % 7) + 1;
  SELECT c.streak_day INTO v_streak_day
    FROM public.ca_daily_bonus_calendar c
   WHERE c.streak_day = v_streak AND c.active
   LIMIT 1;

  -- The mystery roll is decided when the day opens and stored with the
  -- snapshot, so a claim reveals it rather than rolling it. The lucky
  -- multiplier on top of it is rolled at the claim (phase 3).
  v_mystery := public.fn_ca_daily_bonus_roll_mystery();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slot', c.slot,
           'kind', c.kind,
           'label', c.label,
           'vip_only', c.vip_only,
           'quantity', c.quantity,
           'base_diamonds', c.diamonds,
           -- The diamond tile scales with the platform streak ladder. Clamped
           -- to award_diamonds_v2's 125-per-call ceiling so the sheet never
           -- shows a number the ledger would trim.
           'diamonds', CASE WHEN c.kind = 'diamonds'
                            THEN LEAST(125, round(c.diamonds * public.fn_get_streak_multiplier(v_streak))::integer)
                            ELSE 0 END,
           'mystery', CASE WHEN c.kind = 'mystery' THEN v_mystery ELSE NULL END
         ) ORDER BY c.slot), '[]'::jsonb)
    INTO v_tiles
    FROM public.ca_daily_bonus_calendar c
   WHERE c.active
     AND ((v_streak_day IS NOT NULL AND c.streak_day = v_streak_day)
       OR (v_streak_day IS NULL AND c.cycle_day = v_cycle_day));

  v_tiles := v_tiles || public.fn_ca_daily_bonus_spin_tile(v_streak);

  IF v_tiles = '[]'::jsonb THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_open_day: no calendar rows for streak % (cycle day %)', v_streak, v_cycle_day
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ca_daily_bonus_days (user_id, bonus_date, streak, cycle_day, streak_day, tiles, streak_protected, shield_consumed_id)
  VALUES (p_user_id, p_today, v_streak, v_cycle_day, v_streak_day, v_tiles, v_protected, v_shield_id)
  ON CONFLICT (user_id, bonus_date) DO NOTHING;

  SELECT * INTO v_row FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today;
  RETURN v_row;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_claim(p_slot integer, p_request_id uuid, p_user_id uuid DEFAULT NULL::uuid, p_bonus_date date DEFAULT NULL::date, p_client jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_elig       text;
  v_today      date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_day        public.ca_daily_bonus_days;
  v_is_vip     boolean := false;
  v_tile       jsonb;
  v_kind       text;
  v_qty        integer;
  v_diamonds   integer;
  v_feature    text;
  v_existing   public.ca_daily_bonus_claims;
  v_award      jsonb;
  v_credit_id  uuid;
  v_journal_id uuid;
  v_balance    integer;
  v_granted    jsonb;
  v_result     jsonb;
  v_ref        text;
  v_from       jsonb;
  v_lucky      integer := NULL;
  v_boost_id   uuid;
  v_boost_ends timestamptz;
  v_claim_id   uuid := gen_random_uuid();
  v_spin_ticket uuid;
BEGIN
  -- A BROWSER SPEAKS FOR ITSELF AND FOR NOBODY ELSE.
  IF v_uid IS NOT NULL AND p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim a daily bonus for another player' USING ERRCODE = '42501';
  END IF;
  -- THE HORSE'S INPUT DEVICE (CLAUDE.md 10.5). A horse has no session, so the engine names the
  -- player it is acting for. Only the engine may: fn_caller_is_engine is false for any browser.
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_claim requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  v_from := public.fn_ca_daily_bonus_claimed_from(p_client);
  IF p_request_id IS NULL THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'request_id_required', NULL, v_from);
  END IF;
  IF p_slot IS NULL OR p_slot < 1 OR p_slot > 7 THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'no_such_tile', NULL, v_from);
  END IF;

  v_elig := public.fn_ca_daily_bonus_eligibility(v_uid);
  IF v_elig <> 'ok' THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, v_elig, NULL, v_from);
  END IF;

  -- One claim at a time per player. Every path below runs under this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_daily_bonus:' || v_uid::text, 0));

  -- Replay: the same request id returns the stored result and pays nothing.
  SELECT * INTO v_existing FROM public.ca_daily_bonus_claims
   WHERE user_id = v_uid AND request_id = p_request_id;
  IF FOUND THEN
    RETURN v_existing.result || jsonb_build_object('idempotent', true);
  END IF;

  -- The sheet names the day it showed. A tap that arrives after Chicago
  -- midnight is refused rather than paid against a day the player never saw;
  -- the sheet re-reads and shows today.
  IF p_bonus_date IS NOT NULL AND p_bonus_date <> v_today THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'day_rolled_over',
             jsonb_build_object('today', v_today, 'requested', p_bonus_date), v_from)
           || jsonb_build_object('today', v_today, 'requested', p_bonus_date);
  END IF;

  v_day := public.fn_ca_daily_bonus_open_day(v_uid, v_today);

  SELECT t INTO v_tile FROM jsonb_array_elements(v_day.tiles) t WHERE (t->>'slot')::int = p_slot;
  IF v_tile IS NULL THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'no_such_tile', NULL, v_from);
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_daily_bonus_claims
              WHERE user_id = v_uid AND bonus_date = v_today AND slot = p_slot) THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'already_claimed', NULL, v_from);
  END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p WHERE p.id = v_uid;
  IF (v_tile->>'vip_only')::boolean AND NOT v_is_vip THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'vip_only', NULL, v_from);
  END IF;

  -- Resolve what the tile pays. A mystery tile pays what was rolled when the
  -- day opened, times a lucky multiplier rolled right here, on the server,
  -- at the moment of the tap (phase 3). The browser learns both together.
  v_kind     := v_tile->>'kind';
  v_qty      := COALESCE((v_tile->>'quantity')::int, 0);
  v_diamonds := COALESCE((v_tile->>'diamonds')::int, 0);
  IF v_kind = 'mystery' THEN
    v_kind     := v_tile->'mystery'->>'kind';
    v_qty      := COALESCE((v_tile->'mystery'->>'quantity')::int, 0);
    v_diamonds := COALESCE((v_tile->'mystery'->>'diamonds')::int, 0);
    v_lucky    := public.fn_ca_daily_bonus_roll_lucky();
    v_qty      := v_qty * v_lucky;
    v_diamonds := LEAST(125, v_diamonds * v_lucky);
  END IF;

  v_ref := 'ca_daily_bonus:' || v_uid::text || ':' || v_today::text || ':' || p_slot::text;

  IF v_kind = 'diamonds' THEN
    IF v_diamonds <= 0 THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'nothing_to_pay', NULL, v_from);
    END IF;
    v_award := public.award_diamonds_v2(
      v_uid, 'daily_bonus', v_ref, NULL,
      jsonb_build_object(
        '_source', 'fn_ca_daily_bonus_claim',
        'bonus_diamonds', v_diamonds,
        'bonus_streak', v_day.streak,
        'cycle_day', v_day.cycle_day,
        'slot', p_slot,
        'vip_tile', (v_tile->>'vip_only')::boolean,
        'mystery', v_tile->>'kind' = 'mystery',
        'lucky', v_lucky
      ));
    IF NOT COALESCE((v_award->>'success')::boolean, false) THEN
      -- award_diamonds_v2 writes nothing on refusal, so the tile stays
      -- claimable and the player sees the ledger's own reason.
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot,
               COALESCE(v_award->>'reason', 'award_refused'), v_award, v_from);
    END IF;
    SELECT t.id INTO v_journal_id FROM public.diamond_transactions t
     WHERE t.user_id = v_uid AND t.reference_id = v_ref
     ORDER BY t.created_at DESC LIMIT 1;
    v_balance := (v_award->>'balance_after')::integer;
    v_granted := jsonb_build_object('kind', 'diamonds', 'diamonds', (v_award->>'awarded')::integer,
                                    'quantity', 0, 'diamond_transaction_id', v_journal_id,
                                    'balance_after', v_balance, 'lucky', v_lucky);

  ELSIF v_kind IN ('throwables', 'rabbit_hunts', 'time_bank', 'shield') THEN
    IF v_qty <= 0 THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'nothing_to_pay', NULL, v_from);
    END IF;
    v_feature := CASE v_kind WHEN 'throwables'   THEN 'throwable'
                             WHEN 'rabbit_hunts' THEN 'rabbit_hunt'
                             WHEN 'shield'       THEN 'streak_shield'
                             ELSE 'time_bank_seconds' END;
    -- A shield keeps for a month; everything else is spent at a table within a week.
    INSERT INTO public.feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at, source)
    VALUES (v_uid, v_feature, 0, 'per_use', v_qty,
            now() + CASE WHEN v_kind = 'shield' THEN interval '30 days' ELSE interval '7 days' END,
            'daily_bonus')
    RETURNING id INTO v_credit_id;
    SELECT p.diamonds INTO v_balance FROM public.profiles p WHERE p.id = v_uid;
    v_granted := jsonb_build_object('kind', v_kind, 'feature', v_feature, 'quantity', v_qty, 'diamonds', 0,
                                    'feature_purchase_id', v_credit_id,
                                    'expires_at', now() + CASE WHEN v_kind = 'shield' THEN interval '30 days' ELSE interval '7 days' END,
                                    'balance_after', v_balance, 'lucky', v_lucky);

  ELSIF v_kind = 'free_spin' THEN
    IF p_slot<>7 OR v_day.streak % 10<>0 OR v_qty<>1 THEN
      RAISE EXCEPTION 'A Bonus Spin Requires Its Tenth Day Reward';
    END IF;
    v_spin_ticket := gen_random_uuid();
    SELECT diamonds INTO v_balance FROM public.profiles WHERE id=v_uid;
    v_granted := jsonb_build_object('kind','free_spin','quantity',1,'diamonds',0,
       'entry_diamonds',100,'funded_by','mint','ticket_id',v_spin_ticket,'balance_after',v_balance);

  ELSIF v_kind = 'boost' THEN
    -- 2x diamonds on Daily Missions for the tile's hours. One live boost per
    -- player: a second claim while one runs extends nothing and pays nothing.
    IF v_qty <= 0 THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'nothing_to_pay', NULL, v_from);
    END IF;
    IF EXISTS (SELECT 1 FROM public.player_boosts b
                WHERE b.user_id = v_uid AND b.kind = 'mission_diamonds' AND b.ends_at > now()) THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'boost_already_live', NULL, v_from);
    END IF;
    v_boost_ends := now() + make_interval(hours => v_qty);
    v_boost_id   := gen_random_uuid();          -- written after the claim row it references
    SELECT p.diamonds INTO v_balance FROM public.profiles p WHERE p.id = v_uid;
    v_granted := jsonb_build_object('kind', 'boost', 'factor', 2.00, 'hours', v_qty, 'quantity', v_qty, 'diamonds', 0,
                                    'boost_id', v_boost_id, 'ends_at', v_boost_ends,
                                    'balance_after', v_balance);
  ELSE
    RAISE EXCEPTION 'fn_ca_daily_bonus_claim: unsupported tile kind %', v_kind USING ERRCODE = '22023';
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'idempotent', false,
    'slot', p_slot,
    'bonus_date', v_today,
    'tile', v_tile - 'mystery',
    'revealed', CASE WHEN v_tile->>'kind' = 'mystery'
                     THEN (v_tile->'mystery') || jsonb_build_object('lucky', v_lucky, 'quantity', v_qty, 'diamonds', v_diamonds)
                     ELSE NULL END,
    'granted', v_granted,
    'streak', v_day.streak,
    'first_claim_of_day', v_day.first_claimed_at IS NULL
  );

  INSERT INTO public.ca_daily_bonus_claims (id, user_id, bonus_date, slot, request_id, tile, granted, result, claimed_from)
  VALUES (v_claim_id, v_uid, v_today, p_slot, p_request_id, v_tile, v_granted, v_result, v_from);

  IF v_kind='free_spin' THEN
    INSERT INTO public.diamond_bonus_spin_tickets(id,user_id,claim_id,bonus_date,streak)
    VALUES(v_spin_ticket,v_uid,v_claim_id,v_today,v_day.streak);
  END IF;

  IF v_kind = 'boost' THEN
    INSERT INTO public.player_boosts (id, user_id, kind, factor, starts_at, ends_at, source, claim_id)
    VALUES (v_boost_id, v_uid, 'mission_diamonds', 2.00, now(), v_boost_ends, 'daily_bonus', v_claim_id);
  END IF;

  UPDATE public.ca_daily_bonus_days
     SET first_claimed_at = COALESCE(first_claimed_at, now())
   WHERE user_id = v_uid AND bonus_date = v_today;

  -- The two rules. Neither can refuse; both file once per day.
  PERFORM public.fn_ca_daily_bonus_velocity_check(v_today, v_from);
  IF v_kind = 'diamonds' THEN
    PERFORM public.fn_ca_daily_bonus_budget_check(v_today);
  END IF;

  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_elig       text;
  v_today      date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_reset_at   timestamptz := ((now() AT TIME ZONE 'America/Chicago')::date + 1)::timestamp AT TIME ZONE 'America/Chicago';
  v_day        public.ca_daily_bonus_days;
  v_is_vip     boolean := false;
  v_caps       jsonb;
  v_tiles      jsonb;
  v_week       jsonb;
  v_next       jsonb;
  v_next_streak integer;
  v_next_cycle  integer;
  v_shield     jsonb;
  v_boost      jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_status requires an authenticated caller' USING ERRCODE = '28000';
  END IF;

  v_elig := public.fn_ca_daily_bonus_eligibility(v_uid);
  IF v_elig <> 'ok' THEN
    RETURN jsonb_build_object('eligible', false, 'reason', v_elig, 'today', v_today,
                              'reset_at', v_reset_at,
                              'seconds_to_reset', GREATEST(0, floor(extract(epoch FROM (v_reset_at - now())))::integer),
                              'shown_today', false,
                              'tiles', '[]'::jsonb);
  END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p WHERE p.id = v_uid;

  v_day  := public.fn_ca_daily_bonus_open_day(v_uid, v_today);
  v_caps := public.fn_ca_daily_bonus_caps(v_uid, v_is_vip);

  -- Today's tiles with their claim state. The mystery result stays hidden
  -- until it is claimed; the claim reveals it. A diamond tile the daily cap
  -- would trim is flagged so the sheet can say so before the tap.
  SELECT COALESCE(jsonb_agg(
           (t - 'mystery') || jsonb_build_object(
             'claimed', cl.id IS NOT NULL,
             'claimed_at', cl.created_at,
             'granted', cl.granted,
             'revealed', CASE WHEN cl.id IS NOT NULL THEN cl.result->'revealed' ELSE NULL END,
             'locked', (t->>'vip_only')::boolean AND NOT v_is_vip,
             'capped', cl.id IS NULL AND t->>'kind' = 'diamonds'
                       AND (t->>'diamonds')::int > (v_caps->>'daily_remaining')::int
           ) ORDER BY (t->>'slot')::int), '[]'::jsonb)
    INTO v_tiles
    FROM jsonb_array_elements(v_day.tiles) t
    LEFT JOIN public.ca_daily_bonus_claims cl
      ON cl.user_id = v_uid AND cl.bonus_date = v_today AND cl.slot = (t->>'slot')::int;

  -- The week strip. Today's entry comes from the snapshot the day was opened
  -- with, so a chest day (streak 14, 30) reads as the chest and not as the
  -- cycle-day rows it replaced. Every other day is the calendar's cycle row
  -- at the streak that day would carry.
  SELECT jsonb_agg(jsonb_build_object(
           'day', d,
           'streak', v_day.streak - v_day.cycle_day + d,
           'diamonds', CASE WHEN d = v_day.cycle_day THEN
                         (SELECT (t->>'diamonds')::int FROM jsonb_array_elements(v_day.tiles) t
                           WHERE t->>'kind' = 'diamonds' AND NOT (t->>'vip_only')::boolean
                           ORDER BY (t->>'slot')::int LIMIT 1)
                       ELSE
                         (SELECT LEAST(125, round(c.diamonds * public.fn_get_streak_multiplier(GREATEST(1, v_day.streak - v_day.cycle_day + d)))::integer)
                            FROM public.ca_daily_bonus_calendar c
                           WHERE c.active AND c.cycle_day = d AND c.kind = 'diamonds' AND NOT c.vip_only
                           ORDER BY c.slot LIMIT 1)
                       END,
           'extras', CASE WHEN d = v_day.cycle_day THEN
                         (SELECT string_agg(t->>'label', ', ' ORDER BY (t->>'slot')::int)
                            FROM jsonb_array_elements(v_day.tiles) t
                           WHERE t->>'kind' <> 'diamonds')
                       ELSE
                         (SELECT string_agg(c.label, ', ' ORDER BY c.slot)
                            FROM public.ca_daily_bonus_calendar c
                           WHERE c.active AND c.cycle_day = d AND c.kind <> 'diamonds')
                       END,
           'chest', d = v_day.cycle_day AND v_day.streak_day IS NOT NULL,
           'state', CASE WHEN d < v_day.cycle_day THEN 'done'
                         WHEN d = v_day.cycle_day THEN 'today'
                         ELSE 'upcoming' END
         ) ORDER BY d)
    INTO v_week
    FROM generate_series(1, 7) d;

  v_next_streak := v_day.streak + 1;
  v_next_cycle  := ((v_next_streak - 1) % 7) + 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', c.kind, 'label', c.label, 'vip_only', c.vip_only, 'quantity', c.quantity,
           'diamonds', CASE WHEN c.kind = 'diamonds'
                            THEN LEAST(125, round(c.diamonds * public.fn_get_streak_multiplier(v_next_streak))::integer)
                            ELSE 0 END
         ) ORDER BY c.slot), '[]'::jsonb)
    INTO v_next
    FROM public.ca_daily_bonus_calendar c
   WHERE c.active
     AND ((EXISTS (SELECT 1 FROM public.ca_daily_bonus_calendar s WHERE s.active AND s.streak_day = v_next_streak)
             AND c.streak_day = v_next_streak)
       OR (NOT EXISTS (SELECT 1 FROM public.ca_daily_bonus_calendar s WHERE s.active AND s.streak_day = v_next_streak)
             AND c.cycle_day = v_next_cycle));

  v_next := v_next || public.fn_ca_daily_bonus_spin_tile(v_next_streak);
  SELECT jsonb_agg(CASE WHEN (d->>'day')::integer<>v_day.cycle_day
      AND (d->>'streak')::integer>0 AND (d->>'streak')::integer % 10=0
    THEN d || jsonb_build_object('extras',concat_ws(', ',NULLIF(d->>'extras',''),'100 Diamond Bonus Spin'))
    ELSE d END ORDER BY (d->>'day')::integer) INTO v_week FROM jsonb_array_elements(v_week) d;

  -- PHASE 3. What the player holds: shields (unspent, unexpired credits) and
  -- a live Mission Boost, and whether a shield saved today's streak.
  SELECT jsonb_build_object(
           'held', COALESCE(sum(f.uses_remaining), 0),
           'expires_at', min(f.expires_at))
    INTO v_shield
    FROM public.feature_purchases f
   WHERE f.user_id = v_uid AND f.feature = 'streak_shield'
     AND f.uses_remaining > 0 AND (f.expires_at IS NULL OR f.expires_at > now());
  SELECT jsonb_build_object(
           'active', true, 'factor', b.factor, 'kind', b.kind,
           'ends_at', b.ends_at,
           'seconds_left', GREATEST(0, floor(extract(epoch FROM (b.ends_at - now())))::integer),
           'applied_diamonds', b.applied_diamonds)
    INTO v_boost
    FROM public.player_boosts b
   WHERE b.user_id = v_uid AND b.kind = 'mission_diamonds' AND b.starts_at <= now() AND b.ends_at > now()
   ORDER BY b.ends_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'eligible', true,
    'bonus_spin_every_days',10,
    'bonus_spin_entry_diamonds',100,
    'bonus_spins_held',(SELECT count(*) FROM public.diamond_bonus_spin_tickets WHERE user_id=v_uid AND redeemed_spin_id IS NULL),
    'today', v_today,
    'reset_at', v_reset_at,
    'seconds_to_reset', GREATEST(0, floor(extract(epoch FROM (v_reset_at - now())))::integer),
    'streak', v_day.streak,
    'cycle_day', v_day.cycle_day,
    'streak_day', v_day.streak_day,
    'multiplier', public.fn_get_streak_multiplier(v_day.streak),
    'is_vip', v_is_vip,
    'claimed_today', v_day.first_claimed_at IS NOT NULL,
    'shown_today', v_day.sheet_shown_at IS NOT NULL,
    'unclaimed', (SELECT count(*) FROM jsonb_array_elements(v_tiles) x
                   WHERE NOT (x->>'claimed')::boolean AND NOT (x->>'locked')::boolean),
    'tiles', v_tiles,
    'week', v_week,
    'tomorrow', v_next,
    'caps', v_caps,
    'cents_per_diamond', 1,
    'shield', COALESCE(v_shield, jsonb_build_object('held', 0, 'expires_at', NULL)),
    'streak_protected', COALESCE(v_day.streak_protected, false),
    'boost', COALESCE(v_boost, jsonb_build_object('active', false))
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_wheel_spin_core(p_club_id uuid,p_commit_id uuid,p_client_seed text,p_welcome boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $fn$
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 RETURN public.fn_wheel_spin_core(p_club_id,p_commit_id,p_client_seed,p_welcome,NULL);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean) TO service_role;

CREATE FUNCTION public.fn_wheel_daily_bonus_spin(p_club_id uuid,p_commit_id uuid,p_client_seed text,p_ticket_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $fn$
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 IF p_ticket_id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Claim A Daily Bonus Spin First'); END IF;
 RETURN public.fn_wheel_spin_core(p_club_id,p_commit_id,p_client_seed,false,p_ticket_id);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_wheel_daily_bonus_spin(uuid,uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_daily_bonus_spin(uuid,uuid,text,uuid) TO authenticated,service_role;


CREATE OR REPLACE FUNCTION public.fn_wheel_spin_core(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_welcome boolean, p_bonus_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_spins%ROWTYPE;
  a record;
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer; v_mult integer; v_intake numeric;
  v_dia_now numeric; v_intake_chips numeric;
  v_owner uuid; v_owner_dia numeric;
  v_bank numeric; v_bank_after numeric;
  v_promo numeric; v_bank_only numeric; v_pay record;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer := 0; v_acc integer := 0;
  v_eligible smallint[] := '{}'; v_locked jsonb := '[]'::jsonb;
  seg record; v_pick record; v_found boolean := false;
  v_value_chips numeric := 0; v_prize_chips numeric := 0; v_prize_dia integer := 0;
  v_today integer; v_last timestamptz;
  v_spendable integer; v_diamonds numeric; v_purchased integer;
  v_lot record; v_remaining integer; v_take integer;
  v_deduct jsonb; v_credit jsonb;
  v_member_after numeric; v_dia_after numeric;
  v_spin_id uuid := gen_random_uuid();
  v_is_fixture boolean := false;
  v_result jsonb;
  v_ticket public.diamond_bonus_spin_tickets;
  -- The welcome budget is a window, not a lifetime total, and a welcome spin is
  -- the whole wheel or it is not offered. Both figures are measured once, up
  -- front, under the config lock that serialises every spin on this host.
  v_welcome_spent numeric := 0; v_welcome_top numeric := 0;
BEGIN
  -- ── who and where ──────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- ── replay: a commit is spent once; the second call returns the first spin ─
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    IF prior.club_id IS DISTINCT FROM p_club_id OR prior.client_seed IS DISTINCT FROM v_client
       OR prior.is_welcome IS DISTINCT FROM p_welcome OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    IF p_welcome THEN RETURN jsonb_build_object('ok',false,'error','Choose One Free Spin Reward'); END IF;
    SELECT * INTO v_ticket FROM public.diamond_bonus_spin_tickets WHERE id=p_bonus_ticket_id FOR UPDATE;
    IF v_ticket.id IS NULL OR v_ticket.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok',false,'error','Claim This Bonus Spin In Daily Bonus First');
    END IF;
    IF v_ticket.redeemed_spin_id IS NOT NULL THEN
      SELECT * INTO prior FROM public.wheel_spins WHERE id=v_ticket.redeemed_spin_id;
      IF prior.user_id=v_user AND prior.club_id=p_club_id AND prior.commit_id=p_commit_id
         AND prior.client_seed=v_client AND prior.bonus_ticket_id=p_bonus_ticket_id AND NOT prior.is_welcome THEN
        RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
      END IF;
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
    IF v_ticket.funded_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
  END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    -- Match the canonical Mint's lock order before taking host/owner rows.
    PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:diamonds'));
  END IF;

  -- ── the freeze and the kill switch, before any money moves ─────────────────
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- ── the host, its table, its pool: one lock serialises every spin on it ────
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id=p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user OR prior.club_id IS DISTINCT FROM p_club_id
       OR prior.client_seed IS DISTINCT FROM v_client OR prior.is_welcome IS DISTINCT FROM p_welcome
       OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
  END IF;
  IF cfg.host_id IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Not Open Here');
  END IF;
  INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host FOR UPDATE;

  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  IF a.weight_total IS DISTINCT FROM 100000 OR a.spec_rtp IS DISTINCT FROM 0.800000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Prize Table Failed Its Audit. The Wheel Is Closed Until It Is Fixed');
  END IF;
  SELECT (CASE WHEN p_welcome OR p_bonus_ticket_id IS NOT NULL THEN 100 ELSE cfg.spin_price_diamonds END) / v.spin_price_diamonds INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  IF p_bonus_ticket_id IS NOT NULL AND cfg.spin_price_diamonds<>100 THEN RETURN jsonb_build_object('ok',false,'error','The 100 Diamond Reward Table Is Unavailable'); END IF;
  v_price  := CASE WHEN p_welcome OR p_bonus_ticket_id IS NOT NULL THEN 100 ELSE cfg.spin_price_diamonds END;
  IF v_mult IS NULL OR v_mult<1 THEN RETURN jsonb_build_object('ok',false,'error','The 100 Diamond Reward Table Is Unavailable'); END IF;
  v_intake := v_price::numeric / v_rate;
  -- THE HOST IS THE HOUSE (Dan 2026-09-10). Nothing is minted: the whole price
  -- is taken in by the host's owner, and the prize is paid out of what the host
  -- holds. The chip side is bounded by the chips this wheel has taken in (this
  -- spin included) plus the host's allowance; the diamond side by the diamonds
  -- it has taken in plus the seed the host put up. Both are "never more than
  -- taken in", stated on the money that actually moved.
  -- A WELCOME SPIN TAKES NOTHING IN (Dan 2026-09-10: the owner "simply receives
  -- no diamonds"). So it adds nothing to the float and nothing to the intake the
  -- paid game's invariant is stated on; its payout is charged to the welcome
  -- budget instead, a few lines below.
  v_dia_now      := CASE WHEN p_welcome THEN 0 ELSE v_price END;
  v_intake_chips := round((pool.intake_diamonds + v_dia_now)::numeric / v_rate, 2);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;

  -- ── the player: member, not a fixture, inside the limits, able to pay ──────
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;

  -- ── the welcome spin: once per member, ever, and only out of a real budget ─
  IF p_welcome THEN
    IF NOT cfg.welcome_spin_enabled THEN
      RETURN jsonb_build_object('ok', false, 'error', 'There Is No Welcome Spin Here');
    END IF;
    IF COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spin Is Not Funded Here Yet');
    END IF;
    IF v_user = v_owner THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Host Does Not Take Its Own Welcome Spin');
    END IF;
    -- The unique index is what actually enforces this; the check is here to
    -- answer the player in words rather than with a constraint violation.
    IF EXISTS (SELECT 1 FROM public.wheel_spins s
                WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'You Have Already Taken Your Welcome Spin Here');
    END IF;
    -- A WELCOME SPIN IS THE WHOLE WHEEL OR IT IS NOT OFFERED (2026-09-11).
    -- The budget used to be checked tier by tier, so as the spend approached it
    -- the top prizes locked one after another and the last new members to
    -- arrive were handed a visibly worse wheel than the first ones. A gift that
    -- gets meaner the longer you take to join is not the gift Dan described.
    -- So the budget is asked ONE question before anything is offered: can it
    -- still cover the biggest prize on this table? If it can, every tier is
    -- live. If it cannot, there is no welcome spin here until the window turns.
    -- ONE DEFINITION OF THE QUESTION (2026-09-11). The door, the page and the
    -- entry read all asked it, and the entry read asked a DIFFERENT one, so a
    -- player could be told "Welcome Spin Ready" and then be refused by the
    -- door. There is one helper now and three callers.
    SELECT r.o_spent, r.o_top INTO v_welcome_spent, v_welcome_top
      FROM public.fn_wheel_welcome_room(v_host) r;
    IF v_welcome_spent + v_welcome_top > cfg.welcome_budget_chips THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spins Here Are Gone For Now');
    END IF;
  END IF;
  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;
  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_today >= cfg.max_spins_per_player_per_day THEN
    RETURN jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Spins', cfg.max_spins_per_player_per_day));
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'One Moment Between Spins');
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;
  IF NOT p_welcome AND p_bonus_ticket_id IS NULL AND v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host's cover and its owner's diamonds, locked ─────────────────────
  -- The promo wallet pays first and the host's own chip bank stands behind it
  -- (Dan 2026-09-10). v_bank is the two together: what a prize may draw on.
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_promo, v_bank_only, v_bank
    FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  -- ── eligibility: the affordability gate ────────────────────────────────────
  FOR seg IN SELECT * FROM public.wheel_segments g WHERE g.version = cfg.segment_version ORDER BY g.ord LOOP
    IF seg.kind = 'chips' THEN
      -- There is no welcome branch here any more. The budget was asked about
      -- the WHOLE table before the spin was allowed, so on a welcome spin every
      -- tier is affordable by construction and none of them may be locked for
      -- being expensive. The exposure gate below is the paid wheel's alone: a
      -- welcome spin took nothing in, so it may not lean on what the paid game
      -- took in either.
      IF NOT p_welcome AND pool.chips_paid + seg.amount * v_mult > v_intake_chips + cfg.exposure_allowance_chips THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'exposure',
                      'unlocks_at', round(pool.chips_paid + seg.amount * v_mult - cfg.exposure_allowance_chips, 2));
        CONTINUE;
      END IF;
      IF v_bank < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'cover', 'unlocks_at', round(seg.amount * v_mult, 2));
        CONTINUE;
      END IF;
    ELSIF seg.kind = 'diamonds' THEN
      -- THE PAID WHEEL'S FLOAT IS NOT THE GIFT'S TO SPEND (audit 2026-09-11).
      -- A welcome diamond prize comes from the owner and is charged to the
      -- welcome budget, which was checked just above. Gating it on the paid
      -- float as well locked tiers a club had every right to give away, and
      -- draining that float for it made the paid wheel pay for the welcome.
      IF NOT p_welcome AND pool.diamond_float + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'diamond_float',
                      'unlocks_at', round(seg.amount * v_mult - v_dia_now, 0));
        CONTINUE;
      END IF;
      IF v_owner_dia + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'owner_diamonds',
                      'unlocks_at', round(seg.amount * v_mult, 0));
        CONTINUE;
      END IF;
    END IF;
    v_eligible := v_eligible || seg.ord;
    v_total := v_total + seg.weight;
  END LOOP;
  IF p_bonus_ticket_id IS NOT NULL AND jsonb_array_length(v_locked)>0 THEN
    RETURN jsonb_build_object('ok',false,'error','The Host Must Cover The Whole Bonus Spin Table','locked',v_locked);
  END IF;
  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No Prize Can Be Paid Right Now. Try Again Shortly', 'locked', v_locked);
  END IF;

  -- ── the roll: committed seed, player seed, per-player nonce ────────────────
  SELECT count(*) + 1 INTO v_nonce FROM public.wheel_spins s WHERE s.user_id = v_user;
  v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),
                            convert_to(cm.server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_point := floor(v_roll * v_total / c_two48);
  v_acc := 0;
  FOR seg IN SELECT * FROM public.wheel_segments g
              WHERE g.version = cfg.segment_version AND g.ord = ANY (v_eligible) ORDER BY g.ord LOOP
    v_acc := v_acc + seg.weight;
    IF v_point < v_acc THEN v_pick := seg; v_found := true; EXIT; END IF;
  END LOOP;
  IF NOT v_found THEN
    SELECT * INTO v_pick FROM public.wheel_segments g
     WHERE g.version = cfg.segment_version AND g.ord = v_eligible[array_length(v_eligible, 1)];
  END IF;

  -- ── 1. the spin is paid for, unless it is the welcome ─────────────────────
  -- THE OWNER SIMPLY RECEIVES NO DIAMONDS (Dan 2026-09-10). Not a refund, not a
  -- credit and back out again: on a welcome spin no diamond moves anywhere. The
  -- player pays nothing, the owner takes nothing, and what the host gives up is
  -- exactly the spin price it would have been paid.
  IF p_bonus_ticket_id IS NOT NULL THEN
    BEGIN
      UPDATE public.diamond_bonus_spin_tickets SET club_id=p_club_id,host_id=v_host,host_kind=v_kind,
        owner_id=v_owner,commit_id=p_commit_id,client_seed=v_client,
        funded_at=transaction_timestamp(),mint_op_id='daily-bonus-spin:'||p_bonus_ticket_id::text
       WHERE id=p_bonus_ticket_id RETURNING * INTO v_ticket;
    EXCEPTION WHEN SQLSTATE 'PDS01' THEN
      RETURN jsonb_build_object('ok',false,'error',SQLERRM);
    END;
  ELSIF NOT p_welcome THEN
    v_deduct := public.deduct_diamonds(
      v_user, v_price,
      format('Diamond Wheel Spin (%s Diamonds)', v_price),
      'wheel_spin', 'wheel_spin',
      jsonb_build_object('spin_id', v_spin_id, 'club_id', p_club_id, 'host_id', v_host,
                         'commit_id', p_commit_id, 'segment_version', cfg.segment_version,
                         'recipient_id', v_owner),
      'wheel:' || v_spin_id::text, 0);
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For A Spin',
                                'detail', v_deduct->>'error');
    END IF;
    -- The intake is the host owner's (Dan 2026-09-10): a transfer, not an issuance.
    v_credit := public.add_diamonds_to_balance(v_owner, v_price, 'transfer',
                  format('Diamond Wheel Intake (%s Diamonds)', v_price), 'wheel:' || v_spin_id::text || ':intake', v_user);
    IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the spin price could not be credited to the host owner: %', v_credit->>'error';
    END IF;
    IF cfg.purchased_only THEN
      v_remaining := v_price;
      FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                    WHERE l.user_id = v_user AND l.frozen_at IS NULL
                      AND (l.issued - l.consumed - l.refunded) > 0
                    ORDER BY l.created_at, l.id FOR UPDATE LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
        UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
        v_remaining := v_remaining - v_take;
      END LOOP;
      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'fn_wheel_spin_core: purchased lots could not cover the spin (% short) after the availability check passed', v_remaining;
      END IF;
    END IF;
  END IF;

  -- ── 2. the prize ───────────────────────────────────────────────────────────
  IF v_pick.kind = 'chips' THEN
    v_prize_chips := round(v_pick.amount * v_mult, 2);
    v_value_chips := v_prize_chips;
    IF v_bank < v_prize_chips THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the host cover % is below the prize % after the gate passed', v_bank, v_prize_chips;
    END IF;
    -- ONE PAYER FOR EVERY CHIP THE DIAMOND GAMES PAY. The promo wallet goes
    -- first and the host's own bank covers whatever is left (Dan 2026-09-10),
    -- journaled from the paying side so each row names the column the chips
    -- left, and the member side stands down so nothing is journaled twice.
    SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips(
      'wheel_prize', v_host, v_kind, p_club_id, v_user, v_prize_chips,
      'wheel-prize:' || v_spin_id::text,
      format('Diamond Wheel: %s', v_pick.label),
      jsonb_build_object('spin_id', v_spin_id, 'host_id', v_host, 'host_kind', v_kind,
                         'segment_version', cfg.segment_version, 'ord', v_pick.ord,
                         'welcome', p_welcome,'bonus_ticket_id',p_bonus_ticket_id,
                         'entry_funded_by',CASE WHEN p_bonus_ticket_id IS NOT NULL THEN 'mint' ELSE 'player' END));
    v_member_after := v_pay.member_after;
    v_bank_after   := v_pay.cover_after;
    v_promo        := v_pay.promo_after;
    v_bank_only    := v_pay.bank_after;
    v_bank := v_bank_after;
  ELSIF v_pick.kind = 'diamonds' THEN
    v_prize_dia := (v_pick.amount * v_mult)::integer;
    v_value_chips := round(v_prize_dia::numeric / v_rate, 4);
    -- The diamond prize is paid BY THE HOST'S OWNER, out of what the wheel took
    -- in (Dan 2026-09-10). Two transfer legs, one transaction; nothing is issued.
    PERFORM public.fn_diamond_game_pay_diamonds(v_owner, v_user, v_prize_dia,
              format('Diamond Wheel: %s', v_pick.label), 'wheel:' || v_spin_id::text || ':prize');
  END IF;

  -- ── 4. the pool remembers, on the right side of the books ─────────────────
  -- A welcome payout NEVER enters chips_paid. chips_paid is bounded by what the
  -- paid game took in; the welcome is bounded by the budget the host declared.
  -- Two promises, kept apart, both checked below.
  UPDATE public.wheel_pools
     SET spins = spins + CASE WHEN p_welcome THEN 0 ELSE 1 END,
         welcome_spins = welcome_spins + CASE WHEN p_welcome THEN 1 ELSE 0 END,
         intake_diamonds = intake_diamonds + v_dia_now,
         chips_paid = chips_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_chips END,
         welcome_chips_paid = welcome_chips_paid + CASE WHEN p_welcome THEN v_value_chips ELSE 0 END,
         diamond_float = diamond_float + v_dia_now
                       - CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         diamonds_paid = diamonds_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         -- constrained_spins is a rate over `spins`, and a welcome spin is not
         -- one of those, so counting it here made the operator's lock rate able
         -- to exceed 1 (audit 2026-09-11).
         constrained_spins = constrained_spins
                           + CASE WHEN NOT p_welcome AND jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF pool.chips_paid > round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: chips_paid % would exceed the chips taken in % + allowance % - the gate was bypassed',
      pool.chips_paid, round(pool.intake_diamonds::numeric / v_rate, 2), cfg.exposure_allowance_chips;
  END IF;
  -- The window is what is bounded now, not the lifetime total, and the row for
  -- THIS spin is not written until a few lines below - so the assertion is made
  -- on the figure the gate used plus what this spin just paid. Both were read
  -- under the config lock, so no other spin on this host can have moved them.
  IF p_welcome AND v_welcome_spent + v_value_chips > cfg.welcome_budget_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: the welcome window has paid % against a budget of % - the gate was bypassed',
      v_welcome_spent + v_value_chips, cfg.welcome_budget_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after,
     is_fixture, is_welcome, bonus_ticket_id)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, cfg.segment_version,
     CASE WHEN p_welcome THEN 0 ELSE v_price END, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, v_pick.amount * v_mult, v_value_chips, 0, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after,
     v_is_fixture, p_welcome, p_bonus_ticket_id)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  IF p_bonus_ticket_id IS NOT NULL THEN
    UPDATE public.diamond_bonus_spin_tickets SET redeemed_spin_id=v_spin_id,redeemed_at=transaction_timestamp()
     WHERE id=p_bonus_ticket_id;
  END IF;
  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.fn_wheel_spin_result(s wheel_spins)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'welcome', COALESCE(s.is_welcome, false),
    'daily_bonus',s.bonus_ticket_id IS NOT NULL,'bonus_ticket_id',s.bonus_ticket_id,
    'player_cost_diamonds',CASE WHEN s.is_welcome OR s.bonus_ticket_id IS NOT NULL THEN 0 ELSE s.spin_price_diamonds END,
    'entry_value_diamonds',CASE WHEN s.is_welcome OR s.bonus_ticket_id IS NOT NULL THEN 100 ELSE s.spin_price_diamonds END,
    'entry_funded_by',CASE WHEN s.bonus_ticket_id IS NOT NULL THEN 'mint' WHEN s.is_welcome THEN 'welcome' ELSE 'player' END,
    'spin_id', s.id, 'club_id', s.club_id, 'host_id', s.host_id,
    'segment_version', s.segment_version, 'spin_price_diamonds', s.spin_price_diamonds,
    'diamonds_per_chip', s.diamonds_per_chip,
    'outcome', jsonb_build_object('ord', s.outcome_ord, 'kind', s.outcome_kind, 'amount', s.outcome_amount,
                                  'label', (SELECT g.label FROM public.wheel_segments g
                                             WHERE g.version = s.segment_version AND g.ord = s.outcome_ord),
                                  'value_chips', s.prize_value_chips),
    'fairness', jsonb_build_object('commit_id', s.commit_id, 'server_seed_hash', s.server_seed_hash,
                                   'server_seed', s.server_seed, 'client_seed', s.client_seed,
                                   'nonce', s.nonce, 'roll', s.roll, 'weight_total', s.weight_total,
                                   'eligible_ords', to_jsonb(s.eligible_ords), 'locked', s.locked),
    'balances', jsonb_build_object('diamonds', s.diamonds_after, 'member_chips', s.member_chips_after),
    'pool', jsonb_build_object('chips_paid', s.pool_chips_paid_after,
                               'diamond_float', s.pool_diamond_float_after),
    'created_at', s.created_at);
$function$
;

CREATE OR REPLACE FUNCTION public.fn_diamond_games_spent_today(p_host uuid, p_user uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    SELECT sum(s.spin_price_diamonds)::numeric
      FROM public.wheel_spins s
     WHERE s.host_id = p_host AND s.user_id = p_user
       AND NOT COALESCE(s.is_welcome, false) AND s.bonus_ticket_id IS NULL
       AND (s.created_at AT TIME ZONE 'America/Chicago')::date
           = (now() AT TIME ZONE 'America/Chicago')::date), 0)
  + COALESCE((SELECT sum(r.bet_diamonds)::numeric FROM public.diamond_game_round_book r
    WHERE r.host_id=p_host AND r.user_id=p_user
    AND (r.created_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date),0);
$function$
;

CREATE OR REPLACE FUNCTION public.fn_wheel_welcome_state(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_used boolean := false;
  v_member boolean := false;
  v_reason text := NULL;
  v_owner uuid;
  v_segments jsonb;
  v_taken integer := 0;
  v_spent numeric := 0; v_top numeric := 0;
BEGIN
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg  FROM public.wheel_configs WHERE host_id = v_host;
  SELECT * INTO pool FROM public.wheel_pools   WHERE host_id = v_host;
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);

  -- THE WELCOME SPIN IS THE REAL WHEEL (Dan 2026-09-10: "a free 100 diamond
  -- spin"), so the table it shows is the wheel's own table, not a smaller one
  -- kept beside it. What is offered is exactly what a paying player sees.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ord', g.ord, 'label', g.label, 'kind', g.kind,
                                               'amount', g.amount, 'weight', g.weight,
                                               'value_chips', CASE WHEN g.kind = 'chips' THEN g.amount::numeric
                                                                   ELSE round(g.amount::numeric / v_rate, 4) END,
                                               'probability', round(g.weight::numeric / NULLIF(t.total, 0), 6),
                                               'locked', false)
                            ORDER BY g.ord), '[]'::jsonb)
    INTO v_segments
    FROM public.wheel_segments g,
         (SELECT sum(weight) AS total FROM public.wheel_segments WHERE version = (SELECT segment_version FROM public.wheel_configs WHERE host_id = v_host)) t
   WHERE g.version = (SELECT segment_version FROM public.wheel_configs WHERE host_id = v_host);

  IF cfg.host_id IS NULL OR NOT cfg.enabled OR NOT cfg.welcome_spin_enabled THEN
    v_reason := 'closed';
  END IF;
  IF v_reason IS NULL AND COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN
    v_reason := 'unfunded';
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.wheel_spins s
                    WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome) INTO v_used;
    SELECT EXISTS (SELECT 1 FROM public.club_members m
                    WHERE m.club_id = p_club_id AND m.user_id = v_user
                      AND COALESCE(m.status, 'active') IN ('active', 'approved')) INTO v_member;
  END IF;
  SELECT COALESCE(pool.welcome_spins, 0) INTO v_taken;
  IF v_reason IS NULL AND v_used THEN v_reason := 'used'; END IF;
  -- The same one question the door asks: can the window still cover the biggest
  -- prize on this table? The page and the door must agree, so the figure comes
  -- from the same helper rather than from a second copy of the arithmetic.
  SELECT r.o_spent, r.o_top INTO v_spent, v_top FROM public.fn_wheel_welcome_room(v_host) r;
  IF v_reason IS NULL AND v_spent + v_top > COALESCE(cfg.welcome_budget_chips, 0) THEN v_reason := 'pot_empty'; END IF;
  IF v_reason IS NULL AND v_user IS NOT NULL AND NOT v_member THEN v_reason := 'not_member'; END IF;
  -- The host does not welcome itself: an owner spinning their own wheel for
  -- free would spend the club's budget on the club's own account.
  IF v_reason IS NULL AND v_user IS NOT NULL AND v_user = v_owner THEN v_reason := 'owner'; END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'enabled', COALESCE(cfg.welcome_spin_enabled, false) AND COALESCE(cfg.enabled, false),
    'available', v_user IS NOT NULL AND v_reason IS NULL,
    'reason', v_reason,
    'used', v_used,
    'once_only', true,
    'spin_price_diamonds', 100,
    'budget_chips', COALESCE(cfg.welcome_budget_chips, 0),
    'budget_period_days', COALESCE(cfg.welcome_budget_period_days, 0),
    'budget_paid_chips', v_spent,
    'budget_left_chips', GREATEST(COALESCE(cfg.welcome_budget_chips, 0) - v_spent, 0),
    'top_prize_chips', v_top,
    'lifetime_chips_paid', COALESCE(pool.welcome_chips_paid, 0),
    'welcome_spins', v_taken,
    'segments', v_segments);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_wheel_welcome_room(p_host uuid, OUT o_spent numeric, OUT o_top numeric, OUT o_open boolean)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  cfg public.wheel_configs%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_mult integer := 1;
BEGIN
  o_spent := 0; o_top := 0; o_open := false;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = p_host;
  IF cfg.host_id IS NULL THEN RETURN; END IF;

  -- The VIP multiplier the table is priced at, the same way the core reads it.
  SELECT COALESCE(100 / v.spin_price_diamonds, 1) INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  v_mult := COALESCE(v_mult, 1);

  -- The biggest prize this table can pay, in chips, whichever kind it is.
  SELECT COALESCE(max(CASE WHEN g.kind = 'chips'    THEN g.amount::numeric * v_mult
                           WHEN g.kind = 'diamonds' THEN round((g.amount * v_mult)::numeric / v_rate, 4)
                           ELSE 0 END), 0)
    INTO o_top
    FROM public.wheel_segments g WHERE g.version = cfg.segment_version;

  o_spent := public.fn_wheel_welcome_spent(p_host, cfg.welcome_budget_period_days);
  -- A budget of zero is unfunded, not open with nothing in it.
  o_open := COALESCE(cfg.welcome_budget_chips, 0) > 0
        AND o_spent + o_top <= cfg.welcome_budget_chips;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_wheel_welcome_room(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_wheel_welcome_room(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_wheel_welcome_room(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_welcome_room(uuid) TO service_role;


CREATE FUNCTION public.fn_wheel_daily_bonus_state(p_club_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE u uuid:=auth.uid(); s jsonb; n integer; first_ticket uuid; reason text;
BEGIN
 IF u IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To See Bonus Spins'); END IF;
 SELECT count(*)::integer INTO n FROM public.diamond_bonus_spin_tickets WHERE user_id=u AND redeemed_spin_id IS NULL;
 SELECT id INTO first_ticket FROM public.diamond_bonus_spin_tickets WHERE user_id=u AND redeemed_spin_id IS NULL ORDER BY created_at,id LIMIT 1;
 s:=public.fn_wheel_state(p_club_id);
 IF NOT COALESCE((s->>'ok')::boolean,false) THEN RETURN s; END IF;
 IF n=0 THEN reason:='Claim Your Tenth Day Reward In Daily Bonus';
 ELSIF NOT COALESCE((s->'player'->>'is_member')::boolean,false) THEN reason:='Join The Club Before You Spin';
 ELSIF NOT COALESCE((s->>'available')::boolean,false) THEN reason:='The Diamond Wheel Is Not Open Here';
 ELSIF COALESCE((s->>'frozen')::boolean,false) OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope='diamond_issuance' AND cleared_at IS NULL) THEN reason:='Bonus Spins Are Paused Right Now';
 ELSIF (s->'config'->>'spin_price_diamonds')::integer IS DISTINCT FROM 100 THEN reason:='The 100 Diamond Reward Table Is Unavailable';
 ELSIF jsonb_array_length(COALESCE(s->'segments','[]'::jsonb))=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'segments') g WHERE COALESCE((g->>'locked')::boolean,true)) THEN reason:='The Host Must Cover The Whole Bonus Spin Table';
 ELSIF (public.fn_ca_is_fixture_account(u) OR public.fn_ca_is_cert_account(u)) AND NOT COALESCE((SELECT allow_fixture_accounts FROM public.wheel_configs WHERE host_id=(s->>'host_id')::uuid),false) THEN reason:='Certification Accounts Do Not Spin This Wheel';
 ELSIF (s->'player'->>'spins_today')::integer >= (s->'config'->>'max_spins_per_player_per_day')::integer THEN reason:='Today’s Spin Limit Has Been Reached';
 END IF;
 RETURN jsonb_build_object('ok',true,'available',reason IS NULL,'reason',reason,'ticket_count',n,
   'ticket_id',first_ticket,'entry_diamonds',100,'funded_by','mint','claim_required',true,'every_days',10,
   'segments',COALESCE(s->'segments','[]'::jsonb));
END $fn$;
REVOKE ALL ON FUNCTION public.fn_wheel_daily_bonus_state(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_daily_bonus_state(uuid) TO authenticated,service_role;


CREATE INDEX diamond_bonus_spin_tickets_by_user ON public.diamond_bonus_spin_tickets(user_id,created_at,id);
ALTER TABLE public.diamond_bonus_spin_tickets
 ADD CONSTRAINT diamond_bonus_spin_tickets_user_fk FOREIGN KEY(user_id) REFERENCES public.profiles(id),
 ADD CONSTRAINT diamond_bonus_spin_tickets_claim_fk FOREIGN KEY(claim_id) REFERENCES public.ca_daily_bonus_claims(id),
 ADD CONSTRAINT diamond_bonus_spin_tickets_spin_fk FOREIGN KEY(redeemed_spin_id) REFERENCES public.wheel_spins(id);
ALTER TABLE public.wheel_spins ADD CONSTRAINT wheel_spins_bonus_ticket_fk FOREIGN KEY(bonus_ticket_id) REFERENCES public.diamond_bonus_spin_tickets(id);
COMMIT;
