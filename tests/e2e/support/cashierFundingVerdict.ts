// THE VERDICT A BATCH PREVIEW OWES DEPENDS ON THE WALLET THAT FUNDS IT.
//
// The Send Out and Send Ticket confirmations print one status line:
//
//   funding wallet covers the total -> "<n> Recipients Ready For Server Verification"
//   funding wallet is short          -> "Insufficient Chips In The Funding Wallet"
//   agent wallet unreadable ("--")   -> "Agent Wallet Could Not Be Verified"
//
// The production canary runs as one maintained read-only identity, and that
// identity holds no agent wallet and no club chips by design: the harness never
// funds or creates a money-bearing identity. A certificate that hard-codes the
// "Ready" verdict therefore asserts a fixture that does not exist (the defect
// that kept the cashier canary red after #6683). The canary instead reads the
// funding figure the dialog itself prints and requires the verdict that figure
// owes, so a wrong verdict in EITHER direction still fails.
//
// The dialog prints the funding figure with compactChips: whole chips under
// 1,000, one floored decimal with a K/M/B suffix above. The printed figure is
// therefore a range, never overstated. "unknown" is its own outcome (CLAUDE.md
// 10.86): a figure whose range straddles the total cannot decide the verdict,
// and the caller must say so rather than guess.
//
// No Playwright import: tests/unit/cashierFundingVerdict.test.ts pins this.

export type FundingCoverage = 'covers' | 'short' | 'unreadable' | 'unknown';

const UNITS: Record<string, number> = { '': 1, K: 1_000, M: 1_000_000, B: 1_000_000_000 };

export function fundingCoverage(printedFigure: string, total: number): FundingCoverage {
  const figure = printedFigure.trim();
  if (figure === '--') return 'unreadable';
  const match = /^(-?)(\d+(?:\.\d)?)([KMB]?)$/.exec(figure);
  if (!match || !Number.isFinite(total)) return 'unknown';
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

export function batchVerdictFor(coverage: FundingCoverage, recipients: number): string | null {
  switch (coverage) {
    case 'covers':
      return `${recipients} Recipients Ready For Server Verification`;
    case 'short':
      return 'Insufficient Chips In The Funding Wallet';
    case 'unreadable':
      return 'Agent Wallet Could Not Be Verified';
    default:
      return null;
  }
}

export const BATCH_VERDICTS = [
  'Recipients Ready For Server Verification',
  'Insufficient Chips In The Funding Wallet',
  'Agent Wallet Could Not Be Verified',
] as const;
