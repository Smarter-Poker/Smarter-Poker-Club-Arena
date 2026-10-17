import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('certifies the installed Club Bank lock-order wrapper and rejects its superseded definition', () => {
  const migration = readFileSync(
    'supabase/migrations/20261016021637_chip_send_honors_the_recipient_wallet_chosen_by_the_sender.sql',
    'utf8'
  );
  const contract = readFileSync(
    'scripts/verification-harness/cashier-release-contract.sql',
    'utf8'
  );
  const signature = 'public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)';
  const proof = migration
    .split('\n')
    .find((line) => line.startsWith('-- @live-proof:') && line.includes(signature));
  const installed = proof?.match(/= '([0-9a-f]{32})'/)?.[1];
  expect(installed).toBe('08e0c75b5fb1f51fc8c31a8928271fb6');
  expect(contract).toContain(`'hash', '${installed}'`);
  expect(contract).not.toContain("'hash', 'd858bb9dbc4c2657c940c99f0c03b015'");
  expect(contract).toContain("has_function_privilege('anon', v_oid, 'EXECUTE')");
  expect(migration).toContain("pg_advisory_xact_lock(hashtextextended('agent-agreement:'");
});
