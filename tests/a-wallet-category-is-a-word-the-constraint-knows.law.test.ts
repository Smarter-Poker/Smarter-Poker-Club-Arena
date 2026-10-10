/**
 * LAW: A WALLET CATEGORY IS A WORD THE CONSTRAINT KNOWS.
 * ═══════════════════════════════════════════════════════════════════════════
 * `wallet_transactions.category` is closed by `wallet_transactions_category_check`.
 * A word that is not in that list does not become a badly-labelled row - it
 * raises 23514 and takes its whole transaction with it. This platform has now
 * paid for that twice, five months apart, because nothing tied a category word
 * written in the source to the constraint that has to accept it.
 *
 * 1. `HydraService.seatHorse` (2026-04-01 -> 2026-04-14)
 *    It wrote the horse buy-in receipt TWICE. First
 *    `WalletService.logTransaction(..., 'buyin', \`Horse buy-in ${stack} chips
 *    at ${bigBlind}BB table\`, tableId)` - awaited, correct, landed. Then a
 *    second, fire-and-forget `supabase.rpc('log_wallet_transaction', { ...
 *    p_category: 'buy_in' ... })` carrying the same amount, same table, same
 *    horse, ~3 seconds later. `'buy_in'` has never been in the constraint;
 *    `'buyin'` has 773,771 rows. Every one of those 8,535 duplicate writes was
 *    refused.
 *
 *    Measured on production 2026-09-12: 8,535 rejected attempts, 333 distinct
 *    horses, 2,016,133.30 chips. 8,528 of them (99.92%) have the correct
 *    `'buyin'` receipt for the same horse and amount within ten minutes; the
 *    remaining 7 are horses seating 35-84 times in that window, so the
 *    exact-amount match is what fails, not the receipt. ZERO `'buy_in'` rows
 *    exist in `wallet_transactions` and zero ever did. No money and no seat
 *    was lost - the seat INSERT and the correct receipt both completed before
 *    this call, and the call was never awaited. The constraint is the only
 *    reason two million chips of second debit receipts did not land on 333
 *    horses' ledgers. It was doing its job; the spelling was the defect.
 *
 *    The reports were invisible because nothing dedupes `horse_bug_reports`:
 *    one misspelled word became 8,535 unresolved rows, the largest single
 *    error family on the platform.
 *
 * 2. `fn_payout_leaderboard` (fixed 2026-09-03)
 *    Credited winners as `'leaderboard_payout'`, which the constraint did not
 *    know. Migration `20260903225331_a_leaderboard_win_is_a_word_the_wallet_knows`
 *    records the cost: the batch row was written, the funding wallets were
 *    debited, and the first winner's credit aborted the whole transaction.
 *    Zero leaderboard batches had ever been paid. That one DID move money.
 *
 * The difference between the two is luck about whether the failing write was
 * awaited. The defect is identical, so the guard is on the word, not on the
 * await: the vocabulary is pinned to the migration that defines it, and no
 * source file may hand the wallet a word the constraint would refuse.
 *
 * These pins are on the SOURCE - a law test cannot reach production. The
 * migration is the repo's copy of the constraint; `WALLET_TRANSACTION_CATEGORIES`
 * in `useWalletStore.ts` is the TypeScript copy. This test keeps all three
 * honest with each other.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const STORE = join(ROOT, 'src', 'stores', 'useWalletStore.ts');

/** The migration that last (re)defined the constraint is the repo's copy of it. */
function constraintMigration(): string {
  const f = readdirSync(MIGRATIONS)
    .filter((n) => n.includes('a_leaderboard_win_is_a_word_the_wallet_knows'))
    .sort()
    .pop();
  if (!f) {
    throw new Error(
      'the migration that defines wallet_transactions_category_check is missing from the repo'
    );
  }
  return readFileSync(join(MIGRATIONS, f), 'utf8');
}

/** Pull the ARRAY[...] vocabulary out of the ADD CONSTRAINT statement. */
function constraintVocabulary(): string[] {
  const sql = constraintMigration();
  const add = sql.slice(sql.indexOf('ADD CONSTRAINT wallet_transactions_category_check'));
  const arr = add.slice(add.indexOf('ARRAY['), add.indexOf(']', add.indexOf('ARRAY[')));
  const words = [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (words.length === 0) throw new Error('could not read the constraint vocabulary');
  return words;
}

/** The TypeScript copy, read as text so the test pins the literal list. */
function storeVocabulary(): string[] {
  const src = readFileSync(STORE, 'utf8');
  const start = src.indexOf('export const WALLET_TRANSACTION_CATEGORIES');
  if (start === -1) {
    throw new Error('WALLET_TRANSACTION_CATEGORIES is gone from useWalletStore.ts');
  }
  const block = src.slice(start, src.indexOf('] as const;', start));
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'server', 'src'));
  return out;
}

describe('the constraint vocabulary is readable, and the wallet still has one', () => {
  it('reads a non-trivial closed list out of the migration', () => {
    const words = constraintVocabulary();
    expect(words).toContain('buyin');
    expect(words).toContain('leaderboard_payout');
    expect(words.length).toBeGreaterThan(20);
  });

  it('never learns the spellings that were already refused', () => {
    // Adding 'buy_in' would "fix" the April defect by fragmenting a vocabulary
    // that already has 773,771 'buyin' rows behind it. The spelling was wrong,
    // not the constraint.
    const words = constraintVocabulary();
    expect(words).not.toContain('buy_in');
    expect(words).not.toContain('cash_out');
  });
});

describe('the TypeScript copy does not drift from the constraint', () => {
  it('is exactly the constraint vocabulary, in the same set', () => {
    expect([...storeVocabulary()].sort()).toEqual([...constraintVocabulary()].sort());
  });

  it('types WalletTransaction.category from that list rather than by hand', () => {
    const src = readFileSync(STORE, 'utf8');
    expect(src).toMatch(
      /export type WalletTransactionCategory = \(typeof WALLET_TRANSACTION_CATEGORIES\)\[number\]/
    );
    expect(src).toMatch(/category: WalletTransactionCategory;/);
  });
});

describe('no source file hands the wallet a word the constraint would refuse', () => {
  const allowed = new Set(constraintVocabulary());

  it('every literal p_category passed to a wallet RPC is in the vocabulary', () => {
    const offences: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/p_category:\s*'([^']+)'/g)) {
        if (!allowed.has(m[1])) {
          offences.push(`${relative(ROOT, file)}: p_category: '${m[1]}'`);
        }
      }
    }
    expect(
      offences,
      `wallet_transactions_category_check refuses these: ${offences.join('; ')}`
    ).toEqual([]);
  });

  it('every literal category passed to WalletService.logTransaction is in the vocabulary', () => {
    // logTransaction(userId, walletType, amount, type, category, ...) - the
    // category is the argument that follows the 'credit'/'debit' literal.
    const offences: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(
        /logTransaction\(\s*[\s\S]{0,400}?'(?:credit|debit)'\s*,\s*'([^']+)'/g
      )) {
        if (!allowed.has(m[1])) {
          offences.push(`${relative(ROOT, file)}: logTransaction category '${m[1]}'`);
        }
      }
    }
    expect(
      offences,
      `wallet_transactions_category_check refuses these: ${offences.join('; ')}`
    ).toEqual([]);
  });
});
