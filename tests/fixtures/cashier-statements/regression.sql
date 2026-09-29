-- Cashier statements (Phase 5): behaviour of the installed migration.
-- Every statement call runs as the `authenticated` role with auth.uid()
-- stubbed through test.uid; setup and oracle reads run as the bootstrap
-- superuser (RESET ROLE). Result rows are discarded; the PASS/FAIL notices
-- are the output.
\o /dev/null

-- Invoker helpers (no privileges of their own). The September statement of
-- club A is the default request.
CREATE FUNCTION public.page_a(p_filters jsonb DEFAULT '{}', p_cursor jsonb DEFAULT NULL, p_limit int DEFAULT 200,
                              p_from timestamptz DEFAULT '2026-09-01T00:00:00Z', p_to timestamptz DEFAULT '2026-09-30T00:00:00Z')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.fn_cashier_statement_page(public.u(100), p_from, p_to, p_filters, p_cursor, p_limit)
$$;

-- Walks every page of one request and returns the entries in order.
CREATE FUNCTION public.walk_a(p_filters jsonb DEFAULT '{}', p_limit int DEFAULT 5)
RETURNS TABLE(ord int, page int, entry jsonb, totals jsonb) LANGUAGE plpgsql AS $$
DECLARE
  v_cursor jsonb;
  v_page jsonb;
  v_page_no int := 0;
  v_ord int := 0;
  v_entry jsonb;
BEGIN
  LOOP
    v_page_no := v_page_no + 1;
    IF v_page_no > 500 THEN RAISE EXCEPTION 'walk did not terminate'; END IF;
    v_page := public.page_a(p_filters, v_cursor, p_limit);
    IF NOT (v_page ->> 'authorized')::boolean THEN RETURN; END IF;
    FOR v_entry IN SELECT value FROM jsonb_array_elements(v_page -> 'rows') LOOP
      v_ord := v_ord + 1;
      ord := v_ord; page := v_page_no; entry := v_entry; totals := v_page -> 'totals';
      RETURN NEXT;
    END LOOP;
    v_cursor := v_page -> 'next_cursor';
    EXIT WHEN v_cursor IS NULL OR jsonb_typeof(v_cursor) = 'null';
  END LOOP;
END
$$;

-- The totals door for the September statement of club A.
CREATE FUNCTION public.totals_a(p_filters jsonb DEFAULT '{}', p_from timestamptz DEFAULT '2026-09-01T00:00:00Z', p_to timestamptz DEFAULT '2026-09-30T00:00:00Z')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.fn_cashier_statement_totals(public.u(100), p_from, p_to, p_filters)
$$;

-- True when the totals door equals the sum of every page of the same
-- request (walked 7 at a time) for the current viewer.
CREATE FUNCTION public.totals_match(p_filters jsonb) RETURNS boolean LANGUAGE sql AS $$
  SELECT (SELECT public.totals_a(p_filters)->'totals') = jsonb_build_object(
           'in', to_char(coalesce(sum((w.entry->>'amount')::numeric) FILTER (WHERE w.entry->>'direction'='in'),0),'FM999999999999999990.00'),
           'out', to_char(coalesce(sum((w.entry->>'amount')::numeric) FILTER (WHERE w.entry->>'direction'='out'),0),'FM999999999999999990.00'),
           'managed', to_char(coalesce(sum((w.entry->>'amount')::numeric) FILTER (WHERE w.entry->>'direction'='managed'),0),'FM999999999999999990.00'),
           'count', count(w.entry))
    FROM public.walk_a(p_filters, 7) w
$$;

-- Ids returned for a filter, as one sorted text array (for exact matches).
CREATE FUNCTION public.ids_a(p_filters jsonb) RETURNS text[] LANGUAGE sql AS $$
  SELECT coalesce(array_agg(e ->> 'id' ORDER BY e ->> 'id'), ARRAY[]::text[])
    FROM jsonb_array_elements(public.page_a(p_filters) -> 'rows') e
$$;
CREATE FUNCTION public.ids(VARIADIC int[]) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT array_agg(public.u(n)::text ORDER BY public.u(n)::text) FROM unnest($1) n
$$;

-- Oracle: the statement set computed independently from the base tables.
CREATE FUNCTION public.oracle_ids(p_members uuid[]) RETURNS text[] LANGUAGE sql SECURITY DEFINER AS $$
  SELECT array_agg(x ORDER BY x) FROM (
    SELECT ct.id::text x FROM public.chip_transactions ct
     WHERE ct.club_id = public.u(100) AND ct.created_at >= '2026-09-01T00:00:00Z' AND ct.created_at < '2026-09-30T00:00:00Z'
       AND (p_members IS NULL OR ct.from_user_id = ANY(p_members) OR ct.to_user_id = ANY(p_members))
    UNION ALL
    SELECT cl.id::text FROM public.chip_ledger cl
     WHERE cl.club_id = public.u(100) AND cl.created_at >= '2026-09-01T00:00:00Z' AND cl.created_at < '2026-09-30T00:00:00Z'
       AND cl.status = 'posted'
       AND cl.category IN ('buyin','addon','rebuy','tournament_prize','bounty','refund','spin_entry','spin_prize','promo','promo_send','treasury_transfer','transfer','player_funding','agent_funding','overlay','reversal','correction','adjustment','leaderboard_payout')
       AND (p_members IS NULL OR cl.from_entity_id = ANY(p_members) OR cl.to_entity_id = ANY(p_members))
       AND NOT EXISTS (SELECT 1 FROM public.chip_transactions r WHERE r.club_id = cl.club_id
                         AND r.created_at >= '2026-08-31T00:00:00Z' AND r.created_at < '2026-10-01T00:00:00Z'
                         AND cl.idempotency_key IN (r.metadata ->> 'idempotency_key', r.metadata ->> 'restore_key'))
  ) s
$$;

SET ROLE authenticated;

-- ===========================================================================
-- 1. Scope: exactly the fn_club_trade_ledger rule.
-- ===========================================================================
SELECT public.as_user(1);
SELECT assert_true((SELECT s->>'scope'='all' AND s->>'role'='owner' AND (s->>'authorized')::boolean AND s->>'viewer'=public.u(1)::text AND length(s->>'fingerprint')=32 FROM (SELECT public.fn_cashier_statement_scope(public.u(100)) s) x),'owner sees the whole club');
SELECT public.as_user(2);
SELECT assert_true(public.fn_cashier_statement_scope(public.u(100))->>'scope'='all','co_owner sees the whole club');
SELECT public.as_user(3);
SELECT assert_true(public.fn_cashier_statement_scope(public.u(100))->>'scope'='all','admin sees the whole club');
SELECT public.as_user(4);
SELECT assert_true(public.fn_cashier_statement_scope(public.u(100))->>'scope'='all','super_agent sees the whole club, as in the trade ledger');
SELECT public.as_user(10);
SELECT assert_true(public.fn_cashier_statement_scope(public.u(100))->>'scope'='downline','agent sees a downline');
SELECT public.as_user(11);
SELECT assert_true(public.fn_cashier_statement_scope(public.u(100))->>'scope'='downline','sub_agent sees a downline');
SELECT public.as_user(20);
SELECT assert_true(public.fn_cashier_statement_scope(public.u(100))->>'scope'='self','player sees self');
SELECT public.as_user(21);
SELECT assert_true(public.fn_cashier_statement_scope(public.u(100))->>'scope'='self','an approved membership counts as active');
SELECT public.as_user(23);
SELECT assert_true((SELECT s->>'scope'='none' AND NOT (s->>'authorized')::boolean AND s->>'reason'='not_an_active_member' AND s->>'role' IS NULL FROM (SELECT public.fn_cashier_statement_scope(public.u(100)) s) x),'a suspended member sees nothing');
SELECT public.as_user(26);
SELECT assert_true(public.fn_cashier_statement_scope(public.u(100))->>'scope'='none','a member with no role sees nothing (the trade ledger returns no row)');
SELECT public.as_user(30);
SELECT assert_true((SELECT s->>'scope'='none' AND NOT (s->>'authorized')::boolean FROM (SELECT public.fn_cashier_statement_scope(public.u(100)) s) x),'a non-member sees nothing');
SELECT assert_true((SELECT p = '{"reason": "not_an_active_member", "authorized": false}'::jsonb FROM (SELECT public.page_a() p) x),'a non-member page is {authorized:false}, not an error');
SELECT assert_true(public.page_a('{"wallet":"bogus"}')->>'authorized'='false','lost authorization is reported before input validation');
SELECT public.as_user(NULL);
SELECT assert_true((SELECT s->>'reason'='sign_in_required' AND s->>'scope'='none' FROM (SELECT public.fn_cashier_statement_scope(public.u(100)) s) x),'no session sees nothing');
SELECT assert_true(public.page_a()->>'authorized'='false','no session page is {authorized:false}');
SELECT public.as_user(1);
SELECT assert_true(public.fn_cashier_statement_scope(NULL)->>'reason'='club_required','a null club is refused as unauthorized');

