/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WALLET DISPLAY + LEDGER — regression pins for the 2026-08-25 audit
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every assertion below corresponds to a defect that was live in production
 * when this file was written, and every category / transaction_type named here
 * was read out of the real database on that date, not invented.
 *
 * The rule these pin, in one sentence: A DISPLAY MUST NEVER SHOW A RAW DATABASE
 * ENUM, MUST NEVER PRESENT A FAILED READ AS A BALANCE, AND MUST NEVER PUT TWO
 * DIFFERENT ACCOUNTS UNDER ONE LABEL.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { formatCategory } from '../src/components/wallet/TransactionHistory';
import { labelForTransactionType } from '../src/components/wallet/PlayerWalletModal';
import { diamondTxLabel } from '../src/components/wallet/DiamondWalletModal';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. wallet_transactions — every live category has a name
// ═══════════════════════════════════════════════════════════════════════════════

describe('TransactionHistory category labels', () => {
  /**
   * Counts are the production row counts on 2026-08-25. The four marked NEW had
   * no entry in the label map and rendered as the raw enum - including
   * `tournament_buyin`, which at 85,589 rows is the second largest category of
   * spend on the platform.
   */
  const LIVE_CATEGORIES = [
    'rake', // 1,332,340
    'buyin', // 668,382
    'cashout', // 137,963
    'tournament_buyin', // 85,589  NEW
    'prize', // 31,841
    'rebuy', // 13,637
    'bounty', // 7,217   NEW
    'addon', // 5,014
    'rakeback', // 1,571   NEW
    'deposit', // 764
    'transfer', // 575
    'settlement', // 202
    'addon_refund', // 103     NEW
    'refund', // 25
    'mint', // 3
    'commission', // 2
    'promo', // 1
  ];

  it('names every category that exists in production', () => {
    for (const category of LIVE_CATEGORIES) {
      const label = formatCategory(category);
      expect(label, `category ${category}`).toBeTruthy();
      // The failure this pins: the label WAS the enum.
      expect(label, `category ${category} rendered its raw enum`).not.toBe(category);
    }
  });

  it('names the four that were missing, specifically', () => {
    expect(formatCategory('tournament_buyin')).toBe('Tournament Buy-In');
    expect(formatCategory('bounty')).toBe('Bounty');
    expect(formatCategory('rakeback')).toBe('Rakeback');
    expect(formatCategory('addon_refund')).toBe('Add-On Refund');
  });

  it('degrades an unknown category to English, never to the enum or to blank', () => {
    expect(formatCategory('weekly_streak_bonus')).toBe('Weekly Streak Bonus');
    expect(formatCategory('some-new-thing')).toBe('Some New Thing');
  });

  it('formats a SCREAMING_CASE enum the way house rule 9 requires', () => {
    // The canonical example from CLAUDE.md section 9.
    expect(formatCategory('HIGH_HAND')).toBe('High Hand');
  });

  it('never renders blank for a null or empty category', () => {
    expect(formatCategory(null)).toBe('Movement');
    expect(formatCategory(undefined)).toBe('Movement');
    expect(formatCategory('')).toBe('Movement');
    expect(formatCategory('   ')).toBe('Movement');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. chip_transactions — the club statement
// ═══════════════════════════════════════════════════════════════════════════════

describe('PlayerWalletModal transaction_type labels', () => {
  it('names every cash-out lifecycle step distinctly', () => {
    // A statement that renders request, approval, denial and expiry the same
    // way cannot be reconciled by the person reading it.
    const lifecycle = {
      cashout_request: 'Cash Out Requested',
      cashout_approved: 'Cash Out Approved',
      cashout_denied: 'Cash Out Denied',
      cashout_cancelled: 'Cash Out Cancelled',
      cashout_expired: 'Cash Out Expired',
      cashout_refund: 'Cash Out Returned',
    };
    for (const [type, label] of Object.entries(lifecycle)) {
      expect(labelForTransactionType(type)).toBe(label);
    }
    const labels = Object.values(lifecycle);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('keeps acronyms intact instead of title-casing them into nonsense', () => {
    // Plain title-casing lower-cases the tail of every word, which turned these
    // two live types into "Bbj Promo Sweep" and "Union Pnl Payout".
    expect(labelForTransactionType('bbj_promo_sweep')).toBe('BBJ Promo Sweep');
    expect(labelForTransactionType('union_pnl_payout')).toBe('Union PnL Payout');
  });

  it('names the agent, claim-back, mint, rake and rakeback movements', () => {
    expect(labelForTransactionType('agent_funding')).toBe('Agent Funding');
    expect(labelForTransactionType('club_bank_send')).toBe('Club Bank Send');
    expect(labelForTransactionType('admin_removal')).toBe('Claimed Back');
    expect(labelForTransactionType('mint')).toBe('Chip Mint');
    expect(labelForTransactionType('treasury_mint')).toBe('Treasury Mint');
    expect(labelForTransactionType('rakeback')).toBe('Rakeback');
  });

  it('degrades an unknown type to English and never renders blank', () => {
    expect(labelForTransactionType('some_future_type')).toBe('Some Future Type');
    expect(labelForTransactionType(null)).toBe('Chip Movement');
    expect(labelForTransactionType('')).toBe('Chip Movement');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. diamond_transactions — the diamond wallet
// ═══════════════════════════════════════════════════════════════════════════════

describe('DiamondWalletModal transaction labels', () => {
  /**
   * These eleven types are all live in `diamond_transactions` and every one of
   * them fell through to the grey "Adjustment" fallback - indistinguishable
   * from an admin correction, which is the exact complaint the component's own
   * `feature_purchase` comment was written about.
   */
  const PREVIOUSLY_UNLABELLED = [
    'reconciliation', // 557 rows: the single largest group in the table
    'live_gift_sent',
    'live_gift_received',
    'diamond_gift_sent',
    'diamond_gift_received',
    'diamond_gift_refund',
    'pvp_stake',
    'training_reward',
    'easter_egg',
    'chip_mint',
    'trivia_arcade',
    'trivia_run',
  ];

  it('no live diamond type renders as "Adjustment"', () => {
    for (const type of PREVIOUSLY_UNLABELLED) {
      expect(diamondTxLabel(type), `type ${type}`).not.toBe('Adjustment');
      expect(diamondTxLabel(type), `type ${type}`).not.toBe(type);
    }
  });

  it('an unknown type reads as English rather than claiming to be an adjustment', () => {
    // "Adjustment" is a claim that somebody corrected the account. Saying it
    // about a type we simply do not recognise is a lie about the player's
    // money, not a harmless default.
    expect(diamondTxLabel('brand_new_reward')).toBe('Brand New Reward');
    expect(diamondTxLabel('brand_new_reward')).not.toBe('Adjustment');
  });

  it('never renders blank', () => {
    expect(diamondTxLabel(null)).toBe('Diamond Movement');
    expect(diamondTxLabel('')).toBe('Diamond Movement');
  });

  it('still honours the explicit names it already had', () => {
    expect(diamondTxLabel('feature_purchase')).toBe('Feature Purchase');
    expect(diamondTxLabel('signup_bonus')).toBe('Welcome Bonus');
    expect(diamondTxLabel('adjustment')).toBe('Adjustment');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SOURCE GUARDS — the fixes that are structural, not functional
// ═══════════════════════════════════════════════════════════════════════════════

describe('the diamond wallet reads diamonds, and only diamonds', () => {
  const SRC = read('src/components/wallet/DiamondWalletModal.tsx');

  it('does not read the CHIP ledger', () => {
    // It used to pull `category IN (..., 'mint', ...)` out of
    // wallet_transactions - a CHIP mint, in tens of thousands, rendered on a
    // DIAMOND statement as a movement of that size. Five of the six categories
    // it filtered on are rejected outright by the table's CHECK constraint, so
    // the query was five-sixths dead and one-sixth wrong.
    expect(SRC).not.toContain("from('wallet_transactions')");
  });

  it('reads the older `type` column as well as `transaction_type`', () => {
    // 774 of the rows in diamond_transactions carry a NULL transaction_type -
    // 557 `reconciliation` and 216 `signup_bonus` - with their kind in `type`.
    // Selecting only transaction_type is why a player's Welcome Bonus, the
    // first diamond movement on every account ever opened, said "Adjustment".
    expect(SRC).toMatch(/select\(\s*'id,\s*type,\s*transaction_type/);
  });

  it('surfaces a failed read instead of calling it an empty wallet', () => {
    expect(SRC).toContain('setLoadError');
    expect(SRC).toContain('Could Not Load Your Diamond History');
  });
});

describe('the deposit/withdraw sheet does not forge ledger rows', () => {
  const SRC = read('src/components/wallet/DepositWithdrawModal.tsx');

  it('no longer inserts into wallet_transactions', () => {
    // That insert was impossible four ways over (no INSERT policy; four columns
    // that do not exist; a type CHECK violation; no category) and, had it been
    // possible, would have shown a PENDING deposit as a SETTLED credit in the
    // history rendered three lines further up the same page.
    expect(SRC).not.toMatch(/from\('wallet_transactions'\)[\s\S]{0,80}\.insert/);
  });

  it('says plainly that the channel is not open rather than failing generically', () => {
    expect(SRC).toContain('FUNDING_ENDPOINT');
    expect(SRC).toMatch(/Deposits Are Not Open On This Channel Yet/);
  });
});

describe('the transaction history pages on the server', () => {
  const SRC = read('src/components/wallet/TransactionHistory.tsx');

  it('uses .range() rather than slicing a page it already has', () => {
    // The old Load More was unreachable code: it fetched `limit` rows (20) and
    // then gated the button on having more than a 25-row page of them.
    expect(SRC).toContain('.range(');
  });

  it('filters on the server so paging and filtering agree', () => {
    expect(SRC).toMatch(/query\.eq\('type'/);
    expect(SRC).toMatch(/query\.eq\('category'/);
  });

  it('does not tear the list down to a skeleton on every refresh', () => {
    // `loading` gates the skeleton, and it used to be raised at the top of
    // every fetch - so a buy-in three seats away replaced the whole history
    // with shimmer bars. It is now raised in exactly ONE place, the effect that
    // runs on mount and on a filter or user change; the fetch itself never
    // raises it, and Load More has its own `loadingMore` flag instead.
    expect(SRC).toContain('loadingMore');
    const raises = SRC.match(/setLoading\(true\)/g) || [];
    expect(raises.length, 'setLoading(true) must appear exactly once').toBe(1);
  });

  it('subscribes to the same bus events the wallet panel refreshes on', () => {
    // The panel above this list refreshed on CHIPS_ADDED and CHIPS_WITHDRAWN
    // and the list below it did not, so a top-up moved the balance while the
    // history under it still showed the movement missing.
    expect(SRC).toContain("'CHIPS_ADDED'");
    expect(SRC).toContain("'CHIPS_WITHDRAWN'");
  });
});

describe('wallet separation and honest labels', () => {
  it('the club panel does not render a second Backup BBJ row on a union panel', () => {
    // UNION_ROWS already carries `union_backup_bbj` off the same animated
    // value; the extra row below the stack was gated only on `!isClubInUnion`,
    // so a union panel pointed at a standalone club showed the same reserve
    // twice, one row apart.
    const SRC = read('src/components/wallet/DynamicWallet.tsx');
    expect(SRC).toMatch(
      /effectiveVariant === 'club'\s*&&\s*!isClubInUnion\s*&&\s*data\.backupBBJ > 0/
    );
  });

  it('the wallet page does not call a sum of three wallets a "Total Balance"', () => {
    const SRC = read('src/pages/PlayerWalletPage.tsx');
    expect(SRC).not.toContain('>Total Balance<');
    expect(SRC).toContain('All Wallets Combined');
    // ...and states the figure that can actually be played with.
    expect(SRC).toContain('Playable Now');
  });

  it('the diamond readout is not a button that does nothing', () => {
    const SRC = read('src/pages/PlayerWalletPage.tsx');
    expect(SRC).not.toMatch(/className="hero-diamonds"\s+role="button"/);
  });
});

describe('house rules', () => {
  const WALLET_FILES = [
    'src/components/wallet/DynamicWallet.tsx',
    'src/components/wallet/PlayerWalletModal.tsx',
    'src/components/wallet/TransactionHistory.tsx',
    'src/components/wallet/DepositWithdrawModal.tsx',
    'src/components/wallet/DiamondWalletModal.tsx',
    'src/components/wallet/index.ts',
    'src/pages/PlayerWalletPage.tsx',
    'src/services/WalletService.ts',
  ];

  /** Stylesheets count as source. The banner of one carried a card emoji. */
  const WALLET_STYLES = [
    'src/components/wallet/DynamicWallet.css',
    'src/components/wallet/TransactionHistory.css',
    'src/components/wallet/DepositWithdrawModal.module.css',
    'src/components/wallet/DiamondWalletModal.css',
    'src/pages/PlayerWalletPage.css',
  ];

  /**
   * Pictographs only. This deliberately does NOT match the typographic symbols
   * these files use on purpose (diamonds, spades, arrows, the warning
   * triangle) - those are BMP dingbats, not emoji, they do not carry a
   * variation selector, and they are what the emoji purge replaced the emoji
   * WITH. The rule is about emoji breaking the SWC compiler.
   */
  const EMOJI = /[\u{1F000}-\u{1FAFF}]|\u{FE0F}/u;

  it('no emoji in any wallet source file', () => {
    for (const file of [...WALLET_FILES, ...WALLET_STYLES]) {
      const src = read(file);
      const hit = src.match(EMOJI);
      expect(hit, `${file} contains emoji ${hit?.[0]}`).toBeNull();
    }
  });

  /**
   * The codepoints below live OUTSIDE the plane the regex above scans, but
   * Unicode lists every one of them as an RGI emoji - so iOS and Android render
   * them in full colour, which is the thing the rule is actually about. They
   * are named individually rather than swept by range because the same
   * neighbourhood holds the card suits, the warning triangle and the chess
   * pieces that this product uses on purpose.
   */
  const EMOJI_IN_BMP = ['⚡', '⚔', '⚙', '⚭', '⚯', '⚑', '☖'];

  it('no colour-rendering BMP symbol smuggled in as a "dingbat"', () => {
    for (const file of [...WALLET_FILES, ...WALLET_STYLES]) {
      const src = read(file);
      for (const cp of EMOJI_IN_BMP) {
        expect(src.includes(cp), `${file} contains U+${cp.codePointAt(0)!.toString(16)}`).toBe(
          false
        );
      }
    }
  });

  it('no em or en dash in any toast this pass touches', () => {
    // popupStyle.formatPopupText strips them at render time, but a string
    // written with one is a string somebody will copy into a non-toast surface.
    for (const file of WALLET_FILES) {
      const src = read(file);
      const toasts = src.match(/toast\.(error|success|info|warning)\((['"`])[^'"`]*\2/g) || [];
      for (const t of toasts) {
        expect(t, `${file}: ${t}`).not.toMatch(/[—–]/);
      }
    }
  });

  it('every toast this pass touches is already in Title Case', () => {
    for (const file of WALLET_FILES) {
      const src = read(file);
      const toasts = src.match(/toast\.(error|success|info|warning)\(['"]([^'"]+)['"]/g) || [];
      for (const t of toasts) {
        const text = t.replace(/^toast\.\w+\(['"]/, '').replace(/['"]$/, '');
        for (const word of text.split(/\s+/)) {
          // Skip interpolations, punctuation-only fragments and short joiners
          // that Title Case leaves alone in ordinary English.
          if (!/^[a-zA-Z]/.test(word)) continue;
          expect(word[0], `${file}: "${text}" -> "${word}"`).toBe(word[0].toUpperCase());
        }
      }
    }
  });
});
