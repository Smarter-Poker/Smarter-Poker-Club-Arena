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
    expect(collisions).toEqual([]);
  });
});
