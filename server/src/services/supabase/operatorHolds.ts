/** Operator holds are durable table authority, never an expiring presence park. */
import { supabase } from './client.js';

/** Symbolic native refusals are final; transport/unreadable outcomes are unknown. */
export class OperatorHoldRefusal extends Error {
  constructor(public readonly code: string) {
    super('Operator hold refused');
  }
}

export interface OperatorHold {
  paused: boolean;
  version: number;
  commandId: string | null;
}

function parseHold(data: unknown): OperatorHold {
  const row = data as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.paused !== 'boolean' ||
    !Number.isSafeInteger(row.version) ||
    Number(row.version) < 0 ||
    !(row.command_id === null || typeof row.command_id === 'string')
  ) {
    throw new Error('Operator hold outcome is unreadable');
  }
  return {
    paused: row.paused,
    version: Number(row.version),
    commandId: row.command_id as string | null,
  };
}

export async function readOperatorHold(tableId: string): Promise<OperatorHold> {
  const { data, error } = await supabase.rpc('fn_ca_get_table_operator_hold', {
    p_table_id: tableId,
  });
  if (error) throw new Error('Operator hold read is unconfirmed');
  return parseHold(data);
}

export async function writeOperatorHold(
  tableId: string,
  paused: boolean,
  actorId: string,
  commandId: string,
  generation: string,
  instanceId: string,
  expectedVersion: number
): Promise<OperatorHold> {
  const { data, error } = await supabase.rpc('fn_ca_set_table_operator_hold', {
    p_table_id: tableId,
    p_paused: paused,
    p_actor_id: actorId,
    p_command_id: commandId,
    p_lease_generation: generation,
    p_instance_id: instanceId,
    p_expected_version: expectedVersion,
  });
  if (error) {
    if (['42501', '22023', '40001', '55P03', 'P0002'].includes(error.code))
      throw new OperatorHoldRefusal(error.code);
    throw new Error('Operator hold write is unconfirmed');
  }
  return parseHold(data);
}
