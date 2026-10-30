// THE VERDICT A BATCH PREVIEW OWES DEPENDS ON THE WALLET THAT FUNDS IT.
//
// The Send Out and Send Ticket confirmations print one status line:
//
//   funding wallet covers the total -> empty validation status
//   funding wallet is short          -> "Insufficient Chips In The Funding Wallet"
//   agent wallet unreadable ("--")   -> "Selected Wallet Could Not Be Verified"
//
// The production canary runs as one maintained read-only identity, and that
// identity holds no agent wallet and no club chips by design: the harness never
// funds or creates a money-bearing identity. A certificate that hard-codes the
// "Ready" verdict therefore asserts a fixture that does not exist (the defect
// that kept the cashier canary red after #6683). The canary instead reads the
// funding figure the dialog itself prints and requires the verdict that figure
// owes, so a wrong verdict in EITHER direction still fails.
//
// Current wallets print exact grouped two-decimal amounts below one million.
// Those figures decide coverage directly, including equality. Legacy compact
// figures remain ranges: whole chips below 1,000, one floored decimal with a
// K/M/B suffix above. "unknown" remains its own outcome (CLAUDE.md 10.86):
// a compact range straddling the total cannot decide the verdict.
//
// No Playwright import: tests/unit/cashierFundingVerdict.test.ts pins this.

export type FundingCoverage = 'covers' | 'short' | 'unreadable' | 'unknown';

const UNITS: Record<string, number> = { '': 1, K: 1_000, M: 1_000_000, B: 1_000_000_000 };

/**
 * The figure one painted funding row prints. CashierWalletRow renders
 * <section aria-label={label}> with the figure as its only <strong>, so the
 * caller passes that element's textContent (never the dialog's innerText,
 * which applies the label's text-transform and runs label and figure
 * together). Anything but exactly one value element is not a reading.
 */
export function printedFundingFigure(valueTexts: readonly string[]): string {
  return valueTexts.length === 1 ? valueTexts[0].trim() : '';
}

export function fundingCoverage(printedFigure: string, total: number): FundingCoverage {
  const figure = printedFigure.trim();
  // The trade dialog's CashierWalletRow prints a single hyphen for a wallet it
  // could not read; the classic surfaces print two. Both are the same answer.
  if (figure === '--' || figure === '-') return 'unreadable';
  if (!Number.isFinite(total)) return 'unknown';
  if (/^-?(?:0|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}$/.test(figure)) {
    const held = Number(figure.replace(/,/g, ''));
    return Number.isFinite(held) ? (held >= total ? 'covers' : 'short') : 'unknown';
  }
  const match = /^(-?)(\d+(?:\.\d)?)([KMB]?)$/.exec(figure);
  // An unsuffixed fractional figure must satisfy the exact wallet contract;
  // it is never a legacy whole-chip compact figure.
  if (!match || (!match[3] && match[2].includes('.'))) return 'unknown';
  const unit = UNITS[match[3]];
  const shown = Number(match[2]) * unit;
  // compactChips floors the magnitude: whole chips below 1,000, tenths of a
  // unit above. The held amount lies in [shown, shown + step).
  const step = match[3] ? unit / 10 : 1;
  const lower = match[1] === '-' ? -(shown + step) : shown;
  const upper = match[1] === '-' ? -shown : shown + step;
  if (lower >= total) return 'covers';
  if (upper <= total) return 'short';
  return 'unknown';
}

export function batchVerdictFor(coverage: FundingCoverage): string | null {
  switch (coverage) {
    case 'covers':
      return '';
    case 'short':
      return 'Insufficient Chips In The Funding Wallet';
    case 'unreadable':
      return 'Selected Wallet Could Not Be Verified';
    default:
      return null;
  }
}
