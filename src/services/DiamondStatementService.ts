import { supabase } from '../lib/supabase';

const totals = [
  'entry_diamonds',
  'bonus_diamonds',
  'mint_entry_diamonds',
  'diamond_prizes',
  'throwables',
  'time_banks',
  'rabbit_hunts',
  'other_expenses',
] as const;
export type DiamondStatement = Record<(typeof totals)[number], number> & {
  day: string;
  status: 'open' | 'settled';
  net_diamonds: number;
  settled_at: string | null;
  wallet_transaction_id: string | null;
  hosts: {
    host_id: string;
    host_kind: 'union' | 'club';
    host_name: string | null;
    entries: number;
    expenses: number;
    net_diamonds: number;
  }[];
};
export interface DiamondStatements {
  timezone: 'America/Chicago';
  days: DiamondStatement[];
  next_before_day: string | null;
}
const day = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function loadDiamondStatements(
  before: string | null = null
): Promise<DiamondStatements> {
  if (before !== null && !day(before)) throw new Error('Invalid Statement Date');
  const { data, error } = await supabase.rpc(
    'fn_diamond_spin_statements' as never,
    { p_before_day: before } as never
  );
  if (error) throw error;
  const result = data as unknown as DiamondStatements & { ok?: boolean; error?: string };
  if (!result || result.ok !== true)
    throw new Error(result?.error ?? 'Diamond Statements Could Not Be Loaded');
  const bad = () => {
    throw new Error('Diamond Statement Totals Could Not Be Verified');
  };
  if (
    result.timezone !== 'America/Chicago' ||
    !Array.isArray(result.days) ||
    result.days.length > 31 ||
    (result.next_before_day !== null && !day(result.next_before_day))
  )
    bad();
  let previous = before;
  for (const row of result.days) {
    if (
      !row ||
      !day(row.day) ||
      (previous !== null && row.day >= previous) ||
      !['open', 'settled'].includes(row.status) ||
      !integer(row.net_diamonds) ||
      !totals.every((key) => integer(row[key]) && row[key] >= 0) ||
      !Array.isArray(row.hosts) ||
      (row.wallet_transaction_id !== null && !uuid(row.wallet_transaction_id)) ||
      (row.status === 'open'
        ? row.settled_at !== null
        : typeof row.settled_at !== 'string' || !Number.isFinite(Date.parse(row.settled_at)))
    )
      bad();
    const entries = row.entry_diamonds + row.bonus_diamonds + row.mint_entry_diamonds;
    const expenses =
      row.diamond_prizes + row.throwables + row.time_banks + row.rabbit_hunts + row.other_expenses;
    if (entries - expenses !== row.net_diamonds) bad();
    for (const host of row.hosts) {
      if (
        !host ||
        !uuid(host.host_id) ||
        !['club', 'union'].includes(host.host_kind) ||
        (host.host_name !== null && typeof host.host_name !== 'string') ||
        !integer(host.entries) ||
        host.entries < 0 ||
        !integer(host.expenses) ||
        host.expenses < 0 ||
        !integer(host.net_diamonds) ||
        host.net_diamonds !== host.entries - host.expenses
      )
        bad();
    }
    if (
      row.hosts.reduce((n, h) => n + h.entries, 0) !== entries ||
      row.hosts.reduce((n, h) => n + h.expenses, 0) !== expenses
    )
      bad();
    previous = row.day;
  }
  if (
    result.next_before_day !== null &&
    result.next_before_day !== result.days[result.days.length - 1]?.day
  )
    bad();
  return result;
}
