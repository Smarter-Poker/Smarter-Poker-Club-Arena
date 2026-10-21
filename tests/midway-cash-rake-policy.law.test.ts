import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRakeConfig } from '../src/config/RakeConfig';
import { resolveRakeOverride } from '../src/lib/rakeOverride';
import { getFullRakeConfig, RAKE_SCHEDULE } from '../server/src/config/RakeConfig';
const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const midway = 'fade0000-0000-0000-0000-000000000001';
describe('owner rule: Midway cash caps are 2.5 BB and standalone clubs choose their rake', () => {
  it('keeps browser and engine policy definitions identical', () => {
    expect(read('src/config/cashRakePolicy.ts')).toBe(read('server/src/config/cashRakePolicy.ts'));
  });
  it('shows exactly the charged scoped price at every stake, including custom standalone prices', () => {
    for (const row of [...RAKE_SCHEDULE, { sb: 2.5, bb: 5 }, { sb: 200, bb: 500 }])
      for (const variant of [
        'nlh',
        'flh',
        'plo4',
        'plo5',
        'plo6',
        'plo8',
        'flo8',
        'pineapple',
        'short_deck',
      ]) {
        for (const club of [
          { union_id: midway, default_rake_percent: 15, rake_cap: 20 },
          { union_id: null, default_rake_percent: 15, rake_cap: 20 },
          { union_id: null, default_rake_percent: -1, rake_cap: -1 },
        ]) {
          const override = resolveRakeOverride({ rake_percent: -1, rake_cap_bb: -1 }, club);
          const client = getRakeConfig(row.bb, variant, row.sb, override);
          const server = getFullRakeConfig(row.sb, row.bb, variant, override);
          expect([client.rakePercent, client.rakeCap, client.bbjFeeBB, client.bbjEnabled]).toEqual([
            server.rakePercent,
            server.rakeCap,
            server.bbjFeeBB,
            server.bbjEnabled,
          ]);
        }
      }
  });
  it('connects physical, Lightning, displayed rules and frozen hand receipts', () => {
    for (const path of [
      'server/src/engine/ServerTableEngineBase.ts',
      'server/src/lightning/LightningHandHost.ts',
    ])
      expect(read(path)).toContain('cashRakeScope(');
    expect(read('server/src/engine/ServerTableEngineSettlement.ts')).toContain(
      'cashRakePolicy: snap.cashRakePolicy'
    );
    expect(read('server/src/services/supabase/handHistory.ts')).toContain(
      'cash_rake_policy: params.cashRakePolicy'
    );
    expect(read('server/src/lightning/LightningHandHost.ts')).toContain(
      'cash_rake_policy: this.hc?.getRakeConfigSnapshot()'
    );
    expect(read('src/hooks/useEffectiveRake.ts')).toContain(
      'default_rake_percent, rake_cap, union_id'
    );
    expect(read('src/hooks/useEffectiveRake.ts')).toMatch(/version === 1\s*\? override/);
    expect(read('server/src/GameServer.ts')).toContain('cashRakePolicyVersion: 1');
  });
  it('runs native migration, future-write and history qualification in CI', () => {
    expect(read('.github/workflows/midway-cash-rake-policy.yml')).toContain(
      'run: python3 scripts/ci/test-midway-cash-rake-policy.py'
    );
    const migration = read(
      'supabase/migrations/20261021174448_midway_cash_rake_policy_two_point_five_bb.sql'
    );
    expect(migration).toContain('hh.cash_rake_policy');
    expect(migration).toContain('ELSE e.rake END AS exp_rake');
    expect(migration).not.toMatch(/UPDATE\s+public\.(hand_history|rake_records|ca_rake_schedule)/i);
  });
});
