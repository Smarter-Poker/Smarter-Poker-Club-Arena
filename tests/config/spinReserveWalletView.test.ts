/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE SPIN RESERVE IS A WALLET, NOT A NUMBER ON A CARD
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two defects found by re-reading this session's own diffs.
 *
 *   1. THE TILE YOU COULD NOT OPEN. UnionWalletModal turned the four union
 *      wallets into openable views with balance, history and a send flow. The
 *      Spin reserve - added the same day, and the wallet the entire Spin
 *      economy is funded from - was left a plain <div>. So the one wallet with
 *      a brand new money-movement control attached to it was also the only one
 *      whose movements could not be seen anywhere in the product. Its rows go
 *      to union_wallet_transactions, and nothing in the SPA read that table.
 *
 *   2. THE THEME THAT NEVER RESOLVED. useUserThemeSettings deliberately WAITS
 *      on a null tournament format rather than guessing MTT. But TablePage set
 *      the format only inside `if (tournData)`, so a tournament row that could
 *      not be read - deleted, RLS-denied, transient - left the format null for
 *      the life of the table and the player sat on the DEFAULT felt forever.
 *      Before the guard that case silently used the MTT theme; the guard turned
 *      one wrong answer into no answer. A regression, and mine.
 *
 * What the reserve view must NOT have is a send control, and that is the
 * assertion in this file worth the most. spinSpec.ts prices the whole format on
 * the pool being net-neutral over volume - E[multiplier] = seats x (1 - rake) -
 * so a single manual withdrawal breaks the invariant every tier is derived
 * from, and breaks it silently, because solvency is only ever read afterwards.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveThemeBucket } from '../../src/hooks/useUserThemeSettings';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const tsCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const modal = tsCode(read('src/components/union/UnionWalletModal.tsx'));
const page = tsCode(read('src/pages/UnionDashboardPage.tsx'));
const table = tsCode(read('src/pages/TablePage.tsx'));
// (the theme hook is asserted by CALLING resolveThemeBucket below, not by
//  reading its source — see the note on that test)

describe('the reserve opens, like every other wallet', () => {
  it('is a key the modal understands', () => {
    expect(modal).toMatch(/export type UnionWalletKey =[^;]*'spin_reserve'/);
  });

  it('the dashboard tile is a button that opens it', () => {
    expect(page).toMatch(/key: 'spin_reserve'/);
    expect(page).toMatch(/aria-label="Open Spin Reserve"/);
    // A <div> here is the bug: four wallets openable, the fifth inert.
    expect(page).toMatch(/<button[\s\S]{0,400}aria-label="Open Spin Reserve"/);
  });

  it('reads its ledger from union_wallet_transactions, not chip_transactions', () => {
    const branch = modal.slice(modal.indexOf('if (readOnly)'), modal.indexOf('setReserveLedger(('));
    expect(branch).toMatch(/from\('union_wallet_transactions'\)/);
    expect(branch).toMatch(/eq\('wallet', 'spin_reserve_wallet'\)/);
    // chip_transactions records member sends. Reading it here would show an
    // empty feed on a wallet that had been moving all day.
    expect(branch).not.toMatch(/chip_transactions/);
  });

  it('shows direction, so a payout does not read like a deposit', () => {
    expect(modal).toMatch(/r\.direction === 'credit'/);
    expect(modal).toMatch(/inbound \? '\+' : '-'/);
  });

  it('says something useful when the ledger is empty, in Title Case', () => {
    expect(modal).toMatch(/reserveLedger\.length === 0/);
    // Dan 2026-08-21, binding: the first letter of every word is capitalised on
    // every forward-facing page. scripts/ci/check-title-case.mjs enforces it in
    // the pre-push hook - it caught this very string written in sentence case -
    // so the assertion pins the cased form rather than the words alone.
    expect(modal).toMatch(/Nothing Has Moved Through This Wallet Yet/);
    expect(modal).not.toMatch(/Nothing has moved through this wallet yet/);
  });
});

describe('the reserve offers no way to move money out', () => {
  it('marks itself read-only', () => {
    expect(modal).toMatch(/const readOnly = walletKey === 'spin_reserve';/);
  });

  it('hides the kind selector, the member picker and the send button', () => {
    // Two guards: one over the kind selector, one over the whole outbound flow
    // (picker + amount + send). If either escapes, an operator can spend the
    // pool that pays Spin prizes.
    const guards = modal.match(/\{!readOnly && \(/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(2);

    // The send button must sit AFTER the first guard - i.e. inside a guarded
    // region - and never before one.
    const firstGuard = modal.indexOf('{!readOnly && (');
    const sendButton = modal.indexOf('Pick A Member');
    expect(firstGuard).toBeGreaterThan(-1);
    expect(sendButton).toBeGreaterThan(firstGuard);
  });

  it('does not fetch the roster it would never show', () => {
    const branch = modal.slice(modal.indexOf('if (readOnly)'), modal.indexOf('setReserveLedger(('));
    expect(branch).not.toMatch(/fn_union_player_directory/);
  });

  it('points the operator at the control that DOES add funds', () => {
    expect(modal).toMatch(/Fund Spin Reserve/);
    expect(page).toMatch(/unionApi\.fundSpinReserve\(/);
  });
});

describe('a tournament theme waits for its authoritative format', () => {
  it('the hook still waits rather than guessing', () => {
    // 2026-08-25: was a text match on the hook's source. The guard became an
    // exported function during the theme-persistence audit — same behaviour,
    // different characters — so it is asserted by CALLING it now. A guard
    // pinned by grep is pinned to its formatting, not to what it does.
    expect(resolveThemeBucket(undefined, true, undefined)).toBeNull();
    expect(resolveThemeBucket('nlh', true, undefined)).toBeNull();
    expect(resolveThemeBucket(undefined, true, 'mtt')).toBe('MTT');
  });

  it('TablePage clears unresolved format and seat-purchase eligibility on an unreadable row', () => {
    expect(table).toMatch(/setTournamentFormat\(null\);\s*setSeatFirstBuyIn\(null\)/);
    expect(table).toContain('getTournamentFormatKind(tournData)');
  });

  it('cannot relabel a missing or resolved format as a guessed MTT', () => {
    expect(table).not.toMatch(/setTournamentFormat\('mtt'\)/);
    expect(table).not.toMatch(/setTournamentFormat\(\(prev\) => prev \?\? 'mtt'\)/);
  });
});
