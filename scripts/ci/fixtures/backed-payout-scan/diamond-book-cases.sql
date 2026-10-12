-- Diamond book cases (2026-10-09). Every expected delta is written by hand
-- from the rows below, independently of either formula.
--
-- A platform Diamond event (club asset 'diamonds', is_platform, no union on
-- the club or the event) keeps its book in poker_diamond_tournament_ledger,
-- not in wallet_transactions. The shared fixture never needed either table.
CREATE TABLE public.clubs(id uuid PRIMARY KEY, asset text, is_platform boolean, union_id uuid);
ALTER TABLE public.tournaments ADD COLUMN union_id uuid;
CREATE TABLE public.poker_diamond_tournament_ledger(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tournament_id uuid, kind text,
 amount numeric DEFAULT 0, prize_part numeric DEFAULT 0, bounty_part numeric DEFAULT 0,
 fee_part numeric DEFAULT 0);
CREATE INDEX ON public.poker_diamond_tournament_ledger(tournament_id);
INSERT INTO clubs(id,asset,is_platform,union_id) VALUES
 (md5('db-arena')::uuid,'diamonds',true,NULL),                         -- the Diamond Arena
 (md5('db-union-arena')::uuid,'diamonds',true,md5('db-union')::uuid),  -- in a union: chip book
 (md5('db-private')::uuid,'diamonds',false,NULL),                      -- not the platform: chip book
 (md5('db-chip-platform')::uuid,'chips',true,NULL);                    -- chips: chip book

-- db-sat: a Diamond satellite. Two entries of 100 prize + 10 fee, the fee
--   leg took 20, its one seat (200) went to db-target. Escrow 0.00.
--   The chip book holds nothing collected and a 200 seat paid out: -200.00.
-- db-target: the Diamond event that seat entered. The seat's entry leg is
--   200 prize, its prize leg paid 200. Escrow 0.00. The chip book reads the
--   arriving seat as held: +200.00, and the predecessor sweep would pay its
--   150 reconciler top-up through the chip book.
-- db-held: a Diamond event still holding 55 prize (300 in + 20 overlay - 5
--   returned - 250 paid - 10 refunded), 10 bounty (40 - 30) and 4 fee (30 -
--   25 - 1 refunded): 69.00. A stray chip-book debit of 999 is not its book:
--   the chip formula reads 999.00.
INSERT INTO tournaments(id,name,club_id,prize_pool,ended_at,status,variant,satellite_target_id,fixture_topup) VALUES
 (md5('db-sat')::uuid,'db-sat',md5('db-arena')::uuid,200,now()-interval '1 day','COMPLETED','satellite',md5('db-target')::uuid,0),
 (md5('db-target')::uuid,'db-target',md5('db-arena')::uuid,200,now()-interval '12 hours','COMPLETED',NULL,NULL,150),
 (md5('db-held')::uuid,'db-held',md5('db-arena')::uuid,300,now()-interval '2 hours','COMPLETED',NULL,NULL,0);
INSERT INTO poker_diamond_tournament_ledger(tournament_id,kind,amount,prize_part,bounty_part,fee_part) VALUES
 (md5('db-sat')::uuid,'entry',110,100,0,10),(md5('db-sat')::uuid,'entry',110,100,0,10),
 (md5('db-sat')::uuid,'fee',20,0,0,0),(md5('db-sat')::uuid,'prize',200,0,0,0),
 (md5('db-target')::uuid,'entry',200,200,0,0),(md5('db-target')::uuid,'prize',200,0,0,0),
 (md5('db-held')::uuid,'entry',370,300,40,30),(md5('db-held')::uuid,'overlay',20,0,0,0),
 (md5('db-held')::uuid,'overlay_return',5,0,0,0),(md5('db-held')::uuid,'prize',250,0,0,0),
 (md5('db-held')::uuid,'bounty',30,0,0,0),(md5('db-held')::uuid,'fee',25,0,0,0),
 (md5('db-held')::uuid,'refund',11,10,0,1);
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata) VALUES
 (md5('db-sat')::uuid,md5('db-user-1')::uuid,200,'satellite_seat',NULL,
  jsonb_build_object('satellite_target_id',md5('db-target')::uuid::text));
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id) VALUES
 (md5('db-held')::uuid,'debit','tournament_buyin',999,md5('db-user-2')::uuid);

