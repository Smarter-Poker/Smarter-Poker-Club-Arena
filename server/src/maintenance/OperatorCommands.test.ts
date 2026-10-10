import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../services/supabase.js';
import {
  operatorCapabilities,
  operatorCommand,
  operatorCommandStatus,
} from './OperatorCommands.js';
afterEach(() => vi.restoreAllMocks());
describe.each([
  ['receipt read', () => operatorCommandStatus('actor', 'operation')],
  ['capability read', () => operatorCapabilities('actor')],
] as const)('%s authority verdict', (_name, read) => {
  it.each([
    { data: null, error: { message: 'permissions backend unavailable' } },
    { data: null, error: null },
    { data: { permissions: 'console.read' }, error: null },
    { data: { permissions: [null, 'console.read'] }, error: null },
  ])('keeps unavailable or malformed permission evidence unknown', async (verdict) => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue(verdict as any);
    const storage = vi.spyOn(supabase, 'from');
    await expect(read()).rejects.toThrow('engine_operator_authority_unknown');
    expect(storage).not.toHaveBeenCalled();
  });
  it('refuses only a confirmed permission set missing console read', async () => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: { permissions: [] }, error: null } as any);
    await expect(read()).rejects.toThrow('engine_operator_forbidden');
  });
});

it('an RPC execution permission failure is technical unknown, not a confirmed actor denial', async () => {
  vi.spyOn(supabase, 'rpc').mockResolvedValue({
    data: null,
    error: {
      code: '42501',
      message: 'permission denied for function fn_ca_engine_operator_command',
    },
  } as any);
  await expect(operatorCommand('actor', {})).rejects.toThrow(
    'engine_operator_command_outcome_unknown'
  );
});
it('the owning SQL predicate can explicitly deny the actor', async () => {
  vi.spyOn(supabase, 'rpc').mockResolvedValue({
    data: null,
    error: { code: '42501', message: 'engine_operator_forbidden' },
  } as any);
  await expect(operatorCommand('actor', {})).rejects.toThrow('engine_operator_forbidden');
});
