-- Native fixture for the conservation sweep's history-wide reads.
-- Column names and types match production for every column the three
-- installed functions read; production indexes those reads could use are
-- reproduced (idx_chip_ledger_created_at, the payout and idempotency keys).
-- No player data: every identity is md5-derived from an integer.
SET client_min_messages = warning;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;

CREATE FUNCTION u(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT (substr(md5(n::text),1,8)||'-'||substr(md5(n::text),9,4)||'-'||substr(md5(n::text),13,4)||'-'||substr(md5(n::text),17,4)||'-'||substr(md5(n::text),21,12))::uuid $$;

CREATE TABLE chip_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL,
  club_id uuid,
  from_type text NOT NULL,
  from_entity_id uuid,
  to_type text NOT NULL,
  to_entity_id uuid,
  amount numeric NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'posted',
  memo text
);
CREATE INDEX idx_chip_ledger_created_at ON chip_ledger (created_at);
CREATE INDEX idx_chip_ledger_to_entity_created ON chip_ledger (to_entity_id, created_at DESC);
CREATE INDEX idx_chip_ledger_from_entity_created ON chip_ledger (from_entity_id, created_at DESC);

CREATE TABLE ca_chip_baseline (
  club_id uuid NOT NULL, user_id uuid NOT NULL,
  opening_balance numeric NOT NULL, ledger_at_baseline numeric NOT NULL DEFAULT 0,
  unledgered_gap numeric NOT NULL DEFAULT 0, taken_at timestamptz NOT NULL,
  PRIMARY KEY (club_id, user_id));
CREATE TABLE club_members (
  club_id uuid NOT NULL, user_id uuid NOT NULL, chip_balance numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (club_id, user_id));

-- BBJ books read by fn_bbj_conservation_check
CREATE TABLE bbj_contributions (id bigserial PRIMARY KEY, amount numeric NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE money_flow_checkpoint (metric_key text PRIMARY KEY, as_of timestamptz, total numeric);
CREATE TABLE union_wallet_transactions (id bigserial PRIMARY KEY, tx_type text, amount numeric);
CREATE TABLE bbj_payouts (id bigserial PRIMARY KEY, total_amount numeric);
CREATE TABLE chip_transactions (id bigserial PRIMARY KEY, transaction_type text, amount numeric);
CREATE TABLE wallet_transactions (id bigserial PRIMARY KEY, category text, description text, amount numeric);
CREATE TABLE bbj_pools (id uuid PRIMARY KEY, main_balance numeric, backup_balance numeric, promo_balance numeric,
  total_paid_out numeric, merged_into_pool_id uuid, pool_amount numeric);
CREATE TABLE bbj_conservation_baseline (id integer PRIMARY KEY, tolerance numeric, baseline_gap numeric,
  pre_ledger_payouts numeric, opening_seeds numeric, lifetime_residue numeric, epoch_residue numeric);
CREATE TABLE ca_bbj_pool_snapshots (id bigserial PRIMARY KEY, taken_at timestamptz NOT NULL, is_baseline boolean NOT NULL,
  main numeric, backup numeric, promo numeric);

-- payout rows without money
CREATE TABLE tournaments (id uuid PRIMARY KEY, name text);
CREATE TABLE tournament_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid NOT NULL, user_id uuid NOT NULL,
  position integer, source text NOT NULL, amount numeric NOT NULL, paid_at timestamptz NOT NULL,
  idempotency_key text, metadata jsonb);
