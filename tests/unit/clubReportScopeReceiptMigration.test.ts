import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261006040022_club_reports_return_exact_scope_receipts.sql',
  'utf8'
);
const manifest = readFileSync(
  'scripts/ci/schema-manifest.d/club-data-final-deep-audit-20261005.json',
  'utf8'
);

const reports = [
  {
    publicName: 'ca_club_insurance_report',
    signature: 'uuid,integer',
    coreName: 'ca_club_insurance_report_core_20261006',
    contract: 'ca_club_insurance_report.v2',
  },
  {
    publicName: 'ca_club_financials',
    signature: 'uuid,date,date',
    coreName: 'ca_club_financials_core_20261006',
    contract: 'ca_club_financials.v2',
  },
  {
    publicName: 'ca_club_chip_ledger',
    signature: 'uuid,integer,timestamptz,boolean',
    coreName: 'ca_club_chip_ledger_core_20261006',
    contract: 'ca_club_chip_ledger.v2',
  },
  {
    publicName: 'ca_club_game_page',
    signature: 'uuid,date,date,text,text,text,text,jsonb,integer',
    coreName: 'ca_club_game_page_core_20261006',
    contract: 'ca_club_game_page.v2',
  },
  {
    publicName: 'ca_club_player_page',
    signature: 'uuid,date,date,text,text,jsonb,integer',
    coreName: 'ca_club_player_page_core_20261006',
    contract: 'ca_club_player_page.v2',
  },
] as const;

const livePreimages = [
  {
    signature: 'ca_club_insurance_report(uuid,integer)',
    variable: 'v_insurance',
    prosrcMd5: '8626295fcf40cfe73be63edf4702d568',
    definitionMd5: '9bb9cbf8dbfaa17167690aa191a1f4bc',
  },
  {
    signature: 'fn_club_bomb_pot_report(uuid,integer)',
    variable: 'v_bombs',
    prosrcMd5: '635cce48ca50b92c3ef235be220d7dc8',
    definitionMd5: 'a37016388c8957533a8a7f1e0b610065',
  },
  {
    signature: 'ca_club_financials(uuid,date,date)',
    variable: 'v_financials',
    prosrcMd5: '6a5399bf03d567b34d6382b25a9ca6db',
    definitionMd5: 'ac1e093ddb297eb63ee8905d6c48229e',
  },
  {
    signature: 'ca_club_chip_ledger(uuid,integer,timestamptz,boolean)',
    variable: 'v_ledger',
    prosrcMd5: '53554b8d9922c63d160aa6cd68b0bbd6',
    definitionMd5: '2da327b47573b7313a9362b81c78b873',
  },
  {
    signature: 'ca_club_game_page(uuid,date,date,text,text,text,text,jsonb,integer)',
    variable: 'v_game_page',
    prosrcMd5: '1bb73735870ec3e4e26509f2dade4a8d',
    definitionMd5: '005fcf77ba241a357921edc029fdfc3c',
  },
  {
    signature: 'ca_club_player_page(uuid,date,date,text,text,jsonb,integer)',
    variable: 'v_player_page',
    prosrcMd5: '3a7ec883a7ca32920d345e4d7eea044a',
    definitionMd5: '171060d16ed798d1a185080d1a9334cd',
  },
] as const;

