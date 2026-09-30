/**
 * THE LEDGER SPEAKS TO THE PLAYER (phase 6 of the diamond wallet programme).
 *
 * Dan, 2026-08-20: every line a player reads is Title Case and carries no em
 * dash. The diamond ledger's `description` column is written by twenty-four
 * functions for two audiences at once - the player and the operator - and on
 * 2026-09-20 it held 59,000 challenge ids, 418 audit sentences ("engine-direct
 * UPDATEs that bypassed add_diamonds_to_balance"), 488 em dashes with the
 * number glued to its unit ("10diamonds"), 20 emoji and a table uuid, all
 * printed to players by three surfaces. The journal is append-only, so the
 * record stays; the ledger learned to speak to the player in ONE place:
 * `fn_diamond_ledger_line` and its computed column `player_line`.
 *
 * The law: a wallet surface prints `player_line` (or the kind's label), never
 * the raw description, and the one place that composes the line strips every
 * dash, glyph, uuid and operator note before a player sees it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const MIGRATIONS_DIR = 'supabase/migrations';

/**
 * THE LAW READS WHAT PRODUCTION RAN, NOT A FILE THAT LOOKS LIKE IT (2026-09-30).
 *
 * This constant used to be one hard-coded path,
 * `20260920142916_the_ledger_speaks_to_the_player.sql`. Two files on main
 * carried that base name, identical but for a 54-line header, and only the
 * OTHER one - `20260920143152` - has a row in
 * `supabase_migrations.schema_migrations`. So the law pinned a migration the
 * database never applied, and any change to the twin production does run left
 * it green. Resolving the LATEST migration that declares each function is what
 * the sibling law `the-route-and-the-client-agree` already does, and it cannot
 * go stale: redefine one of these three tomorrow and this reads the new file.
 */
function latestDeclaring(needle: string): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const text = read(`${MIGRATIONS_DIR}/${files[i]}`);
    if (text.includes(needle)) return text.slice(text.indexOf('BEGIN;'));
  }
  throw new Error(`no migration declares ${needle}`);
}

