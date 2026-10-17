// Test oracle for the independently read wallet amount; never import the
// production formatter, which is the behavior the browser certificate checks.
export function expectedWalletChipDisplay(amount: number): string {
  if (!Number.isFinite(amount)) throw new Error('Wallet expectation requires a finite balance.');
  const magnitude = Math.abs(amount);
  if (magnitude < 1_000_000) {
    return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // The established large-wallet policy truncates to tenths, never rounding
  // up. Derive the printed digits directly rather than calling runtime code.
  const unit = magnitude >= 1_000_000_000 ? 1_000_000_000 : 1_000_000;
  const tenths = Math.floor(Math.floor(magnitude) / (unit / 10));
  const fraction = tenths % 10;
  return `${amount < 0 ? '-' : ''}${Math.floor(tenths / 10)}${fraction ? `.${fraction}` : ''}${unit === 1_000_000_000 ? 'B' : 'M'}`;
}
