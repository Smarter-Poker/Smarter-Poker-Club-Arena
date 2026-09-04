-- ═══════════════════════════════════════════════════════════════════════════
-- RESTORE THE ERASED SEAT CREDITS (chip standard, 2026-09-04).
--
-- Companion to 20260904104847_felt_erasure_delta_settlement, which explains
-- the defect: a mid-hand add-on debited from a player's club wallet and
-- applied to the seat was overwritten by the next hand's absolute stack
-- write when the engine dealt from a stale copy. The wallet stayed debited;
-- the felt never held the chips; nothing on the platform said they were
-- owed. This migration gives every one of them back.
--
-- THE PARAGRAPH (CLAUDE.md 10.9 rule 5). 282 add-ons were erased between
-- 2026-08-29 22:01:43 UTC and 2026-09-04 10:44:52 UTC, 33,626.88 chips in
-- all, across 180 players (282 of the 282 rows are horses - the horse rotator is the
-- only user of mid-hand top-ups, and a horse is paid exactly as a human is,
-- CLAUDE.md 10.5). Each was found by fn_ca_find_erased_seat_credits: two
-- consecutive cash hands with exactly the same players, the felt between
-- them moved by exactly -(rake + bbj) of the later hand (so nothing arrived),
-- and yet one credit - and only one, with no other seat movement on that
-- table in the window - was applied to a named seat between the two hands.
-- The credit therefore never reached the felt. Every player is repaid the
-- exact amount debited, to the club wallet the debit came from - the club
-- on the add-on's own ledger leg (the seat row's club is the UNION for a
-- union table, and the wallet is the member club's; the first cut of the
-- detector got 107 of these wrong and is corrected below before anything
-- moves) - through fn_ca_restore_erased_seat_credit:
-- keyed on the pending-add-on row id (a replay restores nothing), journalled
-- issuance_reserve -> player_wallet as category refund with the key, one row
-- on the mint register. The supply meter reads the restoration as explained
-- issuance; the hours in which the chips were destroyed keep their recorded
-- unexplained drift as the history of the defect.
--
-- By club wallet:
--   Club JAQK (a0000000-...-0001)            14,224.50
--   Deep Stack Society (2a1132b9-...)       10,707.38
--   SHARK CLUB (a41434bb-...)                8,695.00
--
-- THE NUMBERS ARE ASSERTED (10.9 rule 4): the list below is what the probe
-- returned at generation time. Before any chip moves, every row is checked
-- against the pending-add-on row it came from (same user, same table, same
-- applied amount, unresolved-restoration), and the count and total are
-- asserted; a mismatch aborts the whole migration with nothing moved.
--
-- Of the 282, 186 are mid-hand add-ons (table_pending_addons rows, key
-- seat_credit_erased:pending_addon:<row id>) and 96 are between-hands
-- add-ons (the add-on ledger leg itself, key seat_credit_erased:addon_leg:<leg id>).
--
-- Partial erasures (a boundary with more than one credit, or a credit plus
-- a buy-in) are not in this list: the conservative detector cannot attribute
-- them to one seat by the identity alone. They are named in the changelog
-- as open.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 0. The detector repays the wallet that was DEBITED. Its first cut resolved
--    the club from the seat row, which on a union table is the union itself
--    while the add-on came out of the player's member-club wallet. The club
--    is now read from the add-on's own ledger leg (by id for a between-hands
--    add-on; by user, table, requested amount and request time for a mid-hand
--    one), falling back to the seat's club and then the table's.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_find_erased_seat_credits(
  p_since timestamptz, p_until timestamptz DEFAULT now())
 RETURNS TABLE(restore_key text, source text, source_id uuid, table_id uuid, user_id uuid, club_id uuid,
               amount numeric, credited_at timestamptz, prev_hand bigint, next_hand bigint, is_horse boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_find_erased_seat_credits is operator/service only';
  END IF;
  RETURN QUERY
  WITH h AS (
    SELECT hh.id, hh.table_id, hh.hand_number, hh.created_at, hh.rake_amount, COALESCE(hh.bbj_amount, 0) AS bbj,
           (SELECT sum((q->>'stack')::numeric) FROM jsonb_array_elements(hh.players) q) AS felt,
           (SELECT array_agg((q->>'userId')::uuid ORDER BY q->>'userId') FROM jsonb_array_elements(hh.players) q) AS ids
      FROM public.hand_history hh
     WHERE hh.tournament_id IS NULL
       AND hh.created_at > p_since - interval '30 minutes' AND hh.created_at <= p_until + interval '30 minutes'
  ), pairs AS (
    SELECT h.*, lag(h.felt) OVER w AS prev_felt, lag(h.created_at) OVER w AS prev_at,
           lag(h.hand_number) OVER w AS prev_hand_number, (h.ids = lag(h.ids) OVER w) AS same_players
      FROM h WINDOW w AS (PARTITION BY h.table_id ORDER BY h.hand_number)
  ), quiet AS (
    -- a boundary whose felt moved by exactly -(rake+bbj): nothing arrived
    SELECT p.table_id, p.prev_at, p.created_at, p.prev_hand_number, p.hand_number, p.ids
      FROM pairs p
     WHERE p.same_players AND p.prev_felt IS NOT NULL
       AND round(p.felt - p.prev_felt + p.rake_amount + p.bbj, 2) = 0
  ), credits AS (
    SELECT 'pending_addon'::text AS source, pa.id AS source_id, pa.table_id, pa.user_id,
           round(pa.applied_to_stack, 2) AS amount, pa.resolved_at AS credited_at,
           (SELECT l.club_id FROM public.chip_ledger l
             WHERE l.category = 'addon' AND l.from_entity_id = pa.user_id AND l.to_entity_id = pa.table_id
               AND round(l.amount, 2) = round(pa.amount, 2)
               AND l.created_at BETWEEN pa.created_at - interval '5 seconds' AND pa.created_at + interval '5 seconds'
             ORDER BY abs(extract(epoch FROM (l.created_at - pa.created_at))) LIMIT 1) AS debited_club
      FROM public.table_pending_addons pa
     WHERE pa.resolved_at > p_since AND pa.resolved_at <= p_until AND pa.applied_to_stack > 0
    UNION ALL
    SELECT 'addon_leg', l.id, l.to_entity_id, l.from_entity_id, round(l.amount, 2), l.created_at, l.club_id
      FROM public.chip_ledger l
     WHERE l.category = 'addon' AND l.to_type = 'table_stack' AND l.from_type = 'player_wallet'
       AND l.created_at > p_since AND l.created_at <= p_until
       AND NOT EXISTS (SELECT 1 FROM public.table_pending_addons q
                        WHERE q.user_id = l.from_entity_id AND q.table_id = l.to_entity_id
                          AND round(q.amount, 2) = round(l.amount, 2)
                          AND q.created_at BETWEEN l.created_at - interval '5 seconds' AND l.created_at + interval '5 seconds')
  )
  SELECT ('seat_credit_erased:' || c.source || ':' || c.source_id::text) AS restore_key,
         c.source, c.source_id, c.table_id, c.user_id,
         COALESCE(c.debited_club,
                  (SELECT ts.club_id FROM public.table_seats ts
                    WHERE ts.table_id = c.table_id AND ts.user_id = c.user_id
                    ORDER BY ts.joined_at DESC LIMIT 1),
                  (SELECT t.club_id FROM public.tables t WHERE t.id = c.table_id)) AS club_id,
         c.amount, c.credited_at, q.prev_hand_number::bigint, q.hand_number::bigint,
         COALESCE((SELECT pr.is_horse FROM public.profiles pr WHERE pr.id = c.user_id), false) AS is_horse
    FROM credits c
    JOIN quiet q ON q.table_id = c.table_id AND c.user_id = ANY(q.ids)
                AND c.credited_at > q.prev_at AND c.credited_at <= q.created_at
   WHERE NOT EXISTS (   -- exactly one credit in the window, so the identity attributes it
           SELECT 1 FROM credits c2
            WHERE c2.table_id = c.table_id AND c2.source_id <> c.source_id
              AND c2.credited_at > q.prev_at AND c2.credited_at <= q.created_at)
     AND NOT EXISTS (   -- and no other seat movement on the table between the hands
           SELECT 1 FROM public.chip_ledger l
            WHERE l.created_at > q.prev_at AND l.created_at <= q.created_at
              AND l.category IN ('buyin', 'rebuy', 'horse_funding', 'table_cashout')
              AND (l.to_entity_id = c.table_id OR l.from_entity_id = c.table_id OR l.table_id = c.table_id))
     AND NOT EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k
                      WHERE k.key = 'seat_credit_erased:' || c.source || ':' || c.source_id::text)
   ORDER BY c.credited_at;
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The restoration, asserted
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n integer; v_total numeric; v_bad integer; v_restored integer := 0; v_sum numeric := 0;
  r record; v_res jsonb;