-- Row sets equal an independent oracle for every scope branch.
SELECT public.as_user(1);
SELECT assert_true(public.ids_a('{}') = public.oracle_ids(NULL) AND cardinality(public.ids_a('{}')) = 74,'owner statement is every receipt plus every unrepresented included movement (43 + 31 = 74)');
SELECT public.as_user(4);
SELECT assert_true(public.ids_a('{}') = public.oracle_ids(NULL),'super_agent statement equals the owner statement');
SELECT public.as_user(10);
SELECT assert_true(public.ids_a('{}') = public.oracle_ids(ARRAY[public.u(10),public.u(11),public.u(20),public.u(21),public.u(25)]) AND cardinality(public.ids_a('{}')) = 67,'agent statement is the recursive active downline including self (67)');
SELECT assert_true(NOT (public.ids_a('{}') && public.ids(1006,1010,1012,1016,1020,2009,2012)),'agent never sees rows outside the downline');
SELECT assert_true(public.ids_a('{}') @> public.ids(1013,1014),'agent keeps the rows where the agent is a side, even to a suspended member');
SELECT public.as_user(11);
SELECT assert_true(public.ids_a('{}') = public.oracle_ids(ARRAY[public.u(11),public.u(21)]) AND cardinality(public.ids_a('{}')) = 30,'sub_agent statement is its own subtree (30)');
SELECT public.as_user(12);
SELECT assert_true(public.ids_a('{}') = public.oracle_ids(ARRAY[public.u(12),public.u(22)]) AND cardinality(public.ids_a('{}')) = 6,'a cyclic agent assignment terminates without duplicates (6)');
SELECT public.as_user(20);
SELECT assert_true(public.ids_a('{}') = public.oracle_ids(ARRAY[public.u(20)]) AND cardinality(public.ids_a('{}')) = 56,'player statement is self only (56)');
SELECT assert_true((SELECT bool_and(e->'from'->>'id' = public.u(20)::text OR e->'to'->>'id' = public.u(20)::text) FROM jsonb_array_elements(public.page_a()->'rows') e),'every player row has the player on a side');
SELECT assert_true(NOT (public.ids_a('{}') && public.ids(1100,2100)),'another club''s rows never enter the statement');
SELECT public.as_user(28);
SELECT assert_true(public.ids_a('{}') = public.ids(1014,1016),'a member under a suspended agent is still self-scoped');

-- ===========================================================================
-- 2. Input validation.
-- ===========================================================================
SELECT public.as_user(1);
SELECT assert_true(refuses($$SELECT public.page_a('{}',NULL,100,'2026-09-10Z','2026-09-10Z')$$,'22023'),'from equal to to is refused');
SELECT assert_true(refuses($$SELECT public.page_a('{}',NULL,100,'2026-09-11Z','2026-09-10Z')$$,'22023'),'from after to is refused');
SELECT assert_true(refusal($$SELECT public.page_a('{}',NULL,100,'2026-06-01Z','2026-09-01T00:00:00.000001Z')$$) = '22023 statement range is limited to 92 days','a range over 92 days is refused with the contract message');
SELECT assert_true((public.page_a('{}',NULL,1,'2026-06-01Z','2026-09-01Z')->>'authorized')::boolean,'exactly 92 days is accepted');
SELECT assert_true(refuses($$SELECT public.page_a('{}',NULL,100,NULL,'2026-09-10Z')$$,'22023'),'a null bound is refused');
SELECT assert_true(refuses($$SELECT public.page_a('{}',NULL,100,'-infinity','2026-09-10Z')$$,'22023'),'an infinite bound is refused');
SELECT assert_true(refuses($$SELECT public.page_a('{"wallet":"bogus"}')$$,'22023'),'an unknown wallet family is refused');
SELECT assert_true(refuses($$SELECT public.page_a('{"direction":"sideways"}')$$,'22023'),'an unknown direction is refused');
SELECT assert_true(refuses($$SELECT public.page_a('{"state":"lost"}')$$,'22023'),'an unknown state is refused');
SELECT assert_true(refuses($$SELECT public.page_a('{"colour":"red"}')$$,'22023'),'an unknown filter key is refused');
SELECT assert_true(refuses($$SELECT public.page_a('{"wallet":7}')$$,'22023'),'a non-text filter is refused');
SELECT assert_true(refuses($$SELECT public.page_a('[1]')$$,'22023'),'filters must be an object');
SELECT assert_true(refuses($$SELECT public.page_a('{"counterparty":"x"}')$$,'22023'),'a one-character counterparty is refused');
SELECT assert_true(refuses(format($q$SELECT public.page_a('{"counterparty":"%s"}')$q$, repeat('a',65)),'22023'),'a counterparty over 64 characters is refused');
SELECT assert_true(refuses(format($q$SELECT public.page_a('{"reference":"%s"}')$q$, repeat('a',129)),'22023'),'a reference over 128 characters is refused');
SELECT assert_true(jsonb_array_length(public.page_a('{}',NULL,1000)->'rows') = 74 AND jsonb_array_length(public.page_a('{}',NULL,0)->'rows') = 1 AND jsonb_array_length(public.page_a('{}',NULL,NULL)->'rows') = 74,'page size is clamped to 1..200 (default 100)');
SELECT assert_true(public.page_a('{"wallet":" Cashout ","operation":"  "}')->'filters' = '{"wallet":"cashout","direction":"any","state":"any","operation":null,"counterparty":null,"reference":null}'::jsonb,'filters are normalized and echoed');

