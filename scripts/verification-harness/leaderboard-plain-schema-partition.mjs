// Partition native schema-only pg_dump text. Never execute SQL or connection commands.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateRestoreScript } from './leaderboard-isolation-restore-script.mjs';

export function partitionPlainSchema(sql) {
  assert.equal(typeof sql, 'string');
  assert.ok(!sql.includes('\0'));
  const parts = { database: [], schemas: [], extensions: [], remaining: [] };
  let i = 0,
    start = 0,
    text = '',
    lexical = '',
    restricted = null,
    connects = 0,
    creates = 0;
  let standardStrings = false,
    propertyReconnect = false;
  const preamble = [];
  const quoted = '(?:"(?:[^"\\r\\n]|"")+"|[a-z_][a-z0-9_$]*)';
  const database = '(?:postgres|"postgres")';
  function finish(end) {
    const value = text.trim();
    const dispatch = lexical.trim();
    const raw = sql.slice(start, end);
    start = end;
    text = '';
    lexical = '';
    if (!value) return;
    assert.ok(
      !/^(?:BEGIN|COMMIT|END|ROLLBACK|ABORT|COPY|INSERT)\b|^START\s+TRANSACTION\b|^PREPARE\s+TRANSACTION\b|^DROP\s+DATABASE\b/i.test(
        value
      )
    );
    let section = 'remaining';
    if (/^CREATE\s+DATABASE\b/i.test(dispatch)) {
      assert.match(value, new RegExp('^CREATE\\s+DATABASE\\s+' + database + '\\s+WITH\\s+', 'i'));
      assert.equal(creates++, 0);
      section = 'database';
    } else if (/^(?:ALTER|COMMENT\s+ON|SECURITY\s+LABEL.*?ON)\s+DATABASE\b/i.test(dispatch)) {
      assert.match(
        value,
        new RegExp(
          '^(?:ALTER|COMMENT\\s+ON|SECURITY\\s+LABEL.*?ON)\\s+DATABASE\\s+' +
            database +
            '(?:\\s|;)',
          'i'
        )
      );
      section = 'database';
    } else if (/^(?:GRANT|REVOKE)\b.*?\bON\s+DATABASE\b/is.test(dispatch)) {
      assert.match(
        value,
        new RegExp('\\bON\\s+DATABASE\\s+' + database + '\\s+(?:TO|FROM)\\s', 'i')
      );
      section = 'database';
    } else if (/^ALTER\s+ROLE\b.*?\bIN\s+DATABASE\b/is.test(dispatch)) {
      assert.match(
        value,
        new RegExp(
          '^ALTER\\s+ROLE\\s+' + quoted + '\\s+IN\\s+DATABASE\\s+' + database + '\\s+SET\\s',
          'i'
        )
      );
      section = 'database';
    } else if (/^(?:CREATE|ALTER)\s+SCHEMA\b/i.test(dispatch)) {
      assert.match(
        value,
        new RegExp(
          '^(?:CREATE\\s+SCHEMA\\s+' +
            quoted +
            '\\s*;|ALTER\\s+SCHEMA\\s+' +
            quoted +
            '\\s+OWNER\\s+TO\\s+' +
            quoted +
            '\\s*;)$',
          'i'
        )
      );
      section = 'schemas';
    } else if (/^CREATE\s+EXTENSION\b/i.test(dispatch)) {
      assert.match(
        value,
        new RegExp(
          '^CREATE\\s+EXTENSION\\s+IF\\s+NOT\\s+EXISTS\\s+' +
            quoted +
            '\\s+WITH\\s+SCHEMA\\s+' +
            quoted +
            '\\s*;$',
          'i'
        )
      );
      section = 'extensions';
    } else if (
      /^(?:SET\s|SELECT\s+pg_catalog\.set_config\()/i.test(value) &&
      connects === 0 &&
      creates === 0
    ) {
      assert.ok(
        /^SET\s+(?:(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout)\s*=\s*0|client_encoding\s*=\s*'[A-Za-z0-9_]+'|standard_conforming_strings\s*=\s*on|check_function_bodies\s*=\s*false|xmloption\s*=\s*content|client_min_messages\s*=\s*warning|row_security\s*=\s*off)\s*;$/i.test(
          value
        ) || /^SELECT\s+pg_catalog\.set_config\('search_path',\s*'',\s*false\)\s*;$/i.test(value)
      );
      if (/^SET\s+standard_conforming_strings\s*=\s*on\s*;$/i.test(value)) standardStrings = true;
      preamble.push(raw);
      return;
    }
    assert.ok(standardStrings, 'Native standard string preamble missing');
    if (connects === 1)
      propertyReconnect =
        section === 'database' &&
        (/^ALTER\s+DATABASE\s+(?:postgres|"postgres")\s+SET\s/i.test(value) ||
          /^ALTER\s+ROLE\b.*?\bIN\s+DATABASE\s+(?:postgres|"postgres")\s+SET\s/is.test(value));
    parts[section].push(raw);
  }
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      text += ' ';
      lexical += ' ';
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
      text += ' ';
      lexical += ' ';
      continue;
    }
    if (sql[i] === '\\') {
      assert.equal(text.trim(), '');
      const end = sql.indexOf('\n', i),
        next = end < 0 ? sql.length : end + 1;
      const line = sql.slice(i, end < 0 ? sql.length : end).trim();
      const restriction = /^\\(restrict|unrestrict) ([A-Za-z0-9]+)$/.exec(line);
      if (restriction) {
        if (restriction[1] === 'restrict') {
          assert.equal(restricted, null);
          restricted = restriction[2];
        } else {
          assert.equal(restricted, restriction[2]);
          restricted = null;
        }
      } else {
        assert.equal(line, '\\connect postgres');
        assert.equal(restricted, null);
        assert.equal(creates, 1);
        assert.ok(connects === 0 || (connects === 1 && propertyReconnect));
        connects++;
        propertyReconnect = false;
      }
      i = next;
      start = next;
      text = '';
      lexical = '';
      continue;
    }
    const dollar =
      i > 0 && /[\p{L}\p{N}_$]/u.test(sql[i - 1])
        ? null
        : /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      assert.ok(end >= 0);
      text += sql.slice(i, end + dollar[0].length);
      lexical += ' quoted_body ';
      i = end + dollar[0].length;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const begin = i,
        quote = sql[i++];
      const escaped = quote === "'" && /(?:^|[^\p{L}\p{N}_$])E$/iu.test(text);
      let closed = false;
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
      assert.ok(closed);
      text += sql.slice(begin, i);
      lexical += ' quoted_value ';
      continue;
    }
    lexical += sql[i];
    text += sql[i++];
    if (sql[i - 1] === ';') finish(i);
  }
  assert.equal(text.trim(), '');
  assert.equal(restricted, null);
  assert.equal(creates, 1);
  assert.ok(connects === 1 || connects === 2);
  assert.ok(standardStrings);
  const header = preamble.join('');
  const output = {};
  for (const [name, statements] of Object.entries(parts)) {
    output[name] = header + statements.join('') + '\n';
    validateRestoreScript(output[name]);
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [input, ...outputs] = process.argv.slice(2);
    assert.equal(outputs.length, 4);
    const parts = partitionPlainSchema(readFileSync(input, 'utf8'));
    for (const [index, value] of Object.values(parts).entries())
      writeFileSync(outputs[index], value, { flag: 'wx', mode: 0o600 });
  } catch {
    console.error('Native Plain Schema Partition Refused');
    process.exitCode = 1;
  }
}
