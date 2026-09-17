-- R46 preparation: dual creation at the owning ABI boundary.
-- No activation, historical financial rewrite, or legacy HU conversion.
-- Before activation all existing creators retain numeric capacity/fees. After
-- activation only a newly admitted MTT receives NULL and the mtt-v2 marker.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $requires$ DECLARE item record;BEGIN
 IF (SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton)
     IS DISTINCT FROM 'legacy-capacity-v1'
    OR to_regprocedure('public.fn_ca_tournament_is_unlimited(uuid)') IS NULL THEN
  RAISE EXCEPTION 'MTT_CREATION_REQUIRES_LEGACY_PREPARATION';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
   ('fn_ca_is_new_mtt','fn_ca_new_tournament_is_unlimited','fn_ca_normalize_new_mtt_capacity',
    'fn_ca_fixed_tournament_waitlist_only')) THEN
  RAISE EXCEPTION 'MTT_CREATION_PREPARATION_NAME_COLLISION';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.tournaments'::regclass
     AND attname='max_players' AND attnotnull AND NOT attisdropped) THEN
  RAISE EXCEPTION 'MTT_CREATION_CAPACITY_PREIMAGE_DRIFT';
 END IF;
 FOR item IN SELECT * FROM (VALUES
  ('mystery_bounty_activation','''at_the_money''::text'),
  ('mystery_bounty_profile','''classic''::text'),
  ('mystery_bounty_top_percent','20'),('mystery_bounty_pool_percent','50'),
  ('mystery_bounty_regular_pool_percent','50')) e(name,expression) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d
     ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid='public.tournaments'::regclass AND a.attname=item.name
       AND a.attnotnull AND pg_get_expr(d.adbin,d.adrelid)=item.expression) THEN
   RAISE EXCEPTION 'MTT_CREATION_DIAMOND_DEFAULT_DRIFT: %',item.name;
  END IF;
 END LOOP;
