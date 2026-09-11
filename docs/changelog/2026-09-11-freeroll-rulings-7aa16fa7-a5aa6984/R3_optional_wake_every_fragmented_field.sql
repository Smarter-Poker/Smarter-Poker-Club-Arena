-- OPTIONAL R3 - wake every RUNNING event whose field is spread one player per
-- table (57 at 12:10 UTC 2026-09-11, 7aa16fa7 among them). Same mechanism as
-- R2, one durable 'rebuy' wake per event, nothing else written. Until the
-- engine fix on branch fix/freeze-deferred-balance-redrive ships, a field in
-- this shape has nothing that will ever run its balancer again: no hand can be
-- dealt, so no bust can wake the manager. Apply OUTSIDE :50-:03 UTC so the
-- woken sweeps do not land in the :53-:00 freeze and skip the balance again.
-- Wakes only the listed events that are STILL in the shape at apply time and
-- reports how many; refuses if none are.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $window$
BEGIN
  IF extract(minute FROM clock_timestamp() AT TIME ZONE 'UTC') >= 50
     OR extract(minute FROM clock_timestamp() AT TIME ZONE 'UTC') < 3 THEN
    RAISE EXCEPTION 'R3 refuses to run inside the :50-:03 UTC break window';
  END IF;
END $window$;

DO $wake$
DECLARE
  v_listed uuid[] := ARRAY['01f1a800-e32b-4f79-b907-8505d87e8646'::uuid,'19402dec-1a13-4854-ac5d-e06859a6ee4e'::uuid,'1ddfeba4-5e50-4880-994b-b0a5c8bb5824'::uuid,'1e361036-5757-4184-81b2-95c4314a3f92'::uuid,'22dfe2e4-086f-4845-a5c0-c86c2889f973'::uuid,'27f8f241-c013-4ec3-ac36-3014fb313d8a'::uuid,'28c46112-5645-4138-8aa4-ce26ba4de79e'::uuid,'2960a276-46db-4487-8a99-6ed82137f603'::uuid,'2dbc9bb6-fd3f-4a92-9589-f9f1bf0a879c'::uuid,'313a274b-0cc8-4b90-bada-f4a4e7deae6a'::uuid,'33883f12-0840-43c7-a3c2-18a3f8e9fe84'::uuid,'4065ef36-7f08-405a-85e7-2045cad04b5c'::uuid,'456963df-1be3-4a71-8540-3d1463d6fd32'::uuid,'4f52c049-9d33-4065-971a-cff9d6c6004a'::uuid,'57a417c5-312a-40dc-a093-ea30176e2f5c'::uuid,'5964d09d-a31a-4e94-a80b-80820bc0b002'::uuid,'5a5c5e27-e705-4844-b1c1-31302f55ec31'::uuid,'5bd4927b-673b-47af-b87f-3b17d97e8052'::uuid,'5d555bb1-d86d-42a3-b93a-14e27c0e5299'::uuid,'5e1f17e4-8801-4b7d-9d75-6ae3917c9301'::uuid,'645f6cc7-fe07-443e-8ea2-5c13c7d04017'::uuid,'69076c4b-d417-49ed-a4eb-cf87358fc8ae'::uuid,'6f4e96d7-4e5a-4670-bb85-2ad4cfb4ca64'::uuid,'72989413-a18c-4db5-8c84-6f1409dd4bd9'::uuid,'75eead55-020e-4e3c-a231-e725ad19737a'::uuid,'78617cab-31a5-4a7b-976d-a0c81b25c8cd'::uuid,'7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d'::uuid,'7d6f3d3b-e4bf-40a7-9d15-7a82e63d00ee'::uuid,'7f521f47-c943-4f4d-a802-488d4776d2e9'::uuid,'86bc3818-b881-4c5d-9f6a-c25e39c46500'::uuid,'8a99264d-c307-4c38-af48-3f8a7b9b5917'::uuid,'8cc23002-adfc-4a90-a3b1-e8514085034b'::uuid,'8e16cdb4-d763-47d5-8545-fdc1c151d364'::uuid,'98d82974-381f-4fc9-86d7-44005c2de25c'::uuid,'a8556857-8404-477c-8595-6301f25074a2'::uuid,'abff41cd-dfee-4d72-82aa-8994b94f1075'::uuid,'ac0f62ca-666e-490e-a7fe-49a4b248df8e'::uuid,'b1c5c8e9-7885-462a-893b-183796ba7f72'::uuid,'b7de8289-604e-493d-811c-2f796b77d81d'::uuid,'bee519fa-ff07-438c-9542-d386fc821908'::uuid,'bfadfccb-55f4-4204-b0d4-b2ad545958ea'::uuid,'c30cbdee-cc14-45c7-a988-541b1207852d'::uuid,'c74935b9-84d9-4004-b125-a0724ceddd26'::uuid,'cd6328ec-e45b-4fc3-a7b5-aa46baddc2cc'::uuid,'cef15ddb-f65e-443d-b11d-58788edeef24'::uuid,'d04da598-d472-4521-99ff-5609403bac44'::uuid,'d2910755-21bb-4d87-b317-012f78bd998a'::uuid,'d7997aef-0a69-4c0a-b074-aa63d8ba40fe'::uuid,'d7e6300c-a6ef-4207-b59b-dbdf222c2cb4'::uuid,'dbf7e308-827c-4a66-b61d-663571068e0a'::uuid,'dd3dc44a-da68-41b3-999a-fdfc84bc28b2'::uuid,'e3ef32fd-0d93-4469-a249-392b408fff84'::uuid,'eb5a947c-af12-4f2c-851f-473838219815'::uuid,'ed1bc5ab-9e06-4a72-9e4a-36ec41f37e48'::uuid,'f922df63-a780-4482-86c4-55d8a4199311'::uuid,'f9e22dd2-2d50-4fc6-be3b-ab18e7f62c13'::uuid,'fc02d2b4-3f82-4c0f-a2d9-05c3a833a6ee'::uuid];
  v_id uuid;
  v_woken integer := 0;
BEGIN
  IF cardinality(v_listed) <> 57 THEN RAISE EXCEPTION 'PRE: list is not the 57 captured events'; END IF;
  FOR v_id IN
    WITH live AS (
      SELECT tb.tournament_id, s.table_id, count(*) AS n
        FROM public.table_seats s
        JOIN public.tables tb ON tb.id = s.table_id
        JOIN public.tournaments t ON t.id = tb.tournament_id
       WHERE t.status = 'RUNNING' AND s.left_at IS NULL AND t.id = ANY (v_listed)
       GROUP BY 1, 2)
    SELECT l.tournament_id FROM live l
     GROUP BY l.tournament_id
    HAVING count(*) >= 2 AND max(l.n) = 1
     ORDER BY l.tournament_id
  LOOP
    PERFORM public.fn_emit_tournament_manager_wake(v_id, 'rebuy');
    v_woken := v_woken + 1;
  END LOOP;
  IF v_woken = 0 THEN RAISE EXCEPTION 'PRE: none of the listed events is still fragmented'; END IF;
  RAISE NOTICE 'R3 woke % of the 57 listed events', v_woken;
END $wake$;
COMMIT;