CREATE INDEX idx_tournament_payouts_tournament ON tournament_payouts (tournament_id);
CREATE UNIQUE INDEX uq_tournament_payouts_idempotency_key ON tournament_payouts (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE wallet_credit_idempotency (key text PRIMARY KEY, created_at timestamptz NOT NULL, user_id uuid, note text);
CREATE INDEX idx_wallet_credit_idempotency_user_id ON wallet_credit_idempotency (user_id);

-- 480,000 ledger legs, 2026-08-20 .. 2026-09-27. 1 in 5 moves a club member's
-- player_wallet (half credits, half debits), 2 in 5 feed or pay a BBJ pool,
-- the rest are other legs; a padding memo gives rows a realistic width.
INSERT INTO chip_ledger (created_at, club_id, from_type, from_entity_id, to_type, to_entity_id, amount, category, memo)
SELECT timestamptz '2026-08-20 00:00:00+00' + (i * interval '6.8 seconds'),
       CASE WHEN i % 97 = 0 THEN NULL ELSE u(1000 + (i % 300) % 20) END,
       CASE k WHEN 0 THEN 'table' WHEN 1 THEN 'player_wallet'
              WHEN 2 THEN 'table_pot' WHEN 3 THEN 'table_pot' WHEN 4 THEN 'table_pot'
              WHEN 5 THEN 'bbj_pool' ELSE 'table_pot' END,
       CASE k WHEN 1 THEN u(2000 + i % 300) WHEN 5 THEN u(5000 + i % 5) ELSE u(9000 + i % 50) END,
       CASE k WHEN 0 THEN 'player_wallet' WHEN 1 THEN 'table'
              WHEN 2 THEN 'bbj_pool' WHEN 3 THEN 'bbj_pool' WHEN 4 THEN 'bbj_pool'
              WHEN 5 THEN 'player_wallet' ELSE 'rake_pool' END,
       CASE k WHEN 0 THEN u(2000 + i % 300) WHEN 2 THEN u(5000 + i % 5) WHEN 3 THEN u(5000 + i % 5)
              WHEN 4 THEN u(5000 + i % 5) WHEN 5 THEN u(2000 + i % 300) ELSE u(9000 + i % 50) END,
       round(((i % 997) + 1) / 100.0, 2),
       CASE WHEN k IN (2,3,4,5) THEN 'bbj' ELSE 'hand' END,
       repeat('x', 180)
  FROM (SELECT i, CASE WHEN i % 10 < 1 THEN 0 WHEN i % 10 < 2 THEN 1 WHEN i % 10 < 5 THEN 2 + (i % 3)
                       WHEN i % 10 < 6 THEN 5 ELSE 6 END AS k
          FROM generate_series(1, 480000) i) s;

INSERT INTO ca_chip_baseline (club_id, user_id, opening_balance, taken_at)
SELECT u(1000 + n % 20), u(2000 + n), 1000 + n, timestamptz '2026-08-26 00:00:00+00'
  FROM generate_series(0, 299) n;
-- Balances equal baseline + movements for every member but twelve, which
-- drift by a known amount.
INSERT INTO club_members (club_id, user_id, chip_balance)
SELECT b.club_id, b.user_id,
       b.opening_balance
       + COALESCE((SELECT sum(CASE WHEN l.to_type = 'player_wallet' THEN l.amount ELSE 0 END)
                        - sum(CASE WHEN l.from_type = 'player_wallet' THEN l.amount ELSE 0 END)
                     FROM chip_ledger l
                    WHERE l.club_id = b.club_id AND l.created_at >= b.taken_at
                      AND ((l.to_type = 'player_wallet' AND l.to_entity_id = b.user_id)
                        OR (l.to_type <> 'player_wallet' AND l.from_type = 'player_wallet' AND l.from_entity_id = b.user_id))), 0)
       + CASE WHEN b.opening_balance::int % 25 = 0 THEN 7.25 ELSE 0 END
  FROM ca_chip_baseline b;

INSERT INTO bbj_contributions (amount, created_at)
SELECT 0.5, timestamptz '2026-09-20 00:00:00+00' + i * interval '1 minute' FROM generate_series(1, 5000) i;
INSERT INTO money_flow_checkpoint VALUES ('bbj_contributions_inflow', '2026-09-24 00:00:00+00', 1234.50);
INSERT INTO union_wallet_transactions (tx_type, amount) VALUES ('bbj_fund', 100), ('bbj_promo_sweep', 40), ('rake', 9);
INSERT INTO bbj_payouts (total_amount) VALUES (300), (125.5);
INSERT INTO chip_transactions (transaction_type, amount) VALUES ('bbj_promo_sweep', 12);
INSERT INTO wallet_transactions (category, description, amount) VALUES ('promotion', 'BBJ promo pool payout', 3);
INSERT INTO bbj_pools SELECT u(5000 + n), 1000 + n, 200, 50, 400 + n, NULL, 10 FROM generate_series(0, 4) n;
INSERT INTO bbj_conservation_baseline VALUES (1, 1.00, 0, 0, 0, 0, 0);
INSERT INTO ca_bbj_pool_snapshots (taken_at, is_baseline, main, backup, promo) VALUES
  ('2026-09-01 00:00:00+00', true, 5000, 900, 200),
  ('2026-09-02 00:00:00+00', false, 5100, 900, 200);

-- 40,000 payouts over 30 days, 2,000 tournaments; the newest have a missing
-- or unmatched idempotency key in known places.
INSERT INTO tournaments SELECT u(20000 + n), 'Fixture Event ' || n FROM generate_series(0, 1999) n;
INSERT INTO wallet_credit_idempotency (key, created_at, user_id, note)
SELECT 'prize:' || i, timestamptz '2026-08-01 00:00:00+00' + i * interval '1 minute', u(2000 + i % 300), repeat('y', 150)
  FROM generate_series(1, 90000) i;
INSERT INTO tournament_payouts (tournament_id, user_id, position, source, amount, paid_at, idempotency_key, metadata)
SELECT u(20000 + i % 2000), u(2000 + i % 300), 1 + i % 9,
       (ARRAY['structure','reconcile','satellite_ticket','bubble_protection'])[1 + i % 4],
       CASE WHEN i % 53 = 0 THEN 0 ELSE 5 + i % 40 END,
       now() - (i * interval '64.8 seconds'),
       CASE WHEN i % 211 = 0 THEN NULL WHEN i % 307 = 0 THEN 'missing:' || i ELSE 'prize:' || (i % 90000 + 1) END,
       jsonb_build_object('pad', repeat('z', 200))
  FROM generate_series(1, 40000) i;

VACUUM (ANALYZE);
