-- 20260930055147_the_journal_explains_the_balance.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- THE DEFECT, READ FROM ROWS (not assumed) ON 2026-09-30
-- ============================================================================
--
-- 439 wallets hold a profiles.diamonds balance that diamond_transactions
-- cannot explain. The balance is ALWAYS high, never low, and the total
-- unexplained is 220,985 diamonds:
--
--     437 wallets  x  +500   =  218,500   the signup grant
--       1 wallet      +485   =      485   clubco, opening balance
--       1 wallet    +2,000   =    2,000   kingfish, residual
--                              ---------
--                                220,985
--
-- Four of the 437 hold their 500 with NO journal row at all, so an INNER JOIN
-- against diamond_transactions does not see them. They are the same defect and
-- they are settled here with the rest.
--
-- THE CAUSE, NAMED. Before 2026-09-01 the signup path wrote the 500 diamond
-- welcome grant straight into the profiles row: handle_new_user's INSERT INTO
-- public.profiles carried the literal 500 in its `diamonds` column, so the
-- balance existed from the instant the row was born and no diamond_transactions
-- row was ever written for it. The player had the diamonds; the ledger had
-- never heard of them.
--
-- THE CAUSE IS ALREADY CLOSED, and this migration does NOT reopen or re-fix it.
-- Three things closed it, in order:
--   20260901032430  ca_signup_diamonds_journal_their_own_grant - the grant
--                   journals itself. The newest drifted profile on this
--                   database was born 2026-09-01 01:46:08 UTC; this landed at
--                   03:24:30 UTC the same morning and the drift stops dead
--                   there. Every profile created after it is clean.
--   2026-09-08      handle_new_user now inserts 0 and asks fn_ca_mint for the
--                   500 under op id signup:<id>, which fills the balance,
--                   journals it and registers it in one call.
--   2026-09-15      DR2:balance_born_outside_the_mint and
--                   DR6:balance_changed_without_journal were flipped from
--                   'log' to 'refuse' in ca_diamond_rule_modes. A profile may
--                   no longer be BORN holding diamonds, and an unsanctioned
--                   write to profiles.diamonds is now refused outright. The
--                   door is not merely shut, it is bolted.
--
-- So what is left is the damage, and that is what this migration settles.
--
-- ============================================================================
-- THE SETTLEMENT (CLAUDE.md 10.9)
-- ============================================================================
--
-- NOBODY'S BALANCE MOVES. Not up, not down. Every one of these players is
-- holding diamonds we gave them and have spent, played and won against for
-- months. Reducing a balance to match a ledger we failed to write would be
-- taking money back for our own defect, which 10.9 rule 3 forbids outright.
-- The ledger is the thing that is wrong, so the ledger is the thing we fix:
-- this migration writes the MISSING JOURNAL ROWS and touches profiles.diamonds
-- nowhere. Read the INSERTs below: there is no UPDATE of a balance in this file.
--
-- WHY THE REGISTER MUST NOT FOLLOW. fn_ca_mint_supply('diamonds') and what
-- players hold agree exactly today (6,834,511 each, difference 0.00 on the
-- trial balance). The born-with-balance door moved the register even though it
-- skipped the journal, so the register ALREADY counts these 220,985 diamonds.
-- Letting the register follow these journal rows would count them a second
-- time and break an identity that is currently true. The existing signup_bonus
-- clause in fn_ca_diamond_journal_origin already refuses to register that kind
-- for exactly this reason; this migration adds one named clause beside it so
-- the same holds for the two rows that are not signup grants. That is the only
-- behaviour change to any function in this file, and it makes a backfilled
-- journal row non-registering by name rather than by accident.
--
-- IDEMPOTENT, AND PROVABLY SO. idx_diamond_transactions_reference_id is a
-- UNIQUE index on reference_id. Every row below carries a per-user reference
-- id, so a second run inserts nothing: the WHERE NOT EXISTS skips it and the
-- unique index would refuse it even if the guard were removed. Nobody can be
-- paid twice by re-running this, and nothing here hand-writes a wallet row.
--
-- HORSES ARE PLAYERS (10.5). The cohort is selected on the drift and on
-- nothing else. is_horse appears nowhere in this file. A horse in this cohort
-- gets its journal row exactly as a human does.
--
-- NOT A REPAIR JOB (10.12). This is a one-time settlement of damage already
-- done, in a migration, with the live path already fixed and armed to refuse.
-- It creates no cron, no sweep, no backfill job and no reconciler, and nothing
-- in it runs again.
--
-- WHAT EACH AFFECTED PLAYER GETS:
--   437 players get a 'signup_bonus' row for the 500 diamond welcome grant
--       they were given at signup and have held ever since. Their wallet has
--       always shown the 500; now the Welcome Bonus line that explains it is
--       there too, dated to the moment their profile was created.
--     1 player (clubco, 5a7e34f8) gets a 485 'adjustment' row. Its first
--       ledger row is a +10 profile picture reward whose balance_after is 495,
--       so the wallet demonstrably opened at 485 before any ledger row
--       existed. It is an opening balance, not provably the 500 grant, so it
--       is recorded as what can be read rather than as what it resembles.
--     1 player (kingfish, 47965354) gets a 2,000 'adjustment' row. This
--       account predates the ledger and was already reconciled once, on
--       2026-05-03, by a +453,929 row. 2,000 remains. The writer cannot be
--       named from rows: ca_diamond_balance_audit, which records the writer of
--       every balance change, only begins in September 2026, and this
--       account's balance_after column is unreliable (dozens of rows where the
--       balance_after delta disagrees with the amount, from concurrent
--       diamond-game writes). So the row says it is a correction of residual
--       pre-audit drift, which is exactly what can be proved, and claims no
--       cause it cannot show.
--
-- The single transaction below is required by the production DDL policy: every
-- DDL statement fires Supabase's schema-cache reload (~28s on this database),
-- and loose statements mean one reload each.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. A BACKFILLED JOURNAL ROW DOES NOT MOVE THE REGISTER.
--
-- Byte-identical to the live function except for the one clause marked ADDED.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_origin(
  p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind  text := lower(COALESCE(NULLIF(btrim(p_transaction_type), ''), NULLIF(btrim(p_type), ''), ''));
  v_class text := lower(COALESCE(NULLIF(btrim(p_issuance_class), ''), ''));
  v_src   text := lower(COALESCE(NULLIF(btrim(p_source), ''), ''));
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN RETURN NULL; END IF;
  -- The Mint's own doors register their own rows.
  IF v_src = 'the_mint' THEN RETURN NULL; END IF;
  -- SO DOES THE SEED DOOR. fn_ca_diamond_born_with_balance writes the
  -- 'seed:<id>' register row for the signup grant and then the journal row.
  -- Registering it here as well counts one movement twice (2026-09-05: 18
  -- duplicate pairs, 9,000 diamonds). Named writer, not a class: every OTHER
  -- promotional credit still registers here.
  IF v_kind = 'signup_bonus' OR v_src = 'handle_new_user' THEN RETURN NULL; END IF;
  -- ADDED 20260930055147. A JOURNAL ROW THAT ONLY WRITES DOWN SUPPLY THE
  -- REGISTER ALREADY COUNTED. The pre-2026-09-01 born-with-balance door moved
  -- profiles.diamonds and the register together and skipped the journal, so
  -- 220,985 diamonds sat in wallets that the journal could not explain while
  -- the register could. The backfill that writes those journal rows must not
  -- register them a second time: fn_ca_mint_supply('diamonds') already equals
  -- what players hold, and following these rows would break that identity by
  -- the exact amount of the backfill. Named source, not a class, for the same
  -- reason as the seed door above: every other admin credit still registers.
  IF v_src = 'journal_backfill' THEN RETURN NULL; END IF;
  -- Player to player: supply moves, none is created or retired.
  IF public.fn_ca_diamond_journal_is_transfer(p_type, p_transaction_type, p_source, p_issuance_class) THEN
    RETURN NULL;
  END IF;
  -- THE ARENA DOORS MOVE MONEY, THEY DO NOT ISSUE IT. A deposit takes diamonds out of
  -- profiles.diamonds and puts them in the platform club's member wallet; a withdrawal is the
  -- mirror. The player still owns them and the supply is unchanged, so the register must not
  -- follow either leg - the same treatment, for the same reason, as a player-to-player transfer
  -- above. Classified as 'spend' (deposit) and 'arena' (withdrawal), the register would have
  -- burned the float on the way in and minted it on the way out (2026-09-08).
  IF v_kind IN ('arena_deposit', 'arena_withdraw') THEN RETURN NULL; END IF;
  -- The deletion door writes its own register row.
  IF v_class = 'deletion' THEN RETURN NULL; END IF;
  -- A test fixture row is not supply the Mint issued.
  IF v_kind LIKE 'test%' THEN RETURN NULL; END IF;

  IF p_amount > 0 THEN
    IF v_class = 'purchased' OR v_kind IN ('purchase', 'stripe_purchase', 'diamond_purchase') THEN
      RETURN 'purchase';
    ELSIF v_class = 'refund' OR v_kind LIKE '%refund%' OR v_kind = 'diamond_refund' THEN
      RETURN 'refund';
    ELSIF v_class = 'promotional' OR v_kind IN ('union_grant', 'bonus', 'promo',
                                                 'promo_purchased', 'easter_egg', 'vip_daily',
                                                 'vip_stipend', 'vip_monthly') THEN
      RETURN 'promotion';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'admin_grant') THEN
      RETURN 'adjustment';
    -- 'arcade%' only. The 'arena' CLASS now belongs to the arena doors, which are handled
    -- as transfers above; leaving it here would have made a withdrawal mint.
    ELSIF v_kind LIKE 'arcade%' THEN
      RETURN 'arena';
    ELSE
      RETURN 'reward';
    END IF;
  ELSE
    IF v_kind IN ('chip_mint', 'chip_purchase', 'mint_chips', 'diamonds_to_chips') OR v_class = 'bridge' THEN
      RETURN 'bridge';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'chargeback', 'clawback') THEN
      RETURN 'adjustment';
    ELSE
      RETURN 'spend';
    END IF;
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. THE COHORT, READ ONCE, AND THE BOARD ASSERTED BEFORE ANYTHING IS WRITTEN.
--
-- Every wallet whose balance the journal cannot explain, computed here and not
-- pasted from a probe. The assertion that follows aborts the whole migration
-- if the board has moved since it was measured (10.9 rule 4).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE zz_journal_gap ON COMMIT DROP AS
SELECT p.id AS user_id,
       p.created_at AS profile_created_at,
       p.diamonds::bigint - COALESCE((SELECT SUM(t.amount) FROM public.diamond_transactions t
                                       WHERE t.user_id = p.id), 0)::bigint AS gap
