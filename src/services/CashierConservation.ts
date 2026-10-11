import { supabase } from '../lib/supabase';
import { compactChips } from '../utils/format';

type Verdict = 'verified' | 'attention' | 'incomplete';
export interface CashierConservation {
  schema_version: 1;
  club_id: string;
  as_of: string;
  scope: 'bank_and_player_baselines';
  bank: {
    status: Verdict;
    actual: string | null;
    expected: string | null;
    drift: string | null;
    baseline_at: string | null;
  };
  players: {
    status: Verdict;
    positions: number;
    checked: number;
    missing: number;
    mismatches: number;
    actual: string | null;
    expected: string | null;
    net_drift: string;
    absolute_drift: string;
  };
  inventory: {
    agent_wallets: string | null;
    promo_wallets: string | null;
    held_chips: string | null;
    cash_stacks: string | null;
  };
}

// Compare decimal strings exactly. Financial verdicts never depend on binary
// floating point or a tolerance that can conceal a small discrepancy.
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d{1,30}(\.\d{1,12})?$/.test(value))
    throw new Error('Invalid Accounting Amount');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return BigInt(whole + fraction.padEnd(12, '0')) * (negative ? -1n : 1n);
}
const absolute = (value: bigint) => (value < 0n ? -value : value);
function nullableAmount(value: unknown) {
  if (value !== null) decimal(value);
}
function count(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Invalid Accounting Coverage');
}
export function validateCashierConservation(value: unknown, clubId: string): CashierConservation {
  const r = value as CashierConservation;
  if (
    !r ||
    r.schema_version !== 1 ||
    r.club_id !== clubId ||
    r.scope !== 'bank_and_player_baselines' ||
    typeof r.as_of !== 'string' ||
    !Number.isFinite(Date.parse(r.as_of)) ||
    !r.bank ||
    !r.players ||
    !r.inventory
  )
    throw new Error('Accounting Report Could Not Be Verified');
  const b = r.bank,
    p = r.players;
  [b.actual, b.expected, b.drift, p.actual, p.expected].forEach(nullableAmount);
  const net = decimal(p.net_drift),
    abs = decimal(p.absolute_drift);
  [p.positions, p.checked, p.missing, p.mismatches].forEach(count);
  if (
    p.positions !== p.checked + p.missing ||
    p.mismatches > p.checked ||
    abs < absolute(net) ||
    (p.mismatches === 0 && abs !== 0n) ||
    (p.mismatches > 0 && abs === 0n) ||
    (p.checked > 0 &&
      (p.actual === null || p.expected === null || decimal(p.actual) - decimal(p.expected) !== net))
  )
    throw new Error('Accounting Coverage Disagrees');
  const playerStatus =
    p.mismatches > 0 ? 'attention' : p.missing > 0 || p.checked === 0 ? 'incomplete' : 'verified';
  const bankCovered =
    b.actual !== null &&
    b.expected !== null &&
    b.drift !== null &&
    typeof b.baseline_at === 'string' &&
    Number.isFinite(Date.parse(b.baseline_at)) &&
    Date.parse(b.baseline_at) <= Date.parse(r.as_of);
  const bankStatus = !bankCovered
    ? 'incomplete'
    : decimal(b.drift) === 0n
      ? 'verified'
      : 'attention';
  if (
    b.status !== bankStatus ||
    p.status !== playerStatus ||
    (bankCovered && decimal(b.actual) - decimal(b.expected) !== decimal(b.drift))
  )
    throw new Error('Accounting Verdict Disagrees');
  Object.values(r.inventory).forEach(nullableAmount);
  for (const key of ['agent_wallets', 'promo_wallets', 'held_chips', 'cash_stacks'] as const)
    nullableAmount(r.inventory[key]);
  return r;
}
export async function readCashierConservation(clubId: string): Promise<CashierConservation> {
  const { data, error } = await supabase.rpc('fn_cashier_conservation_report', {
    p_club_id: clubId,
  });
  if (error) throw error;
  return validateCashierConservation(data, clubId);
}
export function conservationChips(value: string | null): string {
  if (value === null) return 'Unknown';
  const exact = decimal(value);
  if (exact === 0n) return '0';
  const sign = exact < 0n ? 'Minus ' : '';
  const whole = absolute(exact) / 1_000_000_000_000n;
  if (whole === 0n) return `${sign}Less Than 1 Chip`;
  // Typical club values use the same formatter as the rest of the cashier.
  return (
    sign +
    (whole <= BigInt(Number.MAX_SAFE_INTEGER)
      ? compactChips(Number(whole))
      : whole.toLocaleString())
  );
}
