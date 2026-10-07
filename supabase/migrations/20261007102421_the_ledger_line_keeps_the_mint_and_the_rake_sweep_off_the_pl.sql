-- 20261007102421_the_ledger_line_keeps_the_mint_and_the_rake_sweep_off_the_pl.sql
--
-- THE LEDGER LINE KEEPS THE MINT AND THE RAKE SWEEP OFF THE PLAYER'S SCREEN.
--
-- Version reserved by scripts/new-migration.mjs. One function, one transaction,
-- one schema-cache reload. Redefines fn_diamond_ledger_line (and so the
-- computed column player_line(diamond_transactions), which calls it) from the
-- text of 20260920143152 with three changes and nothing else.
--
-- WHAT WAS WRONG, read from production on 2026-10-07 by grouping all 163,907
-- diamond_transactions rows to their 250 distinct (kind, sign, description)
-- shapes and running each shape through the live function:
--
--   1. "The Mint: signup grant" (833 rows, 832 of them human wallets) and
--      "The Mint: Lifetime VIP Monthly Diamond Benefit" (1,021 rows) reached
--      the player verbatim. Dan, 2026-09-05, binding: "THEY SHOULD NEVER SEE
--      OR HAVE ACCESS TO THE MINT, THATS INTERNAL SYSTEMS." fn_ca_mint writes
--      'The Mint: ' || reason into the description; the line now drops that
--      prefix and Title Cases a reason written in lower case.
--
--   2. Every cash_rake row (46 at the time of reading, one per payer per hourly
--      sweep since 05:14 UTC today) printed the sweep's operator sentence:
--      "Diamond cash-game rake: attributed to this player's contributions
--      (from the arena to the house)". It now takes its row label, "Diamond
--      Arena Rake", which fn_diamond_kind_row_label already returns.
--
--   3. "The Mint: Horse Diamond Arena bankroll: 100,000 Diamonds added to every
--      horse (Dan 2026-10-06 10:25 CT)" (3 horse wallets). Horses are players
--      (CLAUDE.md 10.5): an owner instruction quoted into a reason is an
--      operator note on any wallet, so it takes the row label.
--
-- WHAT DID NOT CHANGE: every pinned clean-up (dashes, the diamond glyph,
-- emoji, glued units, uuid tails), the operator-note pattern, the bare-kind and
-- empty-line fallbacks, IMMUTABLE PARALLEL SAFE, and the grants. Pure; it
-- reads no table and writes nothing. The journal is append-only and is not
-- touched: this is the one place the ledger speaks to the player.
--
-- Proved before it was written: the new body was created as a pg_temp function
-- and run over the same 250 production shapes beside the live one. Exactly the
-- shapes above changed; every other shape returned the identical line.
--
-- Wrap ALL DDL for one change in ONE transaction (club-arena CLAUDE.md,
-- production DDL policy). Never apply inside :50-:03 UTC.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_diamond_ledger_line(
    p_type             text,
    p_transaction_type text,
    p_source           text,
    p_amount           bigint,
    p_description      text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
    WITH resolved AS (
        SELECT LOWER(COALESCE(
            NULLIF(BTRIM(p_transaction_type), ''),
            CASE WHEN LOWER(COALESCE(p_type, '')) IN ('spend', 'earn', 'credit', 'debit')
                 THEN NULLIF(BTRIM(p_source), '') END,
            NULLIF(BTRIM(p_type), ''),
            ''
        )) AS k,
        -- THE MINT IS INTERNAL (Dan, 2026-09-05, tests/the-mint-is-internal.law.test.ts).
        -- fn_ca_mint writes every description as 'The Mint: ' || reason, and that
        -- prefix reached 853 player screens as "The Mint: signup grant". The
        -- prefix is dropped here, in the one place that speaks to the player.
        regexp_replace(BTRIM(COALESCE(p_description, '')), '^the mint:\s*', '', 'i') AS d,
        BTRIM(COALESCE(p_description, '')) ~* '^the mint:' AS minted
    ),
    cleaned AS (
        SELECT k, d, minted,
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(
                      regexp_replace(
                        regexp_replace(
                          regexp_replace(
                            regexp_replace(d,
                              E'\\s*[\u2012\u2013\u2014\u2015]\\s*', ', ', 'g'),          -- em and en dashes: a comma clause
                            E'\\s*\U0001F48E', ' diamonds', 'g'),                        -- the diamond glyph is a word
                          E'[\U0001F000-\U0001FAFF\u2728\u2B50\u2705\u274C]', '', 'g'),    -- every other emoji goes
                        '(\d)(diamonds?)\M', '\1 \2', 'gi'),                              -- 10diamonds -> 10 diamonds
                      '\s*\[[0-9a-f-]{36}\]\s*$', '', 'i'),                               -- trailing [uuid] reference
                    '\s*\((?:match|table|game|seat|round)\s+[0-9a-f-]{36}\)', '', 'gi'),  -- (match <uuid>)
                  '\s+for\s+[0-9a-f-]{36}\M', '', 'gi'),                                  -- for <uuid>
                '\s{2,}', ' ', 'g'),
              '^[\s,.:;-]+|[\s,.:;-]+$', '', 'g') AS line
        FROM resolved
    )
    SELECT CASE
        WHEN d = ''
          OR k IN ('daily_challenge_claim', 'daily_mission_milestone')
          -- The cash rake sweep writes an operator sentence ("attributed to this
          -- player's contributions (from the arena to the house)"); its row label
          -- is "Diamond Arena Rake".
          OR k = 'cash_rake'
          -- An owner instruction quoted into a reason: "(Dan 2026-10-06 10:25 CT)".
          OR LOWER(d) ~ '\(dan \d{4}-\d{2}-\d{2}'
          OR LOWER(d) ~ '(audit|reconcil|retro-credit|orphaned|clawback|replay|bypass|cowork|make-good|certification|pipeline|verification|journaled|\mtest\M|phase\s?\d|drift|rollback|pre-fix|constraint|batch)'
          OR LOWER(d) ~ '^(challenge reward|diamond rewards v\d|diamond award|diamond deduction|deduct|training):'
          OR d ~ '^[a-z0-9_]+$'
          OR line ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}'
          OR line = ''
        THEN public.fn_diamond_kind_row_label(k, p_amount)
        -- A Mint reason is written lower case ("signup grant"); the player reads it
        -- in Title Case. Only the Mint's own reasons are recased, nothing else.
        ELSE CASE WHEN minted AND line = LOWER(line) THEN INITCAP(line) ELSE line END
    END
    FROM cleaned;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_ledger_line(text, text, text, bigint, text) IS
  'The line a player reads for a diamond ledger row: the description when it is player copy, cleaned (dashes, glued units, emoji, uuids, the internal Mint prefix), else the row label for the kind. Operator notes, machine tails, the cash rake sweep sentence and test rows never reach a player. Pure. Casing is the surface''s (Title Case). DIAMONDS ONLY.';

REVOKE ALL ON FUNCTION public.fn_diamond_ledger_line(text, text, text, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_ledger_line(text, text, text, bigint, text) TO authenticated, service_role;

COMMIT;
