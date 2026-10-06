export const UUID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_ROLES = new Set(['super_agent', 'agent', 'sub_agent']);
const AGENT_STATUSES = new Set(['active', 'suspended', 'frozen']);
const PAYABLE_CAP = 500;

type JsonRecord = Record<string, unknown>;

export interface AgentPayableRow {
  agent_id: string;
  user_id: string;
  name: string;
  role: string;
  status: string;
  is_prepaid: boolean;
  credit_limit: number;
  credit_used: number;
  credit_available: number;
  utilization: number;
  commission_rate: number;
  player_rakeback_rate: number;
  total_players: number;
  owed: number;
  rows_behind: number;
  oldest_unsettled: string | null;
}

export interface AgentPayables {
  agents: number;
  cap: number;
  total_owed: number;
  total_rows: number;
  oldest_unsettled: string | null;
  rollup_checked_at: string | null;
  rows: AgentPayableRow[];
  generated_at: string;
}

function malformed(field: string): never {
  throw new Error(`The Agent Payables Receipt Is Malformed (${field}).`);
}

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed(field);
  return value as JsonRecord;
}

function uuidValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_TOKEN.test(value)) return malformed(field);
  return value.toLowerCase();
}

function textValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) return malformed(field);
  return value.trim();
}

function numberValue(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; integer?: boolean; scale?: number } = {}
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?(?:\d+)(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return malformed(field);
  if (options.min !== undefined && parsed < options.min) return malformed(field);
  if (options.max !== undefined && parsed > options.max) return malformed(field);
  if (options.integer && !Number.isInteger(parsed)) return malformed(field);
  if (options.scale !== undefined) {
    const factor = 10 ** options.scale;
    if (Math.abs(parsed * factor - Math.round(parsed * factor)) > 1e-6) {
      return malformed(field);
    }
  }
  return parsed;
}

function timestampValue(value: unknown, field: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    return malformed(field);
  }
  return value;
}

function cents(value: number): number {
  return Math.round(value * 100);
}

function parseRow(value: unknown, index: number): AgentPayableRow {
  const row = record(value, `rows[${index}]`);
  const role = textValue(row.role, `rows[${index}].role`);
  const status = textValue(row.status, `rows[${index}].status`);
  if (!AGENT_ROLES.has(role)) return malformed(`rows[${index}].role`);
  if (!AGENT_STATUSES.has(status)) return malformed(`rows[${index}].status`);
  if (typeof row.is_prepaid !== 'boolean') return malformed(`rows[${index}].is_prepaid`);

  const creditLimit = numberValue(row.credit_limit, `rows[${index}].credit_limit`, {
    min: 0,
    scale: 2,
  });
  const creditUsed = numberValue(row.credit_used, `rows[${index}].credit_used`, {
    min: 0,
    scale: 2,
  });
  const creditAvailable = numberValue(row.credit_available, `rows[${index}].credit_available`, {
    min: 0,
    scale: 2,
  });
  const utilization = numberValue(row.utilization, `rows[${index}].utilization`, {
    min: 0,
    scale: 4,
  });
  const expectedAvailable = Math.max(cents(creditLimit) - cents(creditUsed), 0);
  const expectedUtilization =
    creditLimit > 0 ? Math.round((creditUsed / creditLimit) * 10_000) / 10_000 : 0;
  if (cents(creditAvailable) !== expectedAvailable) {
    return malformed(`rows[${index}].credit_available`);
  }
  if (Math.abs(utilization - expectedUtilization) > 1e-9) {
    return malformed(`rows[${index}].utilization`);
  }

  return {
    agent_id: uuidValue(row.agent_id, `rows[${index}].agent_id`),
    user_id: uuidValue(row.user_id, `rows[${index}].user_id`),
    name: textValue(row.name, `rows[${index}].name`),
    role,
    status,
    is_prepaid: row.is_prepaid,
    credit_limit: creditLimit,
    credit_used: creditUsed,
    credit_available: creditAvailable,
    utilization,
    commission_rate: numberValue(row.commission_rate, `rows[${index}].commission_rate`, {
      min: 0,
      max: 0.7,
      scale: 4,
    }),
    player_rakeback_rate: numberValue(
      row.player_rakeback_rate,
      `rows[${index}].player_rakeback_rate`,
      { min: 0, max: 0.5, scale: 4 }
    ),
    total_players: numberValue(row.total_players, `rows[${index}].total_players`, {
      min: 0,
      integer: true,
    }),
    owed: numberValue(row.owed, `rows[${index}].owed`, { min: 0, scale: 2 }),
    rows_behind: numberValue(row.rows_behind, `rows[${index}].rows_behind`, {
      min: 0,
      integer: true,
    }),
    oldest_unsettled: timestampValue(row.oldest_unsettled, `rows[${index}].oldest_unsettled`, true),
  };
}

