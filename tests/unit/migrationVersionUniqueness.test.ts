import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('database migration publication safety', () => {
  it('assigns every Phase 1-and-later migration a unique recorded version', () => {
    const directory = resolve(__dirname, '../../supabase/migrations');
    // Historical date-only files predate the tracked-version convention and
    // intentionally share a day prefix. New release migrations use sortable
    // 14-digit versions and must never repeat one.
    const migrations = readdirSync(directory).filter((name) => {
      const version = name.split('_', 1)[0];
      return name.endsWith('.sql') && /^\d{14}$/.test(version) && version >= '20260902050000';
    });
    const owners = new Map<string, string[]>();

    for (const name of migrations) {
      const version = name.split('_', 1)[0];
      owners.set(version, [...(owners.get(version) || []), name]);
    }

    const collisions = [...owners.entries()].filter(([, names]) => names.length > 1);
    expect(
      collisions,
      'Two migrations share a version. Neither branch was wrong on its own - the\n' +
        'collision appears when the second one takes main, because agents pick the\n' +
        'version by hand and reach for round numbers.\n\n' +
        'This is not only a red build: Supabase keys schema_migrations on the version,\n' +
        'so of two files sharing one, the SECOND IS SILENTLY NEVER APPLIED.\n\n' +
        'Do not hand-pick a version. Run:\n\n' +
        '    node scripts/new-migration.mjs "what it does"\n\n' +
        'It reserves a version against origin/main AND every remote branch, so it\n' +
        'cannot collide with work that has not merged yet.\n\n' +
        'Colliding versions:\n' +
        collisions.map(([v, names]) => `  ${v}: ${names.join(', ')}`).join('\n')
    ).toEqual([]);
  });
});
