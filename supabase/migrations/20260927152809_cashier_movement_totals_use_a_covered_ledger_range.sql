-- A fixed-width ledger range for unchanged Cashier statement totals.
-- The exact 18-parameter production plan used 26227 ledger buffers for 9936
-- rows, rejecting another 16792 by status/category. The omission CTE used only
-- 254 buffers. The first whole read exceeded 8s; a warmed whole read took227ms.
-- Narrow the existing range to its exact posted/category predicate and cover
-- only UUID/time/numeric identities. No variable text/JSON tuple or financial
-- function, permission, row, retention, timeout, or table option is changed.
-- Complete tests/fixtures/cashier-statements/ledger-cover-build-online.sql as
-- ONE native top-level statement first. No blocking fallback or blind retry.
-- Preserve original native session caller, DDL/freeze gates and bounded runway.
-- @live-proof: EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.idx_chip_ledger_cashier_totals_cover') AND indisvalid AND indisready AND indislive)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='8s';
SET LOCAL search_path=public,pg_temp;
DO $qualify$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_cashier_statement_downline(uuid,uuid)','f98d60a45ab3aa1110964e1c57958349'),
    ('public.fn_cashier_statement_export_cancel(uuid)','7772e8238e42f490c20e2235d1358ce2'),
    ('public.fn_cashier_statement_export_page(uuid,integer,integer)','3ab1d903bbd15f1b8c97e6bc168bc466'),
    ('public.fn_cashier_statement_export_start(uuid,timestamp with time zone,timestamp with time zone,jsonb,uuid)','64d8ce9fac09f83bb04105cded1e6177'),
    ('public.fn_cashier_statement_filters(timestamp with time zone,timestamp with time zone,jsonb)','e6117573c33ba2cfbaf8060f083b906d'),
    ('public.fn_cashier_statement_page(uuid,timestamp with time zone,timestamp with time zone,jsonb,jsonb,integer)','06493bb58a2199b8aaed0f950bafe2c2'),
    ('public.fn_cashier_statement_prune_expired()','a87705b0a595ffa4a22fe88b18ee3d8a'),
    ('public.fn_cashier_statement_rows(uuid,uuid,text,timestamp with time zone,timestamp with time zone,jsonb,timestamp with time zone,text,uuid,integer)','49e310be00e91afc9a9b7582bb048184'),
    ('public.fn_cashier_statement_scope(uuid)','5c3180605b76db07957f261b39914f8d'),
    ('public.fn_cashier_statement_totals(uuid,timestamp with time zone,timestamp with time zone,jsonb)','5e50033127ded658f0bb4de87e0a10e6')
  ) pins(signature, fingerprint) LOOP
    IF to_regprocedure(r.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(r.signature))) IS DISTINCT FROM r.fingerprint THEN
      RAISE EXCEPTION 'CASHIER_LEDGER_COVER_SOURCE_CHANGED: %',r.signature USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'fn\_cashier\_statement\_%'
      AND (p.proowner <> 'postgres'::regrole OR p.proacl IS DISTINCT FROM
        CASE WHEN p.proname IN ('fn_cashier_statement_rows','fn_cashier_statement_downline','fn_cashier_statement_filters','fn_cashier_statement_prune_expired')
        THEN '{postgres=X/postgres}'::aclitem[]
        ELSE '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[] END)
  ) THEN RAISE EXCEPTION 'CASHIER_LEDGER_COVER_AUTHORITY_CHANGED'; END IF;

  IF EXISTS(SELECT 1 FROM (VALUES
    ('club_id','uuid',false),('created_at','timestamp with time zone',true),
    ('id','uuid',true),('amount','numeric(15,2)',true),
    ('from_entity_id','uuid',false),('to_entity_id','uuid',false),
    ('status','text',true),('category','text',true)
  ) shape(name,typ,nn) LEFT JOIN pg_attribute a ON a.attrelid='public.chip_ledger'::regclass
    AND a.attname=shape.name AND a.attnum>0 AND NOT a.attisdropped
  WHERE a.attname IS NULL OR format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM shape.typ
    OR a.attnotnull IS DISTINCT FROM shape.nn) THEN
    RAISE EXCEPTION 'CASHIER_LEDGER_COVER_COLUMN_CHANGED';
  END IF;
  IF to_regclass('public.idx_chip_ledger_cashier_totals_cover') IS NULL THEN
    RAISE EXCEPTION 'CASHIER_LEDGER_COVER_MISSING_BUILD_ONLINE';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am am ON am.oid=ix.relam
    WHERE i.indexrelid='public.idx_chip_ledger_cashier_totals_cover'::regclass
      AND i.indrelid='public.chip_ledger'::regclass AND t.relkind='r' AND ix.relkind='i'
      AND t.relowner='postgres'::regrole AND ix.relowner=t.relowner
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND am.amname='btree' AND i.indnkeyatts=2 AND i.indnatts=6
      AND i.indoption::text='0 3' AND i.indcollation::text='0 0'
      AND i.indexprs IS NULL
      AND pg_get_indexdef(i.indexrelid)=$exact$CREATE INDEX idx_chip_ledger_cashier_totals_cover ON public.chip_ledger USING btree (club_id, created_at DESC) INCLUDE (id, amount, from_entity_id, to_entity_id) WHERE ((status = 'posted'::text) AND (category = ANY (ARRAY['buyin'::text, 'addon'::text, 'rebuy'::text, 'tournament_prize'::text, 'bounty'::text, 'refund'::text, 'spin_entry'::text, 'spin_prize'::text, 'promo'::text, 'promo_send'::text, 'treasury_transfer'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'overlay'::text, 'reversal'::text, 'correction'::text, 'adjustment'::text, 'leaderboard_payout'::text])))$exact$
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='uuid_ops' AND opcmethod=ix.relam)
      AND i.indclass[1]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='timestamptz_ops' AND opcmethod=ix.relam)) THEN
    RAISE EXCEPTION 'CASHIER_LEDGER_COVER_INDEX_CHANGED';
  END IF;
END
$qualify$;
COMMIT;
