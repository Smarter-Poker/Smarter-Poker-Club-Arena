import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { cashGameCreateServerMessage } from '../../src/config/cashGames';

const migration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20261028214622_midway_allows_two_five_plo_creation.sql'
  ),
  'utf8'
);
describe('Midway 2/5 PLO creation', () => {
  it('keeps the allowance scoped to the union, PLO, and exactly 2/5', () => {
    expect(migration).toContain("new.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid");
    expect(migration).toContain("new.variant in ('plo4', 'plo5', 'plo6')");
    expect(migration).toContain('new.sb = 2.00 and new.bb = 5.00');
    expect(migration).toContain('coalesce(new.bb, 0) > 2.00');
    expect(migration).toContain("errcode = '22023'");
    expect(migration).not.toMatch(
      /(?:UPDATE|DELETE FROM|INSERT INTO) public\.(?:cash_games|tables|club_members)/i
    );
  });
  it('shows the actual plain-object PostgREST error from the failed request', () => {
    expect(
      cashGameCreateServerMessage({
        code: '22023',
        message: 'Cash games are capped at 1.00/2.00 blinds',
      })
    ).toBe('Cash games are capped at 1.00/2.00 blinds');
    expect(cashGameCreateServerMessage(new Error('Connection Failed'))).toBe('Connection Failed');
    expect(cashGameCreateServerMessage({ message: '' })).toBeNull();
    expect(cashGameCreateServerMessage({ message: 42 })).toBeNull();
    expect(cashGameCreateServerMessage(null)).toBeNull();
    expect(
      cashGameCreateServerMessage({
        get message() {
          throw Error('getter');
        },
      })
    ).toBeNull();
  });
});

// Exercise the maintained trigger and retained SQL matrix on real isolated
// PostgreSQL in the normal Client Unit Tests job (Ubuntu ships PostgreSQL).
// Store every fixture beneath this checkout, including on the owner's SSD.
it('runs the old rejection and repaired stake matrix in isolated PostgreSQL', () => {
  const root = resolve(__dirname, '../..');
  const bin = [
    '/opt/homebrew/bin',
    '/usr/lib/postgresql/18/bin',
    '/usr/lib/postgresql/17/bin',
    '/usr/lib/postgresql/16/bin',
    '/usr/bin',
  ].find((dir) => ['initdb', 'pg_ctl', 'psql'].every((name) => existsSync(`${dir}/${name}`)));
  if (!bin) throw new Error('PostgreSQL binaries are required for stake-guard regression');
  const cache = resolve(root, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const scratch = mkdtempSync(resolve(cache, 'midway-stake-'));
  // Unix socket paths are length limited; pg_ctl uses TCP on a random port
  // chosen by the OS for this test's short-lived private server.
  const port = 20000 + Math.floor(Math.random() * 30000);
  const data = resolve(scratch, 'data');
  const env = {
    ...process.env,
    PGHOST: '127.0.0.1',
    PGPORT: String(port),
    PGDATABASE: 'postgres',
    PGUSER: process.env.USER || 'runner',
    PGSSLMODE: 'disable',
  };
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  const run = (cmd: string, args: string[], input?: string) =>
    execFileSync(`${bin}/${cmd}`, args, {
      cwd: root,
      env,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust']);
    run('pg_ctl', [
      '-D',
      data,
      '-l',
      resolve(scratch, 'postgres.log'),
      '-o',
      `-p ${port} -h 127.0.0.1 -k ''`,
      '-w',
      'start',
    ]);
    started = true;
    run(
      'psql',
      ['-X', '-v', 'ON_ERROR_STOP=1'],
      `CREATE TABLE public.cash_games (club_id uuid,variant text,sb numeric,bb numeric,enabled boolean);
${readFileSync(resolve(root, 'supabase/migrations/20261023160959_cash_game_stake_cap_allows_one_two_for_every_variant.sql'), 'utf8')}
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OF enabled, bb, variant ON public.cash_games FOR EACH ROW EXECUTE FUNCTION public.fn_cash_game_max_stake_guard();`
    );
    expect(() =>
      run(
        'psql',
        ['-X', '-v', 'ON_ERROR_STOP=1'],
        "INSERT INTO cash_games VALUES ('fade0000-0000-0000-0000-000000000001','plo4',2,5,true);"
      )
    ).toThrow(/capped at/);
    run('psql', ['-X', '-v', 'ON_ERROR_STOP=1'], migration);
    expect(
      run('psql', [
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        'scripts/qualification/midway-two-five-stake-guard.sql',
      ])
    ).toContain('ROLLBACK');
    run(
      'psql',
      ['-X', '-v', 'ON_ERROR_STOP=1'],
      `
ALTER TABLE cash_games ADD COLUMN union_id uuid;
CREATE TABLE clubs (id uuid, union_id uuid);
${readFileSync(resolve(root, 'tests/fixtures/midway-concurrent-stake-guard.sql'), 'utf8')}`
    );
    const definitionHash = () =>
      run('psql', [
        '-X',
        '-At',
        '-c',
        "SELECT md5(pg_get_functiondef('public.fn_cash_game_max_stake_guard()'::regprocedure))",
      ]).trim();
    expect(definitionHash()).toBe('b02ce4fda596606aa3f94ff2b46e3980');
    run('psql', ['-X', '-v', 'ON_ERROR_STOP=1'], migration);
    expect(definitionHash()).toBe('b02ce4fda596606aa3f94ff2b46e3980');
    run(
      'psql',
      ['-X', '-v', 'ON_ERROR_STOP=1'],
      "INSERT INTO cash_games(club_id,variant,sb,bb,enabled) VALUES ('fade0000-0000-0000-0000-000000000001','plo5',2,5,true)"
    );
    run(
      'psql',
      ['-X', '-v', 'ON_ERROR_STOP=1'],
      `
CREATE OR REPLACE FUNCTION public.fn_cash_game_max_stake_guard() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`
    );
    expect(() => run('psql', ['-X', '-v', 'ON_ERROR_STOP=1'], migration)).toThrow(
      /Cash stake guard changed/
    );
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    rmSync(scratch, { recursive: true, force: true });
  }
});
