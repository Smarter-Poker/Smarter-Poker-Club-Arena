import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const handHistory = readFileSync(join(__dirname, 'handHistory.ts'), 'utf8');
const tables = readFileSync(join(__dirname, 'tables.ts'), 'utf8');
const gameServer = readFileSync(join(__dirname, '..', '..', 'GameServer.ts'), 'utf8');
const entrypoint = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8');
const settlement = readFileSync(
  join(__dirname, '..', '..', 'engine', 'ServerTableEngineSettlement.ts'),
  'utf8'
);
const terminalMigration = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'supabase',
    'migrations',
    '20260909215641_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
  ),
  'utf8'
);

describe('hand history has one atomic persistence owner', () => {
  it('has no process-local queue, retry timer, recovery callback, or boot/shutdown wiring', () => {
    const runtime = [handHistory, gameServer, entrypoint].join('\n');
    expect(runtime).not.toMatch(
      /pendingHands|enqueueHandHistory|drainHandHistoryQueue|startHandHistoryRetry|stopHandHistoryRetry|onHandHistoryRecovered|handHistoryQueue(?:Depth|Bytes)/
    );
    expect(handHistory).not.toContain('retry-queue');
    expect(handHistory).not.toContain('setInterval(');
  });

  it('persists the row and bomb units only through the accepted-hand transaction', () => {
    expect(handHistory).toContain("supabase.rpc('fn_ca_commit_hand_settlement', payload)");
    expect(handHistory).toContain('p_hand_row:');
    expect(handHistory).toContain('p_units: bombAwardUnits');
    expect(handHistory).not.toContain(".from('hand_history')");
    expect(handHistory).not.toContain('fn_ca_insert_hand_with_awards');
    expect(settlement).not.toContain('writeAwardUnits');
    expect(settlement).not.toContain("from('bomb_pot_award_units').upsert");
  });

  it('exposes no stack-only runtime helper or direct stack-core RPC', () => {
    expect(tables).not.toMatch(/export async function syncStacks\s*\(/);
    expect(tables).not.toContain("supabase.rpc('fn_ca_settle_hand_stacks_absolute'");
    expect(handHistory).not.toContain("supabase.rpc('fn_ca_insert_hand_with_awards'");
  });

  it('retires both rolling overloads and makes every implementation core owner-only', () => {
    const normalizedMigration = terminalMigration
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')');
    expect(terminalMigration).toContain(
      'DROP FUNCTION public.fn_ca_commit_hand_settlement(\n  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) RESTRICT;'
    );
    expect(terminalMigration).toContain(
      'DROP FUNCTION public.fn_ca_commit_hand_settlement(\n  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) RESTRICT;'
    );
    for (const signature of [
      'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
      'public.fn_ca_insert_hand_with_awards(jsonb,jsonb)',
      'public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)',
      'public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)',
    ]) {
      const revoke = normalizedMigration.lastIndexOf(`REVOKE ALL ON FUNCTION ${signature}`);
      expect(revoke, `${signature} has no final ACL retirement`).toBeGreaterThan(-1);
      const statementEnd = normalizedMigration.indexOf(';', revoke);
      expect(statementEnd, `${signature} ACL retirement is not terminated`).toBeGreaterThan(revoke);
      expect(normalizedMigration.slice(revoke, statementEnd + 1)).toContain(
        'FROM PUBLIC,anon,authenticated,service_role;'
      );
    }
    expect(terminalMigration).toContain(
      '12-argument accepted-hand transaction is not the one service-executable door'
    );
  });
});
