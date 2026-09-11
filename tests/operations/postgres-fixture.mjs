import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { connect } from '../../operations/release/journal.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const binaries = process.env.RELEASE_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const migration = new URL('../../supabase/migrations/20260911151748_private_global_release_journal.sql', import.meta.url);
function command(name, args) {
  const result = spawnSync(path.join(binaries, name), args, { encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' } });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}
export async function createCluster() {
  const version = command('postgres', ['--version']);
  if (!/PostgreSQL\) 17\./.test(version)) throw new Error('Native PostgreSQL 17 is required');
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(path.join(work, 'release-journal-pg-'));
  // macOS Unix sockets cannot fit under the long worktree path. Only the socket
  // is in a private temporary directory; all database/log bytes stay in work/.
  const socket = await mkdtemp(path.join(os.tmpdir(), 'ca-rj-'));
  const data = path.join(directory, 'data');
  const port = 35000 + Math.floor(Math.random() * 20000);
  const base = { host: socket, port, user: 'release_journal_test_admin', database: 'postgres',
    application_name: 'release-journal-native-test', connectionTimeoutMillis: 3000 };
  let started = false;
  const start = () => {
    command('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-o',
      `-k ${socket} -p ${port} -c listen_addresses='' -c max_connections=30`, '-w', 'start']);
    started = true;
  };
  const stop = () => { if (started) { command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); started = false; } };
  try {
    command('initdb', ['-D', data, '--auth=trust', '--no-locale', '--encoding=UTF8', '--username=release_journal_test_admin']);
    start();
    const admin = await connect(base);
    await admin.query('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN');
    await admin.end();
    return { directory, socket, version: version.trim(), start, stop, base,
      async database({ migrate = true, additionalMigrations = [] } = {}) {
        const name = `rj_${randomUUID().replaceAll('-', '')}`;
        const admin = await connect(base);
        await admin.query(`CREATE DATABASE ${name}`);
        await admin.end();
        const config = { ...base, database: name };
        const db = await connect(config);
        if (migrate) await db.query(await readFile(migration, 'utf8'));
        for (const extra of additionalMigrations) await db.query(await readFile(extra, 'utf8'));
        await db.end();
        return config;
      },
      backup(config, filename) { command('pg_dump', ['-h', config.host, '-p', String(config.port), '-U', config.user, '-d', config.database, '-Fc', '-f', filename]); },
      restore(config, filename) { command('pg_restore', ['-h', config.host, '-p', String(config.port), '-U', config.user, '-d', config.database, '--exit-on-error', '--no-owner', filename]); },
      async close() { stop(); await rm(socket, { recursive: true, force: true }); }
    };
  } catch (error) { stop(); await rm(socket, { recursive: true, force: true }); throw error; }
}
