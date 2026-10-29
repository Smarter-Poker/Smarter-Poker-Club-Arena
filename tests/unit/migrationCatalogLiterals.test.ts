import { describe, expect, it } from 'vitest';
import {
  authoritativeMigrationSQL,
  functionBody,
  latestDeclaring,
  readMigration,
} from '../helpers/migrations';
const fn = 'native_catalog_reader';
const definition = `CREATE OR REPLACE FUNCTION public.${fn}()\nRETURNS integer LANGUAGE sql AS $function$SELECT 1;$function$;`;
const snapshot = `DO $guard$DECLARE expected jsonb:=$snapshot$${JSON.stringify({ owners: [{ definition }] })}$snapshot$::jsonb;BEGIN NULL;END$guard$;`;
describe('authoritative migration declarations keep catalog literals as data', () => {
  it('does not count a pre-image as a declaration, including GRANT EXECUTE nearby', () => {
    expect(authoritativeMigrationSQL(snapshot, fn)).not.toContain(
      'CREATE OR REPLACE FUNCTION public.'
    );
    expect(() => functionBody(snapshot, fn)).toThrow('is not declared');
    expect(() =>
      authoritativeMigrationSQL(
        snapshot + ' GRANT EXECUTE ON FUNCTION public.unrelated() TO service_role;',
        fn
      )
    ).not.toThrow();
  });
  it('retains raw source bytes for a real latest declaration', () => {
    const latest = latestDeclaring('trg_ca_club_data_fact_rake');
    expect(latest.sql).toBe(readMigration(latest.name));
    expect(authoritativeMigrationSQL(latest.sql, 'trg_ca_club_data_fact_rake')).toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.trg_ca_club_data_fact_rake\s*\(/i
    );
  });

  it('reads the actual declaration rather than a following catalog snapshot', () => {
    const actual = definition.replace('SELECT 1;', 'SELECT 2;');
    expect(functionBody(actual + snapshot, fn)).toContain('SELECT 2;');
    expect(functionBody(snapshot + actual, fn)).toContain('SELECT 2;');
  });
  it('refuses dynamic JSON-value and JSON-key declarations instead of falling back silently', () => {
    for (const [json, execute] of [
      [{ sql: definition }, "EXECUTE(j->>'sql')"],
      [{ [definition]: true }, 'FOR k IN SELECT jsonb_object_keys(j) LOOP EXECUTE k;END LOOP'],
    ] as const) {
      const value = JSON.stringify(json);
      const source = `DO $do$DECLARE j jsonb:=$j$${value}$j$::jsonb;k text;BEGIN ${execute};END$do$;`;
      expect(() => authoritativeMigrationSQL(source, fn)).toThrow('dynamic JSON-carried DDL');
      expect(() => functionBody(definition + source, fn)).toThrow('dynamic JSON-carried DDL');
    }
  });
});
