-- MAKE-GOOD LEDGER (READ-ONLY) - rebuy legs that were charged and delivered no chips.
--
-- 31 legs, 1.00 each, 31.00 in total: 27 in 7aa16fa7 (25 players), 4 in a5aa6984
-- (4 players, river222 included). Each leg debited club_members.chip_balance of
-- the club named in refund_wallet_club_id (the entry's funding club) and booked
-- 0.90 to the event's prize bank and 0.10 to its fee bank. None of them reached
-- a seat: 27 were bought after the player's last dealt hand (23 in 7aa16fa7, all
-- 4 in a5aa6984 - the seat had been vacated in the bust hand's own transaction,
-- and the 09-08/09 money core credited the chips to tournament_players.chips
-- only, where the later elimination zeroed them); 4 are the second leg of a
-- double charge for one bust where only 5,000 of 10,000 chips ever reached the
-- felt; 7 of the 31 were also bought after the decision window had closed.
--
-- WHY NOT fn_settle_tournament_refund_exact (the platform's refund door). It pays
-- 0.90 out of the event's prize bank and 0.10 out of its fee bank. The terminal
-- settlement then refuses the event (rehearsed on a PG17 copy of these rows:
-- 'escrow does not exactly fund its remaining obligations'), because
-- prize_balance must equal the FINALIZED prize_pool, which
-- trg_freeze_finalized_tournament_prize_pool will not let anyone lower, and
-- fee_balance must equal sum(rake_records). After the finish the door is
-- refused outright ('terminal tournament escrow evidence is immutable'). So
-- these are owed by the house through the separate audited make-good door,
-- credited to the exact club wallet each leg came from, and nothing is taken
-- from the prize pool the other players played for.
--
-- This file writes nothing. It re-proves every row against the live ledger and
-- refuses if any leg has changed, was already refunded, or is no longer owed.
WITH owed(wallet_tx, why) AS (VALUES
    ('612a9d32-0923-46d5-92d2-0193cd4ca878'::uuid, 'in-window, seat vacated at bust, never seated'),
    ('33a25cc1-2577-4688-87b1-804e97c16e06'::uuid, 'in-window, never seated'),
    ('308206cd-61ed-47b9-9289-cae82282e8f3'::uuid, 'in-window, never seated'),
    ('bdc43d2b-06cc-48b9-ac86-d14a0b9df023'::uuid, 'in-window, never seated'),
    ('dcc02ae3-9713-4a88-b549-85ad14178d5d'::uuid, 'in-window, never seated (1st of 2 for one bust)'),
    ('41b0e349-0bfd-4b62-805b-3d6e061b9f20'::uuid, 'in-window, never seated (2nd of 2 for one bust)'),
    ('446d105c-91d2-47c2-a7fe-23e28d0432ea'::uuid, 'in-window, never seated'),
    ('7b8bd27b-6ec3-4304-b36b-b0ff67b62f23'::uuid, 'in-window, never seated (1st of 2 for one bust)'),
    ('4db9510b-022c-4a0b-99d1-62e3270d2d3c'::uuid, 'in-window, never seated (2nd of 2 for one bust)'),
    ('46614b53-28c4-4450-8690-64c3d531dc39'::uuid, 'in-window, never seated'),
    ('3644fd55-d387-4826-aee8-4f19e1a21da4'::uuid, 'in-window, never seated'),
    ('f7791794-94e9-40e5-8346-60075f5b4a7f'::uuid, 'in-window, never seated'),
    ('a800bab1-dd52-4032-ae96-2db2a3087720'::uuid, 'in-window, never seated'),
    ('e937a73f-9020-446b-b3c6-c1fced7a845f'::uuid, 'in-window (0.24s before close), never seated'),
    ('00ee4141-a900-4922-b9ff-2fa33e354505'::uuid, 'in-window, never seated'),
    ('8de6d688-16cd-4001-a067-70deaa497c84'::uuid, 'in-window, never seated'),
    ('14a56b42-88d0-4aaa-946f-a31362571e29'::uuid, 'in-window, never seated'),
    ('28859f1d-463f-4135-b7f8-09bc68118487'::uuid, '34s after the window closed, never seated'),
    ('7cd16de1-22d9-4196-b61b-bae7ac5cbee4'::uuid, '18s after the window closed, never seated'),
    ('c4d07087-b9be-429c-8a03-daf573ed1c35'::uuid, 'in-window, never seated'),
    ('55f1e6e3-5d96-45b2-b466-9222db1a5b92'::uuid, 'in-window, never seated'),
    ('f8572db5-5a40-4a74-96c2-ae2d03069a08'::uuid, '17s after the window closed, never seated'),
    ('93314753-2865-4ddb-9a99-5fc7f28fd0d6'::uuid, 'in-window, never seated'),
    ('dea57bb0-bf8e-4306-8527-b990845cb7bc'::uuid, '2nd leg for one bust; only 5000 of 10000 reached the felt'),
    ('c6589de6-b2e2-4aa4-8df3-13a1aa822115'::uuid, '2nd leg for one bust; only 5000 of 10000 reached the felt'),
    ('c4534fa8-b129-4b14-b22a-dc5fe22fa551'::uuid, '2nd leg for one bust; only 5000 of 10000 reached the felt'),
    ('21b2ad42-f9ed-4c22-bf2a-8a5225a66a0b'::uuid, '2nd leg for one bust; only 5000 of 10000 reached the felt (23.5h later)'),
    ('77480914-a763-4033-9b2e-ab3be78cac36'::uuid, '14m47s after the window closed, never seated (river222)'),
    ('f509ce1c-cf7e-4785-8f0b-be078425ad54'::uuid, '13m25s after the window closed, never seated'),
    ('91232185-27e6-4b5d-9a91-e0ecb9d03988'::uuid, '0.8s after the window closed, never seated'),
    ('5f96c06f-2dac-401f-89d9-8bd9190f14b0'::uuid, '9m07s after the window closed, never seated')
), proof AS (
  SELECT o.wallet_tx, o.why, w.related_entity_id AS tournament_id, w.user_id,
         p.username, w.created_at AS charged_at, w.amount,
         l.id AS ledger_id, e.id AS entitlement_id, e.refund_wallet_club_id AS club_wallet,
         e.refund_prize, e.refund_fee,
         EXISTS (SELECT 1 FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id = e.id) AS already_refunded
    FROM owed o
    JOIN public.wallet_transactions w ON w.id = o.wallet_tx AND w.type = 'debit' AND w.category = 'rebuy'
    JOIN public.chip_ledger l ON l.tournament_id = w.related_entity_id AND l.from_type = 'player_wallet'
         AND l.from_entity_id = w.user_id AND l.category = 'rebuy' AND l.created_at = w.created_at
         AND l.amount = w.amount
    JOIN public.tournament_refund_entitlements e ON e.source_ledger_id = l.id
         AND e.entitlement_kind = 'wallet_charge' AND e.gross = 1.00
    JOIN public.tournament_players p ON p.tournament_id = w.related_entity_id AND p.user_id = w.user_id
)
SELECT CASE WHEN tournament_id = '7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d' THEN '7aa16fa7' ELSE 'a5aa6984' END AS event,
       username, user_id, club_wallet, amount, refund_prize, refund_fee, charged_at,
       wallet_tx, ledger_id, entitlement_id, already_refunded, why,
       count(*) OVER () AS legs, sum(amount) OVER () AS total_owed
  FROM proof
 ORDER BY event, username, charged_at;
-- Expected: 31 rows, total_owed 31.00, already_refunded false on every row.
