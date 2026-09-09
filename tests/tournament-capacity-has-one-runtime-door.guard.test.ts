import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const migrations = resolve(root, 'supabase', 'migrations');
const names = readdirSync(migrations)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const retired = [
  'fn_ca_return_stranded_to_the_felt',
  'fn_ca_restore_tournament_felt',
  'fn_ca_move_tournament_seat',
];

describe('tournament capacity has one runtime door', () => {
  it('leaves each incident-only function retired after every migration', () => {
    for (const functionName of retired) {
      const definitions = names.flatMap((name) => {
        const sql = readFileSync(resolve(migrations, name), 'utf8');
        if (sql.includes(`CREATE OR REPLACE FUNCTION public.${functionName}(`)) {
          return [{ name, action: 'create' }];
        }
        if (sql.includes(`DROP FUNCTION public.${functionName}(`)) {
          return [{ name, action: 'drop' }];
        }
        return [];
      });
      expect(definitions.length, `${functionName} has provenance`).toBeGreaterThan(1);
      expect(definitions.at(-1), `${functionName} final migration action`).toEqual({
        name: '20260909230135_tournament_capacity_has_one_runtime_door.sql',
        action: 'drop',
      });
    }
  });

  it('drops the batch helper before its seat primitive and proves all three absent', () => {
    const sql = readFileSync(
      resolve(migrations, '20260909230135_tournament_capacity_has_one_runtime_door.sql'),
      'utf8'
    );
    const batch = sql.indexOf(
      'DROP FUNCTION public.fn_ca_return_stranded_to_the_felt(uuid,boolean,integer) RESTRICT'
    );
    const clone = sql.indexOf(
      'DROP FUNCTION public.fn_ca_restore_tournament_felt(uuid,boolean,integer) RESTRICT'
    );
    const move = sql.indexOf(
      'DROP FUNCTION public.fn_ca_move_tournament_seat(uuid,uuid,uuid,integer,text) RESTRICT'
    );
    expect(batch).toBeGreaterThan(-1);
    expect(clone).toBeGreaterThan(batch);
    expect(move).toBeGreaterThan(clone);
    for (const functionName of retired) {
      expect(sql).toContain(`'public.${functionName}(`);
      expect(sql.slice(sql.indexOf('$postcondition$'))).toContain(`'public.${functionName}(`);
    }
  });
});
