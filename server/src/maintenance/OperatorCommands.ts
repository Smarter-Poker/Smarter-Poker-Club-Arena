import { supabase } from '../services/supabase.js';

export type OperatorCommand = {
  id: string;
  actor_id: string;
  domain: 'floor' | 'maintenance';
  action: string;
  reason: string;
  status: string;
  announced_at: string | null;
  result: unknown;
};

/** Durable operation identity is reserved before calling any runtime owner. */
export async function operatorCommand(actorId: string, input: Record<string, unknown>) {
  const { data, error } = await supabase.rpc('fn_ca_engine_operator_command', {
    p_actor_id: actorId,
    p_operation_id: input.operationId,
    p_domain: input.domain,
    p_action: input.action,
    p_reason: input.reason ?? '',
  });
  if (error?.code === '42501' && error.message?.includes('engine_operator_forbidden'))
    throw new Error('engine_operator_forbidden');
  if (error?.code === 'P0001') throw new Error(`engine_operator_refused:${error.message}`);
  if (error || !data) throw new Error('engine_operator_command_outcome_unknown');
  return data as OperatorCommand;
}

export async function operatorCommandStatus(actorId: string, operationId: string) {
  const { data: permissions, error: permissionError } = await supabase.rpc(
    'fn_ca_operator_permissions',
    { p_user_id: actorId }
  );
  if (
    permissionError ||
    !Array.isArray(permissions?.permissions) ||
    permissions.permissions.some((permission: unknown) => typeof permission !== 'string')
  )
    throw new Error('engine_operator_authority_unknown');
  if (!permissions.permissions.includes('console.read'))
    throw new Error('engine_operator_forbidden');
  const { data, error } = await supabase
    .from('ca_engine_operator_commands')
    .select('*')
    .eq('id', operationId)
    .maybeSingle();
  if (error) throw new Error('engine_operator_status_unknown');
  if (!data || data.domain !== 'maintenance' || data.status === 'cancelled')
    return data as OperatorCommand | null;
  const { data: active, error: activeError } = await supabase
    .from('engine_maintenance_break')
    .select('announced_at,phase')
    .eq('id', true)
    .maybeSingle();
  const { data: thaw, error: thawError } = await supabase
    .from('engine_maintenance_thaws')
    .select('announced_at,thawed_at')
    .eq('announced_at', data.announced_at)
    .limit(1)
    .maybeSingle();
  if (activeError || thawError) return { ...data, status: 'unknown' } as OperatorCommand;
  const matchingActive =
    active && Date.parse(active.announced_at) === Date.parse(data.announced_at);
  return {
    ...data,
    status: thaw
      ? 'completed'
      : matchingActive
        ? 'active'
        : ['applying', 'active'].includes(data.status)
          ? 'unknown'
          : data.status,
    result: { ...(data.result ?? {}), active, thaw },
  } as OperatorCommand;
}

export async function readQueuedMaintenance(announcedAt: number): Promise<OperatorCommand | null> {
  const { data, error } = await supabase
    .from('ca_engine_operator_commands')
    .select('*')
    .eq('domain', 'maintenance')
    .eq('action', 'start')
    .eq('status', 'queued')
    .lte('announced_at', new Date(announcedAt).toISOString())
    .order('announced_at')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('operator_maintenance_queue_unknown');
  return data;
}

export async function acknowledgeMaintenance(
  operationId: string,
  announcedAt: number,
  status: string
) {
  const { error } = await supabase.rpc('fn_ca_engine_operator_observe', {
    p_operation_id: operationId,
    p_status: status,
    p_result: { announcedAt, source: 'MaintenanceBreak' },
  });
  if (error) throw new Error('operator_maintenance_ack_unknown');
}

export async function operatorCapabilities(actorId: string) {
  const { data: permissions, error } = await supabase.rpc('fn_ca_operator_permissions', {
    p_user_id: actorId,
  });
  if (
    error ||
    !Array.isArray(permissions?.permissions) ||
    permissions.permissions.some((permission: unknown) => typeof permission !== 'string')
  )
    throw new Error('engine_operator_authority_unknown');
  if (!permissions.permissions.includes('console.read'))
    throw new Error('engine_operator_forbidden');
  const { error: floorError } = await supabase.rpc('fn_ca_operator_floor_state', {
    p_table_id: '00000000-0000-0000-0000-000000000000',
  });
  const { error: commandError } = await supabase
    .from('ca_engine_operator_commands')
    .select('id')
    .limit(1);
  if (floorError || commandError) throw new Error('operator_contract_unknown');
  return {
    version: 'stable-admin-engine-operator-v1',
    floor: ['pause', 'park', 'resume', 'close_cash'],
    maintenance: ['start', 'cancel', 'end'],
    closeScope: 'cash_tables_only',
    maintenanceSchedule: 'existing_hourly',
  };
}
