/**
 * THE XID RESTORER READS XMAX (2026-10-02).
 *
 * fn_ca_xid8 restores a tuple's 32-bit xmin to the 64-bit xid that
 * pg_visible_in_snapshot judges; the ledger replay
 * (fn_ca_leg_accounts_since_snapshot) asks it "did the previous reading see
 * this leg?". It took its epoch from the snapshot's XMIN, so every xid newer
 * than the oldest running transaction came back as 18446744070211823064 (the
 * future) in epoch 0: a leg the previous reading had seen was counted again
 * whenever an older transaction stayed open across two readings. Every tuple
 * a statement can see has an xmin below the snapshot's XMAX, which is the
 * reference now.
 *
 * Executed on PostgreSQL 17 by scripts/dev/test-xid-restorer-reads-xmax.sh
 * (CI); the old xmin reference fails it with 18446744069414585062.
 *
 * Registry: docs/laws.d/the-xid-restorer-reads-xmax.md
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const sorted = () =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const latestDefinitionOf = (fn: string): { file: string; body: string } | null => {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i');
  for (const f of sorted().reverse()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    const m = re.exec(sql);
    if (m) return { file: f, body: sql.slice(m.index, sql.indexOf('$function$;', m.index)) };
  }
  return null;
};

describe('the xid restorer reads xmax', () => {
  it('the newest fn_ca_xid8 on disk takes its epoch from the snapshot xmax', () => {
    const live = latestDefinitionOf('fn_ca_xid8');
    expect(live).not.toBeNull();
    expect(live!.body, live!.file).toContain('pg_snapshot_xmax(pg_current_snapshot())');
    expect(live!.body, live!.file).not.toContain('pg_snapshot_xmin(pg_current_snapshot())');
    expect(live!.body).toContain('WHEN x < cur32 THEN (epoch << 32) + x');
    expect(live!.body).toContain('WHEN epoch = 0 THEN x');
  });

  it('reading 779 carries its late leg, keeps its original and is acknowledged', () => {
    const file = sorted().find((f) =>
      f.endsWith('_the_xid_restorer_reads_xmax_and_reading_779_is_acknowledged.sql')
    );
    expect(file).toBeDefined();
    const sql = fs.readFileSync(path.join(MIGRATIONS, file!), 'utf8');
    expect(sql).toContain("'644a8e1d8ac03a3579adbbd8f5d15a79'");
    expect(sql).toContain('restated_burn = 902036.92');
    expect(sql).toContain('SET late_mint = 0, late_burn = 100000.00');
    expect(sql).toContain('INSERT INTO public.ca_supply_breach_ack');
    expect(sql).toContain("(779, -100005.30, 'commit_straddled_the_reading'");
  });

  it('is executed on PostgreSQL in CI', () => {
    const ci = fs.readFileSync(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('bash scripts/dev/test-xid-restorer-reads-xmax.sh');
  });
});