FROM public.profiles p
WHERE p.diamonds::bigint <> COALESCE((SELECT SUM(t.amount) FROM public.diamond_transactions t
                                       WHERE t.user_id = p.id), 0)::bigint;

DO $$
DECLARE v_rows bigint; v_total bigint; v_neg bigint;
BEGIN
  SELECT count(*), COALESCE(SUM(gap), 0), count(*) FILTER (WHERE gap <= 0)
    INTO v_rows, v_total, v_neg FROM zz_journal_gap;

  IF v_rows <> 439 OR v_total <> 220985 THEN
    RAISE EXCEPTION
      'THE BOARD MOVED. Measured 439 wallets and 220985 diamonds on 2026-09-30; found % wallets and %. Re-read before settling (CLAUDE.md 10.9 rule 4).',
      v_rows, v_total;
  END IF;

  -- Every gap is the balance being HIGH. A negative gap would mean a player is
  -- short, which is a different defect with a different settlement, and this
  -- migration must not quietly write a debit for it.
  IF v_neg <> 0 THEN
    RAISE EXCEPTION 'Found % wallets whose balance is NOT high. This migration settles excess only; stop and read them.', v_neg;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. THE 437 WELCOME GRANTS.
--
-- type/transaction_type 'signup_bonus' so the player's wallet says "Welcome
-- Bonus" (DiamondWalletModal TX_TYPES and fn_diamond_kind_row_label both
-- already carry that label), issuance_class 'promotional' and counterparty set
-- explicitly so the journal classifier does not have to guess and file DR12,
-- and dated to the moment the profile was created, which is when the grant was
-- made. Engine 'signup' has no daily cap, so DR7 cannot refuse these.
-- ---------------------------------------------------------------------------
INSERT INTO public.diamond_transactions
  (user_id, type, transaction_type, amount, balance_after, description,
   reference_id, source, issuance_class, counterparty, created_at, metadata)
