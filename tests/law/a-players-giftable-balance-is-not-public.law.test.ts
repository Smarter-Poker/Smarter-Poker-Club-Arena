/**
 * A player's diamond balance is theirs. fn_ca_giftable_balance(p_user_id) is
 * SECURITY DEFINER and answers for any user id, so it must never be callable
 * from a browser role. Its one caller, send_stream_gift, is itself a definer.
 * Production repro and reasoning:
 * supabase/migrations/20261002133829_a_players_giftable_diamond_balance_is_not_readable_by_other_.sql
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIG = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    '..',
    'supabase/migrations/20261002133829_a_players_giftable_diamond_balance_is_not_readable_by_other_.sql'
  ),
  'utf8'
);
const code = MIG.replace(/^--.*$/gm, '');

describe("a player cannot read another player's giftable diamond balance", () => {
  it('revokes the browser roles and keeps service_role', () => {
    expect(code).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.fn_ca_giftable_balance\(uuid\) FROM PUBLIC, anon, authenticated;/
    );
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_giftable_balance\(uuid\) TO service_role;/
    );
    expect(code).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_giftable_balance\(uuid\) TO [^;]*(anon|authenticated)/
    );
  });

  it('refuses to commit if a browser role can still call it', () => {
    expect(code).toContain(
      "has_function_privilege('authenticated', 'public.fn_ca_giftable_balance(uuid)', 'EXECUTE')"
    );
    expect(code).toContain(
      "has_function_privilege('anon', 'public.fn_ca_giftable_balance(uuid)', 'EXECUTE')"
    );
    expect(code).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  });

  it('declares a live proof the installer reads back', () => {
    expect(MIG).toMatch(/^-- @live-proof: \(SELECT NOT has_function_privilege\('authenticated'/m);
  });

  it('no client source calls the RPC directly', () => {
    const walk = (d: string): string[] =>
      fs.existsSync(d)
        ? fs
            .readdirSync(d, { withFileTypes: true })
            .flatMap((e) =>
              e.isDirectory()
                ? walk(path.join(d, e.name))
                : /\.(ts|tsx|js|mjs)$/.test(e.name)
                  ? [path.join(d, e.name)]
                  : []
            )
        : [];
    const src = walk(path.join(__dirname, '..', '..', 'src'));
    const hits = src.filter((f) => fs.readFileSync(f, 'utf8').includes("'fn_ca_giftable_balance'"));
    expect(hits).toEqual([]);
  });
});
