// Validate only; never execute SQL or disclose archive/configuration contents.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateRestoreScript(sql) {
  let i = 0,
    statement = '',
    restricted = null,
    sawRestriction = false;
  function finish() {
    assert.ok(
      !/^(?:BEGIN|COMMIT|END|ROLLBACK|ABORT)\b|^START\s+TRANSACTION\b|^PREPARE\s+TRANSACTION\b/i.test(
        statement.trim()
      ),
      'Unexpected transaction boundary'
    );
    statement = '';
  }
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      statement += ' ';
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      assert.equal(depth, 0);
      statement += ' ';
      continue;
    }
    if (sql[i] === '\\') {
      assert.equal(statement.trim(), '');
      const end = sql.indexOf('\n', i),
        line = sql.slice(i, end < 0 ? sql.length : end).trim();
      const match = /^\\(restrict|unrestrict) ([A-Za-z0-9]+)$/.exec(line);
      assert.ok(match, 'Unexpected psql command');
      if (match[1] === 'restrict') {
        assert.equal(restricted, null);
        assert.equal(sawRestriction, false);
        restricted = match[2];
        sawRestriction = true;
      } else {
        assert.equal(match[2], restricted);
        restricted = null;
      }
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    const dollar =
      i > 0 && /[\p{L}\p{N}_$]/u.test(sql[i - 1])
        ? null
        : /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      assert.ok(end >= 0, 'Unterminated dollar quote');
      statement += ' quoted_body ';
      i = end + dollar[0].length;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      let closed = false;
      // pg_dump emits standard_conforming_strings=on; E strings alone escape.
      const escaped = quote === "'" && /(?:^|[^\p{L}\p{N}_$])E$/iu.test(statement);
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      assert.ok(closed, 'Unterminated quote');
      statement += ' quoted_value ';
      continue;
    }
    if (sql[i] === ';') {
      finish();
      i++;
      continue;
    }
    statement += sql[i++];
  }
  assert.equal(statement.trim(), '');
  assert.equal(restricted, null);
}

export function ownerStatements(owners) {
  assert.ok(Array.isArray(owners));
  const seen = new Set();
  for (const row of owners) {
    assert.deepEqual(Object.keys(row).sort(), ['elevate', 'restore']);
    const name = /^ALTER ROLE ("(?:[^"]|"")+"|[a-z_][a-z0-9_]*) SUPERUSER;$/.exec(row.elevate)?.[1];
    assert.ok(name && !/[\r\n\0]/.test(name));
    assert.equal(row.restore, `ALTER ROLE ${name} NOSUPERUSER;`);
    assert.ok(!seen.has(name));
    seen.add(name);
  }
  return {
    elevate: owners.map((row) => row.elevate).join('\n') + '\n',
    restore: owners.map((row) => row.restore).join('\n') + '\n',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [archive, ownersFile, elevateFile, restoreFile] = process.argv.slice(2);
    assert.equal(process.argv.length, 6);
    validateRestoreScript(readFileSync(archive, 'utf8'));
    const prepared = ownerStatements(JSON.parse(readFileSync(ownersFile, 'utf8')));
    writeFileSync(elevateFile, prepared.elevate, { flag: 'wx', mode: 0o600 });
    writeFileSync(restoreFile, prepared.restore, { flag: 'wx', mode: 0o600 });
  } catch {
    console.error('Isolated Restore Script Or Owner Metadata Refused');
    process.exitCode = 1;
  }
}
