-- KEPT. (h) A full-count card set where one row belongs to a user and seat
-- that are not in the roster. The orphan test is carried across untouched and
-- must still refuse; the count alone would not catch this.
\set ON_ERROR_STOP on
BEGIN;
SELECT probe.deal('2c621856-e728-4e8b-bf08-4c56746a8649',12942021,ARRAY[1]);
SELECT probe.deal('bbbb1111-0000-4000-8000-00000000000b',900001,ARRAY[1]);
INSERT INTO public.table_hole_cards(table_id,hand_number,user_id,seat_number,cards,created_at) VALUES
 ('2c621856-e728-4e8b-bf08-4c56746a8649',12942021,'ffff9999-0000-4000-8000-000000000009',9,'["Qs","Jc"]',now()),
 ('bbbb1111-0000-4000-8000-00000000000b',900001,'ffff9999-0000-4000-8000-000000000009',9,'["Qs","Jc"]',now());
SELECT probe.expect_inert_both(false, 'a card row exists at all, so condition 1 fails');
SELECT probe.expect_both('REFUSED', 'a card row whose user and seat are not in the roster');
COMMIT;