-- ===========================================================================
-- 3. Keyset paging: >= 3 pages, ties on `at` across boundaries, no overlap,
--    no skip, totals equal to the sum of every page.
-- ===========================================================================
SELECT public.as_user(1);
CREATE TEMP TABLE walk_owner AS SELECT * FROM public.walk_a('{}', 5);
SELECT assert_true((SELECT max(page) >= 3 FROM walk_owner),'owner statement spans at least three pages of five');
SELECT assert_true((SELECT count(*) = 74 AND count(DISTINCT entry->>'id') = 74 FROM walk_owner),'no entry is repeated or skipped across pages');
SELECT assert_true((SELECT array_agg(entry->>'id' ORDER BY ord) FROM walk_owner) = (SELECT array_agg(e->>'id' ORDER BY n) FROM jsonb_array_elements(public.page_a()->'rows') WITH ORDINALITY x(e,n)),'the concatenated pages equal one page of everything, in order');
SELECT assert_true((SELECT bool_and(ok) FROM (
  SELECT (lag(entry->>'at') OVER w > entry->>'at')
      OR (lag(entry->>'at') OVER w = entry->>'at' AND lag(entry->>'source') OVER w < entry->>'source')
      OR (lag(entry->>'at') OVER w = entry->>'at' AND lag(entry->>'source') OVER w = entry->>'source' AND lag(entry->>'id') OVER w > entry->>'id')
      OR lag(entry->>'id') OVER w IS NULL AS ok
    FROM walk_owner WINDOW w AS (ORDER BY ord)) s),'entries are strictly ordered at DESC, source ASC, id DESC');
SELECT assert_true((SELECT count(*) >= 2 FROM walk_owner a JOIN walk_owner b ON b.page = a.page + 1
                     WHERE a.ord = (SELECT max(ord) FROM walk_owner WHERE page = a.page)
                       AND b.ord = (SELECT min(ord) FROM walk_owner WHERE page = b.page)
                       AND a.entry->>'at' = b.entry->>'at'),'page boundaries fall inside ties on at and still continue exactly');
SELECT assert_true((SELECT count(*) > 0 FROM walk_owner a JOIN walk_owner b ON b.ord = a.ord + 1 AND b.page = a.page + 1
                     WHERE a.entry->>'at' = b.entry->>'at' AND a.entry->>'source' = 'movement' AND b.entry->>'source' = 'receipt'),'a boundary between a movement and a receipt at the same instant continues exactly');
SELECT assert_true((SELECT bool_and(totals = 'null'::jsonb) AND max(page) > 1 FROM walk_owner),'the page never carries totals (O(limit)); totals have their own door');
SELECT assert_true((SELECT (t->'totals'->>'count')::int = 74
                       AND t->'totals'->>'in' = to_char(coalesce((SELECT sum((entry->>'amount')::numeric) FROM walk_owner WHERE entry->>'direction'='in'),0),'FM999999999990.00')
                       AND t->'totals'->>'out' = to_char((SELECT sum((entry->>'amount')::numeric) FROM walk_owner WHERE entry->>'direction'='out'),'FM999999999990.00')
                       AND t->'totals'->>'managed' = to_char((SELECT sum((entry->>'amount')::numeric) FROM walk_owner WHERE entry->>'direction'='managed'),'FM999999999990.00')
                      FROM (SELECT public.totals_a('{}') t) s),'owner totals door equals the sum of all pages');

SELECT public.as_user(20);
CREATE TEMP TABLE walk_player AS SELECT * FROM public.walk_a('{}', 7);
SELECT assert_true((SELECT count(*) = 56 AND count(DISTINCT entry->>'id') = 56 AND max(page) >= 3 FROM walk_player),'player paging covers the statement exactly');
SELECT assert_true((SELECT public.totals_a('{}')->'totals' = '{"in":"451.00","out":"453.00","managed":"0.00","count":56}'::jsonb),'player totals are viewer-relative 2dp strings (in 451.00, out 453.00)');
SELECT assert_true((SELECT t->'totals'->>'in' = to_char((SELECT sum((entry->>'amount')::numeric) FROM walk_player WHERE entry->>'direction'='in'),'FM999999999990.00')
                       AND t->'totals'->>'out' = to_char((SELECT sum((entry->>'amount')::numeric) FROM walk_player WHERE entry->>'direction'='out'),'FM999999999990.00')
                      FROM (SELECT public.totals_a('{}') t) s),'player totals door equals the sum of all pages');
SELECT assert_true((SELECT count(*) = 24 AND count(DISTINCT entry->>'id') = 24 AND max(page) >= 3
                           AND bool_and(entry->>'wallet' = 'player' AND entry->>'direction' = 'in')
                      FROM public.walk_a('{"wallet":"player","direction":"in"}', 3)),'filtered paging stays inside the filter and covers it exactly');
SELECT public.as_user(10);
SELECT assert_true((SELECT count(*) = 67 AND count(DISTINCT entry->>'id') = 67 FROM public.walk_a('{}', 4)),'agent paging covers the statement exactly');

-- ===========================================================================
-- 4. Cursor binding.
-- ===========================================================================
SELECT public.as_user(1);
CREATE TEMP TABLE owner_cursor AS SELECT public.page_a('{}',NULL,5)->'next_cursor' AS c;
SELECT assert_true((SELECT c ? 'at' AND c ? 'source' AND c ? 'id' AND length(c->>'fp') = 32 FROM owner_cursor),'next_cursor carries at, source, id and fp');
SELECT assert_true((SELECT jsonb_array_length(public.page_a('{}',c,5)->'rows') = 5 FROM owner_cursor),'the cursor continues its own statement');
SELECT assert_true((SELECT p->'totals' = 'null'::jsonb AND jsonb_typeof(p->'next_cursor') = 'object' FROM (SELECT public.page_a('{}',c,5) p FROM owner_cursor) s)
                   AND public.page_a('{}',NULL,5)->'totals' = 'null'::jsonb
                   AND public.page_a('{}','null'::jsonb,5)->'rows' = public.page_a('{}',NULL,5)->'rows','every page carries totals null; a JSON null cursor is the first page');
SELECT assert_true(refusal($$SELECT public.page_a('{"direction":"managed"}',(SELECT c FROM owner_cursor),5)$$) = '55000 cursor does not belong to this statement','a cursor from other filters is refused 55000');
SELECT assert_true(refuses($$SELECT public.page_a('{}',(SELECT c FROM owner_cursor),5,'2026-09-02Z','2026-09-30Z')$$,'55000'),'a cursor from another range is refused 55000');
SELECT assert_true(refuses($$SELECT public.page_a('{}',(SELECT c - 'fp' FROM owner_cursor),5)$$,'55000'),'a cursor without a fingerprint is refused 55000');
SELECT assert_true(refuses($$SELECT public.page_a('{}',(SELECT jsonb_set(c,'{id}','"nope"') FROM owner_cursor),5)$$,'22023'),'a malformed cursor position is refused 22023');
SELECT assert_true(refuses($$SELECT public.page_a('{}','"x"',5)$$,'22023'),'a non-object cursor is refused 22023');
SELECT public.as_user(2);
SELECT assert_true(refuses($$SELECT public.page_a('{}',(SELECT c FROM owner_cursor),5)$$,'55000'),'another viewer cannot continue the owner''s cursor');

-- ===========================================================================
-- 4b. The totals door: same authorization, same validation, same rows.
-- ===========================================================================
SELECT public.as_user(30);
SELECT assert_true(public.totals_a() = '{"reason": "not_an_active_member", "authorized": false}'::jsonb,'totals: a non-member is {authorized:false}, not an error');
SELECT public.as_user(23);
SELECT assert_true(public.totals_a()->>'authorized' = 'false' AND public.totals_a('{"wallet":"bogus"}')->>'authorized' = 'false','totals: a suspended member is refused before input validation');
SELECT public.as_user(NULL);
SELECT assert_true(public.totals_a()->>'reason' = 'sign_in_required','totals: no session is {authorized:false}');
SELECT public.as_user(1);
SELECT assert_true(refusal($$SELECT public.totals_a('{}','2026-06-01Z','2026-09-01T00:00:00.000001Z')$$) = '22023 statement range is limited to 92 days'
                   AND refuses($$SELECT public.totals_a('{}','2026-09-10Z','2026-09-10Z')$$,'22023')
                   AND refuses($$SELECT public.totals_a('{"colour":"red"}')$$,'22023')
                   AND refuses($$SELECT public.totals_a('{"state":"lost"}')$$,'22023')
                   AND refuses($$SELECT public.totals_a('{"counterparty":"x"}')$$,'22023'),'totals: the 92-day cap, from < to and every filter rule raise 22023');
