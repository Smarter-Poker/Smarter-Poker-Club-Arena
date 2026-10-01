-- 20261001154709_prospective_lifetime_first_club_welcome_package
--
-- A welcome package is an entitlement, not a conclusion drawn from an empty
-- lobby. Only a successful prospective lifetime-first club creation may mint
-- it. Historical receipts are deliberately not backfilled, and an owner who
-- already owns another club is deliberately ineligible.
--
-- Provision and reset are owner-only, receipt-backed transactions. Reset can
-- retire only durable package item ids. It never deletes a row and never
-- touches members, wallets, chips, ledgers, hands, rake, or history.

BEGIN;
-- The club-creation door already allows this window on the same hot relations.
-- Two fully rolled-back production attempts proved five seconds was too short.
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE public.club_welcome_entitlements (
  club_id uuid PRIMARY KEY REFERENCES public.clubs(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL UNIQUE,
  creation_request_id uuid NOT NULL,
  package_version text NOT NULL DEFAULT 'welcome-v1' CHECK (package_version='welcome-v1'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(owner_id,creation_request_id),
  FOREIGN KEY(owner_id,creation_request_id)
    REFERENCES public.club_creation_requests(user_id,request_id) ON DELETE RESTRICT
);

-- Identity history deliberately has no club/request foreign key. Ownership
-- transfer or later deletion must never make an owner "first" again.
CREATE TABLE public.club_owner_creation_history (
  owner_id uuid PRIMARY KEY,
  first_club_id uuid NOT NULL,
  first_creation_request_id uuid,
  welcome_eligible boolean NOT NULL,
  provenance text NOT NULL CHECK(provenance IN ('historical','prospective')),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

INSERT INTO public.club_owner_creation_history
  (owner_id,first_club_id,welcome_eligible,provenance,recorded_at)
SELECT owner_id,(array_agg(id ORDER BY created_at NULLS LAST,id))[1],false,'historical',
       COALESCE(min(created_at),transaction_timestamp())
  FROM public.clubs WHERE owner_id IS NOT NULL GROUP BY owner_id
ON CONFLICT(owner_id) DO NOTHING;

CREATE FUNCTION public.fn_remember_club_owner_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
BEGIN
  IF NEW.owner_id IS NULL OR NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN RETURN NEW; END IF;
  PERFORM public.fn_club_membership_lock(NEW.owner_id);
  INSERT INTO public.club_owner_creation_history
    (owner_id,first_club_id,welcome_eligible,provenance)
  VALUES(NEW.owner_id,NEW.id,false,'historical') ON CONFLICT(owner_id) DO NOTHING;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_remember_club_owner_transfer() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_remember_club_owner_transfer() TO service_role;
CREATE TRIGGER trg_remember_club_owner_transfer AFTER UPDATE OF owner_id ON public.clubs
FOR EACH ROW EXECUTE FUNCTION public.fn_remember_club_owner_transfer();

CREATE TABLE public.club_welcome_package_receipts (
  club_id uuid PRIMARY KEY REFERENCES public.club_welcome_entitlements(club_id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL UNIQUE,
  actor_id uuid NOT NULL,
  package_version text NOT NULL CHECK(package_version='welcome-v1'),
  economics jsonb NOT NULL,
  result jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE public.club_welcome_package_items (
  club_id uuid NOT NULL REFERENCES public.club_welcome_package_receipts(club_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  slot_key text NOT NULL CHECK(slot_key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  entity_kind text NOT NULL CHECK(entity_kind IN ('cash_game','tournament_schedule')),
  entity_id uuid NOT NULL,
  initial_table_id uuid,
  retired_at timestamptz,
  reset_operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(club_id,slot_key),
  UNIQUE(entity_kind,entity_id),
  CHECK((entity_kind='cash_game')=(initial_table_id IS NOT NULL)),
  CHECK((retired_at IS NULL)=(reset_operation_id IS NULL))
);

CREATE TABLE public.club_welcome_package_funding (
  club_id uuid NOT NULL REFERENCES public.club_welcome_package_receipts(club_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  destination text NOT NULL CHECK(destination IN ('bbj_main','spin_reserve')),
  amount numeric(20,2) NOT NULL CHECK(amount>=0),
  balance_after numeric(20,2) NOT NULL CHECK(balance_after>=0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(club_id,destination)
);

CREATE TABLE public.club_welcome_reset_receipts (
  club_id uuid NOT NULL REFERENCES public.club_welcome_package_receipts(club_id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL UNIQUE,
  actor_id uuid NOT NULL,
  result jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(club_id,operation_id)
);

ALTER TABLE public.club_welcome_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_owner_creation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_welcome_package_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_welcome_package_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_welcome_package_funding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_welcome_reset_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY club_welcome_entitlements_owner_read ON public.club_welcome_entitlements
  FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()));
CREATE POLICY club_welcome_package_receipts_owner_read ON public.club_welcome_package_receipts
  FOR SELECT TO authenticated USING(actor_id=(SELECT auth.uid()));
CREATE POLICY club_welcome_package_items_owner_read ON public.club_welcome_package_items
  FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.club_welcome_entitlements e
    WHERE e.club_id=club_welcome_package_items.club_id AND e.owner_id=(SELECT auth.uid())));
CREATE POLICY club_welcome_package_funding_owner_read ON public.club_welcome_package_funding
  FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.club_welcome_entitlements e
    WHERE e.club_id=club_welcome_package_funding.club_id AND e.owner_id=(SELECT auth.uid())));
CREATE POLICY club_welcome_reset_receipts_owner_read ON public.club_welcome_reset_receipts
  FOR SELECT TO authenticated USING(actor_id=(SELECT auth.uid()));

REVOKE ALL ON TABLE public.club_welcome_entitlements,public.club_welcome_package_receipts,
  public.club_owner_creation_history,
  public.club_welcome_package_items,public.club_welcome_package_funding,
  public.club_welcome_reset_receipts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.club_welcome_entitlements,public.club_welcome_package_receipts,
  public.club_welcome_package_items,public.club_welcome_package_funding,
  public.club_welcome_reset_receipts TO authenticated;
GRANT ALL ON TABLE public.club_welcome_entitlements,public.club_welcome_package_receipts,
  public.club_owner_creation_history,
  public.club_welcome_package_items,public.club_welcome_package_funding,
  public.club_welcome_reset_receipts TO service_role;

CREATE FUNCTION public.fn_club_welcome_package_config(p_version text DEFAULT 'welcome-v1')
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public','pg_temp' AS $function$
  SELECT CASE WHEN p_version='welcome-v1' THEN jsonb_build_object(
    'version','welcome-v1','configured',true,'time_zone',NULL,
    'display_time_zone','UTC','display_time_label','7:00 PM UTC',
    'cash_games',jsonb_build_array(
      jsonb_build_object('slot_key','classic_nlh_050_100','template','classic','variant','nlh','handedness',9,'name','Classic NLH 0.50/1.00'),
      jsonb_build_object('slot_key','classic_flh_050_100','template','classic','variant','flh','handedness',9,'name','Classic FLH 0.50/1.00'),
      jsonb_build_object('slot_key','classic_plo4_050_100','template','classic','variant','plo4','handedness',6,'name','Classic PLO4 0.50/1.00'),
      jsonb_build_object('slot_key','classic_plo5_050_100','template','classic','variant','plo5','handedness',6,'name','Classic PLO5 0.50/1.00'),
      jsonb_build_object('slot_key','classic_plo6_050_100','template','classic','variant','plo6','handedness',6,'name','Classic PLO6 0.50/1.00'),
      jsonb_build_object('slot_key','classic_plo8_050_100','template','classic','variant','plo8','handedness',6,'name','Classic PLO8 0.50/1.00'),
      jsonb_build_object('slot_key','classic_flo8_050_100','template','classic','variant','flo8','handedness',6,'name','Classic FLO8 0.50/1.00'),
      jsonb_build_object('slot_key','classic_short_deck_050_100','template','classic','variant','short_deck','handedness',6,'name','Classic Short Deck 0.50/1.00'),
      jsonb_build_object('slot_key','classic_pineapple_050_100','template','classic','variant','pineapple','handedness',6,'name','Classic Pineapple 0.50/1.00')
    ),
    'tournament_schedule',jsonb_build_object(
      'slot_key','daily_25_freezeout_1900','name','Daily $25 Freezeout',
      'days_of_week',jsonb_build_array(0,1,2,3,4,5,6),'start_times',jsonb_build_array('19:00'),
      'config',jsonb_build_object('type','mtt','name','Daily $25 Freezeout','gameVariant','nlh',
        'buyIn',25,'startingStack',10000,'minPlayers',3,'maxPlayers',10000,
        'blindPreset','STANDARD','payoutPreset','THREE','payoutPercent',10,
        'guarantee',0,'lateRegistrationLevels',0,'isRebuy',false,'maxRebuys',0,
        'isReentry',false,'maxReentries',0,
        'addOnAvailable',false,'tableSize',9,'actionTimeSeconds',15,'banChat',true,
        'synchronizedBreaks',true,'recurrenceCadence','daily')
    ),
    'economics',jsonb_build_object('bbj_enabled',true,'bbj_seed',100,
      'spins_enabled',true,'spin_max_stake',1,
      'spin_seed',GREATEST(100::numeric,public.fn_spin_required_seed(1)),
      'leaderboard_mode','display_only','leaderboard_seed',0,'promo_enabled',false,
      'diamond_spins_status','owner_acceptance_required')
  ) ELSE NULL END
$function$;
REVOKE ALL ON FUNCTION public.fn_club_welcome_package_config(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_welcome_package_config(text) TO service_role;

CREATE FUNCTION public.fn_offer_lifetime_first_club_welcome() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE v_owner uuid; v_claim public.club_owner_creation_history%ROWTYPE; v_result jsonb;
BEGIN
  PERFORM public.fn_club_membership_lock(NEW.user_id);
  SELECT owner_id INTO v_owner FROM public.clubs WHERE id=NEW.club_id;
  IF v_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'WELCOME_ENTITLEMENT_OWNER_MISMATCH' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.club_owner_creation_history
    (owner_id,first_club_id,first_creation_request_id,welcome_eligible,provenance)
  VALUES(NEW.user_id,NEW.club_id,NEW.request_id,true,'prospective')
  ON CONFLICT(owner_id) DO NOTHING RETURNING * INTO v_claim;
  IF NOT FOUND OR v_claim.welcome_eligible IS NOT TRUE THEN RETURN NEW; END IF;
  INSERT INTO public.club_welcome_entitlements(club_id,owner_id,creation_request_id)
  VALUES(NEW.club_id,NEW.user_id,NEW.request_id);
  v_result:=public.fn_provision_first_club_welcome_package(NEW.club_id,NEW.request_id);
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'WELCOME_PACKAGE_ATOMIC_PROVISION_FAILED: %',COALESCE(v_result->>'reason','unknown');
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_offer_lifetime_first_club_welcome() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_offer_lifetime_first_club_welcome() TO service_role;
CREATE TRIGGER trg_offer_lifetime_first_club_welcome AFTER INSERT ON public.club_creation_requests
FOR EACH ROW EXECUTE FUNCTION public.fn_offer_lifetime_first_club_welcome();

CREATE FUNCTION public.fn_get_club_welcome_package(p_club_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_actor uuid:=auth.uid(); v_ent public.club_welcome_entitlements%ROWTYPE;
  v_receipt public.club_welcome_package_receipts%ROWTYPE;
  v_config jsonb:=public.fn_club_welcome_package_config('welcome-v1'); v_items jsonb:='[]'::jsonb;
BEGIN
  SELECT * INTO v_ent FROM public.club_welcome_entitlements e
   WHERE e.club_id=p_club_id AND e.owner_id=v_actor;
  IF v_actor IS NULL OR NOT FOUND THEN
    RETURN jsonb_build_object('ok',true,'club_id',p_club_id,'package_version','welcome-v1',
      'eligible',false,'status','not_eligible','reason','prospective_lifetime_first_club_only',
      'owner_acceptance_required',true,'items',v_items,'economics',v_config->'economics');
  END IF;
  SELECT * INTO v_receipt FROM public.club_welcome_package_receipts WHERE club_id=p_club_id;
  IF FOUND THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('slot_key',i.slot_key,
      'entity_kind',i.entity_kind,'entity_id',i.entity_id,'initial_table_id',i.initial_table_id,
      'retired_at',i.retired_at) ORDER BY i.slot_key),'[]'::jsonb)
      INTO v_items FROM public.club_welcome_package_items i WHERE i.club_id=p_club_id;
  END IF;
  RETURN jsonb_build_object('ok',true,'club_id',p_club_id,'package_version','welcome-v1',
    'eligible',true,'status',CASE WHEN v_receipt.club_id IS NULL THEN 'ready'
      WHEN EXISTS(SELECT 1 FROM public.club_welcome_package_items i
                  WHERE i.club_id=p_club_id AND i.retired_at IS NOT NULL) THEN 'reset'
      ELSE 'provisioned' END,
    'owner_acceptance_required',true,'display_time_zone','UTC','display_time_label','7:00 PM UTC',
    'entitlement',jsonb_build_object('owner_id',v_ent.owner_id,'created_at',v_ent.created_at),
    'receipt',CASE WHEN v_receipt.club_id IS NULL THEN NULL ELSE jsonb_build_object(
      'operation_id',v_receipt.operation_id,'completed_at',v_receipt.completed_at,
      'result',v_receipt.result) END,'items',v_items,
    'economics',COALESCE(v_receipt.economics,v_config->'economics'));
END $function$;
REVOKE ALL ON FUNCTION public.fn_get_club_welcome_package(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_get_club_welcome_package(uuid) TO authenticated,service_role;

-- Register the private balance writer before CREATE FUNCTION so the production
-- event trigger can enforce the reviewed financial authority atomically.
INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES (
  'fn_apply_club_welcome_economics','approved',
  'Private lifetime-first club welcome allocator. Runs only inside the owner-bound idempotent provisioning transaction; moves exactly the reviewed BBJ seed from clubs.chip_treasury into bbj_pools and delegates the reviewed Poker Spins seed to fn_spin_activate, with keyed club_welcome_allocation ledger context. Diamond Spins remain owner-acceptance-required and receive no automatic funds.'
)
ON CONFLICT (proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

CREATE FUNCTION public.fn_apply_club_welcome_economics(
  p_club_id uuid,p_actor uuid,p_operation_id uuid,p_economics jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_bbj numeric:=round((p_economics->>'bbj_seed')::numeric,2);
  v_spin_seed numeric:=round((p_economics->>'spin_seed')::numeric,2);
  v_spin jsonb; v_bbj_id uuid; v_bbj_after numeric;
  v_program_version integer; v_publish jsonb;
BEGIN
  IF p_economics->>'diamond_spins_status' IS DISTINCT FROM 'owner_acceptance_required'
     OR v_bbj<>100 OR (p_economics->>'bbj_enabled')::boolean IS NOT TRUE
     OR (p_economics->>'spins_enabled')::boolean IS NOT TRUE
     OR (p_economics->>'spin_max_stake')::numeric<>1
     OR v_spin_seed<>GREATEST(100::numeric,public.fn_spin_required_seed(1))
     OR p_economics->>'leaderboard_mode' IS DISTINCT FROM 'display_only'
     OR (p_economics->>'leaderboard_seed')::numeric<>0
     OR (p_economics->>'promo_enabled')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'WELCOME_ECONOMICS_CONFIG_INVALID' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.bbj_pools WHERE club_id=p_club_id) THEN
    RAISE EXCEPTION 'WELCOME_BBJ_POOL_ALREADY_EXISTS' USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.ledger_category','club_welcome_allocation',true);
  PERFORM set_config('app.ledger_counterparty','welcome_package',true);
  PERFORM set_config('app.ledger_counterparty_entity',p_club_id::text,true);
  PERFORM set_config('app.ledger_idempotency_key','club-welcome:'||p_operation_id::text||':bbj',true);
  UPDATE public.clubs SET chip_treasury=chip_treasury-v_bbj,bbj_enabled=true,
    bbj_rake_enabled=true,updated_at=now() WHERE id=p_club_id AND chip_treasury>=v_bbj;
  IF NOT FOUND THEN RAISE EXCEPTION 'WELCOME_CLUB_BANK_CANNOT_FUND_BBJ' USING ERRCODE='P0403'; END IF;
  INSERT INTO public.bbj_pools(club_id,main_balance,backup_balance,promo_balance,pool_amount,status)
  VALUES(p_club_id,v_bbj,0,0,0,'active') RETURNING id,main_balance INTO v_bbj_id,v_bbj_after;
  v_spin:=public.fn_spin_activate(p_club_id,v_spin_seed,1,'chip_treasury',p_actor);
  IF COALESCE((v_spin->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'WELCOME_SPIN_ACTIVATION_REFUSED: %',COALESCE(v_spin->>'reason','unknown');
  END IF;
  UPDATE public.clubs SET spins_enabled=true,spins_preseed_amount=v_spin_seed,
    spins_wallet_funding='CHIP_TREASURY',updated_at=now() WHERE id=p_club_id;
  SELECT COALESCE(max(version),0) INTO v_program_version
    FROM public.leaderboard_reward_program_versions WHERE club_id=p_club_id;
  v_publish:=public.fn_publish_leaderboard_reward_program(p_club_id,false,'profit',
    '[]'::jsonb,'[]'::jsonb,'balanced',v_program_version,p_operation_id,false);
  RETURN jsonb_build_object('bbj_enabled',true,'bbj_seed',v_bbj,'bbj_pool_id',v_bbj_id,
    'bbj_balance',v_bbj_after,'spins_enabled',true,'spin_max_stake',1,
    'spin_seed',v_spin_seed,'spin',v_spin,'leaderboard_mode','display_only',
    'leaderboard_seed',0,'leaderboard',v_publish,'promo_enabled',false,
    'diamond_spins_status','owner_acceptance_required');
END $function$;
REVOKE ALL ON FUNCTION public.fn_apply_club_welcome_economics(uuid,uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_apply_club_welcome_economics(uuid,uuid,uuid,jsonb) TO service_role;

CREATE FUNCTION public.fn_provision_first_club_welcome_package(p_club_id uuid,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_actor uuid:=auth.uid(); v_club public.clubs%ROWTYPE;
  v_ent public.club_welcome_entitlements%ROWTYPE; v_prior public.club_welcome_package_receipts%ROWTYPE;
  v_config jsonb; v_economics jsonb; v_entry jsonb; v_created jsonb; v_schedule jsonb;
  v_schedule_id uuid; v_items jsonb:='[]'::jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL OR p_operation_id IS NULL THEN RETURN jsonb_build_object('ok',false,'replayed',false,
    'club_id',p_club_id,'reason',CASE WHEN v_actor IS NULL THEN 'authentication_required' ELSE 'operation_id_required' END); END IF;
  SELECT * INTO v_prior FROM public.club_welcome_package_receipts WHERE operation_id=p_operation_id;
  IF FOUND THEN
    IF v_prior.club_id IS DISTINCT FROM p_club_id OR v_prior.actor_id IS DISTINCT FROM v_actor THEN
      RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,'reason','operation_id_payload_mismatch');
    END IF;
    RETURN v_prior.result||jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id FOR UPDATE;
  IF NOT FOUND OR v_club.owner_id IS DISTINCT FROM v_actor THEN
    RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,'reason','owner_only');
  END IF;
  SELECT * INTO v_ent FROM public.club_welcome_entitlements
    WHERE club_id=p_club_id AND owner_id=v_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,
    'reason','prospective_lifetime_first_club_only'); END IF;
  IF COALESCE(v_club.is_union,false) OR v_club.union_id IS NOT NULL
     OR EXISTS(SELECT 1 FROM public.union_clubs WHERE club_id=p_club_id) THEN
    RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,'reason','standalone_club_only');
  END IF;
  SELECT * INTO v_prior FROM public.club_welcome_package_receipts WHERE club_id=p_club_id;
  IF FOUND THEN RETURN v_prior.result||jsonb_build_object('replayed',true); END IF;
  v_config:=public.fn_club_welcome_package_config(v_ent.package_version);
  IF v_config IS NULL OR COALESCE((v_config->>'configured')::boolean,false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,'reason','package_not_configured');
  END IF;
  IF NOT public.fn_schedule_time_zone_is_known(v_config->>'time_zone') THEN
    RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,
      'reason','time_zone_unsupported','time_zone',v_config->>'time_zone');
  END IF;
  v_economics:=public.fn_apply_club_welcome_economics(p_club_id,v_actor,p_operation_id,v_config->'economics');
  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_config->'cash_games') LOOP
    v_created:=public.fn_cash_game_create_impl_20260905(p_club_id,v_entry->>'template',v_entry->>'variant',
      0.5,1,(v_entry->>'handedness')::integer,'{}'::jsonb,v_entry->>'name',false);
    IF COALESCE((v_created->>'ok')::boolean,false) IS NOT TRUE OR v_created->>'game_id' IS NULL
       OR v_created->>'table_id' IS NULL THEN RAISE EXCEPTION 'WELCOME_CASH_GAME_CREATE_REFUSED'; END IF;
    INSERT INTO public.club_welcome_package_items(club_id,slot_key,entity_kind,entity_id,initial_table_id)
    VALUES(p_club_id,v_entry->>'slot_key','cash_game',(v_created->>'game_id')::uuid,(v_created->>'table_id')::uuid);
    v_items:=v_items||jsonb_build_array(jsonb_build_object('slot_key',v_entry->>'slot_key',
      'entity_kind','cash_game','entity_id',(v_created->>'game_id')::uuid,
      'initial_table_id',(v_created->>'table_id')::uuid));
  END LOOP;
  v_entry:=v_config->'tournament_schedule';
  v_schedule:=public.fn_upsert_tournament_schedule(jsonb_build_object('clubId',p_club_id,
    'unionId',NULL,'name',v_entry->>'name','active',true,'daysOfWeek',v_entry->'days_of_week',
    'startTimesUtc',v_entry->'start_times','timeZone',v_config->>'time_zone','config',v_entry->'config'));
  IF COALESCE((v_schedule->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'WELCOME_TOURNAMENT_SCHEDULE_REFUSED: %',COALESCE(v_schedule->>'error','unknown');
  END IF;
  v_schedule_id:=(v_schedule->>'schedule_id')::uuid;
  INSERT INTO public.club_welcome_package_items(club_id,slot_key,entity_kind,entity_id)
  VALUES(p_club_id,v_entry->>'slot_key','tournament_schedule',v_schedule_id);
  v_items:=v_items||jsonb_build_array(jsonb_build_object('slot_key',v_entry->>'slot_key',
    'entity_kind','tournament_schedule','entity_id',v_schedule_id,'initial_table_id',NULL));
  v_result:=jsonb_build_object('ok',true,'replayed',false,'club_id',p_club_id,
    'package_version','welcome-v1','operation_id',p_operation_id,'items',v_items,
    'economics',v_economics,'time_zone',v_config->>'time_zone',
    'display_time_zone',v_config->>'display_time_zone','display_time_label',v_config->>'display_time_label',
    'owner_acceptance_required',true,'completed_at',transaction_timestamp());
  INSERT INTO public.club_welcome_package_receipts(club_id,operation_id,actor_id,package_version,economics,result)
  VALUES(p_club_id,p_operation_id,v_actor,'welcome-v1',v_economics,v_result);
  INSERT INTO public.club_welcome_package_funding(club_id,destination,amount,balance_after) VALUES
    (p_club_id,'bbj_main',(v_economics->>'bbj_seed')::numeric,(v_economics->>'bbj_balance')::numeric),
    (p_club_id,'spin_reserve',(v_economics->>'spin_seed')::numeric,(v_economics->'spin'->>'balance')::numeric);
  RETURN v_result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_provision_first_club_welcome_package(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_provision_first_club_welcome_package(uuid,uuid) TO authenticated,service_role;

-- A scheduled spawn and package reset serialize on item -> schedule in the
-- same order. A waiter that wakes after reset re-reads both durable rows and
-- cannot resurrect a retired package schedule.
CREATE FUNCTION public.fn_fence_welcome_package_schedule_spawn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE v_retired timestamptz; v_active boolean;
BEGIN
  IF NEW.schedule_id IS NULL THEN RETURN NEW; END IF;
  SELECT i.retired_at INTO v_retired FROM public.club_welcome_package_items i
   WHERE i.entity_kind='tournament_schedule' AND i.entity_id=NEW.schedule_id
   FOR KEY SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT s.active INTO v_active FROM public.tournament_schedules s
   WHERE s.id=NEW.schedule_id FOR KEY SHARE;
  IF NOT FOUND OR v_retired IS NOT NULL OR v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'WELCOME_PACKAGE_SCHEDULE_RETIRED' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_fence_welcome_package_schedule_spawn() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_fence_welcome_package_schedule_spawn() TO service_role;
CREATE TRIGGER trg_fence_welcome_package_schedule_spawn
BEFORE INSERT ON public.tournaments FOR EACH ROW
EXECUTE FUNCTION public.fn_fence_welcome_package_schedule_spawn();

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES (
  'tournaments',
  'trg_fence_welcome_package_schedule_spawn',
  'Reviewed October 1: this owner-package fence moves no chips and changes no tournament value. It serializes a scheduled tournament insert with the package item and schedule rows, then refuses only when the exact preloaded schedule has been retired or disabled so reset cannot resurrect it.'
)
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;

CREATE FUNCTION public.fn_get_club_welcome_package_reset_impact(p_club_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_actor uuid:=auth.uid(); v_owner uuid; v_cash uuid[]:='{}'; v_schedules uuid[]:='{}'; v_tournaments uuid[]:='{}';
  v_seats integer:=0; v_sessions integer:=0; v_waiting integer:=0; v_moves integer:=0;
  v_registered integer:=0; v_running integer:=0; v_executing integer:=0; v_tables integer:=0; v_hands integer:=0;
BEGIN
  SELECT owner_id INTO v_owner FROM public.clubs WHERE id=p_club_id;
  IF v_actor IS NULL OR v_owner IS DISTINCT FROM v_actor THEN
    RETURN jsonb_build_object('ok',true,'club_id',p_club_id,'package_version','welcome-v1',
      'authorized',false,'can_reset',false,'reason','owner_only','cash_game_ids','[]'::jsonb,
      'tournament_ids','[]'::jsonb,'schedule_ids','[]'::jsonb,
      'blocking',jsonb_build_object('active_seats',0,'open_sessions',0,'waiting_players',0,
        'pending_moves',0,'registered_players',0,'running_tournaments',0,'executing_commands',0,
        'hand_history',0),
      'removable',jsonb_build_object('cash_games',0,'tournaments',0,'tables',0,'schedules',0));
  END IF;
  SELECT COALESCE(array_agg(entity_id ORDER BY entity_id),'{}') INTO v_cash
    FROM public.club_welcome_package_items WHERE club_id=p_club_id AND entity_kind='cash_game' AND retired_at IS NULL;
  SELECT COALESCE(array_agg(entity_id ORDER BY entity_id),'{}') INTO v_schedules
    FROM public.club_welcome_package_items WHERE club_id=p_club_id AND entity_kind='tournament_schedule' AND retired_at IS NULL;
  SELECT COALESCE(array_agg(q.id ORDER BY q.id),'{}') INTO v_tournaments FROM (
    SELECT t.id FROM public.tournaments t WHERE t.schedule_id=ANY(v_schedules)
    UNION
    SELECT s.tournament_id FROM public.tournament_schedule_spawns s
      WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id IS NOT NULL
  ) q;
  SELECT count(*) INTO v_seats FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
    WHERE (t.cluster_id=ANY(v_cash) OR t.tournament_id=ANY(v_tournaments)) AND s.left_at IS NULL;
  SELECT count(*) INTO v_sessions FROM public.table_sessions s JOIN public.tables t ON t.id=s.table_id
    WHERE (t.cluster_id=ANY(v_cash) OR t.tournament_id=ANY(v_tournaments))
      AND COALESCE(s.is_active,false) AND s.left_at IS NULL;
  SELECT (SELECT count(*) FROM public.table_waitlist w JOIN public.tables t ON t.id=w.table_id
      WHERE (t.cluster_id=ANY(v_cash) OR t.tournament_id=ANY(v_tournaments)) AND w.status IN('waiting','notified'))
    +(SELECT count(*) FROM public.cash_game_waitlist w WHERE w.game_id=ANY(v_cash) AND w.status IN('waiting','notified')) INTO v_waiting;
  SELECT (SELECT count(*) FROM public.cash_seat_moves WHERE game_id=ANY(v_cash) AND state='pending')
    +(SELECT count(*) FROM public.cash_seat_change_requests WHERE game_id=ANY(v_cash) AND status='requested') INTO v_moves;
  SELECT count(*) INTO v_registered FROM public.tournament_players WHERE tournament_id=ANY(v_tournaments);
  SELECT count(*) INTO v_running FROM public.tournaments t WHERE t.id=ANY(v_tournaments) AND
    (t.started_at IS NOT NULL OR upper(COALESCE(t.status::text,'')) IN('RUNNING','BREAK','COMPLETING')
     OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.tournament_id=t.id)
     OR EXISTS(SELECT 1 FROM public.tables tb JOIN public.hand_history h ON h.table_id=tb.id WHERE tb.tournament_id=t.id));
  SELECT count(*) INTO v_hands FROM public.hand_history h LEFT JOIN public.tables t ON t.id=h.table_id
    WHERE t.cluster_id=ANY(v_cash) OR t.tournament_id=ANY(v_tournaments)
       OR h.tournament_id=ANY(v_tournaments);
  SELECT count(*) INTO v_executing FROM public.managed_game_schedules s WHERE s.status='executing' AND
    ((s.game_kind='tournament' AND s.game_id=ANY(v_tournaments)) OR
     (s.game_kind='table' AND EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.game_id
       AND (t.cluster_id=ANY(v_cash) OR t.tournament_id=ANY(v_tournaments)))));
  SELECT count(*) INTO v_tables FROM public.tables WHERE cluster_id=ANY(v_cash) OR tournament_id=ANY(v_tournaments);
  RETURN jsonb_build_object('ok',true,'club_id',p_club_id,'package_version','welcome-v1',
    'authorized',true,'can_reset',(v_seats+v_sessions+v_waiting+v_moves+v_registered+v_running+v_executing+v_hands)=0,
    'reason',CASE WHEN (v_seats+v_sessions+v_waiting+v_moves+v_registered+v_running+v_executing+v_hands)=0
      THEN NULL ELSE 'package_resources_in_use' END,'cash_game_ids',to_jsonb(v_cash),
    'tournament_ids',to_jsonb(v_tournaments),'schedule_ids',to_jsonb(v_schedules),
    'blocking',jsonb_build_object('active_seats',v_seats,'open_sessions',v_sessions,
      'waiting_players',v_waiting,'pending_moves',v_moves,'registered_players',v_registered,
      'running_tournaments',v_running,'executing_commands',v_executing,'hand_history',v_hands),
    'removable',jsonb_build_object('cash_games',cardinality(v_cash),'tournaments',cardinality(v_tournaments),
      'tables',v_tables,'schedules',cardinality(v_schedules)));
END $function$;
REVOKE ALL ON FUNCTION public.fn_get_club_welcome_package_reset_impact(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_get_club_welcome_package_reset_impact(uuid) TO authenticated,service_role;

CREATE FUNCTION public.fn_remove_first_club_welcome_games(p_club_id uuid,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_actor uuid:=auth.uid(); v_owner uuid; v_prior public.club_welcome_reset_receipts%ROWTYPE;
  v_impact jsonb; v_cash uuid[]:='{}'; v_schedules uuid[]:='{}'; v_tournaments uuid[]:='{}';
  v_tables uuid[]:='{}'; v_result jsonb;
BEGIN
  IF v_actor IS NULL OR p_operation_id IS NULL THEN RETURN jsonb_build_object('ok',false,'replayed',false,
    'club_id',p_club_id,'reason',CASE WHEN v_actor IS NULL THEN 'authentication_required' ELSE 'operation_id_required' END); END IF;
  SELECT * INTO v_prior FROM public.club_welcome_reset_receipts WHERE operation_id=p_operation_id;
  IF FOUND THEN
    IF v_prior.club_id IS DISTINCT FROM p_club_id OR v_prior.actor_id IS DISTINCT FROM v_actor THEN
      RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,'reason','operation_id_payload_mismatch');
    END IF;
    RETURN v_prior.result||jsonb_build_object('replayed',true);
  END IF;
  SELECT owner_id INTO v_owner FROM public.clubs WHERE id=p_club_id FOR UPDATE;
  IF NOT FOUND OR v_owner IS DISTINCT FROM v_actor THEN
    RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,'reason','owner_only');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.club_welcome_package_receipts WHERE club_id=p_club_id) THEN
    RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,'reason','package_not_provisioned');
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_global();
  PERFORM 1 FROM public.club_welcome_package_items WHERE club_id=p_club_id ORDER BY slot_key FOR UPDATE;
  SELECT COALESCE(array_agg(entity_id ORDER BY entity_id),'{}') INTO v_cash FROM public.club_welcome_package_items
    WHERE club_id=p_club_id AND entity_kind='cash_game' AND retired_at IS NULL;
  SELECT COALESCE(array_agg(entity_id ORDER BY entity_id),'{}') INTO v_schedules FROM public.club_welcome_package_items
    WHERE club_id=p_club_id AND entity_kind='tournament_schedule' AND retired_at IS NULL;
  PERFORM 1 FROM public.tournament_schedules WHERE id=ANY(v_schedules) ORDER BY id FOR UPDATE;
  SELECT COALESCE(array_agg(q.id ORDER BY q.id),'{}') INTO v_tournaments FROM (
    SELECT t.id FROM public.tournaments t WHERE t.schedule_id=ANY(v_schedules)
    UNION
    SELECT s.tournament_id FROM public.tournament_schedule_spawns s
      WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id IS NOT NULL
  ) q;
  PERFORM 1 FROM public.cash_games WHERE id=ANY(v_cash) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tournaments WHERE id=ANY(v_tournaments) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tables WHERE cluster_id=ANY(v_cash) OR tournament_id=ANY(v_tournaments) ORDER BY id FOR UPDATE;
  v_impact:=public.fn_get_club_welcome_package_reset_impact(p_club_id);
  IF COALESCE((v_impact->>'can_reset')::boolean,false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok',false,'replayed',false,'club_id',p_club_id,
      'reason',COALESCE(v_impact->>'reason','package_resources_in_use'),'impact',v_impact);
  END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO v_tables FROM public.tables
    WHERE cluster_id=ANY(v_cash) OR tournament_id=ANY(v_tournaments);
  PERFORM set_config('app.managed_game_lifecycle','on',true);
  UPDATE public.tournament_schedules SET active=false,updated_at=now() WHERE id=ANY(v_schedules);
  UPDATE public.cash_games SET enabled=false,state='dormant',closed_at=COALESCE(closed_at,now()),
    closed_by=v_actor,updated_at=now() WHERE id=ANY(v_cash);
  UPDATE public.tournaments SET status='CANCELLED',ended_at=COALESCE(ended_at,now()),updated_at=now()
    WHERE id=ANY(v_tournaments) AND upper(COALESCE(status::text,'')) NOT IN('COMPLETED','CANCELLED','CANCELED');
  UPDATE public.tables SET status='closed',current_players=0,updated_at=now()
    WHERE id=ANY(v_tables) AND lower(COALESCE(status,'')) NOT IN('closed','completed','cancelled','finished');
  UPDATE public.managed_game_schedules SET status='cancelled',completed_at=now(),
    result=jsonb_build_object('ok',false,'reason','welcome_package_reset')
    WHERE status='scheduled' AND ((game_kind='tournament' AND game_id=ANY(v_tournaments))
      OR (game_kind='table' AND game_id=ANY(v_tables)));
  UPDATE public.club_welcome_package_items SET retired_at=now(),reset_operation_id=p_operation_id
    WHERE club_id=p_club_id AND retired_at IS NULL;
  v_result:=jsonb_build_object('ok',true,'replayed',false,'club_id',p_club_id,
    'package_version','welcome-v1','operation_id',p_operation_id,
    'removed',jsonb_build_object('cash_game_ids',to_jsonb(v_cash),'tournament_ids',to_jsonb(v_tournaments),
      'table_ids',to_jsonb(v_tables),'schedule_ids',to_jsonb(v_schedules)),
    'owner_acceptance_required',true,'completed_at',transaction_timestamp());
  INSERT INTO public.club_welcome_reset_receipts(club_id,operation_id,actor_id,result)
    VALUES(p_club_id,p_operation_id,v_actor,v_result);
  RETURN v_result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_remove_first_club_welcome_games(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_remove_first_club_welcome_games(uuid,uuid) TO authenticated,service_role;

-- Reset is a rare owner authority that can retire both cash and scheduled
-- tournament resources in one transaction.  It therefore takes G before any
-- resource row and must be named by the live settlement-lane doctrine.  Edit
-- only the reviewed allow-list clause and prove the reverse substitution so
-- an evolved doctrine fails closed.
DO $welcome_reset_lane_review$
DECLARE
  v_oid oid := to_regprocedure('public.fn_ca_settlement_lane_doctrine()');
  v_before text; v_after text; v_old text; v_new text; v_n integer; v_answer jsonb;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'WELCOME_RESET_REQUIRES_SETTLEMENT_LANE_DOCTRINE'; END IF;
  v_before:=pg_get_functiondef(v_oid);
  v_old:=$x$'fn_poker_diamond_tournament_cancel',$x$;
  v_new:=$x$'fn_poker_diamond_tournament_cancel','fn_remove_first_club_welcome_games',$x$;
  v_n:=(length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
  IF v_n<>1 THEN RAISE EXCEPTION 'WELCOME_RESET_LANE_DOCTRINE_DRIFT: %',v_n; END IF;
  v_after:=replace(v_before,v_old,v_new);
  EXECUTE v_after;
  IF replace(pg_get_functiondef(v_oid),v_new,v_old) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'WELCOME_RESET_LANE_DOCTRINE_REVERSE_SUBSTITUTION_FAILED';
  END IF;
  v_answer:=public.fn_ca_settlement_lane_doctrine();
  IF COALESCE((v_answer->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'WELCOME_RESET_SETTLEMENT_LANE_DOCTRINE_FAILED: %',v_answer->'violations';
  END IF;
END $welcome_reset_lane_review$;

-- Opening setup is still the only completion door.  A welcome package has
-- already funded BBJ and Poker Spins through their authoritative paths, so
-- that door must reuse the immutable package receipt rather than debit those
-- principals a second time.  This is an asserted edit of the current body;
-- drift refuses the migration instead of guessing at a newer authority.
DO $opening_setup_welcome_reuse$
DECLARE
  v_sig regprocedure := 'public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure;
  v_def text := pg_get_functiondef(v_sig);
  v_before text;
BEGIN
  v_before:=v_def;
  v_def:=replace(v_def,
    '  v_tagline text := left(regexp_replace(btrim(COALESCE(p_tagline, '''')), ''\s+'', '' '', ''g''), 72);'||E'\nBEGIN',
    '  v_tagline text := left(regexp_replace(btrim(COALESCE(p_tagline, '''')), ''\s+'', '' '', ''g''), 72);'||E'\n  v_welcome public.club_welcome_package_receipts%ROWTYPE;\nBEGIN');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_DECLARATION_DRIFT'; END IF;
  v_before:=v_def;
  v_def:=replace(v_def,
    E'  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 10) THEN',
    E'  SELECT * INTO v_welcome FROM public.club_welcome_package_receipts WHERE club_id=p_club_id FOR UPDATE;\n'
    ||E'  IF FOUND AND (p_bbj_enabled IS NOT TRUE OR v_bbj_seed IS DISTINCT FROM (v_welcome.economics->>''bbj_seed'')::numeric\n'
    ||E'    OR p_spins_enabled IS NOT TRUE OR v_spin_seed IS DISTINCT FROM (v_welcome.economics->>''spin_seed'')::numeric\n'
    ||E'    OR p_spin_max_stake IS DISTINCT FROM (v_welcome.economics->>''spin_max_stake'')::numeric) THEN\n'
    ||E'    RAISE EXCEPTION ''Welcome BBJ And Poker Spins Are Already Seeded; Reuse Their Recorded Baseline'';\n'
    ||E'  END IF;\n\n  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 10) THEN');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_RECEIPT_DRIFT'; END IF;
  v_before:=v_def;
  v_def:=replace(v_def,
    E'  v_other_allocation := v_bbj_seed + v_promo_budget + v_leaderboard_budget;',
    E'  IF v_welcome.club_id IS NOT NULL THEN\n    v_bbj_seed := 0;\n    v_spin_seed := 0;\n  END IF;\n\n  v_other_allocation := v_bbj_seed + v_promo_budget + v_leaderboard_budget;');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_INCREMENT_DRIFT'; END IF;
  v_before:=v_def;
  v_def:=replace(v_def,
    E'  IF p_spins_enabled THEN\n    v_spin_result := public.fn_spin_activate(',
    E'  IF p_spins_enabled AND v_welcome.club_id IS NULL THEN\n    v_spin_result := public.fn_spin_activate(');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_SPIN_DRIFT'; END IF;
  v_before:=v_def;
  v_def:=replace(v_def,
    E'  IF p_bbj_enabled THEN\n    SELECT pool.id INTO v_pool_id',
    E'  IF p_bbj_enabled AND v_welcome.club_id IS NULL THEN\n    SELECT pool.id INTO v_pool_id');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_BBJ_DRIFT'; END IF;
  v_before:=v_def;
  v_def:=replace(v_def,'      spins_preseed_amount = v_spin_seed,',
    '      spins_preseed_amount = COALESCE((v_welcome.economics->>''spin_seed'')::numeric, v_spin_seed),');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_CLUB_DRIFT'; END IF;
  EXECUTE v_def;
END $opening_setup_welcome_reuse$;

COMMENT ON TABLE public.club_welcome_entitlements IS
  'Prospective lifetime-first owned-club entitlement. No historical backfill; one row per owner forever.';
COMMENT ON FUNCTION public.fn_remove_first_club_welcome_games(uuid,uuid) IS
  'Owner-only idempotent soft retirement of package-created ids; economics and history are never unwound.';

COMMIT;
