-- 20260908153313_every_tournament_payout_names_its_source.sql
--
-- BAND-AID REGISTER #10: 32 tournament payout rows totalling 161.30 chips
-- were recorded as `unclassified`. They were not 32 unknown payments. Every
-- row was written at 2026-09-01 13:34:41.237453 UTC by the one-time
-- vacant-place repair, and every row exactly matches all three durable facts:
--
--   * its `tourney:<id>:vacantplace:<user>:<place>` idempotency key;
--   * its row in tournament_players_position_repair_20260901; and
--   * its wallet_credit_idempotency row for the same user and amount.
--
-- The writer fell through fn_tournament_payout_shape because that classifier
-- did not know the `vacantplace` grammar. fn_credit_and_log then substituted
-- `unclassified`, and tournament_payouts still carried the original
-- `DEFAULT 'payout'` with no source vocabulary constraint. Either route let a
-- payment move without naming what kind of payment it was.
--
-- THIS IS THE ROOT FIX:
--
--   1. teach the single classifier the exact historical key grammar;
--   2. remove the column default and install a closed CHECK vocabulary;
--   3. require the hardened fn_credit_and_log definition, which resolves and
--      validates the source before fn_credit_player_wallet_once can move it;
--   4. correct only the 32 proven rows to `finish_position_correction` under
--      the payout record's explicit DBA correction door; and
--   5. preserve an immutable before/after receipt for every corrected row.
--
-- NO MONEY MOVES. The exact cohort digest below pins payout identity, event,
-- recipient, amount, key, timestamp and repair evidence. The migration also
-- proves the same 32 wallet idempotency claims still total 161.30 before and
-- after the metadata-only correction. Any extra, absent or changed row aborts
-- the whole transaction instead of broadening the repair.
--
-- The version was reserved with scripts/reserve-migration-version.sh.

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- Strongest lock first. No payout writer can arrive between the exact cohort
-- proof, its receipts, the correction and the closed constraint.
LOCK TABLE public.tournament_payouts IN ACCESS EXCLUSIVE MODE;

DO $credit_door_preflight$
DECLARE
  v_credit_definition text;
BEGIN
  IF to_regprocedure(
       'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'source hardening requires the atomic fn_credit_and_log door first';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure(
           'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'))
    INTO v_credit_definition;

  IF v_credit_definition NOT LIKE '%has no recognized payout source%'
     OR v_credit_definition NOT LIKE '%supplied unknown payout source%'
     OR position('has no recognized payout source' IN v_credit_definition)
        > position('v_credited := public.fn_credit_player_wallet_once('
                   IN v_credit_definition) THEN
    RAISE EXCEPTION
      'fn_credit_and_log must reject an unnamed source before moving money';
  END IF;
END;
$credit_door_preflight$;

