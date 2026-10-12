import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { partitionPlainSchema } from './leaderboard-plain-schema-partition.mjs';

const prefix =
  'SET standard_conforming_strings = on;\nCREATE DATABASE postgres WITH TEMPLATE = template0;\nALTER DATABASE postgres OWNER TO owner;\n\\connect postgres\n';
test('partitions lexical statements without interpreting bodies or comments as sections', () => {
  const body =
    "CREATE FUNCTION public.f() RETURNS text LANGUAGE sql AS $fn$ SELECT E'\\\\connect postgres; -- CREATE SCHEMA bad;'; /* nested /* inner */ comment */ $fn$;";
  const parts = partitionPlainSchema(
    prefix +
      'CREATE SCHEMA "semi;schema";\nALTER SCHEMA "semi;schema" OWNER TO owner;\nCREATE EXTENSION IF NOT EXISTS plpgsql WITH SCHEMA pg_catalog;\nCOMMENT ON EXTENSION plpgsql IS \'kept;\';\n' +
      body
  );
  assert.match(parts.database, /CREATE DATABASE postgres/);
  assert.match(parts.schemas, /CREATE SCHEMA "semi;schema"/);
  assert.match(parts.extensions, /CREATE EXTENSION/);
  assert.ok(parts.remaining.includes(body));
  assert.match(parts.remaining, /COMMENT ON EXTENSION/);
  assert.ok(!parts.database.includes('\\connect'));
});
test('restriction envelopes validate but never execute, and dangerous meta commands refuse', () => {
  assert.doesNotThrow(() =>
    partitionPlainSchema(
      '\\restrict key1\n' +
        prefix.replace(
          '\\connect postgres',
          '\\unrestrict key1\n\\connect postgres\n\\restrict key2'
        ) +
        '\\unrestrict key2\n'
    )
  );
  for (const command of [
    '\\connect other',
    '\\connect postgres owner host 5432',
    '\\connect -reuse-previous=on postgres',
    '\\! touch bad',
    '\\i bad',
    '\\gexec',
    '\\copy t from stdin',
    '\\connect postgres\n\\connect postgres',
  ]) {
    assert.throws(() => partitionPlainSchema(prefix.replace('\\connect postgres', command)));
  }
  assert.throws(() => partitionPlainSchema('\\restrict first\n' + prefix));
});

test('quoted keyword identifiers never masquerade as database or schema commands', () => {
  const grant = 'GRANT SELECT ON TABLE public."x ON DATABASE postgres TO owner" TO reader;';
  const parts = partitionPlainSchema(
    prefix + grant + '\nALTER ROLE "IN DATABASE postgres SET" SET work_mem TO \'4MB\';'
  );
  assert.ok(parts.remaining.includes(grant));
  assert.ok(!parts.database.includes(grant));
  assert.match(parts.remaining, /ALTER ROLE "IN DATABASE postgres SET"/);
});
test('rejects missing boundaries, other databases, transactions, data and unterminated quotes', () => {
  for (const sql of [
    prefix.replace('CREATE DATABASE postgres', 'CREATE DATABASE other'),
    prefix.replace('\\connect postgres', ''),
    prefix + 'BEGIN;',
    prefix + 'COPY public.x FROM stdin;',
    prefix + 'INSERT INTO x VALUES(1);',
    prefix + "SELECT 'broken;",
    prefix + '/* broken',
    prefix + 'CREATE FUNCTION f() RETURNS void AS $x$ nope;',
    prefix + 'ALTER DATABASE other OWNER TO owner;',
  ])
    assert.throws(() => partitionPlainSchema(sql));
});

test('admits only the native database-properties reconnect and fixed safe preamble', () => {
  assert.doesNotThrow(() =>
    partitionPlainSchema(
      prefix + 'ALTER DATABASE postgres SET search_path TO pg_catalog;\n\\connect postgres\n'
    )
  );
  assert.doesNotThrow(() =>
    partitionPlainSchema(
      prefix +
        'ALTER ROLE owner IN DATABASE postgres SET statement_timeout TO 1000;\n\\connect postgres\n'
    )
  );
  for (const sql of [
    prefix +
      'ALTER DATABASE postgres SET search_path TO pg_catalog;\nCREATE SCHEMA x;\n\\connect postgres\n',
    prefix +
      'ALTER DATABASE postgres SET search_path TO pg_catalog;\n\\connect postgres\n\\connect postgres\n',
    'SET SESSION AUTHORIZATION other;\n' + prefix,
    "SELECT pg_catalog.set_config('session_replication_role','replica',false);\n" + prefix,
    prefix + 'DROP DATABASE postgres;',
  ])
    assert.throws(() => partitionPlainSchema(sql));
});