BEGIN
  CREATE TEMP TABLE erased (key text, user_id uuid, club_id uuid, amount numeric, table_id uuid, credited_at timestamptz) ON COMMIT DROP;
  INSERT INTO erased VALUES
    ('seat_credit_erased:pending_addon:fc7295de-b673-4421-8e0c-33c0da11c6ba', '5330edb2-9f93-492a-aef3-c7e077c0de68'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 114, '9cf99577-0dcc-44e6-8b00-23dc0904db25'::uuid, '2026-08-29T22:01:43.123982+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:8bc7bb86-d0a4-496e-9aca-6a364d8dded5', '00000000-0000-0000-0000-000000000041'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 121.9, 'ebbac89f-02dc-4c8f-99ef-6f2c13771eb1'::uuid, '2026-08-30T10:46:14.282276+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:c14b9b66-509d-4fc9-9cd6-11c351476518', '3de60526-267e-40be-ab58-f354bf9febc2'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 111, '39ce3371-aac6-4122-a5d2-550a5cd5a748'::uuid, '2026-08-31T15:16:03.351258+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:17b07cc0-8075-482d-bde7-abeb9c928ab4', '7a98c446-fe87-42b9-8525-1e693846d0ba'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 448.43, '08746c1a-eb99-403a-ad98-63e9739ef4e9'::uuid, '2026-08-31T15:17:33.489164+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:f837790d-bc21-4311-9511-ee3ad5ad60d0', 'fb7c947d-79ce-4706-8c33-bb4f39359c59'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 146.4, '6379c52b-be60-4c59-88d7-3d8e33d58e10'::uuid, '2026-08-31T16:01:51.969443+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:c1dfacf4-8f49-45fa-956e-5d27990a97c1', '00000000-0000-0000-0000-000000000042'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 118.05, '8e4b0480-ab17-4fc7-a261-ac2e1eacfddd'::uuid, '2026-08-31T20:26:35.253345+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:43930eae-c701-4283-977c-46b33826e441', 'ef1baf0a-72de-4d60-a90f-b9b608b051b3'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 188.1, '8e4b0480-ab17-4fc7-a261-ac2e1eacfddd'::uuid, '2026-08-31T21:07:00.844179+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:3de6fa9a-0ef8-4dcd-a61b-9d66b9173b9c', '8ba5f4d2-91ce-4d7b-9182-192663784a92'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 403, '08746c1a-eb99-403a-ad98-63e9739ef4e9'::uuid, '2026-08-31T22:02:32.650451+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:3908e2cb-a65c-49ee-be9b-39f7a2e314fb', '3faa1e32-afb8-4b21-9530-2a9fd81c5766'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 132.51, '08381cd7-4051-4652-b19c-936b565b33b6'::uuid, '2026-08-31T22:44:29.320371+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:2ae0f0ad-aafa-4459-bee4-e0f549940288', 'd88dfe5b-9086-40b7-8cc7-d44e23a7a66a'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 453, '0dc28772-165e-4f2a-abec-6299e769bea9'::uuid, '2026-09-01T01:20:22.874784+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:34c361dd-401d-43f3-a517-493b04cdf68a', '53679882-3463-4be9-84ba-a1dcf00124f6'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 191.76, '8e4b0480-ab17-4fc7-a261-ac2e1eacfddd'::uuid, '2026-09-01T01:34:24.311495+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:6bc0e603-dbaa-4924-951e-ad260f074fed', '00000000-0000-0000-0000-000000000028'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 140.65, '98a5788f-8160-4a99-8191-de8717ac8476'::uuid, '2026-09-01T01:43:39.998965+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:4e85ae92-7dfd-498e-bd23-14ec6e27e9db', '99be4f5d-60d2-4827-bd31-4af5412769d1'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 159.5, '7107bc36-b091-4ff6-bd7e-6cde16b2641d'::uuid, '2026-09-01T03:21:44.118268+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:1957c855-c7a9-47bd-97ce-d50aadabb997', '00000000-0000-0000-0000-000000000040'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 97, '9435b208-56b0-4ac1-a35d-327d08d5d5d4'::uuid, '2026-09-01T08:22:43.815346+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a7c32c4a-f563-4c9e-8bc3-f06b74bde8af', 'ea06617e-0710-4590-b4db-772cd0fa4326'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 180, '72259d48-f943-44f9-801d-8a0da1640c04'::uuid, '2026-09-01T09:41:00.043464+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:c50fc22d-f872-4b03-a2cc-e4f2436e033b', '00000000-0000-0000-0000-000000000040'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 158, 'ab74db5f-aa64-4633-9a43-399c2368e813'::uuid, '2026-09-01T09:45:45.054841+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:eb062b08-898e-48ec-b606-ef9a964a373d', 'f26008f2-8015-42b0-9e5f-3550542e9a09'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 129.19, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-01T11:23:02.306592+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:571dc8d2-d68d-4211-ab49-08128944d0b1', '5ff11777-a6c2-41cd-b2b0-56c3576e73ae'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 121.7, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-01T11:37:03.583+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:e3f4c49c-c52a-4fda-a2f6-446390270dfb', 'f26008f2-8015-42b0-9e5f-3550542e9a09'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 149.9, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-01T11:40:50.556438+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:5642e223-225a-49df-8f45-5b14c6114afa', '5ff11777-a6c2-41cd-b2b0-56c3576e73ae'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 146.69, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-01T11:44:13.113023+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:917d2ba4-5035-451a-95a2-3706cfc3b7ff', 'face0000-0000-0000-0000-000000000008'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 145.3, 'd4777ce4-dd15-4ec1-ba67-e2c008d05113'::uuid, '2026-09-01T12:21:14.781711+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:435b7307-8453-41fd-8d95-5dffeb8f0743', 'fb7c947d-79ce-4706-8c33-bb4f39359c59'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 123.61, '98a5788f-8160-4a99-8191-de8717ac8476'::uuid, '2026-09-01T12:46:59.956944+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:43d1ea4c-a4ab-483f-9190-e2c04b9c0a78', '99be32e0-aeca-4b28-a653-99b746f260c4'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 5.54, '68fa89a6-b843-4eb7-b850-06f83db7ea25'::uuid, '2026-09-01T13:00:34.929617+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:eccf63b1-0442-4502-b62d-fcee4d9db296', '948bf927-81cb-46d8-b033-08d5f8b35bf0'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 312.8, '84bba14e-8090-4895-9d39-c8f02d529030'::uuid, '2026-09-01T13:36:19.004554+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:50b0f092-d3dd-48c1-9394-89e83fb366d7', '6cf64a8a-04db-458c-ab06-18f559163143'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 90.72, '16f75832-3463-44bf-a4b7-446c7c6016e7'::uuid, '2026-09-01T15:04:57.315108+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:327be57a-46be-479a-a8df-5ec41b2a19d9', '5129542f-958c-4693-862d-ff95799e344c'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 91.69, '98a5788f-8160-4a99-8191-de8717ac8476'::uuid, '2026-09-01T16:03:02.49634+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:42e3097b-6f09-4a17-880a-c129d62ffd0a', '5e43cd75-b978-438b-ab32-3f9d74151c9e'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 121.9, '30a38546-02d2-4676-aa92-4c04147bdb21'::uuid, '2026-09-01T16:52:47.288068+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:b1997c6e-8d04-4353-a798-fe978e72f6d4', '8d100b96-c791-4495-a7ab-0ffff40719c9'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 123.4, '7107bc36-b091-4ff6-bd7e-6cde16b2641d'::uuid, '2026-09-01T17:02:44.118035+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:6c8a5f4a-c40c-41dc-96f0-775097085b48', '719dda77-bceb-49c8-93a1-bda7b38cd57d'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 139.9, '48b5ecba-c73b-4386-af35-cfd90156573f'::uuid, '2026-09-01T22:30:24.114218+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:ae4240df-3b65-4db8-b6e9-9dc558a74353', '719dda77-bceb-49c8-93a1-bda7b38cd57d'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 115.9, '48b5ecba-c73b-4386-af35-cfd90156573f'::uuid, '2026-09-01T22:38:43.832646+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:a85feb45-5f47-4dd2-b580-13cdf0c9f196', '7d7a80a2-092c-4338-878a-0416611b249c'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 131, '16f75832-3463-44bf-a4b7-446c7c6016e7'::uuid, '2026-09-01T23:41:11.391211+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:b197da0d-338a-44f3-8746-d667d8abc89b', '84385ab0-d3ea-44c1-8e93-6fa6b1d25457'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 132.21, '72259d48-f943-44f9-801d-8a0da1640c04'::uuid, '2026-09-02T00:45:50.438618+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:300f9e70-23dc-45d8-bfe1-3aca4b1aad9a', '488db5a7-be8f-4428-a4ef-466c0aba8aa3'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 119, '30a38546-02d2-4676-aa92-4c04147bdb21'::uuid, '2026-09-02T01:20:16.539944+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:dc66705e-eff8-4c71-b8ca-1b0d517654c7', '77defa28-748c-477f-830d-b35006851b49'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 91, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-02T01:27:45.07709+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:c7360e70-f92e-4a65-bd22-aa34c2bf0c00', '4ce9fa05-703f-40e4-a14e-40cffc3ba305'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 90.65, '19457fda-2a18-4ffe-ae22-82c878635b3c'::uuid, '2026-09-02T10:40:30.776767+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:437f54e1-e46f-4721-990e-99a9b24ff910', '586f1543-8f0b-4486-bde5-cb937657ca30'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 197.95, '09e94aeb-43c0-4924-bd0a-8d1b0a809acb'::uuid, '2026-09-02T13:38:43.424824+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:96b392a3-f9eb-4eab-9428-f8a66fb0619a', '46887b99-8cd6-45db-861c-ad24232efbfe'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.51, '52f04c3e-67b3-409e-a8ee-e52c75411ecc'::uuid, '2026-09-02T13:43:15.001029+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:d796dd7d-9cdc-4a3b-b531-d89af56786e1', '878cdf61-681e-464a-8eb4-989951a978a6'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 142.69, '07589a8b-a986-4a39-9810-02bbdf9075a8'::uuid, '2026-09-02T14:36:51.695255+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:33d035b1-90f2-46d1-81d5-f39f8e738abf', 'f140e49c-7104-46fd-9c7f-6b2625a90305'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 60.3, '2e68aa41-cdfd-4e33-a790-e548b18ffe97'::uuid, '2026-09-03T23:01:39.056075+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:ec308ba8-0b50-4396-831c-fcb1818b8435', '6fdfcb70-b8f3-4ed1-89ca-a7d8af136dfc'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 2.31, '58c3e3ef-376d-4167-b5ff-8ed41ebd5ea1'::uuid, '2026-09-03T23:01:58.405911+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:782bfc78-847d-48ac-b21f-b84509659b6c', '00000000-0000-0000-0000-000000000022'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 98, 'c9250a6a-542a-4ff0-a9f3-5fdda0a9561f'::uuid, '2026-09-03T23:02:05.548421+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:dac4712b-842f-4236-bdf0-050d26632a39', '0fdb265e-7a56-4ecf-8410-eecd49923e42'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 164.3, '3c00d4d0-5d98-44de-ad36-cd683001d32a'::uuid, '2026-09-03T23:03:07.721366+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:7f332723-7b99-4e39-ba8b-62822865fb64', '1179f15e-dac7-4b7e-80df-5e525a498ddd'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 69.3, '2311d5b6-c8a1-483d-bcc0-d2f43b31c50c'::uuid, '2026-09-03T23:04:34.373145+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a3b944cd-7266-488d-a83a-06904f7c9222', 'e23ec3e7-72c2-4e2d-85e7-8b902cc6fe33'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 67.33, '21d25e50-4b84-4e35-9e05-adf211a0342b'::uuid, '2026-09-03T23:05:24.985124+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:13fafaf5-b4e5-4953-951a-560ecef6e59e', '5e65716f-140b-44d9-8e9a-2aacf8b50d8d'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 83.27, '590c4f3d-8ea8-4530-b23a-ad3e56b53592'::uuid, '2026-09-03T23:11:45.347275+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:482d72b9-4749-4e7c-83c6-eea795651175', 'a5e2f927-126c-454a-ae28-840b56bdb1dd'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 50.91, '915e0c84-20e5-4d51-8775-c3589322da48'::uuid, '2026-09-03T23:15:17.851294+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:7de38d7b-4277-4fbf-9235-cdb4172f680f', '2072ad2e-869c-4537-a3dd-0def0c889401'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 6.93, '4734e443-1c20-404a-a445-285d8a05b255'::uuid, '2026-09-03T23:15:18.759674+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:860c600e-009d-4609-b8eb-9e12d06c6d32', 'b2e5bf5b-f6f3-4156-8998-29831e390fa3'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 98.19, '61de9546-e8ca-43d4-a9f0-7f017013fbc7'::uuid, '2026-09-03T23:16:37.95602+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:e3cd08fe-d06f-430a-8815-352aefd01cf7', 'e573c327-dc89-4d87-81f0-efd0cb3c8020'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 657.15, 'ec090cbf-ecd5-49a0-a92d-8a9084027548'::uuid, '2026-09-03T23:16:39.093827+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:2bb1a842-3a69-4645-a780-a44a789d5bc3', 'b2e5bf5b-f6f3-4156-8998-29831e390fa3'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 121.2, '8321e592-06da-4906-a7b2-db5538b75407'::uuid, '2026-09-03T23:17:06.07676+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:67229485-b33e-4bd5-b1fb-4942cb8c6f28', '00000000-0000-0000-0000-000000000019'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 91.71, '7107bc36-b091-4ff6-bd7e-6cde16b2641d'::uuid, '2026-09-03T23:24:06.592706+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:1ebad7f6-6997-4602-afff-acc38c892dd8', 'f687be6b-fef1-4713-be59-9ed6e8b55eef'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 113.12, '16f75832-3463-44bf-a4b7-446c7c6016e7'::uuid, '2026-09-03T23:28:43.769393+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:e61e284c-daba-4355-b0c0-94c2762b135d', '8e5a0e02-7832-416d-970f-f6f74e181dcb'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 8.28, '95e54c54-2265-499d-8dd3-6238f51273bc'::uuid, '2026-09-03T23:30:40.921454+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:9169806a-ea5c-4a18-af27-c356564c676a', '26bb68d8-e995-433e-b364-f953aa198783'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 151, '30a38546-02d2-4676-aa92-4c04147bdb21'::uuid, '2026-09-03T23:31:29.527005+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:0c07eb4d-2ba9-453a-9b5f-449cb9715d59', 'f687be6b-fef1-4713-be59-9ed6e8b55eef'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 93.12, '16f75832-3463-44bf-a4b7-446c7c6016e7'::uuid, '2026-09-03T23:32:14.083221+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:78d0c03b-9ca6-4e6b-b866-6335fb401174', 'd2ce100a-152e-4b0e-8903-2296a9cb7cbe'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 74.26, '43900bfc-ad04-445a-a9f4-c85600a85405'::uuid, '2026-09-03T23:37:46.909585+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:49c9f73c-b514-4705-9ce3-03adf55b0aba', 'd07cf5cf-9aab-4e9f-b281-e243536778ee'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 2.94, '1096b2af-04f2-4ab0-af87-17cc243fc027'::uuid, '2026-09-03T23:39:12.508079+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:82ebbe61-7125-4f8f-9d97-6e85a9231a5a', '82861181-5a96-4e7b-bfa4-b75ca2bd145f'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 66.72, '20d9d5ba-3871-40a4-8b1f-61a9e460c8a9'::uuid, '2026-09-03T23:40:19.15572+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:2dc2175a-7db7-4e61-a26f-644b8d3010ed', '5d6f67cc-cecf-4791-b1ff-9af16e9a8554'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 3.94, '090d570b-1c8f-4e01-b956-41dc8abd71cb'::uuid, '2026-09-03T23:40:44.838215+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:6eb4f575-ff19-41d6-a7e0-0af43249a098', 'ed3f0662-8da7-4c24-b8d7-a1000d60cb1f'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 95.75, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-03T23:40:44.864594+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:71a4ea33-f68b-4428-9f20-f5bdf8418092', 'c1ecb590-e6bb-4a7a-87de-95bb44673efc'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 81.05, '80de44d2-b736-4492-8049-dca66d9ea866'::uuid, '2026-09-03T23:41:47.626511+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:70c5da2b-d4a1-465a-85da-90f5aac36b10', '3de60526-267e-40be-ab58-f354bf9febc2'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 122.24, '977e2987-b3e7-4349-a7fa-e8caabd0f682'::uuid, '2026-09-03T23:42:31.707963+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:ee4358be-8f70-48f3-a957-0b4d65a6c7f6', '5d6f67cc-cecf-4791-b1ff-9af16e9a8554'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 3.89, '090d570b-1c8f-4e01-b956-41dc8abd71cb'::uuid, '2026-09-03T23:43:09.106394+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:22b595f2-d8e5-4426-b043-2e41358b6a6c', 'f83a8613-1969-402b-81a4-05ae7f164bb4'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 336.91, '84bba14e-8090-4895-9d39-c8f02d529030'::uuid, '2026-09-03T23:45:58.339911+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a44fd429-981a-43f8-88f6-a1662464a9bc', '4a686160-2102-4cba-b3e5-cfa3b1856602'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 67.5, '2e68aa41-cdfd-4e33-a790-e548b18ffe97'::uuid, '2026-09-03T23:50:26.180668+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:9f9f9cd8-cf01-45e7-bf8e-a738d5b31e07', '82861181-5a96-4e7b-bfa4-b75ca2bd145f'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 113, '165b9edd-95bd-4194-94eb-333fbedd7ae0'::uuid, '2026-09-04T00:04:38.533741+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:fd6ddaa2-ec2b-4b28-a8ed-02b403e758dc', '7d1b678f-cea8-41fc-873e-2ec47ea5c318'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 119.5, 'c9250a6a-542a-4ff0-a9f3-5fdda0a9561f'::uuid, '2026-09-04T00:12:33.061282+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:9a71e51f-82ea-4c9a-850d-2c094f789d61', 'ed8f5032-e632-4df2-9e8f-d705b883149c'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 6.25, '031dfe93-e96b-45f3-b5ba-55e69a21e35a'::uuid, '2026-09-04T00:12:47.028824+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:42033c32-eb31-4404-913f-2632797424bc', '4a686160-2102-4cba-b3e5-cfa3b1856602'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 65.65, '43900bfc-ad04-445a-a9f4-c85600a85405'::uuid, '2026-09-04T00:14:19.512247+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:9521428b-9fd5-481e-ad90-9dabf0fca09c', 'ed8f5032-e632-4df2-9e8f-d705b883149c'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 6.58, '031dfe93-e96b-45f3-b5ba-55e69a21e35a'::uuid, '2026-09-04T00:21:55.694953+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:1c9674fe-a798-4387-bb6e-00b8a69b3f81', '20f6af61-75e1-4954-b61a-9042f8a9e638'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 6.83, '0065ba44-cd38-4190-86a0-e56ffe032caf'::uuid, '2026-09-04T00:26:20.311938+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:6a2500c4-aff6-4f90-896c-5c65a8a28d07', '4992b455-1a96-4a57-accf-77d5e9da76b1'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 2.38, '18496f3e-27ea-4298-aa78-216fb3207c61'::uuid, '2026-09-04T00:30:53.728825+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:34e68e89-e185-4b67-861e-d3da7fb279cc', 'b23d2455-d884-42e4-901a-369db50e5cd0'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 162.06, '98a5788f-8160-4a99-8191-de8717ac8476'::uuid, '2026-09-04T00:33:36.472657+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:603f5fea-fbee-4784-87ed-3b7ecccfbd9f', '0ce13c54-930f-48b5-93a9-df7a38e90b7f'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 124.95, '027d17b0-617f-4554-8418-a1595b86ff24'::uuid, '2026-09-04T00:39:41.55271+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:9df77b71-f2cd-4b9d-9d70-688534c50fda', '3061ba63-e7ed-4537-8b62-9d2c0a8c420a'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 126.2, '8321e592-06da-4906-a7b2-db5538b75407'::uuid, '2026-09-04T00:43:38.332827+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:8b016c5a-af89-4d86-8bae-9073d1a916da', '46887b99-8cd6-45db-861c-ad24232efbfe'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1, '007bba08-5fd3-4a99-abd9-57a306445c07'::uuid, '2026-09-04T00:44:07.814308+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:ab87135f-de3a-487c-a19c-b59358fcd766', 'a51e2ad3-69aa-4bbc-a82c-06a6581572bf'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 86.46, '144007db-d1e8-4cce-934b-e89bc4fa20c8'::uuid, '2026-09-04T00:46:49.663544+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:ba0190f4-a74d-4ed5-94bc-9b53283f53e1', '8c3ac914-6aae-4937-b438-ba1def687aef'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 381.58, '3e272439-6a6e-44a0-be35-3db383c300c3'::uuid, '2026-09-04T00:48:16.114805+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:495f6069-d643-45a8-ac9c-7de75374b1b1', 'c401b45c-8a60-4480-9900-f452454d77be'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 76.12, '144007db-d1e8-4cce-934b-e89bc4fa20c8'::uuid, '2026-09-04T01:01:59.652651+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:508e88cf-4f2a-4cb1-862f-cae949f6e468', '7e464f21-760d-4682-a6df-f8d89030d519'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 296.24, '02a1adb6-7e4a-49c8-af0a-757265685ca8'::uuid, '2026-09-04T01:02:18.599828+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:ff8826bd-c89d-434a-8b52-1f4d3c7bbe1a', 'd6cd970a-844a-4531-ae66-479583567335'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.02, '10f03347-5d9a-4216-b782-f79cd1ebac78'::uuid, '2026-09-04T01:07:45.652112+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:0c6b5ea0-395a-413b-b316-41a53b3a6be6', 'c698bb3a-2245-4b35-a75c-43bd0649a133'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 15.02, '19ae6284-4fb9-4cb9-a524-1bd0c522b9eb'::uuid, '2026-09-04T01:12:33.409007+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:c374cb8e-bb90-4cda-b254-d921d6788325', '775f4778-ceda-44bb-a26b-7c4194c8c0c1'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 60.35, '03cf3726-75c3-40fd-a4dc-e3daf095a39e'::uuid, '2026-09-04T01:14:07.599663+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:6a6b7609-dae9-48e7-9202-d531b808bb55', '00000000-0000-0000-0000-000000000019'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 152.5, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-04T01:16:53.11336+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:9f0a45b3-57d7-46c2-b139-dd37573ba177', '00000000-0000-0000-0000-000000000019'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 172.5, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-04T01:18:18.2351+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:92065531-e31f-4d5c-a76a-e437cd5d4173', '3ebc3050-24ab-4eea-a3f1-74fac5f0b7a7'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 3.5, '27a2000d-8dd7-49f5-9333-99c52f93017a'::uuid, '2026-09-04T01:19:09.684767+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:d11ec44f-e964-4fe8-95e4-af3b0536c8dd', '5d2f60d0-6eb0-4f7e-a968-8eedf3b282f1'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 12.55, '02bc2b37-ed39-485c-a0d9-1f4fec0a1ce7'::uuid, '2026-09-04T01:21:48.095186+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:06565428-e1eb-4a6b-89de-f39efd6f8f16', '3061ba63-e7ed-4537-8b62-9d2c0a8c420a'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 57.4, '590c4f3d-8ea8-4530-b23a-ad3e56b53592'::uuid, '2026-09-04T01:22:37.383924+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:9790ab48-02a5-4ef4-b9a6-f3f4dac64318', '5eabbbc0-a3a3-4ff5-8329-f94c35f59722'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 91, '82eda914-0ae0-44d8-96e2-ef7901e361f6'::uuid, '2026-09-04T01:22:49.659097+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:ead86a82-7404-409f-b9c5-fb0cf1e8b3ef', 'c97784d9-45ce-488f-ad17-130d569e16be'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 4.83, '4b2cc67b-70f0-4f0b-b064-3b570817317f'::uuid, '2026-09-04T01:22:49.662924+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:0949ae41-2c2d-4918-9b86-d31eb8a13576', '7f99084b-e99a-4312-a258-1be6451c0c8b'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 166, '16f75832-3463-44bf-a4b7-446c7c6016e7'::uuid, '2026-09-04T01:24:44.388212+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:f5184a9c-65c0-46e9-b9e9-f2f2416cbc5a', '7d7a80a2-092c-4338-878a-0416611b249c'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 139.6, '48b5ecba-c73b-4386-af35-cfd90156573f'::uuid, '2026-09-04T01:35:10.256223+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:7ce61b3e-fa10-49bc-8505-0852ab7a6d72', '3ec4fbbc-2e0d-4004-8b34-245e8984e8a3'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 9.32, '1e47c4dc-2087-4053-bb4d-eaaf30166d27'::uuid, '2026-09-04T01:36:17.256601+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a9bdd42e-90a8-482d-a244-259e850d79be', '852b2be0-4983-4507-a687-fc12f241960d'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 65, '7667d1fa-5bac-4430-ad35-6af56c289719'::uuid, '2026-09-04T01:36:30.593091+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:3ae76557-40c6-48fe-9544-9363347bbb3b', '778f8033-c9e2-45fa-98ca-935f38e2b8ca'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 673.85, 'd9d3c3b3-c113-4cb2-946c-ebd9867ccb30'::uuid, '2026-09-04T01:37:47.297824+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:f5ae3d97-18d6-47eb-ab79-4b0e94d2423d', 'd311fcf5-37da-49a7-b925-63f316a80355'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 1.03, '9161f88b-1924-4962-a0ce-bc77f46a98b1'::uuid, '2026-09-04T01:43:53.055897+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:c098780a-ec9d-48af-8b48-6cd907940d4c', 'd69e25e8-c1a7-4c38-8a7e-30784cba86c3'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 150.5, '98a5788f-8160-4a99-8191-de8717ac8476'::uuid, '2026-09-04T01:43:53.059826+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:098b6f27-62cd-4acf-ad8b-ad3694a11d48', '8384a11c-8930-4b0d-a1c9-748f03569a78'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 73.78, '7667d1fa-5bac-4430-ad35-6af56c289719'::uuid, '2026-09-04T01:45:21.055506+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:5e1f5692-1c63-425d-978d-1039aa2dd24e', 'a51e2ad3-69aa-4bbc-a82c-06a6581572bf'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 88.81, '144007db-d1e8-4cce-934b-e89bc4fa20c8'::uuid, '2026-09-04T01:45:32.172938+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:863e5c7c-a561-44e2-a65e-3744e8791359', '8e5a0e02-7832-416d-970f-f6f74e181dcb'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 6.25, '95e54c54-2265-499d-8dd3-6238f51273bc'::uuid, '2026-09-04T01:47:06.22944+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:39363d7f-0b88-4b74-9250-4d036ff2b960', 'd311fcf5-37da-49a7-b925-63f316a80355'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 1.02, '9161f88b-1924-4962-a0ce-bc77f46a98b1'::uuid, '2026-09-04T01:47:17.092865+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:237601f6-c0ed-4e2a-8e47-5cc530fe6cfe', '00000000-0000-0000-0000-000000000047'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 130.83, '977e2987-b3e7-4349-a7fa-e8caabd0f682'::uuid, '2026-09-04T01:48:37.960493+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:25f2794a-2d2a-46c1-b011-07359298d510', 'ef58b642-df26-41b5-8547-bb279151e844'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 3.02, '8039dce5-f39b-4e23-9d7f-370b4e39f959'::uuid, '2026-09-04T01:50:42.043755+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:9c2b612d-3a86-4379-8ca2-291a21e86516', '171038e5-f50e-4bdd-988f-621a7ce9479c'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 4, '1096b2af-04f2-4ab0-af87-17cc243fc027'::uuid, '2026-09-04T01:52:19.986835+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:d8ebb75c-3703-4eec-8662-dcd17c94e596', 'd311fcf5-37da-49a7-b925-63f316a80355'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 1.47, '9161f88b-1924-4962-a0ce-bc77f46a98b1'::uuid, '2026-09-04T02:00:10.820845+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:e73ddf68-d625-4d0f-b8a0-b53eaed2fd3e', 'd311fcf5-37da-49a7-b925-63f316a80355'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 1.27, '9161f88b-1924-4962-a0ce-bc77f46a98b1'::uuid, '2026-09-04T02:03:30.206255+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:d3da6247-3039-46e9-b4a4-768d9b8ce2f4', '4ba85a62-daee-4c8d-8931-8e4414231fd3'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 227.4, '0dc28772-165e-4f2a-abec-6299e769bea9'::uuid, '2026-09-04T02:03:41.295041+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:2e66caea-b5b9-42b5-9ff4-26eb09f72941', '5bb61f42-52d5-4dad-b1e9-c839504dd928'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 99, '82eda914-0ae0-44d8-96e2-ef7901e361f6'::uuid, '2026-09-04T02:05:03.506861+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:55346a5d-49a6-4c69-8835-ead8513bcd40', '0fdb265e-7a56-4ecf-8410-eecd49923e42'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 116.55, '428eb653-2670-4332-8663-c956f45657c7'::uuid, '2026-09-04T02:15:34.126104+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:69397ad8-a570-4791-a405-b946027971f7', '5bb61f42-52d5-4dad-b1e9-c839504dd928'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 112.5, 'd3f96f81-4fd3-4bfe-847e-b9410483f7df'::uuid, '2026-09-04T02:19:23.054804+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:73c666b9-0750-4fc5-9c7d-990b2c63d80a', '00000000-0000-0000-0000-000000000019'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 163.81, 'ab74db5f-aa64-4633-9a43-399c2368e813'::uuid, '2026-09-04T02:23:48.48144+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:1ec75db9-b446-4207-861c-a95554006310', '0fdb265e-7a56-4ecf-8410-eecd49923e42'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 144.94, '428eb653-2670-4332-8663-c956f45657c7'::uuid, '2026-09-04T02:26:10.23597+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:5787f282-2336-424c-82e0-4dc2684c0158', '1b116be6-057d-48a9-9bd7-dca3f607884a'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 22.06, '1b9ce3a3-20bd-4fb5-b480-e1a7317450c1'::uuid, '2026-09-04T02:26:24.211862+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:b91a64f3-7e5c-4094-bba7-038cb60bd384', 'ef5a8ddd-0a68-4ef1-b6f2-4ba9369e0318'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 8.07, '4b2cc67b-70f0-4f0b-b064-3b570817317f'::uuid, '2026-09-04T02:34:46.715739+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:d1bcf16c-7a9a-4fc2-a5fd-8198985158c2', '2db815f9-4302-40c8-b2e3-4bb992e1cff2'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.24, '10f03347-5d9a-4216-b782-f79cd1ebac78'::uuid, '2026-09-04T02:38:05.889646+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:a91abb0b-5b93-46d3-ac2c-af3d77969686', '5c3c64a2-4459-44a2-9381-e73a4cd5d0c5'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 14.52, '00d02acf-03da-4cb2-99c7-7c1bef6aee25'::uuid, '2026-09-04T02:38:06.65895+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:7325e2b9-f8f9-4830-a449-133f9ed936a0', '1b116be6-057d-48a9-9bd7-dca3f607884a'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 22.5, '1b9ce3a3-20bd-4fb5-b480-e1a7317450c1'::uuid, '2026-09-04T02:38:06.659918+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:1dc4a56e-bba5-4c3e-85d8-a19953fadc69', '1110a1ed-fcf2-423b-9d9a-bc615a16cbd5'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 146.09, '72259d48-f943-44f9-801d-8a0da1640c04'::uuid, '2026-09-04T02:52:15.576167+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:dc9af239-fcaa-49b7-a279-cad0f2732b0b', 'a70a0d4c-232e-482d-898f-37518fe134bc'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 9.19, '0222580c-3af4-412f-857e-a363864eaf40'::uuid, '2026-09-04T03:05:10.923117+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:f21c59ed-ad6e-4a39-a571-5fdc821a2748', 'ad66f252-28fb-4ffd-8242-fcafa290f852'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 9.21, '0065ba44-cd38-4190-86a0-e56ffe032caf'::uuid, '2026-09-04T03:05:48.146863+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:a4f38f2a-5d24-4484-91ec-d7bb5927c88d', 'ad66f252-28fb-4ffd-8242-fcafa290f852'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 10.21, '0065ba44-cd38-4190-86a0-e56ffe032caf'::uuid, '2026-09-04T03:10:21.651123+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:6ac1dca9-9eea-45c6-9997-60dd9c0826d7', '62d0cfe7-d505-43e3-ba83-aca280237051'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 131.15, '428eb653-2670-4332-8663-c956f45657c7'::uuid, '2026-09-04T03:12:32.51872+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:e3d9542f-e3ca-4654-86ae-5a65f234a9e5', '5a0cd7e0-174a-466f-ba1d-6d2c80d9252a'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 115.5, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-04T03:13:47.083406+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:cf36cb34-288e-4730-9eba-211787da1248', 'd9025f02-260a-4c89-9311-e00b792d35c4'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 5.61, '4734e443-1c20-404a-a445-285d8a05b255'::uuid, '2026-09-04T03:18:24.55232+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:5654cc2c-f3a6-42e9-93f9-158d407616b8', '6b3f4393-3ccb-491d-bce2-361b3385defe'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 130.55, '027d17b0-617f-4554-8418-a1595b86ff24'::uuid, '2026-09-04T03:19:23.921945+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:ee56e275-812b-4a2a-a706-e42489184547', '3ec4fbbc-2e0d-4004-8b34-245e8984e8a3'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 33.22, '8b359cee-c169-4240-9339-5a8df6cb58fc'::uuid, '2026-09-04T03:19:34.755839+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a070d740-6e33-4a5c-a97f-eb25fa072f6e', '5a0cd7e0-174a-466f-ba1d-6d2c80d9252a'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 139.5, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-04T03:19:39.448187+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:c5ba594d-b4e7-421a-ad64-3068fd1d4639', '2a79f912-76e9-4763-a865-2b7a3c00d587'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 7.99, '0222580c-3af4-412f-857e-a363864eaf40'::uuid, '2026-09-04T03:21:00.282827+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:e2f579e7-e9dc-4704-9d34-c8821e15dfad', 'd2ce100a-152e-4b0e-8903-2296a9cb7cbe'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 93.63, '60e8e090-b288-4897-92b8-4a39bcb00e23'::uuid, '2026-09-04T03:22:18.46202+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:0712b086-fdf0-48cc-b823-4e326b73f4fe', 'd88dfe5b-9086-40b7-8cc7-d44e23a7a66a'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 305.16, '08746c1a-eb99-403a-ad98-63e9739ef4e9'::uuid, '2026-09-04T03:22:18.546595+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:5135efd4-e6c5-4825-89ef-02288c9f7396', '5a0cd7e0-174a-466f-ba1d-6d2c80d9252a'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 103.9, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-04T03:25:25.380419+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:63b9567b-898a-4daf-aa03-567169ce1232', '412a7171-f917-4db4-9a47-c4432d15b4a3'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 7.55, '083cf2f3-3289-4e29-836d-0785d20b646d'::uuid, '2026-09-04T03:25:42.545943+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:e240e3dc-cfb8-4308-ba5f-fe70476deadf', 'eba463f8-2c66-4592-b304-3afc3f7f2c93'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 173.36, '4e853fbd-6263-48ae-8420-23d93731e72e'::uuid, '2026-09-04T03:30:44.974547+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:9515d2b9-88fb-4788-99ea-13e66c177332', '441938f0-4fb5-4ce0-b17e-0e95caeb8cc0'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 33.39, '126d7850-8b99-490d-90e4-157322dac0dd'::uuid, '2026-09-04T03:31:17.67742+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:5212ea60-7f40-44f2-8805-5368993a5ee5', 'd6cd970a-844a-4531-ae66-479583567335'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 77.93, '4a25dd8a-bd59-4568-8f58-3dc4de78bf72'::uuid, '2026-09-04T03:32:54.914057+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:77b71e15-4b1d-44ab-90f9-1bf8cb3f41b8', 'ef5a8ddd-0a68-4ef1-b6f2-4ba9369e0318'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 11.9, '6e0685d4-fdd3-4a32-943b-8326bc3a4207'::uuid, '2026-09-04T03:36:52.004199+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:24e56892-dd0a-474e-a69b-a97f6b7b6b9a', '7d7a80a2-092c-4338-878a-0416611b249c'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 124.36, 'ab74db5f-aa64-4633-9a43-399c2368e813'::uuid, '2026-09-04T03:37:54.375015+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:9756f26a-0c7f-4725-b826-e0cd7559528f', 'f0dbd49e-0991-4f49-8d4a-a715694e96aa'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 3024, '18f697f0-81f3-4167-8fe0-6646636b9680'::uuid, '2026-09-04T03:38:49.587826+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:81e252ef-7681-43fe-b6e9-5a151ab1a9fb', '0f5f1d65-7ce1-4250-93fe-49078f4f14d1'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 134.19, '08381cd7-4051-4652-b19c-936b565b33b6'::uuid, '2026-09-04T03:40:28.235356+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:9cb189f7-5f4f-4dbc-b3f2-c2e573c081f4', '05a38e8e-ce5f-44fb-82de-782369bf9fab'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 51.69, '20d9d5ba-3871-40a4-8b1f-61a9e460c8a9'::uuid, '2026-09-04T03:40:39.370994+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:67d902f0-f431-43ed-9eef-b47bf928d1c9', '26bb68d8-e995-433e-b364-f953aa198783'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 112.18, '48b5ecba-c73b-4386-af35-cfd90156573f'::uuid, '2026-09-04T03:40:50.814112+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:98967d34-b273-492c-8348-3d1cce90624a', 'ef5a8ddd-0a68-4ef1-b6f2-4ba9369e0318'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 16.89, '6e0685d4-fdd3-4a32-943b-8326bc3a4207'::uuid, '2026-09-04T03:41:49.808631+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:823ac1ae-5e4c-4791-8c33-bf4cf1911603', '3c1d70c8-c46a-4e2c-bcc8-dbe53798799a'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 15.21, '036680d0-38cd-4757-8b1e-36ad75a7d1de'::uuid, '2026-09-04T03:45:06.477902+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:6bd96cf8-bfd5-41dc-a8d5-2a1b13d5a6a2', '488db5a7-be8f-4428-a4ef-466c0aba8aa3'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 137.3, 'ab74db5f-aa64-4633-9a43-399c2368e813'::uuid, '2026-09-04T04:01:36.130873+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:d1ad3abe-8d4c-4ad3-8f36-2d7593ca28d2', '26fc77c4-60fc-406b-bf17-5f4b35777ec7'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 60.1, '18a5fd6d-0213-416f-b635-8b650f1bdd2a'::uuid, '2026-09-04T04:13:55.157964+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:5b36d8c0-9f6e-4ba1-ba6b-8dc78d8c9af2', '145aaccb-b8bf-434a-b5e7-ca23a306799c'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 132.3, '0be5fa47-c676-4bef-938f-81a28e3630e4'::uuid, '2026-09-04T04:21:28.501532+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:8a1e1b3d-b6f1-4af3-b137-b31100a87e35', 'bcc2a80a-9731-4dc1-979d-892943c8568b'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 122.68, 'ab74db5f-aa64-4633-9a43-399c2368e813'::uuid, '2026-09-04T04:22:25.017186+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:6426a1c4-4816-49f5-8062-6a0d5c2daf18', 'ffb2b4fc-3479-4f0d-a720-84184b189bdf'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 135.9, '5ecbacef-7129-4bcc-90f1-36db6cc00469'::uuid, '2026-09-04T04:22:54.824718+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:ac20bdba-603b-4283-b6c3-98e37f5d4074', '5bb61f42-52d5-4dad-b1e9-c839504dd928'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 118.9, '82eda914-0ae0-44d8-96e2-ef7901e361f6'::uuid, '2026-09-04T04:23:10.009448+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:9e940c52-68be-4d5e-847e-f247004a237f', 'bcc2a80a-9731-4dc1-979d-892943c8568b'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 162.68, 'ab74db5f-aa64-4633-9a43-399c2368e813'::uuid, '2026-09-04T04:24:35.848905+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:cb45e981-9c81-477d-ac49-ec6835165c19', 'f9e96cd6-c8b8-4ddc-aea8-a6a81155158a'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 360.9, '01a7caee-9d09-40c3-933c-bd4a85bf3b00'::uuid, '2026-09-04T04:26:37.648985+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:110cab0c-3cb0-426d-a91e-f45b2183768e', '484d22c4-ff3c-4430-8058-b6f0d8c2387a'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 1676.2, 'a81728eb-a8ff-4761-89f5-b3466e6a24f8'::uuid, '2026-09-04T04:27:26.013868+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:c955c9cf-daf7-4ccc-b6fd-f8c649e875f6', '8bdb54a1-d614-4932-84fa-795dd4728828'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 57.97, '144007db-d1e8-4cce-934b-e89bc4fa20c8'::uuid, '2026-09-04T04:27:40.581907+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:6de2ab5f-3fe9-40f1-b796-d74d9443dd76', '5bb61f42-52d5-4dad-b1e9-c839504dd928'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 129.9, '82eda914-0ae0-44d8-96e2-ef7901e361f6'::uuid, '2026-09-04T04:28:15.294097+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:46f7d909-fdfe-4ed3-82c1-1b57d355870f', '8e30089b-cad4-402d-a477-7fcdb3db8d05'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 5.88, '0065ba44-cd38-4190-86a0-e56ffe032caf'::uuid, '2026-09-04T04:28:33.705656+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:6e677399-cc9d-43d0-aabf-a4d63bd3c51a', 'c649f5ce-726c-4426-bac5-c1e63d249dd4'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 132.4, '165b9edd-95bd-4194-94eb-333fbedd7ae0'::uuid, '2026-09-04T04:29:02.242102+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:bb87188a-57a6-4c38-9a0a-30fbf1c5fbbb', '8bdb54a1-d614-4932-84fa-795dd4728828'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 57.97, '144007db-d1e8-4cce-934b-e89bc4fa20c8'::uuid, '2026-09-04T04:29:29.635007+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:d2a34002-dab2-4e19-921d-af5b59c95f5e', '137ca64e-eb2a-48a1-84ad-1db2b59aa51e'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 6.53, '055afe43-5ac9-4b28-9d12-c1eafc245ba2'::uuid, '2026-09-04T04:29:45.369736+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:5d12def3-f60b-4012-9d6c-7239b2b75f98', '5e65716f-140b-44d9-8e9a-2aacf8b50d8d'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 93.65, '2755c54c-d55f-4400-babe-e9bd97ae532a'::uuid, '2026-09-04T04:30:07.265315+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a8d413fa-3128-46a2-be8c-d0e28107159b', 'c649f5ce-726c-4426-bac5-c1e63d249dd4'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 152.4, '165b9edd-95bd-4194-94eb-333fbedd7ae0'::uuid, '2026-09-04T04:30:21.253862+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:7b46b2f5-0224-4883-b0bd-59c4a87d76a8', 'eba463f8-2c66-4592-b304-3afc3f7f2c93'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 61.9, '54358ddd-d004-4438-8fcc-45e9ed3b1f6f'::uuid, '2026-09-04T04:30:43.185476+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:71dcccb1-4f76-4f4c-8612-672e868bd6f7', 'f9e96cd6-c8b8-4ddc-aea8-a6a81155158a'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 381.9, '01a7caee-9d09-40c3-933c-bd4a85bf3b00'::uuid, '2026-09-04T04:30:50.139597+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:6fe1150f-7078-4e04-8425-56539d1a9fe8', 'a040ed35-98c2-4354-bb82-476c24184047'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 146.22, '72259d48-f943-44f9-801d-8a0da1640c04'::uuid, '2026-09-04T04:31:26.57765+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:d6acb06b-bd41-423e-803a-57f16574265a', '194e5206-bd4d-4ea5-ba2d-142c8bf8a258'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 7.48, '055afe43-5ac9-4b28-9d12-c1eafc245ba2'::uuid, '2026-09-04T04:31:28.681425+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:b2e4fdee-f3a3-4ea3-9d47-703267ba820c', 'a74c2c28-c2dd-4ad0-b18f-2687eba73dba'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 148.58, '6e9de1db-a2a5-4c2f-9dc9-1ae11e152dd8'::uuid, '2026-09-04T04:31:55.43482+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:3867bac5-9d26-467d-9c27-10777d3a475f', 'a040ed35-98c2-4354-bb82-476c24184047'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 136.22, '72259d48-f943-44f9-801d-8a0da1640c04'::uuid, '2026-09-04T04:32:44.982642+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:9164bc07-54aa-4bda-8ea7-a157fa6b3b8c', '5e65716f-140b-44d9-8e9a-2aacf8b50d8d'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 95.15, '2755c54c-d55f-4400-babe-e9bd97ae532a'::uuid, '2026-09-04T04:32:57.169445+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:b0e3750a-e62f-4daa-a164-0f73a02fb6f6', '00000000-0000-0000-0000-000000000024'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 8.27, '7f74ec68-efdc-4457-8f8f-e5d214361e7d'::uuid, '2026-09-04T04:33:14.087088+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:8c7b4b75-4c21-467e-8ce3-952a635f8120', 'a51e2ad3-69aa-4bbc-a82c-06a6581572bf'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 67.2, '2e68aa41-cdfd-4e33-a790-e548b18ffe97'::uuid, '2026-09-04T04:33:23.690295+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:00fcf416-c748-4cc1-a9d7-15e01a1a9436', '778972f6-be6a-45c3-8f57-d37aa1adb5da'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 82.4, '3bfe7a90-5dfe-499e-a1c8-ade5909c307a'::uuid, '2026-09-04T04:48:56.025307+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:1bcf8299-9b8e-4ad6-b400-adf02faa009f', '3f26288c-4923-447a-9f0d-d5d208ab8f8d'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 281.75, '84bba14e-8090-4895-9d39-c8f02d529030'::uuid, '2026-09-04T04:52:16.079124+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a7d89b04-0a67-47f8-b451-68d147059d1d', 'ad66f252-28fb-4ffd-8242-fcafa290f852'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 5.47, '0065ba44-cd38-4190-86a0-e56ffe032caf'::uuid, '2026-09-04T04:52:22.298364+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:b09dd420-9828-4060-8701-06bf59c3393e', '00000000-0000-0000-0000-000000000022'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 110.95, '6379c52b-be60-4c59-88d7-3d8e33d58e10'::uuid, '2026-09-04T04:52:24.249263+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:05c36dbf-d345-4eeb-aa99-2e4ee6990086', '2de00543-57b1-425e-8ea0-66cb294c1de9'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 233.57, '3e272439-6a6e-44a0-be35-3db383c300c3'::uuid, '2026-09-04T04:52:31.852387+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:bccfa11b-a3e7-4f28-a8fa-5e2d5589f897', '4e6679f8-7ad4-4551-8ab6-8a1168ed95e3'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 16.84, '10326ec5-7d29-4551-b325-479a4a1c8081'::uuid, '2026-09-04T05:13:27.998631+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:0c7b1114-2bdc-4fcf-8356-bc0c6b41b550', '194e5206-bd4d-4ea5-ba2d-142c8bf8a258'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 6.86, '055afe43-5ac9-4b28-9d12-c1eafc245ba2'::uuid, '2026-09-04T05:14:09.884323+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:7c74eadf-e442-4fdc-91bb-3a0faa654ce9', '5d6f67cc-cecf-4791-b1ff-9af16e9a8554'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.21, '0469acd3-5ad2-49a4-8657-05f74bab79da'::uuid, '2026-09-04T05:20:59.586239+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:acd901c6-b038-4d25-acba-9fe8792dc53a', '1f01702e-320c-4e64-b030-e58fdd47cc07'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 52, '43900bfc-ad04-445a-a9f4-c85600a85405'::uuid, '2026-09-04T05:32:38.458558+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:23f48f07-994c-45ee-95a4-873f0595bdcd', '5d6f67cc-cecf-4791-b1ff-9af16e9a8554'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 24.55, '02bc2b37-ed39-485c-a0d9-1f4fec0a1ce7'::uuid, '2026-09-04T05:32:59.093598+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:50aac230-ca75-43c8-8416-5a39c464e80d', '6b3f4393-3ccb-491d-bce2-361b3385defe'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 132.05, '027d17b0-617f-4554-8418-a1595b86ff24'::uuid, '2026-09-04T05:35:27.145959+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:2d90039a-e1fc-4624-bd9b-bc7e8ed38c80', 'f86105e2-d694-4c7c-897e-3f0a9ee34511'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 88.62, '2e68aa41-cdfd-4e33-a790-e548b18ffe97'::uuid, '2026-09-04T05:38:21.639765+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:54336044-f851-4f5f-a6f6-3020f9cd50fe', 'f140e49c-7104-46fd-9c7f-6b2625a90305'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 108.2, '427dd418-efb4-4fc2-9fcf-3089c5a9d28b'::uuid, '2026-09-04T06:08:08.395422+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:ba4fbd45-964e-4cdb-a12d-dd4a33f6a8b0', 'b832b6c4-f58c-4b53-999b-48c9fbd1ec3c'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 16.39, '0ffc8f2b-7055-4a3e-9cc6-d2270c08ed78'::uuid, '2026-09-04T06:10:22.53913+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:84b707f7-6a41-43fe-b143-ab93e540f6b3', '0f5f1d65-7ce1-4250-93fe-49078f4f14d1'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 114.8, '9435b208-56b0-4ac1-a35d-327d08d5d5d4'::uuid, '2026-09-04T06:12:30.483652+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:8697f635-ba94-4de1-b870-114c9dc0d27b', 'ac254a0e-a02b-49be-993d-e89a5803a653'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 78.98, '18a5fd6d-0213-416f-b635-8b650f1bdd2a'::uuid, '2026-09-04T06:14:30.310635+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:13dd4767-4367-4601-9d2a-f16e18527d49', 'b474bb12-d6ec-4ea0-b661-58811b604b97'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 46.5, '0c68c138-c3ed-4088-ad5e-318fea4b9e7e'::uuid, '2026-09-04T06:15:44.185439+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:ae6841eb-8cae-49bc-91da-579dc7333eeb', 'b832b6c4-f58c-4b53-999b-48c9fbd1ec3c'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.52, '1127c1fa-07fa-4421-9f1b-19c298d9e5e2'::uuid, '2026-09-04T06:15:45.113917+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:24cf7e85-a961-41c7-836f-c7992e56768f', '15165d49-c7b3-42bc-b2e9-f46195e151ec'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 90.8, '8321e592-06da-4906-a7b2-db5538b75407'::uuid, '2026-09-04T06:16:14.855637+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:82d5511f-a433-43fe-a003-ff42c04cf933', '06f16138-70cd-49e5-89b3-aec698118b81'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 72.25, '03cf3726-75c3-40fd-a4dc-e3daf095a39e'::uuid, '2026-09-04T06:16:51.800987+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:68931803-16f4-4391-9e7a-a0ed68401039', '775f4778-ceda-44bb-a26b-7c4194c8c0c1'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 56.85, '54358ddd-d004-4438-8fcc-45e9ed3b1f6f'::uuid, '2026-09-04T06:17:09.365015+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:9100a4ed-f5e9-4fcf-b4c6-be46f07f3323', '9a195ad3-15f3-4b47-aa0b-2d5f0634462b'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 131, '8e4b0480-ab17-4fc7-a261-ac2e1eacfddd'::uuid, '2026-09-04T06:18:16.89414+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:6ba04ba4-d0e0-4a25-84fe-256d1d69316b', '31ba2b56-e3f9-40a8-b1e9-d301267a1cef'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 7, '0222580c-3af4-412f-857e-a363864eaf40'::uuid, '2026-09-04T06:30:01.45849+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:1c7e4589-030c-475c-a40e-d38b72a49ced', '62611529-4764-4634-bc1c-a596a4ae428f'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 47.34, '0bf4d17f-79b1-41d5-ae8c-6ad517e9dd81'::uuid, '2026-09-04T06:30:41.007515+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:af14f163-8c5f-4ea1-9efd-5b6696d59dc7', 'f86105e2-d694-4c7c-897e-3f0a9ee34511'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 67.95, '2e68aa41-cdfd-4e33-a790-e548b18ffe97'::uuid, '2026-09-04T06:31:17.051868+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:2199a85e-9de5-4a33-bac2-1475a37eb5b5', '31ba2b56-e3f9-40a8-b1e9-d301267a1cef'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 6, '0222580c-3af4-412f-857e-a363864eaf40'::uuid, '2026-09-04T06:33:33.811183+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:2945f401-7a6b-4513-a27d-234ddce75e51', '778f8033-c9e2-45fa-98ca-935f38e2b8ca'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 620.5, 'ec090cbf-ecd5-49a0-a92d-8a9084027548'::uuid, '2026-09-04T06:33:35.547848+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:448577f2-ee7c-4bfa-92a6-a6763cee0640', '67031c9c-6286-49d6-b00b-893737522f3b'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 4.53, '0eb1ec73-5a47-408d-928b-7beb51c8a883'::uuid, '2026-09-04T06:35:18.35767+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:2aabcbcc-6563-4eee-9997-79d71c009d0c', '778f8033-c9e2-45fa-98ca-935f38e2b8ca'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 520.5, 'ec090cbf-ecd5-49a0-a92d-8a9084027548'::uuid, '2026-09-04T06:35:53.194347+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:648a8188-f3f9-43d5-850a-1fa2f55ddb66', '6b8edb63-36e5-478b-ac6e-cd1021334a0d'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 58, '590c4f3d-8ea8-4530-b23a-ad3e56b53592'::uuid, '2026-09-04T06:36:00.175434+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:d5cb31e0-6526-4716-a29b-23f35b01bf91', '15165d49-c7b3-42bc-b2e9-f46195e151ec'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 159.1, '8321e592-06da-4906-a7b2-db5538b75407'::uuid, '2026-09-04T06:40:08.137113+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:99081d02-56cd-44e4-b94c-714c1a3dde8b', '5d6f67cc-cecf-4791-b1ff-9af16e9a8554'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.43, '01bd71ea-6f5e-4f06-b321-0e2ae3429828'::uuid, '2026-09-04T06:42:43.931944+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:ea32bbf8-6d5e-40d8-b30f-554224a6df87', 'ac254a0e-a02b-49be-993d-e89a5803a653'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 99.26, '18a5fd6d-0213-416f-b635-8b650f1bdd2a'::uuid, '2026-09-04T06:52:02.776238+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:7fff485d-9156-4025-9e23-6aac4f33a8d2', 'd33a878b-e189-4bd4-aeb8-d9d4acf6cb34'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 140.6, '428eb653-2670-4332-8663-c956f45657c7'::uuid, '2026-09-04T07:04:00.651867+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:5ad3532c-2f72-43d4-abc3-0421e89ea701', '66188599-c421-42fa-a36f-d5ebfea530af'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.62, '007bba08-5fd3-4a99-abd9-57a306445c07'::uuid, '2026-09-04T07:10:05.357959+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:e82e035b-b5c1-4c0c-99dd-c9f8e62b1cae', '7ef06129-f9fe-4180-9528-f210037f846c'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 119.75, '28bb8da5-c5aa-4c52-a3bb-5acda073b889'::uuid, '2026-09-04T07:10:05.367434+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:7992624f-a9e9-48a6-9361-bba988b3330d', '98879512-5e3e-4dad-827d-6e62c950642d'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.46, '01bd71ea-6f5e-4f06-b321-0e2ae3429828'::uuid, '2026-09-04T07:16:04.448907+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:82e53f07-74a8-4c5e-aad6-ba1fe92817d7', 'cda69887-ebc4-47e5-a4ce-6e3c810b168c'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 79.45, '60e8e090-b288-4897-92b8-4a39bcb00e23'::uuid, '2026-09-04T07:17:06.751426+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:3204c710-e205-4d12-b66e-f689c1203d2f', 'ef58b642-df26-41b5-8547-bb279151e844'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 14.13, 'a9df3b40-7ce0-44fb-a538-00d3e08b4670'::uuid, '2026-09-04T07:19:02.209726+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:ba684405-1c26-40d7-8d2d-56725ecf6251', '8201618c-0e6a-4d0b-af2f-056156e8b608'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 133.19, '30a38546-02d2-4676-aa92-4c04147bdb21'::uuid, '2026-09-04T07:20:38.986641+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:63eb891c-a5a8-4106-b053-3877df4da536', '8bdb54a1-d614-4932-84fa-795dd4728828'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 46.22, '144007db-d1e8-4cce-934b-e89bc4fa20c8'::uuid, '2026-09-04T07:20:49.707629+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:f7eecc76-86d6-42ec-86e1-fe3a2a5a69d8', 'd4133457-8650-42b6-ab32-3af289b76d16'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 33.61, '03be468d-8c6b-45cb-adfa-4b2542e47da4'::uuid, '2026-09-04T07:21:01.719215+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:71d601f2-2b9e-4459-8c6f-8d8ff3c20754', '34e5b497-f995-4089-9dda-2c2ec6817aeb'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 213.4, '8321e592-06da-4906-a7b2-db5538b75407'::uuid, '2026-09-04T07:24:00.755224+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:5e7984e6-bcf0-4db9-8260-0905db87a2c3', 'aba9beb0-16b9-420a-8247-f5ceabe76b47'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 138.1, '48b5ecba-c73b-4386-af35-cfd90156573f'::uuid, '2026-09-04T07:25:04.306759+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a29e5232-0638-4801-a20e-5f48a326495f', '778cab7d-2b73-4f48-b617-bf5fec0c59ed'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 159, 'ab74db5f-aa64-4633-9a43-399c2368e813'::uuid, '2026-09-04T07:40:15.624539+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:fd8cd080-c01a-48bf-8ae3-6631e3e49fa4', 'efe5c57a-4a17-4281-b26d-aa6efe782422'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.26, '01bd71ea-6f5e-4f06-b321-0e2ae3429828'::uuid, '2026-09-04T07:40:46.733409+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:e6a2cc99-c6b1-4454-92b1-886ec2c65454', '813ddbd7-65df-4086-8556-3ea7c16ab870'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 140.15, '16f75832-3463-44bf-a4b7-446c7c6016e7'::uuid, '2026-09-04T07:44:58.057537+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:455b511e-1fed-4182-90e7-0bc9b215486f', '1545d652-3c85-429f-9354-a753dd6c8afe'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 487.98, '01a7caee-9d09-40c3-933c-bd4a85bf3b00'::uuid, '2026-09-04T07:45:22.508278+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:f310763a-eacd-46b2-bfc5-98b481fb1024', '4182bdc2-b78b-490d-a02f-07f19aa8c070'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 119.4, 'f8183ce8-37d0-430d-916a-2c4ecda93fe7'::uuid, '2026-09-04T07:45:31.184823+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:33821a02-f08c-4091-99de-0cb18807c0ac', 'ac254a0e-a02b-49be-993d-e89a5803a653'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 80.73, '4a25dd8a-bd59-4568-8f58-3dc4de78bf72'::uuid, '2026-09-04T07:46:20.47285+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:5c3fdeee-5b82-44df-a7d5-3ca2b77fdf6f', '3ac76bbb-de77-4f26-b2b9-c3408b5bbf1d'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 7.22, '1e47c4dc-2087-4053-bb4d-eaaf30166d27'::uuid, '2026-09-04T07:46:31.556047+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:c37fd596-961f-46f0-a92d-671177e168ed', '1545d652-3c85-429f-9354-a753dd6c8afe'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 387.98, '01a7caee-9d09-40c3-933c-bd4a85bf3b00'::uuid, '2026-09-04T07:47:45.834707+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:68107bc3-43d8-4d6b-a6c5-b683672afa2c', '66188599-c421-42fa-a36f-d5ebfea530af'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.37, '007bba08-5fd3-4a99-abd9-57a306445c07'::uuid, '2026-09-04T07:47:52.716645+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:c0f1c606-05f0-4de7-bd4a-a3c7dfd0fe83', 'c6dbc079-20e5-4df3-a2f7-f335460c632c'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 241.1, '01a7caee-9d09-40c3-933c-bd4a85bf3b00'::uuid, '2026-09-04T07:50:54.098644+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:f631436d-a304-4a3d-869f-bdc5d133e997', '387b6e20-0019-429c-b8c1-e6bf5f8e7538'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 1.62, '0aed63aa-6273-44cf-b099-8c2a631c1b41'::uuid, '2026-09-04T07:50:55.656363+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:797d3a94-262e-4b09-909b-5e06ee0f67bb', 'd2ce100a-152e-4b0e-8903-2296a9cb7cbe'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 57.2, '130a98d0-90b3-4e6a-acb6-db531464957f'::uuid, '2026-09-04T07:51:01.633032+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:123e8c84-7371-4e81-b06b-c1cb9a48d4b7', '66188599-c421-42fa-a36f-d5ebfea530af'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.01, '007bba08-5fd3-4a99-abd9-57a306445c07'::uuid, '2026-09-04T07:52:12.47399+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:797ac097-1b32-4b32-8449-92c81f2c353c', 'eba463f8-2c66-4592-b304-3afc3f7f2c93'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 48.25, '54358ddd-d004-4438-8fcc-45e9ed3b1f6f'::uuid, '2026-09-04T07:52:16.953496+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:e5a2afc8-ae39-4767-abc3-bc78b819a23e', '4ce9fa05-703f-40e4-a14e-40cffc3ba305'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 67.5, '590c4f3d-8ea8-4530-b23a-ad3e56b53592'::uuid, '2026-09-04T07:52:34.553984+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:d76dd15c-9359-413e-a2e9-94b79b957dfb', 'd33a878b-e189-4bd4-aeb8-d9d4acf6cb34'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 138.71, '1f34967d-d8bf-44e0-9531-ab40c53a0315'::uuid, '2026-09-04T08:01:26.822165+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:7b86303d-af26-41c8-be3b-f5493e1be180', '775f4778-ceda-44bb-a26b-7c4194c8c0c1'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 94.4, '54358ddd-d004-4438-8fcc-45e9ed3b1f6f'::uuid, '2026-09-04T08:07:17.431377+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:7559f26b-25be-47bc-bbae-ac401f53b28f', 'cf8e99b0-7b65-4a2c-95c2-ff55f054c6ec'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 136.69, '027d17b0-617f-4554-8418-a1595b86ff24'::uuid, '2026-09-04T08:10:10.266142+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:38e98f03-a8b4-4e43-8124-45cb2a0ad732', '1c1c117c-bf60-4282-810c-0658f2528e11'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 15.15, '10326ec5-7d29-4551-b325-479a4a1c8081'::uuid, '2026-09-04T08:11:50.404776+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:dd35e63b-0e9d-4728-bcf4-cd565d8ae5a7', '2e26ae7c-0d4a-42da-b8ee-90a498eb25dd'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 169, '39ce3371-aac6-4122-a5d2-550a5cd5a748'::uuid, '2026-09-04T08:12:07.811161+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:239247a6-f78a-43d0-a32a-085e0239aa1f', 'f9a23390-1b4a-4ee3-bf08-84679cd28596'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 307.39, '01a7caee-9d09-40c3-933c-bd4a85bf3b00'::uuid, '2026-09-04T08:14:03.828559+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:564390f6-4550-4419-a6cc-833a1df0164d', 'd311fcf5-37da-49a7-b925-63f316a80355'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 3.19, '58c3e3ef-376d-4167-b5ff-8ed41ebd5ea1'::uuid, '2026-09-04T08:25:17.153534+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:9dc72be9-b629-4a6a-af88-98e77b89f8ce', '00000000-0000-0000-0000-000000000034'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 110.7, '5ecbacef-7129-4bcc-90f1-36db6cc00469'::uuid, '2026-09-04T08:26:54.98016+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:0c737d27-3c45-40e0-af8e-bc9256d73ca4', '2c73e303-bb61-4593-bcea-8debad14b6cc'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 73.15, '54358ddd-d004-4438-8fcc-45e9ed3b1f6f'::uuid, '2026-09-04T08:31:30.696506+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:20a627cb-a845-4920-a4f9-abb7273484ad', 'c1b575fb-3efd-43b6-b314-353e1d300aaa'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 162.69, 'ab74db5f-aa64-4633-9a43-399c2368e813'::uuid, '2026-09-04T08:36:12.039664+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:db0d0537-b341-4943-94c5-9989b7f96944', '484d22c4-ff3c-4430-8058-b6f0d8c2387a'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 1253, 'a81728eb-a8ff-4761-89f5-b3466e6a24f8'::uuid, '2026-09-04T08:36:43.682167+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:d0df26bc-89a9-47b3-82c3-0fa23cce681f', '2c73e303-bb61-4593-bcea-8debad14b6cc'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 53.15, '54358ddd-d004-4438-8fcc-45e9ed3b1f6f'::uuid, '2026-09-04T08:36:53.073697+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:88b43e6e-2d3b-415c-847a-d067e9fd5ed3', '79a7f270-a3d9-495a-b5f3-a7b7600374f8'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.29, '15251a24-d0ca-4391-9c85-9b0f851470f3'::uuid, '2026-09-04T08:39:33.262987+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:76ddefd7-8149-41f5-8883-55ca45db7732', '650f193e-e50c-4239-b243-eb25384a4ae7'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 7.59, '0222580c-3af4-412f-857e-a363864eaf40'::uuid, '2026-09-04T08:39:43.574332+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:fb900bfe-61ad-4a08-81d8-2c37ff9de30f', '29aff535-d3b2-4d9e-9417-0452241f798e'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 13.82, '07b34bbf-6060-45f0-8af0-24feee3f9ea2'::uuid, '2026-09-04T08:43:26.252797+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:bcb890c6-c535-4556-966f-cfe2111763e1', '387b6e20-0019-429c-b8c1-e6bf5f8e7538'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 27.51, '860e24cf-eb52-4bcb-9567-824699c93191'::uuid, '2026-09-04T08:43:41.023645+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a54eff75-e72c-4bbe-b654-5dd71287434f', '62f0d4da-b736-4629-ad14-894e432d0f04'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 133.72, '9cf99577-0dcc-44e6-8b00-23dc0904db25'::uuid, '2026-09-04T08:44:02.832132+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:ef3229be-941b-473d-a400-6f9a8ee2b86a', '29aff535-d3b2-4d9e-9417-0452241f798e'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 13.82, '07b34bbf-6060-45f0-8af0-24feee3f9ea2'::uuid, '2026-09-04T08:45:14.526639+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:c8eb2d17-b2ee-406b-9bd6-e1e3d242d964', '62f0d4da-b736-4629-ad14-894e432d0f04'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 139.72, '9cf99577-0dcc-44e6-8b00-23dc0904db25'::uuid, '2026-09-04T08:47:22.739434+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:822b6fbc-06e7-4f0d-b830-050e35bac427', '5d2f60d0-6eb0-4f7e-a968-8eedf3b282f1'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 16.63, '13e021cb-2512-46df-bfb3-897870f17fdb'::uuid, '2026-09-04T09:17:54.312729+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:4f34902d-e0ae-4a0a-88f2-d4f91f00a5d2', '1f01702e-320c-4e64-b030-e58fdd47cc07'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 67.84, '43900bfc-ad04-445a-a9f4-c85600a85405'::uuid, '2026-09-04T09:21:07.586875+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:2b117c3e-9b64-4b4e-9990-acdcad9c5eba', '1f01702e-320c-4e64-b030-e58fdd47cc07'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 81.34, '43900bfc-ad04-445a-a9f4-c85600a85405'::uuid, '2026-09-04T09:22:24.307486+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:f41e38e8-2835-45fe-81e1-2c4da55a1f76', '42e7863d-54dc-415e-8c10-89f50aa26171'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.41, '1127c1fa-07fa-4421-9f1b-19c298d9e5e2'::uuid, '2026-09-04T09:26:53.992762+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a8d3b981-0671-40f1-a90c-4435cf163f07', '3061ba63-e7ed-4537-8b62-9d2c0a8c420a'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 46, '4860d7a1-9579-4841-9a3d-b1adbc9395fd'::uuid, '2026-09-04T09:30:09.591007+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:88f454b3-f333-4c33-ad3d-7dcad6c9c8ed', 'f12caf56-c369-4b22-8e04-fdda07820876'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 123.85, '48b5ecba-c73b-4386-af35-cfd90156573f'::uuid, '2026-09-04T09:31:33.199428+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:9c9b0f94-ce9e-45c8-a13c-17ed0627e625', '9e5d90d4-efff-49e8-a93e-29d755eed6ca'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 5.9, '031dfe93-e96b-45f3-b5ba-55e69a21e35a'::uuid, '2026-09-04T09:31:33.20829+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:716c3837-5889-4434-ad70-a4ffee51bf62', '3ac76bbb-de77-4f26-b2b9-c3408b5bbf1d'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 5.17, '27a2000d-8dd7-49f5-9333-99c52f93017a'::uuid, '2026-09-04T09:32:31.756174+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:f9c356bf-0f9f-4ece-970b-7dc48a70bd11', '8b3b6f26-589a-4532-8392-003fddfb7d1b'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 1.45, '9161f88b-1924-4962-a0ce-bc77f46a98b1'::uuid, '2026-09-04T09:34:54.76613+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:ba92162b-45b3-446b-bdf6-1e0122b056a9', '0ce13c54-930f-48b5-93a9-df7a38e90b7f'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 81.7, '4e67d9ed-da14-4895-b372-4ad1d6d9735c'::uuid, '2026-09-04T09:36:04.285052+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:027fbf3b-fcda-4b56-bb9a-8fe816cedca5', '3061ba63-e7ed-4537-8b62-9d2c0a8c420a'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 61.83, '4860d7a1-9579-4841-9a3d-b1adbc9395fd'::uuid, '2026-09-04T09:36:27.009391+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:9478c253-6e45-497d-946e-2b13f5a3d0f8', '8b3b6f26-589a-4532-8392-003fddfb7d1b'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 1.3, '9161f88b-1924-4962-a0ce-bc77f46a98b1'::uuid, '2026-09-04T09:39:05.039403+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:ed0b1ca4-d245-46da-8a19-f568fe4725d0', '0a8005e8-5d79-4d8f-809e-e9951ef74651'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 5.21, '0065ba44-cd38-4190-86a0-e56ffe032caf'::uuid, '2026-09-04T09:39:42.56615+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:ab226faf-fe7f-4c9d-9485-28fb706f0a2f', '6d6b3cc2-f6bf-4ea6-bffb-5e450625ef02'::uuid, 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 14.06, '19ae6284-4fb9-4cb9-a524-1bd0c522b9eb'::uuid, '2026-09-04T09:47:06.53704+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:92c9fe05-1197-42bb-988d-d64a2cedc940', '92655975-8766-4c4d-b266-a822055dc6e3'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 149, '72259d48-f943-44f9-801d-8a0da1640c04'::uuid, '2026-09-04T09:47:58.89459+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:b2d50689-795c-4a9b-826d-9bbccf085216', '07db1c71-d567-46dd-8f92-e922b6d470ae'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 6.42, '1e47c4dc-2087-4053-bb4d-eaaf30166d27'::uuid, '2026-09-04T09:48:07.763+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:5b55dfe3-4b2c-4476-b1ba-7063d2951263', '1179f15e-dac7-4b7e-80df-5e525a498ddd'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 92.55, '428eb653-2670-4332-8663-c956f45657c7'::uuid, '2026-09-04T09:48:22.506504+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:285d83f2-303e-4bed-b811-c5c875095580', 'd07cf5cf-9aab-4e9f-b281-e243536778ee'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 23.89, 'a9df3b40-7ce0-44fb-a538-00d3e08b4670'::uuid, '2026-09-04T09:51:00.560322+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:1d5308cd-b01b-47a8-9236-a1dd817edca7', '1179f15e-dac7-4b7e-80df-5e525a498ddd'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 138.65, '428eb653-2670-4332-8663-c956f45657c7'::uuid, '2026-09-04T09:52:44.574939+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:e49bdad3-dda4-4b73-aed4-76ddb7a4d829', 'c401b45c-8a60-4480-9900-f452454d77be'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 66.38, '0c68c138-c3ed-4088-ad5e-318fea4b9e7e'::uuid, '2026-09-04T09:52:46.910269+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a97e74a2-865a-4694-bb37-d54b99a0a95c', 'c698bb3a-2245-4b35-a75c-43bd0649a133'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 1.47, '0aed63aa-6273-44cf-b099-8c2a631c1b41'::uuid, '2026-09-04T10:09:06.072315+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:092b9bad-b2dc-440e-84ac-4ca476f7e25a', '66417bd4-c8e5-4666-af6f-3d85a43593d9'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.49, '007bba08-5fd3-4a99-abd9-57a306445c07'::uuid, '2026-09-04T10:09:10.261581+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:e9ca166f-5f27-4070-83d9-f9a41c106874', '63de1ab9-12ac-4049-b0fe-eec4993e9fb0'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 151.9, '28bb8da5-c5aa-4c52-a3bb-5acda073b889'::uuid, '2026-09-04T10:10:43.474356+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:1c4af1af-e8d8-4b31-9ff2-ba9c2d8f5c80', '441938f0-4fb5-4ce0-b17e-0e95caeb8cc0'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 35.99, '00a6fec9-1f15-4f23-af9b-286ed1df0b01'::uuid, '2026-09-04T10:11:25.820917+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:e7b4d920-0db3-4f24-8a72-7051622f734f', 'f84fc8f2-6a0d-4702-a120-c0e5225fb57e'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 47.51, '33e8b29e-cee4-4138-a2b8-239d9a41447f'::uuid, '2026-09-04T10:14:58.566336+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:f853536e-7c99-432b-bcdc-5c5c2af64fb2', '62611529-4764-4634-bc1c-a596a4ae428f'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 94.35, '471ad6c6-685d-4fa4-ab3b-cc02b61cb3c4'::uuid, '2026-09-04T10:30:24.714828+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:7aec95d8-bf7e-4d3c-acc7-8cd725eb3ac4', '34e5b497-f995-4089-9dda-2c2ec6817aeb'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 54.16, '2c6104e0-f818-40ec-8275-dec56d142ea2'::uuid, '2026-09-04T10:31:27.295857+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:572e2524-a282-4b9f-bcc3-81ee6296ec03', 'cddb2fa8-143a-46c8-8c1c-25b9dd78ec26'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 57.98, '0bf4d17f-79b1-41d5-ae8c-6ad517e9dd81'::uuid, '2026-09-04T10:32:02.839424+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:457bfdcd-ac40-4cee-b0da-5876509bc230', '7f99084b-e99a-4312-a258-1be6451c0c8b'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 166.28, '9435b208-56b0-4ac1-a35d-327d08d5d5d4'::uuid, '2026-09-04T10:33:36.566204+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:e854a2b1-2a68-4892-847e-218c6f179a20', '3086452e-9b29-47eb-b6f8-5a9692889753'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 74.26, '0200346f-e8a4-4aa2-a994-6b696f8ede84'::uuid, '2026-09-04T10:33:49.373336+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:a327d970-d554-4e45-b1b0-83180e81465b', 'c92d92ba-2358-41e7-bc22-13107f718ec9'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 15.16, '036680d0-38cd-4757-8b1e-36ad75a7d1de'::uuid, '2026-09-04T10:36:39.885868+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:bc86c006-1081-42dd-8774-78612ec3fe27', '6f9ee58e-e1e4-446d-bfa8-7d10d1af0aaf'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 62.1, '0c68c138-c3ed-4088-ad5e-318fea4b9e7e'::uuid, '2026-09-04T10:38:01.260025+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:b37daf37-af67-468e-afad-65d0dd70e61f', 'e0f03a88-afc3-448f-835a-e8e323d09b57'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 27.37, '07ad4631-99d0-4c0e-af67-426c3a48ba1e'::uuid, '2026-09-04T10:39:24.993353+00:00'::timestamptz),
    ('seat_credit_erased:pending_addon:cdfb380f-74ab-4a15-b525-889482bd7a5d', '5d6f67cc-cecf-4791-b1ff-9af16e9a8554'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 1.13, '01bd71ea-6f5e-4f06-b321-0e2ae3429828'::uuid, '2026-09-04T10:40:01.470678+00:00'::timestamptz),
    ('seat_credit_erased:addon_leg:633791f3-a8dc-40c1-af45-a0d0d90c1c0c', '00000000-0000-0000-0000-000000000027'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 28.87, '860e24cf-eb52-4bcb-9567-824699c93191'::uuid, '2026-09-04T10:44:52.866129+00:00'::timestamptz);

  SELECT count(*), round(sum(amount), 2) INTO v_n, v_total FROM erased;
  IF v_n <> 282 OR v_total <> 33626.88 THEN
    RAISE EXCEPTION 'restoration list does not match the probe: % rows / % chips (expected 282 / 33626.88)', v_n, v_total;
  END IF;

  -- Every row still describes a real, applied, un-restored credit.
  SELECT count(*) INTO v_bad FROM erased e
   WHERE NOT (
        EXISTS (SELECT 1 FROM public.table_pending_addons pa
                 WHERE e.key = 'seat_credit_erased:pending_addon:' || pa.id::text
                   AND pa.user_id = e.user_id AND pa.table_id = e.table_id
                   AND round(pa.applied_to_stack, 2) = round(e.amount, 2)
                   AND pa.resolved_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.chip_ledger l
                 WHERE e.key = 'seat_credit_erased:addon_leg:' || l.id::text
                   AND l.category = 'addon' AND l.from_type = 'player_wallet' AND l.to_type = 'table_stack'
                   AND l.from_entity_id = e.user_id AND l.to_entity_id = e.table_id
                   AND round(l.amount, 2) = round(e.amount, 2)))
      OR EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = e.key)
      OR NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = e.user_id AND m.club_id = e.club_id);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'the board moved: % row(s) no longer match their pending-add-on row, are already restored, or have no club wallet - nothing restored', v_bad;
  END IF;

  FOR r IN SELECT * FROM erased ORDER BY credited_at LOOP
    v_res := public.fn_ca_restore_erased_seat_credit(
      r.key, r.user_id, r.club_id, r.amount, r.table_id,
      format('Add-on restored to your club wallet: %s chips applied to your seat at %s were erased by the next hand''s stack write (platform defect, fixed 2026-09-04)',
             r.amount, to_char(r.credited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC'));
    IF NOT COALESCE((v_res->>'restored')::boolean, false) THEN
      RAISE EXCEPTION 'restoration refused for %: %', r.key, v_res;
    END IF;
    v_restored := v_restored + 1; v_sum := v_sum + r.amount;
  END LOOP;

  IF v_restored <> 282 OR round(v_sum, 2) <> 33626.88 THEN
    RAISE EXCEPTION 'restored % / % - expected 282 / 33626.88; rolled back', v_restored, round(v_sum, 2);
  END IF;

  -- Post-commit shape: one journal row and one register row per key.
  SELECT count(*) INTO v_bad FROM erased e
   WHERE NOT EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key = e.key
                        AND l.from_type = 'issuance_reserve' AND l.to_type = 'player_wallet' AND l.amount = e.amount)
      OR NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.op_id = e.key AND m.action = 'mint' AND m.amount = e.amount);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% restoration(s) left no journal or register row - rolled back', v_bad;
  END IF;
  RAISE NOTICE 'restored % erased seat credits, % chips', v_restored, round(v_sum, 2);
END $$;