SELECT g.user_id, 'signup_bonus', 'signup_bonus', g.gap::integer, g.gap::integer,
       'Welcome Bonus Recorded. The 500 Diamonds Granted At Signup, Written Into Your Ledger.',
       'signup_bonus_journal:' || g.user_id::text,
       'journal_backfill', 'promotional', 'promo_budget:signup',
       g.profile_created_at,
       jsonb_build_object(
         'settlement', '20260930055147_the_journal_explains_the_balance',
         'reason', 'the pre-2026-09-01 handle_new_user INSERT carried the 500 in profiles.diamonds and wrote no journal row',
         'balance_changed', false)
FROM zz_journal_gap g
WHERE g.gap = 500
  AND NOT EXISTS (SELECT 1 FROM public.diamond_transactions d
                   WHERE d.reference_id = 'signup_bonus_journal:' || g.user_id::text);

-- ---------------------------------------------------------------------------
-- 4. THE TWO THAT ARE NOT SIGNUP GRANTS.
--
-- 'adjustment' renders as "Balance Adjustment" in the player line and
-- "Adjustment" in the wallet, both of which already exist. Each row says what
-- can be read from rows and claims no cause it cannot show.
-- ---------------------------------------------------------------------------
INSERT INTO public.diamond_transactions
  (user_id, type, transaction_type, amount, balance_after, description,
   reference_id, source, issuance_class, counterparty, created_at, metadata)