-- Not Diamond events, whatever Diamond legs they carry: the chip formula,
-- unchanged, on both sides.
-- db-union-event: the Arena's club, but the event is a union's: 50 in, 50
--   paid: 0.00 (its 500 Diamond entry leg is not its book).
-- db-union-club: a union's Diamond club: 70 in, 30 paid: 40.00.
-- db-private: a private Diamond club: 25 in: 25.00.
-- db-chip-platform: a platform chip club: 15 paid, nothing in: -15.00.
INSERT INTO tournaments(id,name,club_id,union_id,prize_pool,ended_at,status) VALUES
 (md5('db-union-event')::uuid,'db-union-event',md5('db-arena')::uuid,md5('db-union')::uuid,50,now()-interval '3 hours','COMPLETED'),
 (md5('db-union-club')::uuid,'db-union-club',md5('db-union-arena')::uuid,NULL,70,now()-interval '3 hours','COMPLETED'),
 (md5('db-private')::uuid,'db-private',md5('db-private')::uuid,NULL,25,now()-interval '3 hours','COMPLETED'),
 (md5('db-chip-platform')::uuid,'db-chip-platform',md5('db-chip-platform')::uuid,NULL,15,now()-interval '3 hours','COMPLETED');
INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id) VALUES
 (md5('db-union-event')::uuid,'debit','tournament_buyin',50,md5('db-user-3')::uuid),
 (md5('db-union-event')::uuid,'credit','prize',50,md5('db-user-3')::uuid),
 (md5('db-union-club')::uuid,'debit','tournament_buyin',70,md5('db-user-4')::uuid),
 (md5('db-union-club')::uuid,'credit','prize',30,md5('db-user-4')::uuid),
 (md5('db-private')::uuid,'debit','tournament_buyin',25,md5('db-user-5')::uuid),
 (md5('db-chip-platform')::uuid,'credit','prize',15,md5('db-user-6')::uuid);
INSERT INTO poker_diamond_tournament_ledger(tournament_id,kind,amount,prize_part) VALUES
 (md5('db-union-event')::uuid,'entry',500,500),(md5('db-union-club')::uuid,'entry',500,500),
 (md5('db-private')::uuid,'entry',500,500),(md5('db-chip-platform')::uuid,'entry',500,500);

-- The migration's own proof names the seven reported Sunday Deep Stack
-- satellites by id. Here they are fixture rows shaped like them: a Diamond
-- satellite whose 200 entry paid one 200 seat to an event elsewhere. Escrow
-- 0.00; the chip book reads -200.00 each.
INSERT INTO tournaments(id,name,club_id,prize_pool,ended_at,status,variant)
SELECT v.id,'db-reported-'||v.n,md5('db-arena')::uuid,200,now()-interval '2 days','COMPLETED','satellite'
  FROM (VALUES (1,'410cfca4-77d9-4b9c-8f36-f20939c9d231'::uuid),(2,'954625ef-0cde-40bf-a7a3-7be3e6348339'),
               (3,'d4f08fba-72e9-470c-9ea5-8ac00f5243b6'),(4,'82aa6c4f-ffc9-4eed-870b-2c257e10e6bf'),
               (5,'7e56f752-e92b-4447-b12e-66d83d1c062a'),(6,'3bea3ecb-9cb4-4a94-b5f4-69de2a697ec5'),
               (7,'e2ea5f2a-da30-425b-96cb-88a19799e21f')) v(n,id);
INSERT INTO poker_diamond_tournament_ledger(tournament_id,kind,amount,prize_part)
SELECT id,'entry',200,200 FROM tournaments WHERE name LIKE 'db-reported-%'
UNION ALL SELECT id,'prize',200,0 FROM tournaments WHERE name LIKE 'db-reported-%';
INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata)
SELECT id,md5(name)::uuid,200,'satellite_seat',NULL,
       jsonb_build_object('satellite_target_id',md5('db-elsewhere')::uuid::text)
  FROM tournaments WHERE name LIKE 'db-reported-%';
