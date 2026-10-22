import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The live cashier contract accepts exactly the committed agent self-funding
// definition of fn_club_cashier_members as its successor, read the same way
// pg_get_functiondef prints it.
it('certifies the installed agent self-funding cashier member list', () => {
  const migration = readFileSync(
    'supabase/migrations/20261021172828_agent_wallet_can_fund_own_player_wallet.sql',
    'utf8'
  );
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_club_cashier_members(');
  expect(start).toBeGreaterThanOrEqual(0);
  const definition = migration.slice(start);
  const tag = definition.match(/\bAS (\$[A-Za-z0-9_]*\$)/)!;
  const end = definition.indexOf(tag[1], tag.index! + tag[0].length) + tag[1].length;
  const installed = createHash('md5')
    .update(definition.slice(0, end) + '\n')
    .digest('hex');
  const contract = readFileSync('scripts/verification-harness/cashier-release-contract.sql', 'utf8');
  const entry = contract.match(
    /'signature', 'public\.fn_club_cashier_members\(uuid\)',([\s\S]*?)\n {4}\)/
  )?.[1];
  expect(entry).toBeDefined();
  expect(entry).toContain("'hash', '052a7ade475196368af0e465417f23eb'");
  expect(entry).toContain(`'replacement_hash', '${installed}'`);
});