SELECT g.user_id, 'adjustment', 'adjustment', g.gap::integer, NULL,
       CASE
         WHEN g.user_id = '5a7e34f8-03ac-408a-b9e4-3c9331f5260a'
           THEN 'Opening Balance Recorded. Diamonds This Wallet Already Held Before Its First Ledger Entry.'
         ELSE 'Balance Recorded. Residual Diamonds Held Before The Balance Audit Began.'
       END,
       'journal_gap_settlement:' || g.user_id::text,
       'journal_backfill', 'admin', 'adjustment',
       CASE WHEN g.user_id = '5a7e34f8-03ac-408a-b9e4-3c9331f5260a'
            THEN g.profile_created_at ELSE now() END,
       jsonb_build_object(
         'settlement', '20260930055147_the_journal_explains_the_balance',
         'reason', CASE
           WHEN g.user_id = '5a7e34f8-03ac-408a-b9e4-3c9331f5260a'
             THEN 'wallet opened at 485 before any journal row existed; first row is +10 with balance_after 495'
           ELSE 'residual gap after the 2026-05-03 reconciliation; the writer cannot be named because ca_diamond_balance_audit only begins in September 2026'
         END,
         'balance_changed', false)
FROM zz_journal_gap g
WHERE g.gap <> 500
  AND NOT EXISTS (SELECT 1 FROM public.diamond_transactions d
                   WHERE d.reference_id = 'journal_gap_settlement:' || g.user_id::text);

-- ---------------------------------------------------------------------------
-- 5. PROVE IT, OR ROLL THE WHOLE THING BACK.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_remaining bigint; v_registered bigint; v_written bigint;
BEGIN
  SELECT count(*) INTO v_written FROM public.diamond_transactions
   WHERE reference_id LIKE 'signup_bonus_journal:%' OR reference_id LIKE 'journal_gap_settlement:%';
  IF v_written <> 439 THEN
    RAISE EXCEPTION 'Expected 439 settlement rows to exist, found %.', v_written;
  END IF;

  -- The defect itself: zero wallets whose balance the journal cannot explain.
  SELECT count(*) INTO v_remaining
    FROM public.profiles p
   WHERE p.diamonds::bigint <> COALESCE((SELECT SUM(t.amount) FROM public.diamond_transactions t
                                          WHERE t.user_id = p.id), 0)::bigint;
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'The journal still cannot explain % wallets. Rolling back.', v_remaining;
  END IF;

  -- And the register did not move: not one settlement row registered.
  SELECT count(*) INTO v_registered
    FROM public.ca_mint_ledger m
    JOIN public.diamond_transactions d ON d.id = m.diamond_tx_id
   WHERE d.reference_id LIKE 'signup_bonus_journal:%' OR d.reference_id LIKE 'journal_gap_settlement:%';
  IF v_registered <> 0 THEN
    RAISE EXCEPTION
      'A settlement row reached the register (% rows). That double-counts supply the register already holds. Rolling back.',
      v_registered;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. THE RECORD (10.9: a settlement is finished when the alert says what was
--    accepted and why).
-- ---------------------------------------------------------------------------
INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolved_by, resolution)
VALUES (
  'warning',
  'diamond_journal_completeness',
  'The diamond journal could not explain 220,985 diamonds held across 439 wallets.',
  jsonb_build_object(
    'wallets', 439, 'diamonds', 220985,
    'cohort', jsonb_build_object('signup_grant_500', 437, 'opening_balance_485', 1, 'residual_2000', 1),
    'cause', 'handle_new_user INSERT INTO public.profiles carried the literal 500 in its diamonds column and wrote no diamond_transactions row, until 20260901032430',
    'cause_closed_by', jsonb_build_array('20260901032430', 'handle_new_user mint routing 2026-09-08', 'DR2 and DR6 flipped to refuse 2026-09-15'),
    'newest_affected_profile', '2026-09-01T01:46:08Z',
    'migration', '20260930055147_the_journal_explains_the_balance'),
  -- resolved_by is a uuid column and no human resolved this, so it stays NULL;
  -- the migration that settled it is named in `context` and in the resolution.
  true, now(), NULL,
  'Settled by writing the 439 missing journal rows. No balance was changed: every affected player keeps every diamond, because the ledger was wrong and the wallets were right, and taking diamonds back for our own defect is refused by CLAUDE.md 10.9 rule 3. The register was deliberately not moved, because the born-with-balance door had already counted these 220,985 diamonds there and fn_ca_mint_supply already equals what players hold. The live path was already fixed and is now armed to refuse: DR2 refuses a profile born holding diamonds and DR6 refuses an unsanctioned write to profiles.diamonds, both since 2026-09-15.'
);

COMMIT;