SELECT assert_true((SELECT t ?& ARRAY['authorized','scope','range','filters','totals','generated_at'] AND t->>'scope' = 'all' AND t->'range'->>'from' = '2026-09-01T00:00:00.000000Z'
                           AND t->'filters' = public.page_a('{"wallet":" Cashout "}')->'filters' AND (SELECT public.totals_a('{"wallet":" Cashout "}')->'filters') = t->'filters'
                      FROM (SELECT public.totals_a('{"wallet":" Cashout "}') t) s),'totals: the document carries scope, range and the normalized filters');
SELECT assert_true(bool_and(public.totals_match(f)),'totals: the owner door equals the sum of every page, for every filter')
  FROM unnest(ARRAY['{}','{"wallet":"table"}','{"wallet":"player"}','{"direction":"out"}','{"state":"pending"}','{"state":"posted"}','{"operation":"player_funding"}',
                    '{"counterparty":"TwentyTwo"}','{"counterparty":"table five"}','{"counterparty":"00000000-0000-0000-0000-000000000022"}',
                    '{"reference":"op-r1"}','{"reference":"no-such-reference"}']::jsonb[]) f;
SELECT assert_true((SELECT (public.totals_a('{"counterparty":"TwentyTwo"}')->'totals'->>'count')::int = 6 AND (public.totals_a('{"reference":"no-such-reference"}')->'totals') = '{"in":"0.00","out":"0.00","managed":"0.00","count":0}'::jsonb),'totals: a label search and an empty match');
SELECT public.as_user(20);
SELECT assert_true(bool_and(public.totals_match(f)),'totals: the player (self) door equals the sum of every page, for every filter')
  FROM unnest(ARRAY['{}','{"wallet":"player","direction":"in"}','{"direction":"out"}','{"counterparty":"Display 10"}','{"counterparty":"table five"}']::jsonb[]) f;
SELECT public.as_user(10);
SELECT assert_true(bool_and(public.totals_match(f)) AND (public.totals_a()->'totals'->>'count')::int = 67,'totals: the agent (downline) door equals the sum of every page (67 entries)')
  FROM unnest(ARRAY['{}','{"direction":"managed"}','{"wallet":"agent"}','{"counterparty":"Player Twenty"}']::jsonb[]) f;
SELECT public.as_user(12);
SELECT assert_true(public.totals_match('{}') AND (public.totals_a()->'totals'->>'count')::int = 6,'totals: a cyclic downline counts each entry once');
SELECT public.as_user(1);

-- ===========================================================================
-- 5. Filters.
-- ===========================================================================
SELECT public.as_user(1);
SELECT assert_true(public.ids_a('{"wallet":"cashout"}') = public.ids(1003,1004,1005,1020,1021),'wallet cashout: the cashout receipts (the mirrored cashout movement is not a second entry)');
SELECT assert_true(public.ids_a('{"wallet":"ticket"}') = public.ids(1008),'wallet ticket: the ticket receipt only');
SELECT assert_true(public.ids_a('{"wallet":"bank"}') = public.ids(1006,1007,2012),'wallet bank');
SELECT assert_true(public.ids_a('{"wallet":"table"}') = public.ids(1018,1019,2001,2005,2026),'wallet table');
SELECT assert_true(public.ids_a('{"wallet":"promo"}') = public.ids(1010),'wallet promo');
SELECT assert_true(public.ids_a('{"wallet":"agent"}') = public.ids(1001,1002,1009,1011,1013,1014),'wallet agent');
SELECT assert_true(cardinality(public.ids_a('{"wallet":"player"}')) = 53 AND public.ids_a('{"wallet":"union"}') = '{}' AND public.ids_a('{"wallet":"other"}') = '{}','wallet player, union and other');
SELECT assert_true(cardinality(public.ids_a('{"wallet":"any"}')) = 74,'wallet any is no filter');
SELECT assert_true(public.ids_a('{"direction":"out"}') = public.ids(1006,1007,1010) AND public.ids_a('{"direction":"in"}') = '{}' AND cardinality(public.ids_a('{"direction":"managed"}')) = 71,'owner direction is viewer-relative');
SELECT assert_true(public.ids_a('{"state":"pending"}') = public.ids(1003,1021),'state pending is an escrow with no terminal receipt up to p_to + 1 day');
SELECT assert_true(public.ids_a('{"state":"reversed"}') = public.ids(1002),'state reversed');
SELECT assert_true(public.ids_a('{"state":"clawed_back"}') = public.ids(1006),'state clawed_back');
SELECT assert_true(public.ids_a('{"state":"reversible"}') = public.ids(1001),'state reversible');
SELECT assert_true(cardinality(public.ids_a('{"state":"posted"}')) = 69,'state posted is everything else');
SELECT assert_true(public.ids_a('{"operation":"agent_wallet_send"}') = public.ids(1001,1009,1011,1013,1014),'operation matches the transaction type exactly');
SELECT assert_true(cardinality(public.ids_a('{"operation":"player_funding"}')) = 24 AND public.ids_a('{"operation":"rake"}') = '{}','operation matches a movement category exactly');
SELECT assert_true(public.ids_a('{"counterparty":"00000000-0000-0000-0000-000000000022"}') = public.ids(1006,1010,1012,1016,1020,2009),'counterparty by id matches either side');
SELECT assert_true(public.ids_a('{"counterparty":"TwentyTwo"}') = public.ids(1006,1010,1012,1016,1020,2009),'counterparty text matches a profile alias, case-insensitively');
SELECT assert_true(public.ids_a('{"counterparty":"user_12"}') = public.ids(1012),'counterparty text matches a username');
SELECT assert_true(public.ids_a('{"counterparty":"table five"}') = public.ids(2001),'counterparty text matches a ledger label');
SELECT assert_true(public.ids_a('{"counterparty":"%%"}') = '{}' AND public.ids_a('{"counterparty":"__"}') = '{}','LIKE wildcards in counterparty text are literal');
SELECT public.as_user(20);
SELECT assert_true(cardinality(public.ids_a('{"direction":"in"}')) = 28 AND cardinality(public.ids_a('{"direction":"out"}')) = 28 AND public.ids_a('{"direction":"managed"}') = '{}','player in/out split');
SELECT public.as_user(10);
SELECT assert_true(public.ids_a('{"direction":"managed"}') @> public.ids(1011),'moving chips between two of the viewer''s own wallets is managed');

