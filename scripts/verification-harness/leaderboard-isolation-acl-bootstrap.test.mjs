// Source contracts plus explicitly selected native PG17 proof; not faithful
// source restore, Auth, financial runtime or production qualification.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const sql = readFileSync(
  new URL('./leaderboard-isolation-acl-bootstrap.sql', import.meta.url),
  'utf8'
);
test(
  'mandatory selected native PG17 restores exact ACL and refuses unsupported identities atomically',
  {
    skip:
      process.env.LEADERBOARD_NATIVE_PG_TEST !== '1' &&
      process.env.LEADERBOARD_NATIVE_PG17_TEST !== '1',
  },
  () => {
    const parent = process.env.TMPDIR;
    assert.ok(
      parent?.startsWith('/Volumes/SmarterWork/agent-work/') ||
        (process.platform === 'linux' &&
          process.env.GITHUB_ACTIONS === 'true' &&
          parent === process.env.RUNNER_TEMP)
    );
    const directory = mkdtempSync(
      join(process.platform === 'darwin' ? '/Volumes/SmarterWork/agent-work/' : parent, 'lb-acl-')
    );
    const data = join(directory, 'db'),
      socket = join(directory, 's');
    mkdirSync(socket);
    assert.ok((socket + '/.s.PGSQL.5432').length < 104);
    const bin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
    const command = (name, args, input) =>
      spawnSync(join(bin, name), args, { input, encoding: 'utf8', timeout: 30000 });
    const ok = (result) => {
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const psql = (input, user = 'leaderboard_qualification_bootstrap', database = 'postgres') =>
      command(
        'psql',
        ['-XAtq', '-h', socket, '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1'],
        input
      );
    try {
      assert.match(ok(command('pg_dump', ['--version'])), /PostgreSQL\) 17\./);
      ok(
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
      ok(
        command('pg_ctl', [
          '-D',
          data,
          '-l',
          join(directory, 'server.log'),
          '-w',
          '-o',
          `-k ${socket} -c listen_addresses=`,
          'start',
        ])
      );
      ok(
        psql(`CREATE ROLE acl_owner; CREATE ROLE acl_reader LOGIN; CREATE ROLE acl_extra;
        CREATE ROLE "reader$acl_restore$";
        CREATE SCHEMA "schema$acl_restore$" AUTHORIZATION acl_owner;
        SET ROLE acl_owner;
        CREATE TABLE "schema$acl_restore$"."table$acl_restore$"(id int);
        GRANT SELECT ON "schema$acl_restore$"."table$acl_restore$" TO "reader$acl_restore$" WITH GRANT OPTION;
        RESET ROLE;
        CREATE SCHEMA acl_test AUTHORIZATION acl_owner;
        SET ROLE acl_owner; CREATE TABLE acl_test.sample(id int,untouched int);
        GRANT USAGE ON SCHEMA acl_test TO acl_reader;
        GRANT SELECT ON acl_test.sample TO acl_reader WITH GRANT OPTION;
        GRANT SELECT(id) ON acl_test.sample TO acl_extra WITH GRANT OPTION;
        CREATE TABLE acl_test.explicit_default(id int);
        GRANT SELECT ON acl_test.explicit_default TO acl_reader;
        REVOKE SELECT ON acl_test.explicit_default FROM acl_reader;
        CREATE TABLE acl_test.explicit_empty(id int);
        REVOKE ALL ON acl_test.explicit_empty FROM acl_owner;
        RESET ROLE;
        CREATE SCHEMA explicit_default_schema AUTHORIZATION acl_owner;
        SET ROLE acl_owner;
        GRANT USAGE ON SCHEMA explicit_default_schema TO acl_reader;
        REVOKE USAGE ON SCHEMA explicit_default_schema FROM acl_reader;
        RESET ROLE; GRANT USAGE ON SCHEMA public TO acl_reader WITH GRANT OPTION;`)
      );
      const emitted = ok(psql(sql));
      const oldSource = sql.replace(
        'IF NOT actual_acl_was_null AND grants IS NOT DISTINCT FROM target_text THEN CONTINUE;',
        'IF grants IS NOT DISTINCT FROM target_text THEN CONTINUE;'
      );
      assert.notEqual(oldSource, sql);
      const oldEmitted = ok(psql(oldSource));
      ok(
        psql(`SET ROLE acl_owner;
        DROP TABLE acl_test.explicit_default,acl_test.explicit_empty;
        CREATE TABLE acl_test.explicit_default(id int);
        CREATE TABLE acl_test.explicit_empty(id int);
        DROP SCHEMA explicit_default_schema;
        RESET ROLE;
        CREATE SCHEMA explicit_default_schema AUTHORIZATION acl_owner;
        RESET ROLE;`)
      );
      ok(psql(oldEmitted));
      assert.equal(
        ok(
          psql(
            "SELECT relacl IS NULL FROM pg_class WHERE oid='acl_test.explicit_default'::regclass;"
          )
        ).trim(),
        't',
        'Original false-skip defect must reproduce'
      );
      assert.equal(
        ok(
          psql("SELECT nspacl IS NULL FROM pg_namespace WHERE nspname='explicit_default_schema';")
        ).trim(),
        't'
      );
      const columns = ok(
        psql(
          "SELECT attacl::text FROM pg_attribute WHERE attrelid='acl_test.sample'::regclass AND attname='id';"
        )
      );
      assert.match(emitted, /pg_database_owner/);
      ok(
        psql(`SET ROLE acl_owner; REVOKE SELECT ON acl_test.sample FROM acl_reader;
        GRANT INSERT ON acl_test.sample TO acl_extra; RESET ROLE;
        REVOKE USAGE ON SCHEMA public FROM acl_reader; GRANT CREATE ON SCHEMA public TO acl_extra;
        SET ROLE acl_owner;
        REVOKE SELECT ON "schema$acl_restore$"."table$acl_restore$" FROM "reader$acl_restore$";
        GRANT INSERT ON "schema$acl_restore$"."table$acl_restore$" TO acl_extra;
        RESET ROLE;`)
      );
      ok(psql(emitted));
      assert.equal(
        ok(
          psql(
            "SELECT relacl IS NOT NULL FROM pg_class WHERE oid='acl_test.explicit_default'::regclass;"
          )
        ).trim(),
        't'
      );
      assert.equal(
        ok(
          psql(
            "SELECT relacl IS NOT NULL AND cardinality(relacl)=0 FROM pg_class WHERE oid='acl_test.explicit_empty'::regclass;"
          )
        ).trim(),
        't',
        'Explicit empty target must remain empty, never NULL/default'
      );
      assert.equal(
        ok(
          psql(
            "SELECT attacl::text FROM pg_attribute WHERE attrelid='acl_test.sample'::regclass AND attname='id';"
          )
        ),
        columns,
        'Column ACL changed by table ACL restoration'
      );
      assert.equal(
        ok(psql(sql)),
        emitted,
        'Full owner/grantor/privilege/options source image differs'
      );
      assert.equal(
        ok(
          psql(
            "SELECT attacl IS NULL FROM pg_attribute WHERE attrelid='acl_test.sample'::regclass AND attname='untouched';"
          )
        ).trim(),
        't'
      );
      const refuse = (input, user, database) => {
        const result = psql(input, user, database);
        assert.notEqual(result.status, 0);
        return result.stderr;
      };
      ok(
        psql(
          'SET ROLE acl_owner; GRANT INSERT ON acl_test.sample TO acl_extra; GRANT SELECT(untouched) ON acl_test.sample TO acl_reader; RESET ROLE;'
        )
      );
      assert.match(refuse(emitted), /Column ACL preimage differs/);
      ok(
        psql(
          'SET ROLE acl_owner; REVOKE INSERT ON acl_test.sample FROM acl_extra; REVOKE SELECT(untouched) ON acl_test.sample FROM acl_reader; RESET ROLE;'
        )
      );
      ok(psql('ALTER TABLE acl_test.sample OWNER TO acl_extra;'));
      assert.match(
        refuse(emitted.replace('BEGIN;', 'BEGIN; INSERT INTO acl_test.sample VALUES(1);')),
        /ACL owner or grant chain differs/
      );
      assert.equal(ok(psql('SELECT count(*) FROM acl_test.sample;')).trim(), '0');
      ok(
        psql(
          'ALTER TABLE acl_test.sample OWNER TO acl_owner; SET ROLE acl_reader; GRANT SELECT ON acl_test.sample TO acl_extra; RESET ROLE;'
        )
      );
      assert.match(refuse(emitted), /ACL owner or grant chain differs/);
      const unsupportedSource = ok(psql(sql));
      assert.match(refuse(unsupportedSource), /Unsupported source ACL grant chain/);
      ok(psql('SET ROLE acl_reader; REVOKE SELECT ON acl_test.sample FROM acl_extra; RESET ROLE;'));
      assert.match(
        refuse(emitted, 'acl_reader'),
        /ACL bootstrap requires exact disposable socket identity/
      );
      ok(psql('CREATE DATABASE wrong_database;'));
      assert.match(
        refuse(emitted, undefined, 'wrong_database'),
        /ACL bootstrap requires exact disposable socket identity/
      );
      ok(psql('ALTER DATABASE postgres OWNER TO acl_extra;'));
      assert.match(refuse(emitted), /Dynamic database owner differs/);
    } finally {
      if (existsSync(join(data, 'PG_VERSION'))) {
        const state = command('pg_ctl', ['-D', data, 'status']);
        if (state.status === 0)
          ok(command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']));
        else assert.equal(state.status, 3, 'Unknown native server state retains evidence');
        assert.equal(command('pg_ctl', ['-D', data, 'status']).status, 3);
        assert.equal(existsSync(join(data, 'postmaster.pid')), false);
      }
      rmSync(directory, { recursive: true, force: false });
      assert.equal(existsSync(directory), false);
    }
  }
);
test('source export is SELECT-only and emits guarded quoted disposable transaction', () => {
  assert.match(sql, /WITH objects AS/);
  assert.match(
    sql,
    /SELECT pg_catalog\.format\('BEGIN; DO %L; COMMIT;',pg_catalog\.format\(\$template\$/
  );
  assert.match(sql, /session_user<>'leaderboard_qualification_bootstrap'/);
  assert.match(sql, /current_user<>session_user/);
  assert.match(sql, /inet_server_addr\(\) IS NOT NULL/);
  assert.match(sql, /current_database\(\)<>'postgres'/);
  assert.doesNotMatch(sql, /DO \$acl_restore\$/);
  assert.doesNotMatch(sql, /CASCADE|UPDATE pg_|INSERT INTO pg_|DELETE FROM pg_|DISABLE TRIGGER/);
});
test('full ACL item equality, source owner grantors and native options retained without NULL normalization', () => {
  for (const field of ['datacl', 'nspacl', 'relacl'])
    assert.match(sql, new RegExp(`${field} IS NOT NULL`));
  assert.match(sql, /a\.grantor<>owner_oid/);
  assert.match(sql, /actual_owner<>owner_id/);
  assert.match(sql, /a\.grantor<>owner_id/);
  assert.match(sql, /array_agg\(v::text ORDER BY v::text\)/);
  assert.match(sql, /WITH GRANT OPTION/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON %%s FROM %%s/);
  assert.match(sql, /ACL exact content readback differs/);
  assert.match(sql, /role_name='pg_database_owner'/);
  assert.match(sql, /role_name:=db_owner/);
  assert.match(sql, /Dynamic database owner differs/);
  assert.match(sql, /SET LOCAL ROLE %%I/);
  assert.match(sql, /RESET ROLE/);
  assert.equal(sql.match(/actual_acl_was_null:=actual_acl IS NULL;/g)?.length, 3);
  assert.match(
    sql,
    /IF NOT actual_acl_was_null AND grants IS NOT DISTINCT FROM target_text THEN CONTINUE/
  );
  assert.match(sql, /c\.relkind IN \('r','p','v','m','f','S'\)/);
  assert.match(sql, /Column ACL preimage differs/);
  assert.match(sql, /Column ACL readback differs/);
  assert.match(sql, /GRANT %%s \(%%I\) ON %%s TO %%s%%s/);
});