/** Strict client mirror of public.fn_ca_agent_payables(uuid). */
export function parseAgentPayablesPayload(value: unknown): AgentPayables {
  const receipt = record(value, 'receipt');
  if (!Array.isArray(receipt.rows)) return malformed('rows');

  const agents = numberValue(receipt.agents, 'agents', { min: 0, integer: true });
  const cap = numberValue(receipt.cap, 'cap', { min: 1, integer: true });
  if (cap !== PAYABLE_CAP) return malformed('cap');
  if (receipt.rows.length !== Math.min(agents, cap)) return malformed('rows.length');

  const rows = receipt.rows.map(parseRow);
  const agentIds = new Set<string>();
  const userIds = new Set<string>();
  for (const row of rows) {
    if (agentIds.has(row.agent_id)) return malformed('rows.agent_id');
    if (userIds.has(row.user_id)) return malformed('rows.user_id');
    agentIds.add(row.agent_id);
    userIds.add(row.user_id);
    if ((row.rows_behind === 0) !== (row.oldest_unsettled === null)) {
      return malformed('rows.oldest_unsettled');
    }
    if (row.rows_behind === 0 && cents(row.owed) !== 0) {
      return malformed('rows.owed');
    }
  }

  const totalOwed = numberValue(receipt.total_owed, 'total_owed', { min: 0, scale: 2 });
  const totalRows = numberValue(receipt.total_rows, 'total_rows', {
    min: 0,
    integer: true,
  });
  const oldest = timestampValue(receipt.oldest_unsettled, 'oldest_unsettled', true);
  const rollupCheckedAt = timestampValue(receipt.rollup_checked_at, 'rollup_checked_at', true);
  const generatedAt = timestampValue(receipt.generated_at, 'generated_at');
  if (generatedAt === null) return malformed('generated_at');

  const visibleOwedCents = rows.reduce((sum, row) => sum + cents(row.owed), 0);
  const visibleRows = rows.reduce((sum, row) => sum + row.rows_behind, 0);
  if (agents <= cap) {
    if (cents(totalOwed) !== visibleOwedCents || totalRows !== visibleRows) {
      return malformed('totals');
    }
  } else if (cents(totalOwed) < visibleOwedCents || totalRows < visibleRows) {
    return malformed('bounded_totals');
  }
  if ((totalRows === 0) !== (oldest === null)) return malformed('oldest_unsettled');
  if (totalRows === 0 && cents(totalOwed) !== 0) return malformed('total_owed');

  const generatedMs = Date.parse(generatedAt);
  for (const [index, row] of rows.entries()) {
    if (row.oldest_unsettled !== null && Date.parse(row.oldest_unsettled) > generatedMs) {
      return malformed(`rows[${index}].oldest_unsettled`);
    }
  }
  const visibleOldestMs = rows.reduce<number | null>((current, row) => {
    if (row.oldest_unsettled === null) return current;
    const rowMs = Date.parse(row.oldest_unsettled);
    return current === null ? rowMs : Math.min(current, rowMs);
  }, null);
  const oldestMs = oldest === null ? null : Date.parse(oldest);
  if (agents <= cap) {
    if (oldestMs !== visibleOldestMs) return malformed('oldest_unsettled');
  } else if (oldestMs !== null && visibleOldestMs !== null && oldestMs > visibleOldestMs) {
    return malformed('oldest_unsettled');
  }
  if (oldest !== null && Date.parse(oldest) > generatedMs) return malformed('oldest_unsettled');
  if (rollupCheckedAt !== null && Date.parse(rollupCheckedAt) > generatedMs) {
    return malformed('rollup_checked_at');
  }

  return {
    agents,
    cap,
    total_owed: totalOwed,
    total_rows: totalRows,
    oldest_unsettled: oldest,
    rollup_checked_at: rollupCheckedAt,
    rows,
    generated_at: generatedAt,
  };
}