-- ===========================================================================
-- 6. Exact reference: every reference field, other filters still apply.
-- ===========================================================================
SELECT public.as_user(1);
SELECT assert_true(public.ids_a(jsonb_build_object('reference', public.u(1001)::text)) = public.ids(1001),'reference matches the source row id');
SELECT assert_true(public.ids_a(jsonb_build_object('reference', upper(public.u(1001)::text))) = public.ids(1001),'a reference id in capitals still matches');
SELECT assert_true(public.ids_a('{"reference":"op-r1"}') = public.ids(1001),'reference matches op_id');
SELECT assert_true(public.ids_a('{"reference":"op-m13"}') = public.ids(2013),'reference matches a movement op_id');
SELECT assert_true(public.ids_a('{"reference":"idem-r1"}') = public.ids(1001),'reference matches a receipt idempotency_key');
SELECT assert_true(public.ids_a('{"reference":"cl-2001"}') = public.ids(2001),'reference matches a movement idempotency_key');
SELECT assert_true(public.ids_a(jsonb_build_object('reference', public.u(5005)::text)) = public.ids(2005),'reference matches correlation_id');
SELECT assert_true(public.ids_a(jsonb_build_object('reference', public.u(2999)::text)) = public.ids(1009),'reference matches a receipt''s recorded ledger_id (metadata.chip_ledger_id)');
SELECT assert_true(public.ids_a(jsonb_build_object('reference', public.u(3002)::text)) = public.ids(1004,1005),'reference matches cashout_id on receipts');
SELECT assert_true(public.ids_a(jsonb_build_object('reference', public.u(3003)::text)) = public.ids(2013),'reference matches cashout_id on movements');
SELECT assert_true(public.ids_a(jsonb_build_object('reference', public.u(4001)::text)) = public.ids(1008),'reference matches ticket_id; the mirrored ticket_issue movement is not a second hit');
SELECT assert_true(public.ids_a('{"reference":"op-r1","direction":"in"}') = '{}','other filters still apply to a reference lookup');
SELECT assert_true(public.ids_a('{"reference":"no-such-reference"}') = '{}','an unknown reference matches nothing');
SELECT public.as_user(20);
SELECT assert_true(public.ids_a('{"reference":"op-r1","direction":"in"}') = public.ids(1001),'reference plus direction for the receiving player');
SELECT assert_true(public.ids_a('{"reference":"op-r6"}') = '{}','a reference outside the viewer scope matches nothing');
SELECT public.as_user(1);
SELECT assert_true((SELECT e->'reference' = jsonb_build_object('id',public.u(1001),'source','receipt','op_id','op-r1','idempotency_key','idem-r1','correlation_id',NULL,'ledger_id',NULL,'cashout_id',NULL,'ticket_id',NULL)
                      FROM jsonb_array_elements(public.page_a('{"reference":"op-r1"}')->'rows') e),'the reference object carries every field, null when absent');

-- ===========================================================================
-- 7. Receipt / movement unification and the entry shape.
-- ===========================================================================
SELECT assert_true(NOT (public.ids_a('{}') && public.ids(2006,2007,2020)),'a movement a receipt names by idempotency_key (2007, 2020) or restore_key (2006) appears only as the receipt');
SELECT assert_true(public.ids_a('{}') @> public.ids(1010,1018),'the representing receipts are present');
SELECT assert_true(public.ids_a('{"reference":"op-r18"}') = public.ids(1018) AND public.ids_a('{"operation":"refund"}') = public.ids(2025),'restore_key: the seat_credit_restored receipt stands for its refund; an unreceipted refund is a movement');
SELECT assert_true(NOT (public.ids_a('{}') && public.ids(2002,2010,2011,2014,2022,2024)) AND public.ids_a('{}') @> public.ids(1008,1019),'categories a receipt family mirrors never appear as movements (table_cashout, ticket_issue, mint, cashout, tournament_buyin, rakeback)');
SELECT assert_true(public.ids_a('{"operation":"ticket_issue"}') = '{}' AND public.ids_a('{"operation":"tournament_buyin"}') = public.ids(1019) AND public.ids_a('{"operation":"rakeback"}') = '{}','the ticket_issue movement (linked only by ticket_id) is excluded; tournament_buyin is the receipt alone');
SELECT assert_true(NOT (public.ids_a('{}') && public.ids(2003,2004,2021)),'rake, horse_funding and bbj_payout movements are excluded categories');
SELECT assert_true(NOT (public.ids_a('{}') && public.ids(2008)),'an unposted movement is not a balance movement');
SELECT assert_true(NOT (public.ids_a('{}') && public.ids(1015,1017,1022,2015)),'entries outside the range are excluded');
SELECT assert_true((SELECT count(*) = 1 FROM jsonb_array_elements(public.page_a('{}',NULL,200,'2026-09-29T00:00:00Z','2026-10-01T00:00:00Z')->'rows') e
                     WHERE e->>'id' IN (public.u(1017)::text, public.u(2020)::text)),'across the range boundary the represented movement still appears exactly once, as its receipt');
SELECT assert_true((SELECT e = jsonb_build_object(
    'source','receipt','id',public.u(1001),'at','2026-09-10T12:00:00.000000Z','kind','agent_wallet_send','wallet','agent',
    'direction','managed','amount','100.00',
    'from',jsonb_build_object('type','user','id',public.u(10),'label','Display 10'),
    'to',jsonb_build_object('type','user','id',public.u(20),'label','Player Twenty'),
    'counterparty',NULL,'notes','Weekly top up','state','reversible',
    'reference',jsonb_build_object('id',public.u(1001),'source','receipt','op_id','op-r1','idempotency_key','idem-r1','correlation_id',NULL,'ledger_id',NULL,'cashout_id',NULL,'ticket_id',NULL),
    'balance_after',NULL,'table_id',NULL,'tournament_id',NULL,'hand_id',NULL)
  FROM jsonb_array_elements(public.page_a('{"reference":"op-r1"}')->'rows') e),'a receipt entry has the exact contract shape');
SELECT public.as_user(20);
SELECT assert_true((SELECT e->>'direction'='out' AND e->>'balance_after'='450.00' AND e->>'counterparty'='Table Five' AND e->'to'->>'type'='table_stack' AND e->>'table_id'=public.u(500)::text
                      FROM jsonb_array_elements(public.page_a('{"reference":"cl-2001"}')->'rows') e),'a movement paid by the viewer: out, the viewer side balance, the other side label');
SELECT assert_true((SELECT e->>'direction'='in' AND e->>'balance_after'='525.00' AND e->>'hand_id'=public.u(502)::text AND e->>'tournament_id'=public.u(600)::text AND e->>'amount'='5.00' AND e->>'counterparty'='Sunday Major'
                      FROM jsonb_array_elements(public.page_a('{"reference":"cl-2026"}')->'rows') e),'a movement received by the viewer: in, post_to_balance');
SELECT assert_true((SELECT e->'balance_after' = 'null'::jsonb AND e->>'direction'='in' FROM jsonb_array_elements(public.page_a('{"reference":"op-r1"}')->'rows') e),'a receipt never prints balance_after, even the receiving player''s (the source row holds the writer''s 600.00)');
SELECT assert_true((SELECT e->>'counterparty'='Display 10' FROM jsonb_array_elements(public.page_a('{"reference":"op-r1"}')->'rows') e),'the counterparty of a received receipt is the payer');
SELECT public.as_user(1);
SELECT assert_true((SELECT e->>'balance_after' IS NULL AND e->>'direction'='managed' FROM jsonb_array_elements(public.page_a('{"reference":"cl-2001"}')->'rows') e),'a staff view never borrows a player''s ledger balance');
SELECT assert_true((SELECT bool_and(e->>'amount' ~ '^[0-9]+\.[0-9]{2}$') FROM jsonb_array_elements(public.page_a()->'rows') e),'every amount is a positive 2dp string');

