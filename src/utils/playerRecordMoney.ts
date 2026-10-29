/** Player Record monetary statistics show full cents (owner, 2026-10-28).
 * Keep this record-specific: other surfaces own their display contracts.
 */
export function playerRecordMoney(amount: number | null | undefined, signed = false): string {
  if (amount == null) return 'Restricted';
  if (!Number.isFinite(amount)) return '-';
  const text = amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (text === '-0.00' || text === '0.00') return '0.00';
  return signed && amount > 0 ? `+${text}` : text;
}