CREATE TABLE public.tournament_payout_source_corrections (
  payout_id          uuid PRIMARY KEY
    REFERENCES public.tournament_payouts(id) ON DELETE RESTRICT,
  tournament_id      uuid NOT NULL,
  user_id            uuid NOT NULL,
  idempotency_key    text NOT NULL,
  amount             numeric(15,2) NOT NULL CHECK (amount > 0),
  previous_source    text NOT NULL CHECK (previous_source = 'unclassified'),
  corrected_source   text NOT NULL
    CHECK (corrected_source = 'finish_position_correction'),
  old_position       integer NOT NULL CHECK (old_position > 0),
  corrected_position integer NOT NULL CHECK (corrected_position > 0),
  place_worth        numeric(15,2) NOT NULL CHECK (place_worth >= 0),
  already_paid       numeric(15,2) NOT NULL CHECK (already_paid >= 0),
  correction_ref     text NOT NULL,
  corrected_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tournament_payout_source_corrections IS
  'Immutable receipts for the 32 metadata-only corrections made by every_tournament_payout_names_its_source. No wallet, escrow or chip ledger value is changed.';

CREATE OR REPLACE FUNCTION
  public.fn_tournament_payout_source_corrections_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $append_only$
BEGIN
  RAISE EXCEPTION
    'tournament_payout_source_corrections is append-only; % is refused for payout %',
    TG_OP, OLD.payout_id USING ERRCODE = 'restrict_violation';
END;
$append_only$;

CREATE TRIGGER trg_tournament_payout_source_corrections_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_payout_source_corrections
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_payout_source_corrections_append_only();

ALTER TABLE public.tournament_payout_source_corrections
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_payout_source_corrections
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.fn_tournament_payout_source_corrections_append_only()
  FROM PUBLIC, anon, authenticated, service_role;

-- The append-only payout record opens only through its deliberately narrow
-- correction door, only for this transaction, and only for session_user
-- postgres. The receipts are inserted before the corrected source is written.
SET LOCAL app.payout_record_correction = 'i_am_correcting_the_record';

DO $correct_exact_cohort$
DECLARE
  c_expected_rows constant integer := 32;
  c_expected_amount constant numeric(15,2) := 161.30;
  c_expected_digest constant text := '2fa8c21ea518a69b669528154e8a9792';
  v_rows integer;
  v_changed integer;
  v_amount numeric(15,2);
  v_digest text;
  v_wallet_rows integer;
  v_wallet_amount numeric(15,2);
BEGIN
  -- Fresh installs have no historical vacant-place incident to correct. Accept
  -- only the truly empty shape; a preclassified or partial cohort must still
  -- fail so production evidence can never be bypassed.
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_payouts
     WHERE source = 'unclassified'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.tournament_payouts
       WHERE idempotency_key ~
         '^tourney:[0-9a-f-]{36}:vacantplace:[0-9a-f-]{36}:[1-9][0-9]*$'
    ) THEN
      RAISE EXCEPTION
        'vacant-place payouts exist without the exact unclassified correction cohort'
        USING ERRCODE = 'P0404';
    END IF;
    RETURN;
  END IF;

  -- Hold only the 32 supporting evidence rows stable. A table-level lock on
  -- wallet_credit_idempotency would pause every unrelated credit on the
  -- platform, while these row locks protect the proof without doing that.
  PERFORM 1
    FROM public.tournament_players_position_repair_20260901 r
   WHERE EXISTS (
     SELECT 1 FROM public.tournament_payouts p
      WHERE p.source = 'unclassified'
        AND p.tournament_id = r.tournament_id AND p.user_id = r.user_id
   )
   ORDER BY r.tournament_id, r.user_id
   FOR SHARE;

  PERFORM 1
    FROM public.wallet_credit_idempotency w
   WHERE EXISTS (
     SELECT 1 FROM public.tournament_payouts p
      WHERE p.source = 'unclassified' AND p.idempotency_key = w.key
   )
   ORDER BY w.key
   FOR SHARE;

  -- This digest is exact, not a shape-only match. It includes each payout id,
  -- tournament, recipient, NULL/non-NULL place, amount in cents, idempotency
  -- key, writer, paid timestamp, old and corrected positions, entitlement,
  -- prior payment, top-up, and wallet-key timestamp, ordered by payout id.
  WITH exact AS (
    SELECT p.*, r.old_position, r.new_position, r.place_worth,
           r.already_paid, r.top_up, w.created_at AS key_created_at
      FROM public.tournament_payouts p
      JOIN public.tournament_players_position_repair_20260901 r
        ON r.tournament_id = p.tournament_id AND r.user_id = p.user_id
      JOIN public.wallet_credit_idempotency w
        ON w.key = p.idempotency_key
       AND w.user_id = p.user_id
       AND w.amount = p.amount
     WHERE p.source = 'unclassified'
  )
  SELECT count(*), COALESCE(sum(amount),0),
         md5(string_agg(
           id::text || '|' || tournament_id::text || '|' || user_id::text || '|' ||
           COALESCE(position::text,'NULL') || '|' ||
           (amount*100)::bigint::text || '|' || idempotency_key || '|' ||
           recorded_by || '|' ||
           to_char(paid_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '|' ||
           old_position::text || '|' || new_position::text || '|' ||
           (place_worth*100)::bigint::text || '|' ||
           (already_paid*100)::bigint::text || '|' ||
           (top_up*100)::bigint::text || '|' ||
           to_char(key_created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US'),
           E'\n' ORDER BY id))
    INTO v_rows, v_amount, v_digest
    FROM exact;

  IF v_rows <> c_expected_rows
     OR v_amount IS DISTINCT FROM c_expected_amount
     OR v_digest IS DISTINCT FROM c_expected_digest THEN
    RAISE EXCEPTION
      'vacant-place source correction expected % rows / % chips / digest %, got % / % / %',
      c_expected_rows, c_expected_amount, c_expected_digest,
      v_rows, v_amount, COALESCE(v_digest,'NULL')
      USING ERRCODE = 'P0404';
  END IF;

  -- Make the key grammar itself part of the assertion. Nothing merely sharing
  -- the old source label may enter this correction.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.source = 'unclassified'
       AND (
         p.idempotency_key !~
           '^tourney:[0-9a-f-]{36}:vacantplace:[0-9a-f-]{36}:[1-9][0-9]*$'
         OR split_part(p.idempotency_key,':',2)::uuid IS DISTINCT FROM p.tournament_id
         OR split_part(p.idempotency_key,':',4)::uuid IS DISTINCT FROM p.user_id
       )
  ) THEN
    RAISE EXCEPTION
      'an unclassified payout is not one of the proven vacant-place corrections'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), COALESCE(sum(w.amount),0)
    INTO v_wallet_rows, v_wallet_amount
    FROM public.wallet_credit_idempotency w
    JOIN public.tournament_payouts p ON p.idempotency_key = w.key
   WHERE p.source = 'unclassified'
     AND w.user_id = p.user_id AND w.amount = p.amount;
  IF v_wallet_rows <> c_expected_rows
     OR v_wallet_amount IS DISTINCT FROM c_expected_amount THEN
    RAISE EXCEPTION
      'vacant-place wallet evidence expected % rows / % chips, got % / %',
      c_expected_rows, c_expected_amount, v_wallet_rows, v_wallet_amount
      USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_payout_source_corrections
    (payout_id,tournament_id,user_id,idempotency_key,amount,
     previous_source,corrected_source,old_position,corrected_position,
     place_worth,already_paid,correction_ref)
  SELECT p.id,p.tournament_id,p.user_id,p.idempotency_key,p.amount,
         p.source,'finish_position_correction',r.old_position,r.new_position,
         r.place_worth,r.already_paid,
         'migration every_tournament_payout_names_its_source: exact vacant-place payout-source correction; no money moved'
    FROM public.tournament_payouts p
    JOIN public.tournament_players_position_repair_20260901 r
      ON r.tournament_id = p.tournament_id AND r.user_id = p.user_id
   WHERE p.source = 'unclassified'
   ORDER BY p.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> c_expected_rows THEN
    RAISE EXCEPTION 'expected % correction receipts, wrote %',
      c_expected_rows, v_rows USING ERRCODE = 'P0404';
  END IF;

  UPDATE public.tournament_payouts p
     SET source = c.corrected_source
    FROM public.tournament_payout_source_corrections c
   WHERE p.id = c.payout_id
     AND p.source = c.previous_source
     AND p.tournament_id = c.tournament_id
     AND p.user_id = c.user_id
     AND p.idempotency_key = c.idempotency_key
     AND p.amount = c.amount;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> c_expected_rows THEN
    RAISE EXCEPTION 'expected to correct % payout sources, corrected %',
      c_expected_rows, v_changed USING ERRCODE = 'P0404';
  END IF;

  -- Recompute the same digest without filtering on the old source. Nothing
  -- except the classified source is allowed to differ.
  WITH exact AS (
    SELECT p.*, r.old_position, r.new_position, r.place_worth,
           r.already_paid, r.top_up, w.created_at AS key_created_at
      FROM public.tournament_payout_source_corrections c
      JOIN public.tournament_payouts p ON p.id = c.payout_id
      JOIN public.tournament_players_position_repair_20260901 r
        ON r.tournament_id = p.tournament_id AND r.user_id = p.user_id
      JOIN public.wallet_credit_idempotency w
        ON w.key = p.idempotency_key
       AND w.user_id = p.user_id
       AND w.amount = p.amount
     WHERE p.source = 'finish_position_correction'
  )
  SELECT count(*), COALESCE(sum(amount),0),
         md5(string_agg(
           id::text || '|' || tournament_id::text || '|' || user_id::text || '|' ||
           COALESCE(position::text,'NULL') || '|' ||
           (amount*100)::bigint::text || '|' || idempotency_key || '|' ||
           recorded_by || '|' ||
           to_char(paid_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '|' ||
           old_position::text || '|' || new_position::text || '|' ||
           (place_worth*100)::bigint::text || '|' ||
           (already_paid*100)::bigint::text || '|' ||
           (top_up*100)::bigint::text || '|' ||
           to_char(key_created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US'),
           E'\n' ORDER BY id))
    INTO v_rows, v_amount, v_digest
    FROM exact;

  IF v_rows <> c_expected_rows
     OR v_amount IS DISTINCT FROM c_expected_amount
     OR v_digest IS DISTINCT FROM c_expected_digest
     OR EXISTS (SELECT 1 FROM public.tournament_payouts
                 WHERE source = 'unclassified') THEN
    RAISE EXCEPTION
      'post-correction proof failed: rows %, chips %, digest %, unclassified remains %',
      v_rows, v_amount, COALESCE(v_digest,'NULL'),
      EXISTS (SELECT 1 FROM public.tournament_payouts
               WHERE source = 'unclassified')
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), COALESCE(sum(w.amount),0)
    INTO v_wallet_rows, v_wallet_amount
    FROM public.wallet_credit_idempotency w
    JOIN public.tournament_payout_source_corrections c
      ON c.idempotency_key = w.key
     AND c.user_id = w.user_id AND c.amount = w.amount;
  IF v_wallet_rows <> c_expected_rows
     OR v_wallet_amount IS DISTINCT FROM c_expected_amount THEN
    RAISE EXCEPTION
      'wallet evidence changed during source correction: expected % / %, got % / %',
      c_expected_rows, c_expected_amount, v_wallet_rows, v_wallet_amount
      USING ERRCODE = 'P0404';
  END IF;
END;
$correct_exact_cohort$;

-- The one classifier now understands the only formerly unclassified key.
-- Explicit source parameters still win for obligation and atomic settlement
-- keys whose grammar deliberately does not encode their payout class.
CREATE OR REPLACE FUNCTION public.fn_tournament_payout_shape(p_key text)
RETURNS TABLE (source text, place integer)
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $classifier$
  WITH s AS (
    SELECT split_part(p_key, ':', 1) AS ns,
           split_part(p_key, ':', 3) AS kind,
           split_part(p_key, ':', 4) AS seg4,
           split_part(p_key, ':', 5) AS seg5,
           split_part(p_key, ':', 6) AS seg6
     WHERE p_key LIKE 'tourney:%'
        OR p_key LIKE 'mb:%'
        OR p_key LIKE 'mb-residual:%'
        OR p_key LIKE 'spin:%'
  )
  SELECT
    CASE
      WHEN s.ns = 'mb'                                  THEN 'mystery_bounty'
      WHEN s.ns = 'mb-residual'                         THEN 'mystery_bounty_residual'
      WHEN s.ns = 'spin' AND s.seg5 = 'unpaid_backpay' THEN 'spin_backpay'
      WHEN s.ns <> 'tourney'                            THEN NULL
      WHEN s.kind = 'prize' AND s.seg6 = 'reconcile'   THEN 'reconcile'
      WHEN s.kind = 'prize' AND s.seg5 = 'hu_shortfall' THEN 'hu_shortfall'
      WHEN s.kind = 'prize' AND s.seg4 = 'place'       THEN 'structure'
      WHEN s.kind = 'prize' AND s.seg5 ~ '^[0-9]+$'    THEN 'structure'
      WHEN s.kind = 'bounty'                            THEN 'bounty'
      WHEN s.kind = 'ownbounty'                         THEN 'own_bounty'
      WHEN s.kind = 'prizeadj'                          THEN 'late_reg_adjustment'
      WHEN s.kind = 'clawback'                          THEN 'clawback'
      WHEN s.kind = 'ftd'                               THEN 'final_table_deal'
      WHEN s.kind = 'vacantplace'
       AND s.seg5 ~ '^[1-9][0-9]*$'                    THEN 'finish_position_correction'
    END,
    CASE
      WHEN s.ns = 'spin' AND s.seg5 = 'unpaid_backpay' THEN 1
      WHEN s.ns <> 'tourney' THEN NULL
      WHEN s.kind IN ('prize','prizeadj','clawback') AND s.seg4 = 'place'
       AND s.seg5 ~ '^[0-9]+$' THEN s.seg5::integer
      WHEN s.kind IN ('prize','prizeadj','clawback')
       AND s.seg5 ~ '^[0-9]+$' THEN s.seg5::integer
      WHEN s.kind = 'vacantplace' AND s.seg5 ~ '^[1-9][0-9]*$'
        THEN s.seg5::integer
    END
  FROM s;
$classifier$;

REVOKE ALL ON FUNCTION public.fn_tournament_payout_shape(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_shape(text)
  TO service_role;

-- No implicit value remains. Omitting source now hits NOT NULL; supplying any
-- undeclared value hits this CHECK. Both reject the payout row, and the atomic
-- credit door rejects even earlier, before it can move a wallet balance.
ALTER TABLE public.tournament_payouts
  ALTER COLUMN source DROP DEFAULT,
  ALTER COLUMN source SET NOT NULL;

ALTER TABLE public.tournament_payouts
  ADD CONSTRAINT tournament_payouts_source_check
  CHECK (source IN (
    'structure','reconcile','hu_shortfall','bounty','bounty_residual',
    'own_bounty','late_reg_adjustment','clawback','final_table_deal',
    'mystery_bounty','mystery_bounty_residual','spin_backpay',
    'overlay_backpay','bubble_protection','satellite_remainder',
    'satellite_seat','satellite_ticket','finish_position_correction'
  )) NOT VALID;

ALTER TABLE public.tournament_payouts
  VALIDATE CONSTRAINT tournament_payouts_source_check;

COMMENT ON COLUMN public.tournament_payouts.source IS
  'Closed payout class. There is no default: an unnamed or unknown payment fails before settlement instead of becoming unclassified.';

DO $final_proof$
DECLARE
  v_default text;
  v_classifier record;
  v_constraint_definition text;
  v_constraint_valid boolean;
BEGIN
  SELECT pg_get_expr(d.adbin,d.adrelid)
    INTO v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.tournament_payouts'::regclass
     AND a.attname = 'source';
  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION 'tournament_payouts.source still has default %', v_default;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = 'public.tournament_payouts'::regclass
       AND a.attname = 'source' AND a.attnotnull
  ) THEN
    RAISE EXCEPTION 'tournament_payouts.source is not NOT NULL';
  END IF;

  SELECT pg_get_constraintdef(c.oid), c.convalidated
    INTO v_constraint_definition, v_constraint_valid
    FROM pg_constraint c
   WHERE c.conrelid = 'public.tournament_payouts'::regclass
     AND c.conname = 'tournament_payouts_source_check';
  IF v_constraint_definition IS NULL
     OR v_constraint_valid IS NOT TRUE
     OR v_constraint_definition LIKE '%unclassified%'
     OR v_constraint_definition LIKE '%''payout''%' THEN
    RAISE EXCEPTION 'closed source constraint is absent, unvalidated or open: %',
      COALESCE(v_constraint_definition,'NULL');
  END IF;

  SELECT * INTO v_classifier
    FROM public.fn_tournament_payout_shape(
      'tourney:32ae0fc3-3728-49b5-ba78-0d0ed96920db:vacantplace:eae3996f-9f4d-4fad-ae65-7cbd976240c1:3');
  IF v_classifier.source IS DISTINCT FROM 'finish_position_correction'
     OR v_classifier.place IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'vacant-place classifier returned source % / place %',
      v_classifier.source, v_classifier.place;
  END IF;

  IF (SELECT count(*) FROM public.tournament_payout_source_corrections)
       NOT IN (0, 32)
     OR (
       (SELECT count(*) FROM public.tournament_payout_source_corrections) = 0
       AND EXISTS (
         SELECT 1 FROM public.tournament_payouts
          WHERE idempotency_key ~
            '^tourney:[0-9a-f-]{36}:vacantplace:[0-9a-f-]{36}:[1-9][0-9]*$'
       )
     )
     OR EXISTS (SELECT 1 FROM public.tournament_payouts
                 WHERE source = 'unclassified')
     OR EXISTS (SELECT 1 FROM public.tournament_payouts
                 WHERE source NOT IN (
                   'structure','reconcile','hu_shortfall','bounty','bounty_residual',
                   'own_bounty','late_reg_adjustment','clawback','final_table_deal',
                   'mystery_bounty','mystery_bounty_residual','spin_backpay',
                   'overlay_backpay','bubble_protection','satellite_remainder',
                   'satellite_seat','satellite_ticket','finish_position_correction'
                 )) THEN
    RAISE EXCEPTION 'final payout-source population proof failed';
  END IF;
END;
$final_proof$;

COMMIT;