-- S1: balance_after. A receipt's balance_after is the writer's balance, so
-- no receipt prints one; a movement prints the viewer's own side only.
SELECT assert_true((SELECT count(*) = 43 + 30 AND bool_and(entry->'balance_after' = 'null'::jsonb)
                      FROM (SELECT entry FROM walk_owner UNION ALL SELECT entry FROM walk_player) s WHERE entry->>'source' = 'receipt'),'no receipt row ever carries balance_after (owner and player walks)');
SELECT assert_true((SELECT count(*) = 31 AND bool_and(entry->'balance_after' = 'null'::jsonb) FROM walk_owner WHERE entry->>'source' = 'movement'),'a staff view of movements carries no balance_after (the owner is never a side)');
RESET ROLE;
SELECT assert_true((SELECT count(*) = 26 AND count(w.entry->>'balance_after') = 26
                           AND bool_and((w.entry->>'balance_after') IS NOT DISTINCT FROM to_char(
                                 CASE WHEN cl.to_entity_id = public.u(20) THEN cl.post_to_balance
                                      WHEN cl.from_entity_id = public.u(20) THEN cl.post_from_balance END, 'FM999999999990.00'))
                      FROM walk_player w JOIN public.chip_ledger cl ON cl.id = (w.entry->>'id')::uuid
                     WHERE w.entry->>'source' = 'movement'),'a movement carries balance_after only for the viewer''s own side, and it is that side''s post balance');
SET ROLE authenticated;
SELECT public.as_user(1);

-- P4: the escrow state lookup is bounded to [escrow, p_to + 1 day] and runs
-- for escrow rows with a related_cashout_id only.
SELECT assert_true((SELECT e->>'state' = 'posted' FROM jsonb_array_elements(public.page_a('{"reference":"op-r20"}')->'rows') e),'an escrow with no related_cashout_id is posted, never pending forever');
SELECT assert_true((SELECT e->>'state' = 'posted' FROM jsonb_array_elements(public.page_a('{"reference":"op-r21"}',NULL,200,'2026-09-15T00:00:00Z','2026-10-10T00:00:00Z')->'rows') e),'an escrow whose approval falls inside the range is posted');
SELECT assert_true((SELECT e->>'state' = 'posted' FROM jsonb_array_elements(public.page_a('{"reference":"op-r21"}',NULL,200,'2026-09-02T00:00:00Z','2026-10-01T13:00:00Z')->'rows') e)
                   AND (SELECT e->>'state' = 'pending' FROM jsonb_array_elements(public.page_a('{"reference":"op-r21"}',NULL,200,'2026-09-02T00:00:00Z','2026-10-01T11:00:00Z')->'rows') e),'the terminal lookup reaches exactly p_to + 1 day');
SELECT assert_true(pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure)
                     ~ 'terminal\.created_at BETWEEN ct\.created_at AND \$4 \+ interval ''1 day''','the terminal lookup is bounded by the statement range in the function text');

-- P3: a cursor page bounds both scans by the cursor instant (plan proof in
-- plan.sql); ties at the cursor instant are still continued (section 3).
SELECT assert_true(pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure) ~ 'v_receipt_keyset := '' AND ct\.created_at <= \$6'
                   AND pg_get_functiondef('public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure) ~ 'v_movement_keyset := '' AND cl\.created_at <= \$6','a cursor adds created_at <= cursor.at to both sources');

-- C3: amounts at 1e13 and totals above it never print '#'.
SELECT public.as_user(5);
CREATE TEMP TABLE big_page AS
SELECT public.fn_cashier_statement_page(public.u(400),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL,200) AS p;
SELECT assert_true((SELECT array_agg(e->>'amount' ORDER BY e->>'at') = ARRAY['9999999999999.99','9999999999999.99','999999999999.99'] FROM big_page, jsonb_array_elements(p->'rows') e),'amounts at the numeric(15,2) ceiling print in full');
CREATE TEMP TABLE big_totals AS
SELECT public.fn_cashier_statement_totals(public.u(400),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb) AS t;
SELECT assert_true((SELECT t->'totals' = '{"in":"0.00","out":"999999999999.99","managed":"19999999999999.98","count":3}'::jsonb AND t::text !~ '#' FROM big_totals) AND (SELECT p::text !~ '#' FROM big_page),'a total above 1e13 prints in full (never #)');
SELECT assert_true((SELECT j->'totals' = (SELECT t->'totals' FROM big_totals) FROM (SELECT public.fn_cashier_statement_export_start(public.u(400),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL) j) s),'the export totals print the same 1e13 figures');
SELECT public.as_user(1);

-- ===========================================================================
-- 8. A horse is never named.
-- ===========================================================================
SELECT public.as_user(1);
SELECT assert_true((SELECT string_agg(entry::text, ' ') !~* 'horse' FROM walk_owner),'no owner entry carries a horse marker');
SELECT assert_true((SELECT e->>'kind'='treasury_funding' AND e->>'notes' IS NULL AND e->'reference'->>'idempotency_key' IS NULL AND e->'reference'->>'op_id' IS NULL
                      FROM jsonb_array_elements(public.page_a(jsonb_build_object('reference', public.u(1007)::text))->'rows') e),'horse funding reads as treasury funding with its marked note and keys withheld');
SELECT assert_true((SELECT e->'to'->>'label' IS NULL AND e->>'notes' IS NULL FROM jsonb_array_elements(public.page_a('{"reference":"cl-2012"}')->'rows') e),'a ledger label or note naming a horse is withheld');
SELECT assert_true(public.ids_a('{"counterparty":"horse"}') = '{}' AND public.ids_a('{"operation":"horse_treasury_funding"}') = '{}' AND public.ids_a('{"reference":"horse-funding:u25"}') = '{}' AND public.ids_a('{"reference":"horse-op-1"}') = '{}','no filter can find a withheld horse marker');
SELECT assert_true(public.ids_a('{"operation":"treasury_funding"}') = public.ids(1007),'the printed kind is the one that filters');
SELECT assert_true(public.page_a()::text !~* 'horse' AND public.fn_cashier_statement_scope(public.u(100))::text !~* 'horse','no page or scope document carries a horse marker');
SELECT public.as_user(10);
SELECT assert_true((SELECT string_agg(entry::text, ' ') !~* 'horse' FROM public.walk_a('{}', 50)),'no agent entry carries a horse marker');

-- ===========================================================================
-- 9. Export: start, page, idempotency, one per user, cancel.
-- ===========================================================================
SELECT public.as_user(1);
CREATE TEMP TABLE export_a AS
SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,public.u(9001)) AS j;
SELECT assert_true((SELECT (j->>'total_rows')::int = 74 AND j->'totals' = (SELECT public.totals_a('{}')->'totals') AND length(j->>'metadata_fingerprint') = 32 AND (j->>'expires_at')::timestamptz > now() + interval '14 minutes' FROM export_a),'export start materializes the whole statement with the on-screen totals');
CREATE TEMP TABLE export_a_pages AS
SELECT n, public.fn_cashier_statement_export_page((SELECT (j->>'export_id')::uuid FROM export_a), n * 30, 30) AS p FROM generate_series(0,2) n;
SELECT assert_true((SELECT (SELECT array_agg(e ORDER BY n, o) FROM export_a_pages, jsonb_array_elements(p->'rows') WITH ORDINALITY x(e,o))
                         = (SELECT array_agg(entry ORDER BY ord) FROM walk_owner)),'the export rows are exactly the on-screen entries, in order');
