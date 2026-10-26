import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * 2026-10-24: join_flash_pool debited the buy-in and never seated the player
 * (no engine seat, no refund path), from the frozen public.wallets pool. Fast
 * fold is Lightning only. No client code may call it, and the migration that
 * shuts the client roles out must stay on file.
 */
const ROOT = resolve(__dirname, '../..');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(resolve(dir, e.name))
      : /\.(ts|tsx)$/.test(e.name)
        ? [resolve(dir, e.name)]
        : []
  );

describe('a Flash Pool join never takes chips', () => {
  it('no client file calls join_flash_pool', () => {
    const callers = walk(resolve(ROOT, 'src')).filter((f) =>
      /rpc\(\s*['"]join_flash_pool['"]/.test(readFileSync(f, 'utf8'))
    );
    expect(callers).toEqual([]);
  });

  it('the client roles are shut out of it in a migration', () => {
    const sql = readFileSync(
      resolve(ROOT, 'supabase/migrations/20261024232449_flash_pool_join_never_takes_chips.sql'),
      'utf8'
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.join_flash_pool\(uuid, uuid, numeric\) FROM PUBLIC, anon, authenticated;/
    );
  });
});