test(
  'native PG17 plain partition restores exact complete catalog and quoted SQL in a socket-only fixture',
  { skip: process.env.LEADERBOARD_NATIVE_PG17_TEST !== '1' },
  () => {
    const parent = process.env.LEADERBOARD_PLAIN_NATIVE_SCRATCH || process.env.TMPDIR;
    assert.ok(
      parent?.startsWith('/Volumes/SmarterWork/agent-work/') ||
        (process.platform === 'linux' &&
          process.env.GITHUB_ACTIONS === 'true' &&
          parent === process.env.RUNNER_TEMP)
    );
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, 'plain-'));
    const socket = join(directory, 's'),
      data = join(directory, 'db');
    assert.ok((socket + '/.s.PGSQL.5432').length < 104);
    mkdirSync(socket);
    const bin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/.test(key)));
    const command = (name, args, input) =>
      spawnSync(join(bin, name), args, {
        env,
        input,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 16 * 1024 * 1024,
      });
    const success = (r) => {
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    const psql = (db, sql) =>
      command(
        'psql',
        [
          '-XAtq',
          '-h',
          socket,
          '-U',
          'leaderboard_qualification_bootstrap',
          '-d',
          db,
          '-v',
          'ON_ERROR_STOP=1',
        ],
        sql
      );
    const catalog = readFileSync(
      new URL('./leaderboard-isolation-catalog.sql', import.meta.url),
      'utf8'
    );
    let started = false;
    try {
      assert.match(success(command('pg_dump', ['--version'])), /PostgreSQL\) 17\./);
      success(
        command('initdb', [
          '-D',
          data,
          '-U',
          'leaderboard_qualification_bootstrap',
          '-A',
          'trust',
          '--no-sync',
          '--locale=C',
        ])
      );
      success(
        command('pg_ctl', [
          '-D',
          data,
          '-l',
          join(directory, 'log'),
          '-w',
          '-o',
          `-k ${socket} -c listen_addresses=`,
          'start',
        ])
      );
      started = true;
      success(
        psql(
          'postgres',
          `CREATE ROLE plain_reader;CREATE EXTENSION hstore;CREATE SCHEMA "semi;schema";
CREATE TABLE public.plain_parent(id integer PRIMARY KEY);
CREATE TABLE public."x ON DATABASE postgres TO owner"(id integer);
GRANT SELECT ON TABLE public."x ON DATABASE postgres TO owner" TO plain_reader;
CREATE TABLE "semi;schema"."quoted;table" (id integer PRIMARY KEY REFERENCES public.plain_parent(id), note text DEFAULT 'literal;');
CREATE FUNCTION public.plain_trigger() RETURNS trigger LANGUAGE plpgsql AS $trigger$ BEGIN NEW.note := 'trigger;written'; RETURN NEW; END; $trigger$;
CREATE TRIGGER "quoted;trigger" BEFORE INSERT ON "semi;schema"."quoted;table" FOR EACH ROW EXECUTE FUNCTION public.plain_trigger();
ALTER TABLE "semi;schema"."quoted;table" ENABLE ROW LEVEL SECURITY;
CREATE POLICY reader ON "semi;schema"."quoted;table" TO plain_reader USING(id>0);
GRANT USAGE ON SCHEMA "semi;schema" TO plain_reader;
GRANT SELECT ON "semi;schema"."quoted;table" TO plain_reader;
GRANT CONNECT ON DATABASE postgres TO plain_reader;
ALTER DATABASE postgres SET search_path TO pg_catalog;
ALTER ROLE plain_reader IN DATABASE postgres SET statement_timeout TO 1000;
COMMENT ON TABLE "semi;schema"."quoted;table" IS 'quoted; -- comment';
CREATE FUNCTION public.quoted_body() RETURNS text LANGUAGE sql AS $fn$ SELECT 'literal; \\connect other -- CREATE SCHEMA nope;'::text; $fn$;`
        )
      );
      const before = success(psql('postgres', catalog));
      const extensionBootstrap = success(
        psql(
          'postgres',
          readFileSync(
            new URL('./leaderboard-isolation-extension-bootstrap.sql', import.meta.url),
            'utf8'
          )
        )
      );
      const dump = success(
        command('pg_dump', [
          '-h',
          socket,
          '-U',
          'leaderboard_qualification_bootstrap',
          '-d',
          'postgres',
          '--schema-only',
          '--create',
          '--format=plain',
          '--no-subscriptions',
          '--no-password',
        ])
      );
      const parts = partitionPlainSchema(dump);
      success(psql('template1', 'ALTER DATABASE postgres RENAME TO source_hold;'));
      success(psql('template1', parts.database));
      success(psql('postgres', 'DROP EXTENSION plpgsql;'));
      success(psql('postgres', parts.schemas));
      assert.match(parts.extensions, /CREATE EXTENSION IF NOT EXISTS hstore/);
      success(psql('postgres', extensionBootstrap));
      success(psql('postgres', 'BEGIN;\n' + parts.remaining + '\nCOMMIT;'));
      assert.equal(success(psql('postgres', catalog)), before);
      assert.equal(
        success(psql('postgres', 'SELECT public.quoted_body();')).trim(),
        'literal; \\connect other -- CREATE SCHEMA nope;'
      );
      assert.equal(
        success(psql('postgres', 'SELECT count(*) FROM "semi;schema"."quoted;table";')).trim(),
        '0'
      );
      success(
        psql(
          'postgres',
          'INSERT INTO public.plain_parent VALUES(1);INSERT INTO "semi;schema"."quoted;table"(id) VALUES(1);'
        )
      );
      assert.equal(
        success(psql('postgres', 'SELECT note FROM "semi;schema"."quoted;table";')).trim(),
        'trigger;written'
      );
      assert.notEqual(
        psql('postgres', 'INSERT INTO "semi;schema"."quoted;table"(id) VALUES(2);').status,
        0
      );
    } finally {
      if (started) {
        success(command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']));
        assert.equal(existsSync(join(data, 'postmaster.pid')), false);
        assert.equal(command('pg_ctl', ['-D', data, 'status']).status, 3);
      }
      rmSync(directory, { recursive: true });
      assert.equal(existsSync(directory), false);
    }
  }
);
