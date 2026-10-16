// Wallet precision is distinct from compact transaction/statistic figures.
// Dan, October 16: exact balances below one million, including 1,000.00.
export function isExactCashierWalletFigure(value: string): boolean {
  const text = value.trim();
  if (/^-?(?:0|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}$/.test(text)) {
    return Math.abs(Number(text.replace(/,/g, ''))) < 1_000_000;
  }
  return /^-?[1-9]\d*(?:\.\d)?[MB]$/.test(text);
}
