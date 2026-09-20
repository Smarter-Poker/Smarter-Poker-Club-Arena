-- Reserved by scripts/reserve-migration-version.sh on 2026-09-14.
-- R32: current issuance and club resolution accept a union host OR member club;
-- ticket selection, horse hints and beneficiary admission required both.
-- Change only those predicates. No row mutation, target remap, cash conversion,
-- authorization grant, entry amount, evidence check or financial-tail change.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE
  item jsonb; pattern jsonb; function_oid oid; source_text text;
  definition text; before_metadata jsonb; after_metadata jsonb; expected_metadata jsonb;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements($changes$[
  {
    "signature": "public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)",
    "expected_metadata": {
      "owner": "postgres",
      "acl": "{postgres=X/postgres}",
      "config": [
        "search_path=public, pg_temp"
      ],
      "definer": true,
      "volatility": "s"
    },
    "before": "40571e97e346d169f9153989e8da503f",
    "after": "b2be04b725a63eb2dd3df5d709178f4e",
    "patterns": [
      {
        "old": "(v_t.club_id IS NULL OR tk.club_id=v_t.club_id)",
        "new": "(v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)",
        "count": 2
      },
      {
        "old": "(v_t.union_id IS NULL OR EXISTS(",
        "new": "(v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(",
        "count": 2
      }
    ]
  },
  {
    "signature": "public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)",
    "expected_metadata": {
      "owner": "postgres",
      "acl": "{postgres=X/postgres}",
      "config": [
        "search_path=public, pg_temp"
      ],
      "definer": true,
      "volatility": "v"
    },
    "before": "c2aa701c3efe83bd5e04b18effba7ea0",
    "after": "b274c4f4e192e0b404397db939476284",
    "patterns": [
      {
        "old": "IF v_t.club_id IS NOT NULL\n     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id THEN",
        "new": "IF v_t.union_id IS NULL AND v_t.club_id IS NOT NULL\n     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id THEN",
        "count": 1
      },
      {
        "old": "IF v_t.union_id IS NOT NULL AND NOT EXISTS(",
        "new": "IF v_t.union_id IS NOT NULL\n     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id AND NOT EXISTS(",
        "count": 1
      }
    ]
  },
  {
    "signature": "public.fn_horse_tournament_entry_ticket_hints(uuid)",
    "expected_metadata": {
      "owner": "postgres",
      "acl": "{postgres=X/postgres,service_role=X/postgres}",
      "config": [
        "search_path=public, pg_temp"
      ],
      "definer": true,
      "volatility": "s"
    },
    "before": "92c16e6c301d570dd2b4fa1662de8f72",
    "after": "b3dddb2e16952bef8025274e3412ed82",
    "patterns": [
      {
        "old": "(v_t.club_id IS NULL OR tk.club_id=v_t.club_id)",
        "new": "(v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)",
        "count": 1
      },
      {
        "old": "(v_t.union_id IS NULL OR EXISTS(",
        "new": "(v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(",
        "count": 1
      }
    ]
  }
]$changes$::jsonb)
  LOOP
    function_oid:=to_regprocedure(item->>'signature');
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'Union ticket scope prerequisite missing: %',item->>'signature';
    END IF;
    SELECT p.prosrc,pg_get_functiondef(p.oid),
      jsonb_build_array(p.oid,p.proowner,p.proacl::text,p.proconfig,
        p.prosecdef,p.provolatile,p.proparallel,p.proleakproof,p.proisstrict)
      INTO source_text,definition,before_metadata FROM pg_proc p WHERE p.oid=function_oid;
    SELECT jsonb_build_object('owner',pg_get_userbyid(p.proowner),
      'acl',p.proacl::text,'config',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile)
      INTO expected_metadata FROM pg_proc p WHERE p.oid=function_oid;
    IF expected_metadata IS DISTINCT FROM item->'expected_metadata' THEN
      RAISE EXCEPTION 'Union ticket scope authorization prerequisite drift: %',item->>'signature';
    END IF;
    IF md5(source_text)=item->>'after' THEN CONTINUE; END IF;
    IF md5(source_text) IS DISTINCT FROM item->>'before' THEN
      RAISE EXCEPTION 'Union ticket scope source drift: % (%)',
        item->>'signature',md5(source_text);
    END IF;
    FOR pattern IN SELECT value FROM jsonb_array_elements(item->'patterns')
    LOOP
      IF array_length(string_to_array(definition,pattern->>'old'),1)-1
           IS DISTINCT FROM (pattern->>'count')::integer THEN
        RAISE EXCEPTION 'Union ticket scope replacement shape changed: %',item->>'signature';
      END IF;
      definition:=replace(definition,pattern->>'old',pattern->>'new');
    END LOOP;
    EXECUTE definition;
    SELECT p.prosrc,
      jsonb_build_array(p.oid,p.proowner,p.proacl::text,p.proconfig,
        p.prosecdef,p.provolatile,p.proparallel,p.proleakproof,p.proisstrict)
      INTO source_text,after_metadata FROM pg_proc p WHERE p.oid=function_oid;
    IF md5(source_text) IS DISTINCT FROM item->>'after'
       OR after_metadata IS DISTINCT FROM before_metadata THEN
      RAISE EXCEPTION 'Union ticket scope postimage or authorization metadata changed: %',
        item->>'signature';
    END IF;
  END LOOP;
END;
$migration$;
COMMIT;
