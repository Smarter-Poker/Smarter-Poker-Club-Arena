/** Read-only credit presentation. Missing or invalid money is never zero debt. */
export const CREDIT_ADMIN_VIEW_LIMIT = 100;
export const CREDIT_ADMIN_AUDIT_LIMIT = 5;

export interface CreditAdminAuditEntry {
  id: string;
  agentName: string;
  oldLimit: number | null;
  newLimit: number | null;
  createdAt: string | null;
}

export interface AgentCredit {
  id: string;
  userId: string;
  clubId: string;
  displayName: string;
  creditLimit: number | null;
  currentBalance: number | null;
  debtOwed: number | null;
  status: string;
}

function readCreditCents(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const text = String(value).trim();
  // Bound untrusted parsing work before constructing a BigInt. This is an
  // input-size guard, not a commercial credit limit.
  if (text.length > 128) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2] || '').slice(2).replace(/0/g, '') !== '') return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0').slice(0, 2));
  return cents;
}

function decimalFromCents(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function readCreditMoney(value: unknown): number | null {
  const cents = readCreditCents(value);
  if (cents === null || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const amount = Number(cents) / 100;
  // Both normal display/serialization and the two-place CSV must preserve
  // exactly the same cents. A safe integer alone does not guarantee this.
  return readCreditCents(amount) === cents && amount.toFixed(2) === decimalFromCents(cents)
    ? amount
    : null;
}

export function creditAdminRow(row: Record<string, unknown>, displayName: string): AgentCredit {
  if (![row.id, row.user_id, row.club_id].every((id) => typeof id === 'string' && id.length > 0)) {
    throw new Error('An agent credit record has no verified account or club identity.');
  }
  return {
    id: row.id as string,
    userId: row.user_id as string,
    clubId: row.club_id as string,
    displayName,
    creditLimit: readCreditMoney(row.credit_limit),
    currentBalance: readCreditMoney(row.agent_wallet_balance),
    debtOwed: readCreditMoney(row.credit_used),
    status: typeof row.status === 'string' && row.status.length > 0 ? row.status : 'Unavailable',
  };
}

export function creditAdminAuditRow(
  row: Record<string, unknown>,
  shownAgents: ReadonlyMap<string, AgentCredit>
): CreditAdminAuditEntry {
  const agent = typeof row.agent_id === 'string' ? shownAgents.get(row.agent_id) : undefined;
  if (!agent || typeof row.id !== 'string' || !row.id) {
    throw new Error('A credit change does not belong to an agent in this view.');
  }
  return {
    id: row.id,
    agentName: agent.displayName,
    oldLimit: readCreditMoney(row.old_limit),
    newLimit: readCreditMoney(row.new_limit),
    createdAt: typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at))
      ? row.created_at : null,
  };
}

export function creditAdminTotal(
  rows: AgentCredit[],
  key: 'creditLimit' | 'debtOwed'
): number | null {
  let cents = 0n;
  for (const row of rows) {
    const amount = row[key];
    if (amount === null || readCreditMoney(amount) === null) return null;
    cents += readCreditCents(amount)!;
  }
  return readCreditMoney(decimalFromCents(cents));
}

export function creditAdminMoney(value: number | null): string {
  return value === null
    ? 'Unavailable'
    : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
