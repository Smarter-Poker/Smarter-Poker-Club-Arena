import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
describe('retired global-wallet transfers', () => {
  it('refuses old clients at the database boundary without a money write', () => {
    const sql = read(
      'supabase/migrations/20261005161344_the_global_wallet_transfer_cannot_move_retired_chips.sql'
    );
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain("ERRCODE = '55000'");
    const body = sql.split('AS $function$')[1].split('$function$;')[0];
    expect(body).toContain('WALLET_POOL_RETIRED');
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|PERFORM)\b/i);
  });
  it('removes every browser entry point while keeping scoped agent transfers', () => {
    const service = read('src/services/WalletService.ts');
    expect(service).not.toContain("supabase.rpc('fn_wallet_type_transfer'");
    expect(service).not.toContain("supabase.rpc('wallet_user_transfer'");
    expect(service).toContain("supabase.rpc('fn_agent_wallet_self_stake'");
    expect(read('src/stores/useWalletStore.ts')).not.toContain('internalTransfer');
    expect(read('src/hooks/index.ts')).not.toContain('internalTransfer');
  });
});
