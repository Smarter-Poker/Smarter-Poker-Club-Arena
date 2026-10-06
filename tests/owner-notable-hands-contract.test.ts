import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { declaredProofs, proofIsRunnable } from '../scripts/ci/check-migrations-are-live.mjs';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const migrationPath =
  'supabase/migrations/20261006035424_owner_notable_hands_carries_scope_receipt.sql';

describe('owner notable-hands evidence contract', () => {
  it('declares one runnable durable postimage proof', () => {
    const proofs = declaredProofs(read(migrationPath));

    expect(proofs).toHaveLength(1);
    expect(proofIsRunnable(proofs[0])).toBe(true);
    expect(proofs[0]).toContain("'''contract_version'', 2");
    expect(proofs[0]).toContain(
      "p.proacl::text = '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'"
    );
  });

  it('upgrades the exact all-clubs wrapper to a v2 scoped envelope', () => {
    const migration = read(migrationPath);

    expect(migration).toContain(
      "v_sig regprocedure := 'public.ca_player_hands_v2(uuid,text,integer,text)'::regprocedure"
    );
    expect(migration).toContain("md5(p.prosrc) = 'cdd7a58bc4b701536dd30829454d8de7'");
    expect(migration).toContain(
      "md5(pg_get_functiondef(p.oid)) = '73e224ac3c79cbb564ea45ae9cebb14f'"
    );
    expect(migration).toContain('IF v_body IS DISTINCT FROM v_expected THEN');
    expect(migration).not.toContain('btrim(v_body)');
    expect(migration).toContain(
      'v_hands := public.ca_player_hands(p_user, p_mode, p_limit, p_asset);'
    );
    expect(migration).toContain("jsonb_typeof(v_hands) IS DISTINCT FROM 'array'");
    expect(migration).toContain("'contract_version', 2");
    expect(migration).toContain("'target_user_id', p_user");
    expect(migration).toContain("'club_id', NULL");
    expect(migration).toContain("'asset', p_asset");
    expect(migration).toContain("'visibility', 'owner'");
    expect(migration).toContain("'hands', v_hands");
  });

  it('preserves owner/security/search-path and refuses public or anonymous execution', () => {
    const migration = read(migrationPath);

    expect(migration).toContain("pg_get_userbyid(p.proowner) = 'postgres'");
    expect(migration).toContain('p.prosecdef');
    expect(migration).toContain("p.provolatile = 's'");
    expect(migration).toContain("p.proparallel = 'u'");
    expect(migration).toContain("p.proconfig::text = '{search_path=public}'");
    expect(migration.match(/p\.proacl::text =/g)).toHaveLength(3);
    expect(migration).toContain(
      "p.proacl::text = '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'"
    );
    expect(migration).toContain('FROM PUBLIC, anon');
    expect(migration).toContain('TO authenticated, service_role');
    expect(migration).toContain('OWNER_NOTABLE_HANDS_POSTIMAGE_DRIFT');
  });

  it('binds the client parser to exact request scope and refuses invented evidence defaults', () => {
    const model = read('src/pages/stats/playerStatsPageModel.tsx');
    const caller = read('src/pages/PlayerStatsPage.tsx');

    expect(model).toContain('payload.contract_version !== 2');
    expect(model).toContain('scope.target_user_id !== request.targetUserId');
    expect(model).toContain('scope.club_id !== request.clubId');
    expect(model).toContain('scope.asset !== request.asset');
    expect(model).toContain('scope.visibility !== request.visibility');
    expect(model).not.toContain('id: str(h?.id, `hand-${i}`)');
    expect(model).not.toContain("variant: str(h?.variant, 'Unknown')");
    expect(caller).toContain('PlayerStatsPage.rpc_ca_player_hands_v2_shape');
    expect(caller).toContain('setHandsError(true)');
  });
});
