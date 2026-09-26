/**
 * REBUY, RE-ENTRY AND ADD-ON ON EVERY BOUNTY FORMAT AND ON SATELLITES
 * (2026-09-26 MTT final sweep).
 *
 * Production has only ever sold these three purchases on `freezeout`: 873
 * rebuy, 861 re-entry and 865 add-on events, and none on bounty,
 * progressive_bounty, mystery_bounty or satellite. Nothing in the engine
 * branches on format for them; the format-specific money is all inside
 * fn_ca_process_tournament_chip_purchase_money_v1 (the bounty head, the
 * prize/bounty/fee split, the re-entry stack and head replacement).
 *
 * scripts/dev/probe-rebuy-format-money-pg17.sh runs that function's byte-exact
 * production body against all fifteen format x purchase combinations. This
 * file keeps the capture honest (it must be the body the newest migration
 * installs, so a change to the money core cannot leave the probe proving an
 * old one) and runs the probe wherever PostgreSQL 17 is installed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(process.cwd(), '..');
const migrations = join(repo, 'supabase', 'migrations');
const RUNNER = join(repo, 'scripts', 'dev', 'probe-rebuy-format-money-pg17.sh');
const SCENARIOS = join(repo, 'scripts', 'dev', 'probe-rebuy-format-money-pg17.sql');
const INSTALLED = join(repo, 'scripts', 'dev', 'fixtures', 'rebuy-format-money', 'installed.sql');
const SIGNATURE =
  'CREATE OR REPLACE FUNCTION public.fn_ca_process_tournament_chip_purchase_money_v1(';

function bodyOf(sql: string): string | null {
  const start = sql.lastIndexOf(SIGNATURE);
  if (start < 0) return null;
  const open = sql.indexOf('AS $function$', start);
  if (open < 0) return null;
  const from = open + 'AS $function$'.length;
  const close = sql.indexOf('$function$', from);
  return close < 0 ? null : sql.slice(from, close);
}

function newestMigrationBody(): string | null {
  const defining = readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => readFileSync(join(migrations, name), 'utf8').includes(SIGNATURE));
  const newest = defining[defining.length - 1];
  return newest ? bodyOf(readFileSync(join(migrations, newest), 'utf8')) : null;
}

function pg17Bin(): string | null {
  const candidates = [
    process.env.PG17_BINDIR,
    '/usr/lib/postgresql/17/bin',
    '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql@17/bin',
  ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  return candidates.find((dir) => existsSync(join(dir, 'initdb'))) ?? null;
}

describe('the chip-purchase money core is proved on every format it can sell to', () => {
  it('probes the body the newest migration installs', () => {
    const captured = bodyOf(readFileSync(INSTALLED, 'utf8'));
    expect(captured).not.toBeNull();
    expect(captured).toBe(newestMigrationBody());
  });

  it('covers all fifteen format x purchase combinations', () => {
    const probe = readFileSync(SCENARIOS, 'utf8');
    for (const variant of [
      'freezeout',
      'bounty',
      'progressive_bounty',
      'mystery_bounty',
      'satellite',
    ]) {
      expect(probe).toContain(`'${variant}'`);
    }
    expect(probe).toContain("ARRAY['rebuy','reentry','addon']");
    expect(probe).toContain('REBUY_FORMAT_MONEY_PG17_OK');
  });

  const bin = pg17Bin();
  it.skipIf(bin === null)(
    'conserves every purchase, funds exactly one head on a bounty rebuy or re-entry and none on an add-on',
    () => {
      const run = spawnSync('bash', [RUNNER], {
        env: { ...process.env, PG17_BINDIR: bin ?? '' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      // psql prints the probe's NOTICEs on stderr.
      const output = `${run.stdout}${run.stderr}`;
      expect(run.status, output).toBe(0);
      expect(output).toContain('REBUY_FORMAT_MONEY_PG17_OK (15 combinations)');
    },
    90_000
  );
});