describe('the ledger speaks to the player', () => {
  const body = latestDeclaring('CREATE OR REPLACE FUNCTION public.fn_diamond_ledger_line');
  const labelBody = latestDeclaring('CREATE OR REPLACE FUNCTION public.fn_diamond_kind_row_label');
  const columnBody = latestDeclaring(
    'CREATE OR REPLACE FUNCTION public.player_line(t public.diamond_transactions)'
  );
  const line = body.slice(
    body.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_ledger_line'),
    body.indexOf('COMMENT ON FUNCTION public.fn_diamond_ledger_line')
  );

  it('the one place strips every dash, the diamond glyph, other emoji, glued units and uuids', () => {
    expect(line.length).toBeGreaterThan(100);
    // em, en, figure and horizontal-bar dashes become a comma clause
    expect(line).toContain("E'\\\\s*[\\u2012\\u2013\\u2014\\u2015]\\\\s*', ', '");
    // the diamond glyph becomes the word, every other emoji goes
    expect(line).toContain("E'\\\\s*\\U0001F48E', ' diamonds'");
    expect(line).toContain("E'[\\U0001F000-\\U0001FAFF\\u2728\\u2B50\\u2705\\u274C]', ''");
    // 10diamonds -> 10 diamonds
    expect(line).toContain("'(\\d)(diamonds?)\\M', '\\1 \\2'");
    // trailing [uuid], (match <uuid>) and "for <uuid>" never reach a player
    expect(line).toContain("'\\s*\\[[0-9a-f-]{36}\\]\\s*$'");
    expect(line).toContain('(?:match|table|game|seat|round)\\s+[0-9a-f-]{36}');
    expect(line).toContain("'\\s+for\\s+[0-9a-f-]{36}\\M'");
  });

  it('an operator note, a machine tail, a bare kind or a test row takes the label instead', () => {
    expect(line).toContain(
      '(audit|reconcil|retro-credit|orphaned|clawback|replay|bypass|cowork|make-good|certification|pipeline|verification|journaled|\\mtest\\M|phase\\s?\\d|drift|rollback|pre-fix|constraint|batch)'
    );
    expect(line).toContain(
      "'^(challenge reward|diamond rewards v\\d|diamond award|diamond deduction|deduct|training):'"
    );
    expect(line).toContain("d ~ '^[a-z0-9_]+$'");
    expect(line).toContain("k IN ('daily_challenge_claim', 'daily_mission_milestone')");
    expect(line).toContain('THEN public.fn_diamond_kind_row_label(k, p_amount)');
  });

  it('the row labels are Title Case, carry no em dash, and name the arena as diamonds', () => {
    const labels = labelBody.slice(
      labelBody.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_kind_row_label'),
      labelBody.indexOf('COMMENT ON FUNCTION public.fn_diamond_kind_row_label')
    );
    const found = [...labels.matchAll(/THEN '([A-Z][^']*)'/g)].map((m) => m[1]);
    expect(found.length).toBeGreaterThan(60);
    for (const label of found) {
      expect(label).not.toContain('—');
      for (const word of label.split(/[\s-]+/)) {
        if (word) expect(word[0], `${label}: ${word}`).toMatch(/[A-Z]/);
      }
    }
    /* NO OPERATOR COPY ON A PLAYER'S SCREEN (2026-09-30). `test%` mapped to
       'Test Entry', and four production rows rendered it - kinds test,
       test_verify and test_ref_id, one Diamond each. They are corrections, so
       they take the label the platform already uses for one. */
    expect(found).not.toContain('Test Entry');
    expect(labels).toMatch(/LIKE 'test%'\s+THEN 'Balance Adjustment'/);
    expect(labels).toMatch(/'arena_deposit'\s+THEN 'Diamond Arena Buy-In'/);
    expect(labels).toMatch(/'arena_withdraw'\s+THEN 'Diamond Arena Cash-Out'/);
    expect(labels).not.toMatch(/arena[^\n]*chip/i);
    // Every kind the bucket map names has a row label or falls back to the bucket label.
    expect(labels).toContain('public.fn_diamond_kind_bucket(k.k, k.k, NULL, p_amount)');
  });

  it("is a computed column under the row's own RLS, pure, and refused to anon", () => {
    expect(columnBody).toContain(
      'CREATE OR REPLACE FUNCTION public.player_line(t public.diamond_transactions)'
    );
    expect(columnBody).toMatch(
      /RETURNS text\s+LANGUAGE sql\s+IMMUTABLE\s+PARALLEL SAFE\s+AS \$fn\$\s+SELECT public\.fn_diamond_ledger_line\(t\.type, t\.transaction_type, t\.source, t\.amount::bigint, t\.description\);/
    );
    expect(columnBody).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(columnBody).toContain(
      'REVOKE ALL ON FUNCTION public.player_line(public.diamond_transactions) FROM PUBLIC, anon;'
    );
    for (const one of [body, labelBody, columnBody]) {
      expect(one.match(/^BEGIN;/gm)).toHaveLength(1);
      expect(one.match(/^COMMIT;/gm)).toHaveLength(1);
    }
    const fragment = JSON.parse(
      read('scripts/ci/schema-manifest.d/cw-wallet-the-ledger-speaks-to-the-player.json')
    );
    expect(fragment.functions).toEqual([
      'fn_diamond_kind_row_label',
      'fn_diamond_ledger_line',
      'player_line',
    ]);
  });

  it('every surface that prints a diamond ledger row reads player_line and never the raw description', () => {
    const surfaces = {
      'src/hooks/useDiamondLedger.ts':
        "'id, type, transaction_type, amount, description, player_line, created_at, metadata'",
      'src/components/wallet/DiamondWalletModal.tsx':
        "'id, type, transaction_type, amount, description, player_line, balance_after, created_at'",
      /* VIPPage stopped ASKING for `description` on 2026-09-29 (phase 8): it
         prints `player_line` and nothing else, so the column was weight on a
         money query with no reader. tests/the-route-and-the-client-agree.law.test.ts
         is what found it and is what keeps the two lists honest from here. */
      'src/pages/VIPPage.tsx':
        "'id, type, transaction_type, amount, player_line, balance_after, created_at'",
    };
    for (const [file, select] of Object.entries(surfaces)) {
      const src = read(file);
      expect(src, file).toContain(select);
      // The description is never the thing printed.
      expect(src, file).not.toMatch(/formatPopupText\((?:tx|row|entry)\.description/);
      expect(src, file).not.toMatch(/(?:row|tx|entry)\.description\s*\|\|\s*(?:row\.)?label/);
    }
    expect(read('src/hooks/useDiamondLedger.ts')).toContain(
      "line: typeof tx.player_line === 'string' ? tx.player_line : ''"
    );
    expect(read('src/components/wallet/DiamondWalletModal.tsx')).toContain(
      '{formatPopupText(tx.line || label)}'
    );
    expect(read('src/pages/PlayerWalletPage.tsx')).toContain(
      'formatPopupText(row.line || row.label)'
    );
    expect(read('src/pages/VIPPage.tsx')).toContain(
      "(typeof entry.player_line === 'string' && entry.player_line)"
    );
  });
});