describe('club report scope receipt migration', () => {
  it('keeps every preimage, rename, wrapper and postimage in one rollback boundary', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    const begin = migration.indexOf('BEGIN;');
    const preimage = migration.indexOf('DO $club_report_receipt_preimage$');
    const firstRename = migration.indexOf('ALTER FUNCTION public.ca_club_insurance_report');
    const postimage = migration.indexOf('DO $club_report_receipt_postimage$');
    const commit = migration.lastIndexOf('COMMIT;');
    expect(begin).toBeLessThan(preimage);
    expect(preimage).toBeLessThan(firstRename);
    expect(firstRename).toBeLessThan(postimage);
    expect(postimage).toBeLessThan(commit);
    expect(migration.slice(postimage, commit)).toContain('RAISE EXCEPTION');
  });

  it.each(reports)('$publicName preserves its core behind a strict public receipt', (report) => {
    expect(migration).toContain(`RENAME TO ${report.coreName};`);
    expect(migration).toContain(
      `REVOKE ALL ON FUNCTION public.${report.coreName}(${report.signature})`
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).toContain(`CREATE FUNCTION public.${report.publicName}(`);
    expect(migration).toContain(`'contract', '${report.contract}'`);
    expect(migration).toContain("'contract_version', 2");
    expect(migration).toContain("'club_id', p_club_id");
    expect(migration).toContain(
      `GRANT EXECUTE ON FUNCTION public.${report.publicName}(${report.signature})`
    );
    expect(manifest).toContain(`"${report.coreName}"`);
  });

  it.each(livePreimages)(
    '$signature must match both immutable production preimages before wrapping',
    ({ signature, variable, prosrcMd5, definitionMd5 }) => {
      expect(migration).toContain(`'public.${signature}'::regprocedure`);
      const blockStart = migration.indexOf(`WHERE p.oid = ${variable}`);
      const blockEnd = migration.indexOf('\n  ) THEN', blockStart);
      expect(blockStart).toBeGreaterThan(-1);
      expect(blockEnd).toBeGreaterThan(blockStart);
      const preflight = migration.slice(blockStart, blockEnd);
      expect(preflight).toContain(`md5(p.prosrc) = '${prosrcMd5}'`);
      expect(preflight).toContain(`md5(pg_get_functiondef(p.oid)) = '${definitionMd5}'`);
    }
  );

  it('pins the exact production ACL before retaining any report implementation', () => {
    expect(
      migration.match(
        /p\.proacl::text = '\{postgres=X\/postgres,authenticated=X\/postgres,service_role=X\/postgres\}'/g
      )
    ).toHaveLength(livePreimages.length);
  });

  it('adds the strict Bomb Pot envelope without breaking the legacy table-returning RPC', () => {
    expect(migration).not.toContain('RENAME TO fn_club_bomb_pot_report_core_20261006;');
    expect(migration).not.toContain('DROP FUNCTION public.fn_club_bomb_pot_report');
    expect(migration).toContain('CREATE FUNCTION public.fn_club_bomb_pot_report_v2(');
    expect(migration).toContain('FROM public.fn_club_bomb_pot_report(p_club_id, p_days) r;');
    expect(migration).toContain('CLUB_BOMB_POT_REPORT_LEGACY_CONTRACT_DRIFT');
    expect(migration).toContain("pg_get_function_result(p.oid) LIKE 'TABLE(table_id uuid,%'");
    expect(migration).toContain("'contract', 'fn_club_bomb_pot_report.v2'");
    expect(migration).toContain("'contract_version', 2");
    expect(migration).toContain("'club_id', p_club_id");
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report_v2(uuid,integer)'
    );
    expect(manifest).toContain('"fn_club_bomb_pot_report_v2"');
  });

  it('binds the exact window and page inputs even when row arrays are empty', () => {
    expect(migration).toContain("'requested_days', p_days");
    expect(migration).toContain("'window_days', v_days");
    expect(migration).toContain("'window_start', v_window_start");
    expect(migration).toContain("'window_end', v_window_end");
    expect(migration).toContain("'rows', v_rows");
    expect(migration).toContain("'requested_start', p_start");
    expect(migration).toContain("'requested_end', p_end");
    expect(migration).toContain("'requested_limit', p_limit");
    expect(migration).toContain("'requested_before', p_before");
    expect(migration).toContain("'requested_include_hand_rows', p_include_hand_rows");
    expect(migration).toContain("'requested_game', p_game");
    expect(migration).toContain("'requested_stakes', p_stakes");
    expect(migration).toContain("'requested_search', p_search");
    expect(migration).toContain("'requested_sort', p_sort");
    expect(migration).toContain("'requested_cursor', p_cursor");
    expect(migration).toContain("'requested_limit', p_limit");
  });

  it('wraps the union-aware player-page post-image instead of replacing its hand scope', () => {
    expect(migration).toContain(
      "md5(pg_get_functiondef(p.oid)) = '171060d16ed798d1a185080d1a9334cd'"
    );
    expect(migration).toContain("position('hand_clubs AS MATERIALIZED' in v_body) = 0");
    expect(migration).toContain(
      "position('JOIN hand_clubs hc ON hc.club_id=s.club_id' in v_body) = 0"
    );
    expect(migration).toContain('RENAME TO ca_club_player_page_core_20261006;');
    expect(migration).toContain('public.ca_club_player_page_core_20261006(');
  });
});
