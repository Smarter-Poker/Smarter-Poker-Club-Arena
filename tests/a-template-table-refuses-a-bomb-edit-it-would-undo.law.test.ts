/**
 * LAW - A TEMPLATE TABLE REFUSES A BOMB EDIT IT WOULD UNDO
 *
 * Launch audit 2026-10-05. fn_update_table_bomb_settings wrote a table's bomb
 * columns, and for a table that belongs to a cash game the cluster tick wrote
 * them back from the game's ruleset about five seconds later: the host saw
 * "saved", the table reverted, and the bomb schedule had been wiped. Two
 * writers of one rule. Migration 20261006031707 refuses the table-level edit
 * for a template table before anything is written, and the page says why.
 *
 * The unit suite has no database, so this pins the migration's shape, the
 * page's message, and that no later migration redefines the door without the
 * refusal. Behaviour was executed on a scratch PostgreSQL 16 (docs/changelog).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const NAME = '20261006031707_a_template_table_refuses_a_bomb_edit_it_would_undo.sql';
const REASON = 'set_by_the_game_template';
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

describe('a template table refuses a bomb edit it would undo', () => {
  const sql = read(NAME);

  it('refuses a table with a cluster before the first setting is read', () => {
    expect(sql).toContain('t.id = p_table_id AND t.cluster_id IS NOT NULL');
    expect(sql).toContain(`'reason', '${REASON}'`);
    expect(sql).toContain('$block$ || c_anchor);');
  });

  it('refuses a definition it was not written against, and asserts its effect', () => {
    expect(sql).toContain("md5(v_def) <> '1686b0072db257921e0dfba91a888bf4'");
    expect(sql).toContain('a template table still accepts a bomb edit');
    expect(sql).toMatch(/^-- @live-proof: .*set_by_the_game_template/m);
  });

  it('is one transaction', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('the page tells the host why', () => {
    const page = readFileSync(
      join(ROOT, 'src', 'pages', 'club', 'TableBombSettingsPage.tsx'),
      'utf8'
    );
    expect(page).toContain(`res?.reason === '${REASON}'`);
    expect(page).toContain("'Bomb Pots At This Table Are Set By The Game Template'");
  });

  it('no later migration redefines the door without the refusal', () => {
    for (const f of files.filter((name) => name > NAME)) {
      const body = read(f);
      if (
        !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.fn_update_table_bomb_settings\b/i.test(body)
      ) {
        continue;
      }
      expect(body, `${f} redefines the bomb settings door`).toContain(REASON);
    }
  });
});