END $requires$;
CREATE FUNCTION public.fn_ca_is_new_mtt(p_row jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog,public
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN false
    -- A genuine satellite target has product meaning; an empty object does not.
    WHEN (jsonb_typeof(p_row->'satellite_target_id')='string'
          AND NULLIF(btrim(p_row->>'satellite_target_id'),'') IS NOT NULL)
      OR (jsonb_typeof(p_row->'satelliteTargetId')='string'
          AND NULLIF(btrim(p_row->>'satelliteTargetId'),'') IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM (VALUES(p_row->'satellite_target'),(p_row->'satelliteTarget')) s(target)
         WHERE (jsonb_typeof(target)='string'
                AND NULLIF(btrim(target#>>'{}'),'') IS NOT NULL)
            OR (jsonb_typeof(target)='object' AND (
                 (jsonb_typeof(target->'tournamentId')='string'
                  AND NULLIF(btrim(target->>'tournamentId'),'') IS NOT NULL)
                 OR (jsonb_typeof(target->'tournament_id')='string'
                  AND NULLIF(btrim(target->>'tournament_id'),'') IS NOT NULL)))
      ) THEN true
    WHEN lower(btrim(COALESCE(p_row->>'tournament_type',p_row->>'tournamentType',p_row->>'type','')))
      IN ('mtt','xmtt','satellite','freezeout','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry','mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry') THEN true
    WHEN lower(btrim(COALESCE(p_row->>'tournament_type',p_row->>'tournamentType',p_row->>'type','')))
      IN ('sng','spin','hu_sng','heads_up') THEN false
    ELSE lower(btrim(COALESCE(p_row->>'variant',''))) IN ('mtt','xmtt','satellite','freezeout','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry','mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry')
  END;
$function$;

ALTER FUNCTION public.fn_ca_is_new_mtt(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_is_new_mtt(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_new_tournament_is_unlimited(p_config jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
DECLARE v_abi text;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 RETURN v_abi='unlimited-mtt-v2' AND public.fn_ca_is_new_mtt(p_config);
END $function$;
ALTER FUNCTION public.fn_ca_new_tournament_is_unlimited(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_new_tournament_is_unlimited(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_new_tournament_is_unlimited(jsonb) TO authenticated,service_role;

CREATE FUNCTION public.fn_ca_normalize_new_mtt_capacity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
DECLARE v_unlimited boolean;
BEGIN
 v_unlimited:=public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW));
 IF TG_OP='INSERT' THEN
  IF v_unlimited THEN
   IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'MTT_CREATION_PLATFORM_FROZEN' USING ERRCODE='55000';
   END IF;
   NEW.max_players:=NULL;
   NEW.min_players:=GREATEST(3,COALESCE(NEW.min_players,3));
   IF COALESCE(NEW.satellite_target_id,NEW.satellite_target) IS NOT NULL
      AND (upper(COALESCE(NEW.tournament_type,'')) IN ('SNG','SPIN')
           OR lower(COALESCE(NEW.variant,'')) IN ('sng','spin')) THEN
    RAISE EXCEPTION 'NEW_SATELLITE_REQUIRES_SCHEDULED_MTT_CONFIG' USING ERRCODE='55000';
   END IF;
  END IF;
 ELSIF OLD.format_contract='mtt-v2' THEN
  IF NOT v_unlimited THEN
   RAISE EXCEPTION 'MTT_V2_REQUIRES_ACTIVE_ADMISSION' USING ERRCODE='55000';
  END IF;
  NEW.max_players:=NULL;
 ELSIF v_unlimited AND OLD.format_contract='mtt-v1' THEN
  -- A now-irrelevant cap edit cannot rewrite an accepted version1 contract.
  NEW.max_players:=OLD.max_players;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_normalize_new_mtt_capacity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_normalize_new_mtt_capacity() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER a0_tournaments_dual_entry_capacity
BEFORE INSERT OR UPDATE OF max_players,tournament_type,variant,satellite_target_id,satellite_target
ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_ca_normalize_new_mtt_capacity();

CREATE FUNCTION public.fn_ca_fixed_tournament_waitlist_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 IF public.fn_ca_tournament_is_unlimited(NEW.tournament_id) THEN
  RAISE EXCEPTION 'MTTs and satellites register directly; no entry-cap waitlist'
    USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_fixed_tournament_waitlist_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_fixed_tournament_waitlist_only() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER tournament_waitlists_fixed_format_only
BEFORE INSERT OR UPDATE OF tournament_id ON public.tournament_waitlists
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_fixed_tournament_waitlist_only();

ALTER TABLE public.tournaments ALTER COLUMN max_players DROP NOT NULL;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_recorded_entry_capacity CHECK (
 (format_contract IS NOT DISTINCT FROM 'mtt-v2' AND max_players IS NULL AND COALESCE(min_players,0)>=3)
 OR (format_contract IS DISTINCT FROM 'mtt-v2' AND COALESCE(max_players>0,false))
);
DO $format_pin$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_guard_tournament_format()')
   AND md5(p.prosrc)='0f3f8b75975dd1051603acb15504528e' AND p.proowner='postgres'::regrole
   AND p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=pg_catalog, public']
   AND (SELECT count(*) FROM aclexplode(p.proacl))=1
   AND NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl)a WHERE a.grantor<>p.proowner
       OR a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) THEN
  RAISE EXCEPTION 'MTT_CREATION_FORMAT_PREIMAGE_DRIFT';
 END IF;
END $format_pin$;
CREATE OR REPLACE FUNCTION public.fn_ca_guard_tournament_format() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE v_format text; v_abi text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.format_contract IS NOT NULL THEN
      RAISE EXCEPTION 'TOURNAMENT_FORMAT_IS_DATABASE_ASSIGNED' USING ERRCODE='22023';
    END IF;
    v_abi:=public.fn_ca_lock_mtt_admission_contract();
    IF v_abi='unlimited-mtt-v2' AND public.fn_ca_is_new_mtt(to_jsonb(NEW)) THEN
      IF NEW.max_players IS NOT NULL OR COALESCE(NEW.min_players,0)<3 THEN
        RAISE EXCEPTION 'MTT_V2_CAPACITY_NOT_NORMALIZED' USING ERRCODE='23514';
      END IF;
      v_format:='mtt-v2';
    ELSE
      v_format:=public.fn_ca_legacy_tournament_format(to_jsonb(NEW));
    END IF;
    IF v_format IS NULL THEN
      RAISE EXCEPTION 'TOURNAMENT_LEGACY_FORMAT_AMBIGUOUS' USING ERRCODE='23514';
    END IF;
    NEW.format_contract:=v_format;
    RETURN NEW;
  END IF;
  IF NEW.format_contract IS DISTINCT FROM OLD.format_contract THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF OLD.format_contract='mtt-v2' THEN
    IF NOT public.fn_ca_is_new_mtt(to_jsonb(NEW)) OR NEW.max_players IS NOT NULL
       OR COALESCE(NEW.min_players,0)<3 THEN
      RAISE EXCEPTION 'TOURNAMENT_FORMAT_IDENTITY_CONFLICT' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF public.fn_ca_tournament_format_identity(to_jsonb(NEW))
      IS DISTINCT FROM public.fn_ca_tournament_format_identity(to_jsonb(OLD))
     AND (OLD.format_contract IS NULL
          OR public.fn_ca_legacy_tournament_format(to_jsonb(NEW)) IS DISTINCT FROM OLD.format_contract) THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_IDENTITY_CONFLICT' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $function$;
DO $format_post$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_guard_tournament_format()'::regprocedure)<>'9f58126f7dca89497351b3e978cf3501' THEN RAISE EXCEPTION 'MTT_CREATION_FORMAT_POSTIMAGE_DRIFT';END IF;END $format_post$;
DO $constraint$ BEGIN IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.tournaments'::regclass AND conname='tournament_prize_math_contract_valid') IS DISTINCT FROM $pin$CHECK ((((payout_math_version = 1) AND (payout_unit_cents = 1)) OR ((payout_math_version = 2) AND (payout_unit_cents = ANY (ARRAY[1, 100])) AND (upper(COALESCE(tournament_type, ''::text)) = 'MTT'::text) AND (COALESCE(max_players, 0) > 2) AND (lower(COALESCE(variant, ''::text)) <> ALL (ARRAY['spin'::text, 'sng'::text, 'satellite'::text])) AND (NOT COALESCE(is_premium_spin, false)) AND (satellite_target_id IS NULL) AND (satellite_target IS NULL))))$pin$ THEN RAISE EXCEPTION 'MTT_CREATION_PRIZE_CONSTRAINT_DRIFT';END IF;END $constraint$;
ALTER TABLE public.tournaments DROP CONSTRAINT tournament_prize_math_contract_valid;
ALTER TABLE public.tournaments ADD CONSTRAINT tournament_prize_math_contract_valid CHECK (
 (payout_math_version=1 AND payout_unit_cents=1)
 OR (payout_math_version=2 AND payout_unit_cents IN(1,100)
   AND upper(COALESCE(tournament_type,''))='MTT'
   AND (COALESCE(max_players,0)>2 OR format_contract IS NOT DISTINCT FROM 'mtt-v2')
   AND lower(COALESCE(variant,'')) NOT IN ('spin','sng','satellite')
   AND NOT COALESCE(is_premium_spin,false)
   AND satellite_target_id IS NULL AND satellite_target IS NULL)
);
DO $dual_creation$
DECLARE targets jsonb:=$targets$[
  {
    "signature": "public.fn_tournaments_creation_guard()",
    "pre_source_md5": "c57c2c577f32e61ad10088e2b34ea3b9",
    "pre_definition_md5": "625347745f78aca51aaa83bb769072a7",
    "post_source_md5": "8f23b94d8e6acc51692405a1b4132c8d",
    "post_definition_md5": "f5dcb63005864b24bf422c6628cb169e",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "  IF COALESCE(NEW.max_players, 0) <= 0 THEN",
        "new": "  IF public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW)) THEN\n    RETURN NEW; -- The earlier normalizer and final recorded-format constraint own NULL.\n  END IF;\n  IF COALESCE(NEW.max_players, 0) <= 0 THEN"
      }
    ]
  },
  {
    "signature": "public.fn_guard_new_mtt_blind_contract()",
    "pre_source_md5": "9b8471c860ac00afa814a6553135c95b",
    "pre_definition_md5": "15dd4f5521cfc9a285bef1cfc97931cd",
    "post_source_md5": "7c0dfb083a77ffac838553ca60d1238e",
    "post_definition_md5": "aac67e5c89eaa564744a97a85b5f3fbb",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "  IF upper(COALESCE(NEW.tournament_type,''))<>'MTT'",
        "new": "  IF (TG_OP='INSERT' OR OLD.format_contract IN ('mtt-v1','mtt-v2'))\n     AND public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW)) THEN\n    IF TG_OP='UPDATE' AND OLD.format_contract IN ('mtt-v1','mtt-v2')\n       AND NEW.blind_structure IS NOT DISTINCT FROM OLD.blind_structure\n       AND NEW.starting_chips IS NOT DISTINCT FROM OLD.starting_chips THEN RETURN NEW; END IF;\n    contract:=public.fn_ca_mtt_blind_contract(NEW.blind_structure,NEW.starting_chips);\n    NEW.blind_speed:=contract->>'blind_speed';\n    NEW.is_turbo:=(contract->>'is_turbo')::boolean;\n    RETURN NEW;\n  END IF;\n  IF upper(COALESCE(NEW.tournament_type,''))<>'MTT'"
      }
    ]
  },
  {
    "signature": "public.fn_create_tournament_governed_legacy(uuid,jsonb)",
    "pre_source_md5": "d00caa094f988ca352b6f7038f660c19",
    "pre_definition_md5": "ee5abd1262229b52e3908bf35bcc4cc2",
    "post_source_md5": "9ff1b6c1c1396145d62face4867fbf0f",
    "post_definition_md5": "bf284ab7932447a7d2e49a1fa7deb9d8",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "  v_sat_seats      int;",
        "new": "  v_sat_seats      int;\n  v_unlimited boolean;"
      },
      {
        "old": "  v_total := COALESCE((p_config->>'buyIn')::numeric, 0);",
        "new": "  v_unlimited:=public.fn_ca_new_tournament_is_unlimited(\n    jsonb_build_object('tournament_type',CASE WHEN p_config->>'type'='sng' THEN 'SNG'\n      WHEN p_config->>'type'='spin' THEN 'SPIN' ELSE 'MTT' END,\n      'satellite_target_id',NULLIF(p_config->>'satelliteTargetId','')));\n  IF v_unlimited AND NULLIF(p_config->>'satelliteTargetId','') IS NOT NULL\n     AND COALESCE(p_config->>'type','mtt') IN ('sng','spin') THEN\n    RETURN jsonb_build_object('success',false,'error','satellite_requires_scheduled_mtt_config');\n  END IF;\n  v_total := COALESCE((p_config->>'buyIn')::numeric, 0);"
      },
      {
        "old": "CASE WHEN COALESCE((p_config->>'maxPlayers')::int, 0) BETWEEN 1 AND 2 THEN 0.05 ELSE 0.1 END",
        "new": "CASE WHEN NOT v_unlimited AND COALESCE((p_config->>'maxPlayers')::int, 0) BETWEEN 1 AND 2 THEN 0.05 ELSE 0.1 END"
      },
      {
        "old": "  v_max_players := COALESCE((p_config->>'maxPlayers')::int, 0);\n  IF v_max_players <= 0 THEN",
        "new": "  v_max_players := CASE WHEN v_unlimited THEN NULL ELSE COALESCE((p_config->>'maxPlayers')::int, 0) END;\n  IF NOT v_unlimited AND v_max_players <= 0 THEN"
      },
      {
        "old": "  v_min_players := GREATEST(COALESCE((p_config->>'minPlayers')::int, 3), 2);",
        "new": "  v_min_players := GREATEST(COALESCE((p_config->>'minPlayers')::int, 3),CASE WHEN v_unlimited THEN 3 ELSE 2 END);"
      },
      {
        "old": "  IF v_min_players > v_max_players THEN",
        "new": "  IF NOT v_unlimited AND v_min_players > v_max_players THEN"
      },
      {
        "old": "  IF jsonb_array_length(v_payouts) > v_max_players THEN",
        "new": "  IF NOT v_unlimited AND jsonb_array_length(v_payouts) > v_max_players THEN"
      }
    ]
  },
  {
    "signature": "public.fn_poker_diamond_create_tournament(jsonb)",
    "pre_source_md5": "9fded7b537c67fffe5e7e5090d004aeb",
    "pre_definition_md5": "c8f89800cef195588ab019a17cdbf6a3",
    "post_source_md5": "f2e4c53135ffb7c24ecd26ca719a551c",
    "post_definition_md5": "6d82bede82370a9cc15d71b5ce1699f5",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "authenticated",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "  v_mb_pool numeric; v_mb_regular numeric; v_mb_min_mult numeric; v_mb_max_mult numeric;",
        "new": "  v_mb_pool numeric; v_mb_regular numeric; v_mb_min_mult numeric; v_mb_max_mult numeric;\n  v_unlimited boolean;"
      },
      {
        "old": "  v_max := COALESCE((p_config->>'maxPlayers')::int,0);\n  IF v_max<2 OR v_max>10000 THEN",
        "new": "  v_unlimited:=public.fn_ca_new_tournament_is_unlimited(jsonb_build_object('tournament_type',CASE WHEN v_type='sng' THEN 'SNG' ELSE 'MTT' END));\n  v_max := CASE WHEN v_unlimited THEN NULL ELSE COALESCE((p_config->>'maxPlayers')::int,0) END;\n  IF NOT v_unlimited AND (v_max<2 OR v_max>10000) THEN"
      },
      {
        "old": "  v_min := GREATEST(COALESCE((p_config->>'minPlayers')::int,3),2);",
        "new": "  v_min := GREATEST(COALESCE((p_config->>'minPlayers')::int,3),CASE WHEN v_unlimited THEN 3 ELSE 2 END);"
      },
      {
        "old": "  IF v_min>v_max THEN",
        "new": "  IF NOT v_unlimited AND v_min>v_max THEN"
      },
      {
        "old": "  v_ratio := CASE WHEN v_max<=2 THEN 0.05 ELSE 0.10 END;",
        "new": "  v_ratio := CASE WHEN NOT v_unlimited AND v_max<=2 THEN 0.05 ELSE 0.10 END;"
      },
      {
        "old": "  IF jsonb_array_length(v_payouts)>v_max THEN",
        "new": "  IF NOT v_unlimited AND jsonb_array_length(v_payouts)>v_max THEN"
      },
      {
        "old": "v_max, LEAST(9, GREATEST(2, v_max)), v_min,",
        "new": "v_max, CASE WHEN v_unlimited THEN LEAST(9,GREATEST(2,COALESCE((p_config->>'tableSize')::int,9))) ELSE LEAST(9,GREATEST(2,v_max)) END, v_min,"
      },
      {
        "old": "CASE WHEN v_mystery THEN v_mb_activation END, CASE WHEN v_mystery THEN v_mb_value END,",
        "new": "CASE WHEN v_mystery THEN v_mb_activation ELSE 'at_the_money' END, CASE WHEN v_mystery THEN v_mb_value END,"
      },
      {
        "old": "CASE WHEN v_mystery THEN v_mb_profile END,",
        "new": "CASE WHEN v_mystery THEN v_mb_profile ELSE 'classic' END,"
      },
      {
        "old": "CASE WHEN v_mystery THEN v_mb_top END, CASE WHEN v_mystery THEN v_mb_pool END,",
        "new": "CASE WHEN v_mystery THEN v_mb_top ELSE 20 END, CASE WHEN v_mystery THEN v_mb_pool ELSE 50 END,"
      },
      {
        "old": "CASE WHEN v_mystery THEN v_mb_regular END,",
        "new": "CASE WHEN v_mystery THEN v_mb_regular ELSE 50 END,"
      }
    ]
  },
  {
    "signature": "public.fn_short_formats_never_break()",
    "pre_source_md5": "541f6bd03a10c456f237d1e9c6be91d4",
    "pre_definition_md5": "c1a3d79a8fd639618e81ec1b2f25abe7",
    "post_source_md5": "b33bee769a9bf7883fa85d474e44e380",
    "post_definition_md5": "fb3adc8a9ea6346e34fee79945f9046a",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "  IF upper(COALESCE(NEW.tournament_type, '')) IN ('SPIN', 'SNG')",
        "new": "  IF (TG_OP='INSERT' OR OLD.format_contract IN ('mtt-v1','mtt-v2'))\n     AND public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW)) THEN RETURN NEW; END IF;\n  IF upper(COALESCE(NEW.tournament_type, '')) IN ('SPIN', 'SNG')"
      }
    ]
  },
  {
    "signature": "public.fn_tournament_management_readiness_for_row(jsonb)",
    "pre_source_md5": "5e94202dfa8e694fb012dbe25abfdf27",
    "pre_definition_md5": "dd267c27fe3792478bb9ffcd763b6c82",
    "post_source_md5": "d895eb1acd27a199757ff19cc7449adc",
    "post_definition_md5": "0b9fecc5c10bdcf459510bbb19a3268a",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "    AND COALESCE(NULLIF(p_row ->> 'max_players', '')::integer, 0) >= 2",
        "new": "    AND ((p_row->>'format_contract' IS NOT DISTINCT FROM 'mtt-v2' AND p_row->>'max_players' IS NULL\n          AND COALESCE(NULLIF(p_row->>'min_players','')::integer,0)>=3)\n      OR COALESCE(NULLIF(p_row ->> 'max_players', '')::integer, 0) >= 2)"
      }
    ]
  },
  {
    "signature": "public.fn_update_managed_game(text,uuid,jsonb)",
    "pre_source_md5": "d85ca8d75218cdc0911c2fbdb1e73ff9",
    "pre_definition_md5": "e40757db7b77ed13f0a890a35443ebac",
    "post_source_md5": "fa18234a679406809e84d44ed58875e6",
    "post_definition_md5": "8616bc6b7c535f0f6eebb97fb0204ad4",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "  IF p_kind = 'table' THEN\n    SELECT club_id, current_players, status",
        "new": "  IF p_kind='tournament' THEN\n    PERFORM pg_advisory_xact_lock_shared(530090,1);\n    PERFORM public.fn_ca_lock_mtt_admission_contract();\n  END IF;\n\n  IF p_kind = 'table' THEN\n    SELECT club_id, current_players, status"
      },
      {
        "old": "  v_name := left(regexp_replace(COALESCE(p_patch ->> 'name', ''),",
        "new": "  IF p_kind='tournament' AND public.fn_ca_tournament_is_unlimited(p_game_id) THEN\n    p_patch:=p_patch-'max_players'; -- obsolete request field must not reach integer casting\n  END IF;\n\n  v_name := left(regexp_replace(COALESCE(p_patch ->> 'name', ''),"
      },
      {
        "old": "           max_players = GREATEST(\n             2,\n             COALESCE((p_patch ->> 'max_players')::integer, max_players)\n           ),",
        "new": "           max_players = CASE WHEN public.fn_ca_tournament_is_unlimited(p_game_id)\n             THEN max_players -- retain accepted v1 storage, or v2 NULL\n             ELSE GREATEST(2,COALESCE((p_patch->>'max_players')::integer,max_players)) END,"
      }
    ]
  },
  {
    "signature": "public.fn_create_seat_first_game_atomic(uuid,jsonb)",
    "pre_source_md5": "b40dd95b7a87019070a8abf0fcc4fff3",
    "pre_definition_md5": "92cbf5680d78bdbaa4309412b3d19dfd",
    "post_source_md5": "985042b735d49331833ac25a6adc62a5",
    "post_definition_md5": "0669e34f1376e42d734f7632ea35eb6a",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "  v_big_blind numeric;",
        "new": "  v_big_blind numeric;\n  v_admission_abi text;"
      },
      {
        "old": "  PERFORM pg_advisory_xact_lock_shared(530090, 1);",
        "new": "  PERFORM pg_advisory_xact_lock_shared(530090, 1);\n  v_admission_abi:=public.fn_ca_lock_mtt_admission_contract();"
      },
      {
        "old": "  INSERT INTO public.tournaments (",
        "new": "  IF v_admission_abi='unlimited-mtt-v2' AND v_satellite_target_id IS NOT NULL THEN\n    RAISE EXCEPTION 'NEW_SATELLITE_REQUIRES_SCHEDULED_MTT_CONFIG' USING ERRCODE='55000';\n  END IF;\n\n  INSERT INTO public.tournaments ("
      }
    ]
  }
]$targets$::jsonb;
 item jsonb; edit jsonb; phase text; fn oid; definition text; actual_acl jsonb;
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'MTT_DUAL_CREATION_OWNER_REQUIRED'; END IF;
 FOREACH phase IN ARRAY ARRAY['pre','post'] LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
   fn:=to_regprocedure(item->>'signature');
   IF fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn
      AND md5(p.prosrc)=item->>(phase||'_source_md5')
      AND md5(pg_get_functiondef(p.oid))=item->>(phase||'_definition_md5')
      AND p.proowner='postgres'::regrole) THEN
    RAISE EXCEPTION 'MTT_DUAL_CREATION_%_AUTHORITY_DRIFT: %',phase,item->>'signature';
   END IF;
   SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege_type',a.privilege_type,'is_grantable',a.is_grantable)
      ORDER BY a.grantee::regrole::text,a.privilege_type) INTO actual_acl
   FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid=fn;
   IF actual_acl IS DISTINCT FROM item->'acl' THEN
    RAISE EXCEPTION 'MTT_DUAL_CREATION_%_ACL_DRIFT: %',phase,item->>'signature';
   END IF;
  END LOOP;
  IF phase='pre' THEN
   FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
    SELECT pg_get_functiondef(to_regprocedure(item->>'signature')) INTO STRICT definition;
    FOR edit IN SELECT value FROM jsonb_array_elements(item->'edits') LOOP
     IF (length(definition)-length(replace(definition,edit->>'old','')))/length(edit->>'old')<>1 THEN
      RAISE EXCEPTION 'MTT_DUAL_CREATION_SPLICE_DRIFT: %',item->>'signature';
     END IF;
     definition:=replace(definition,edit->>'old',edit->>'new');
    END LOOP;
    EXECUTE definition;
   END LOOP;
  END IF;
 END LOOP;
END $dual_creation$;

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES ('tournaments','a0_tournaments_dual_entry_capacity','R46 locked new MTT format and capacity admission'),
 ('tournament_waitlists','tournament_waitlists_fixed_format_only','R46 existing capacity authority refuses MTT waitlist diversion')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;
COMMIT;