SELECT assert_true((SELECT bool_and((p->>'has_more')::boolean = (n < 2)) AND max((p->>'next_offset')::int) = 74 FROM export_a_pages),'export paging reports next_offset and has_more');
SELECT assert_true((SELECT (SELECT public.fn_cashier_statement_export_page((j->>'export_id')::uuid, -5, 30)) = (SELECT p FROM export_a_pages WHERE n = 0) FROM export_a),'a negative export offset is clamped to 0');
SELECT assert_true((SELECT p->'rows' = '[]'::jsonb AND (p->>'next_offset')::int = 74 AND NOT (p->>'has_more')::boolean
                      FROM (SELECT public.fn_cashier_statement_export_page((j->>'export_id')::uuid, 1000, 30) p FROM export_a) s),'an export offset past the file is clamped to total_rows');
SELECT assert_true((SELECT p->'rows' = '[]'::jsonb AND (p->>'next_offset')::int = 74 AND NOT (p->>'has_more')::boolean
                      FROM (SELECT public.fn_cashier_statement_export_page((j->>'export_id')::uuid, 2147483647, 2147483647) p FROM export_a) s),'the largest integer offset and limit do not overflow (bigint arithmetic)');
SELECT assert_true((SELECT p->'metadata'->>'kind' = 'cashier_statement' AND p->'metadata'->>'scope' = 'all' AND (p->'metadata'->>'total_rows')::int = 74
                       AND p->'metadata'->>'club_id' = public.u(100)::text AND p->'metadata'->>'from' = '2026-09-01T00:00:00.000000Z'
                       AND p->>'metadata_fingerprint' = md5((p->'metadata')::text) FROM export_a_pages WHERE n = 0),'export metadata describes the request and matches its fingerprint');
