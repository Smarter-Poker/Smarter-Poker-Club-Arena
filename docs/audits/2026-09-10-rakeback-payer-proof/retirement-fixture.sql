CREATE SCHEMA extensions;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
CREATE TABLE wallet_transactions(id uuid);
CREATE TABLE chip_ledger(id uuid);
CREATE TABLE wallet_credit_idempotency(key text);