SELECT assert_true((SELECT string_agg(p::text, ' ') !~* 'horse' FROM export_a_pages),'no export page carries a horse marker');
SELECT assert_true((SELECT (public.fn_cashier_statement_export_start(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,public.u(9001))->>'export_id') = j->>'export_id' FROM export_a),'a repeated request id returns the same job');
SELECT assert_true(refusal($$SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{"wallet":"bank"}'::jsonb,public.u(9001))$$) = '22023 statement export request id was already used for different inputs','a request id cannot be replayed with other inputs');
SELECT assert_true(refuses($$SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-06-01Z','2026-09-30Z','{}'::jsonb,NULL)$$,'22023'),'export start applies the 92-day rule');
CREATE TEMP TABLE export_b AS
SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{"wallet":"bank"}'::jsonb,public.u(9002)) AS j;
SELECT assert_true((SELECT (j->>'total_rows')::int = 3 AND j->>'export_id' <> (SELECT j->>'export_id' FROM export_a) FROM export_b),'a new request prepares a new job');
SELECT assert_true(refusal(format('SELECT public.fn_cashier_statement_export_page(%L)', (SELECT j->>'export_id' FROM export_a))) = '55000 export is unavailable','starting a second export retires the first (one job per user)');
SELECT public.as_user(2);
SELECT assert_true(refusal(format('SELECT public.fn_cashier_statement_export_page(%L)', (SELECT j->>'export_id' FROM export_b))) = '55000 export is unavailable','another user cannot read the job');
SELECT assert_true(NOT public.fn_cashier_statement_export_cancel((SELECT (j->>'export_id')::uuid FROM export_b)),'another user cannot cancel the job');
SELECT public.as_user(1);
SELECT assert_true((SELECT jsonb_array_length(public.fn_cashier_statement_export_page((j->>'export_id')::uuid, 0, 1000)->'rows') = 3 FROM export_b),'the owner still reads the job');
SELECT assert_true(public.fn_cashier_statement_export_cancel((SELECT (j->>'export_id')::uuid FROM export_b)),'the owner cancels the job');
SELECT assert_true(NOT public.fn_cashier_statement_export_cancel((SELECT (j->>'export_id')::uuid FROM export_b)),'a cancelled job is gone');
SELECT public.as_user(30);
SELECT assert_true(refusal($$SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-09-01Z','2026-09-30Z','{}'::jsonb,NULL)$$) = '42501 not authorized to export this statement','a non-member cannot export');
SELECT public.as_user(23);
SELECT assert_true(refuses($$SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-09-01Z','2026-09-30Z','{}'::jsonb,NULL)$$,'42501'),'a suspended member cannot export');
SELECT public.as_user(NULL);
SELECT assert_true(refuses($$SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-09-01Z','2026-09-30Z','{}'::jsonb,NULL)$$,'42501'),'no session cannot export');
SELECT assert_true(refuses($$SELECT public.fn_cashier_statement_export_page(gen_random_uuid())$$,'42501') AND NOT public.fn_cashier_statement_export_cancel(gen_random_uuid()),'no session cannot read or cancel');

-- Expiry: an expired job refuses, and the next start or cancel retires it.
SELECT public.as_user(20);
CREATE TEMP TABLE export_c AS
SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL) AS j;
SELECT assert_true((SELECT (j->>'total_rows')::int = 56 FROM export_c),'a player export holds the player statement');
RESET ROLE;
UPDATE public.ca_cashier_statement_exports SET expires_at = now() - interval '1 minute' WHERE id = (SELECT (j->>'export_id')::uuid FROM export_c);
SET ROLE authenticated;
SELECT assert_true(refusal(format('SELECT public.fn_cashier_statement_export_page(%L)', (SELECT j->>'export_id' FROM export_c))) = '55000 export expired; prepare a new export','an expired job is refused 55000');
SELECT public.as_user(2);
SELECT assert_true(NOT public.fn_cashier_statement_export_cancel(gen_random_uuid()),'an unrelated cancel returns false');
RESET ROLE;
SELECT assert_true(NOT EXISTS (SELECT 1 FROM public.ca_cashier_statement_exports WHERE id = (SELECT (j->>'export_id')::uuid FROM export_c))
                   AND NOT EXISTS (SELECT 1 FROM public.ca_cashier_statement_export_rows WHERE export_id = (SELECT (j->>'export_id')::uuid FROM export_c)),'anyone''s next door retires an expired job and its rows');
SET ROLE authenticated;

-- Scope change between start and page voids the whole file.
SELECT public.as_user(10);
CREATE TEMP TABLE export_d AS
SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL) AS j;
SELECT assert_true((SELECT (j->>'total_rows')::int = 67 AND jsonb_array_length(public.fn_cashier_statement_export_page((j->>'export_id')::uuid,0,10)->'rows') = 10 FROM export_d),'an agent export pages while the scope holds');
RESET ROLE;
UPDATE public.club_members SET role = 'member' WHERE club_id = public.u(100) AND user_id = public.u(10);
SET ROLE authenticated;
SELECT assert_true(refusal(format('SELECT public.fn_cashier_statement_export_page(%L,10,10)', (SELECT j->>'export_id' FROM export_d))) = '42501 export is no longer authorized','a role downgrade between pages refuses the file 42501');
SELECT assert_true(refusal(format('SELECT public.fn_cashier_statement_export_page(%L,0,10)', (SELECT j->>'export_id' FROM export_d))) = '42501 export is no longer authorized','page one of the same file is refused too');
RESET ROLE;
SELECT assert_true(EXISTS (SELECT 1 FROM public.ca_cashier_statement_exports WHERE id = (SELECT (j->>'export_id')::uuid FROM export_d))
                   AND (SELECT provolatile = 's' FROM pg_proc WHERE oid = 'public.fn_cashier_statement_export_page(uuid,integer,integer)'::regprocedure),'the refusing page door is STABLE and deletes nothing');
SET ROLE authenticated;
SELECT assert_true(public.fn_cashier_statement_export_cancel((SELECT (j->>'export_id')::uuid FROM export_d)),'the refused job is retired by the owner''s cancel');
RESET ROLE;
SELECT assert_true(NOT EXISTS (SELECT 1 FROM public.ca_cashier_statement_exports WHERE user_id = public.u(10)),'the voided job is gone');
UPDATE public.club_members SET role = 'agent' WHERE club_id = public.u(100) AND user_id = public.u(10);
SET ROLE authenticated;
CREATE TEMP TABLE export_e AS
SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL) AS j;
RESET ROLE;
UPDATE public.club_members SET agent_id = NULL WHERE club_id = public.u(100) AND user_id = public.u(21);
SET ROLE authenticated;
SELECT assert_true(refuses(format('SELECT public.fn_cashier_statement_export_page(%L)', (SELECT j->>'export_id' FROM export_e)),'42501'),'a downline change (member reassigned away) refuses the file 42501');
CREATE TEMP TABLE export_f AS
SELECT public.fn_cashier_statement_export_start(public.u(100),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL) AS j;
RESET ROLE;
SELECT assert_true((SELECT count(*) = 1 FROM public.ca_cashier_statement_exports WHERE user_id = public.u(10))
                   AND NOT EXISTS (SELECT 1 FROM public.ca_cashier_statement_exports WHERE id = (SELECT (j->>'export_id')::uuid FROM export_e)),'the next start retires the voided job');
UPDATE public.club_members SET agent_id = public.u(11) WHERE club_id = public.u(100) AND user_id = public.u(21);

-- The 20,000-entry ceiling.
INSERT INTO public.chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,created_at)
SELECT public.u(300),public.u(3),NULL,1,'mint','2026-09-10T00:00:00Z'::timestamptz + n * interval '1 second' FROM generate_series(1,20001) n;
SET ROLE authenticated;
SELECT public.as_user(3);
SELECT assert_true(refusal($$SELECT public.fn_cashier_statement_export_start(public.u(300),'2026-09-01Z','2026-09-30Z','{}'::jsonb,NULL)$$) = '55000 narrow the range; the export is limited to 20,000 entries','20,001 entries are refused 55000');
RESET ROLE;
SELECT assert_true(NOT EXISTS (SELECT 1 FROM public.ca_cashier_statement_exports WHERE user_id = public.u(3)),'nothing persists from a refused export');
DELETE FROM public.chip_transactions WHERE club_id = public.u(300) AND created_at = '2026-09-10T00:00:00Z'::timestamptz + interval '20001 seconds';
SET ROLE authenticated;
CREATE TEMP TABLE export_g AS
SELECT public.fn_cashier_statement_export_start(public.u(300),'2026-09-01T00:00:00Z','2026-09-30T00:00:00Z','{}'::jsonb,NULL) AS j;
SELECT assert_true((SELECT (j->>'total_rows')::int = 20000 AND j->'totals'->>'managed' = '0.00' AND j->'totals'->>'out' = '20000.00' FROM export_g),'exactly 20,000 entries export');
SELECT assert_true((SELECT jsonb_array_length(p->'rows') = 2000 AND (p->>'next_offset')::int = 20000 AND NOT (p->>'has_more')::boolean
                      FROM (SELECT public.fn_cashier_statement_export_page((j->>'export_id')::uuid, 18000, 5000) p FROM export_g) s),'the last export page is capped at 2,000 rows and closes the file');

-- ===========================================================================
-- 10. Privileges, RLS and definer posture.
-- ===========================================================================
RESET ROLE;
SELECT assert_true(bool_and(NOT has_function_privilege('anon', f, 'EXECUTE')) AND bool_and(has_function_privilege('authenticated', f, 'EXECUTE')) AND bool_and(has_function_privilege('service_role', f, 'EXECUTE')),'the six doors: anon no, authenticated and service_role yes')
  FROM unnest(ARRAY['public.fn_cashier_statement_scope(uuid)','public.fn_cashier_statement_page(uuid,timestamptz,timestamptz,jsonb,jsonb,integer)','public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)','public.fn_cashier_statement_export_start(uuid,timestamptz,timestamptz,jsonb,uuid)','public.fn_cashier_statement_export_page(uuid,integer,integer)','public.fn_cashier_statement_export_cancel(uuid)']::regprocedure[]) f;
SELECT assert_true(NOT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                WHERE p.proname LIKE 'fn\_cashier\_statement\_%' AND a.privilege_type = 'EXECUTE' AND a.grantee = 0),'PUBLIC executes none of the statement functions');
SELECT assert_true(bool_and(NOT has_function_privilege(r, f, 'EXECUTE')),'the private helpers are owner-only')
  FROM unnest(ARRAY['public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)','public.fn_cashier_statement_downline(uuid,uuid)','public.fn_cashier_statement_filters(timestamptz,timestamptz,jsonb)','public.fn_cashier_statement_prune_expired()']::regprocedure[]) f,
       unnest(ARRAY['anon','authenticated','service_role']) r;
SELECT assert_true(count(*) = 10 AND bool_and(p.proconfig @> ARRAY['search_path=public, pg_temp']) AND bool_and(p.prosecdef = (p.proname NOT IN ('fn_cashier_statement_downline','fn_cashier_statement_filters','fn_cashier_statement_prune_expired'))),'every statement function pins search_path; the doors and the row query are SECURITY DEFINER')
  FROM pg_proc p WHERE p.proname LIKE 'fn\_cashier\_statement\_%';
SELECT assert_true(NOT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL unnest(p.proconfig) cfg WHERE p.proname LIKE 'fn\_cashier\_statement\_%' AND cfg LIKE 'statement\_timeout=%')
               AND (SELECT provolatile = 's' FROM pg_proc WHERE oid = 'public.fn_cashier_statement_page(uuid,timestamptz,timestamptz,jsonb,jsonb,integer)'::regprocedure)
               AND (SELECT provolatile = 's' FROM pg_proc WHERE oid = 'public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)'::regprocedure),'no statement function sets a function-level statement_timeout (it never takes effect); the page and totals doors are STABLE');
SELECT assert_true(bool_and(c.relrowsecurity) AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid IN ('public.ca_cashier_statement_exports'::regclass,'public.ca_cashier_statement_export_rows'::regclass)),'both job tables have RLS on and zero policies')
  FROM pg_class c WHERE c.oid IN ('public.ca_cashier_statement_exports'::regclass,'public.ca_cashier_statement_export_rows'::regclass);
SELECT assert_true(bool_and(NOT has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),'anon and authenticated hold no privilege on either job table')
  FROM unnest(ARRAY['public.ca_cashier_statement_exports','public.ca_cashier_statement_export_rows']) t, unnest(ARRAY['anon','authenticated']) r;
SET ROLE authenticated;
SELECT public.as_user(1);
SELECT assert_true(refuses($$SELECT * FROM public.fn_cashier_statement_rows(public.u(100),public.u(20),'all','2026-09-01Z','2026-09-30Z','{}'::jsonb,NULL,NULL,NULL,10)$$,'42501'),'a browser cannot call the row query with a forged viewer or scope');
SELECT assert_true(refuses($$SELECT * FROM public.ca_cashier_statement_exports$$,'42501') AND refuses($$SELECT * FROM public.ca_cashier_statement_export_rows$$,'42501'),'a browser cannot read the job tables');
SET ROLE anon;
SELECT assert_true(refuses($$SELECT public.fn_cashier_statement_scope(public.u(100))$$,'42501') AND refuses($$SELECT public.page_a()$$,'42501') AND refuses($$SELECT public.totals_a()$$,'42501'),'anon cannot execute the doors');
RESET ROLE;
