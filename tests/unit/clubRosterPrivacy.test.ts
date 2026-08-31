import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildCSV, escapeCSVCell } from '../../src/lib/export';
import { normalizeRosterSearch } from '../../src/services/ClubRosterService';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260830143000_club_roster_privacy_and_cursor_pages.sql'
  ),
  'utf8'
);
const HARDENING = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260831150000_player_command_phase3_security_scale_hardening.sql'
  ),
  'utf8'
);
const NOTE_PARITY = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260831151000_player_command_note_capability_parity.sql'
  ),
  'utf8'
);
const PAGE = readFileSync(resolve(__dirname, '../../src/pages/ClubMembersPage.tsx'), 'utf8');
const CACHE = readFileSync(resolve(__dirname, '../../src/lib/rosterCache.ts'), 'utf8');
const MANAGEMENT = readFileSync(
  resolve(__dirname, '../../src/pages/MemberManagementPage.tsx'),
  'utf8'
);
const migrationCode = MIGRATION.replace(/--[^\n]*/g, '');
const managementCode = MANAGEMENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('club roster privacy contract', () => {
  it('never reads the frozen public.wallets pool', () => {
    expect(migrationCode).not.toMatch(/\bpublic\.wallets\b/);
    expect(MIGRATION).toContain('cm.chip_balance');
    expect(MIGRATION).toContain('a.agent_wallet_balance');
  });

  it('returns sensitive columns only through the row-shaped access decision', () => {
    expect(MIGRATION).toContain('CASE WHEN ac.sensitive THEN');
    expect(MIGRATION).toContain("RETURN 'identity'");
    expect(MIGRATION).toContain("RETURN 'downline'");
    expect(MIGRATION).toContain("RETURN 'staff'");
  });

  it('does not expose internal helper functions to browser roles', () => {
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.ca_club_roster_rows(uuid) FROM PUBLIC, anon, authenticated'
    );
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.ca_club_roster_access(uuid, uuid) FROM PUBLIC, anon, authenticated'
    );
  });

  it('requires a staff-authorized, audited server export', () => {
    expect(MIGRATION).toContain('Roster Export Requires Club Staff Access');
    expect(MIGRATION).toContain('Roster Export Requires An Auditable Actor');
    expect(MIGRATION).toContain("'export_club_roster'");
    expect(PAGE).toContain('ClubRosterService.exportRoster');
  });

  it('closes direct note writes and routes the UI through the audited RPC', () => {
    expect(MIGRATION).toContain('trg_club_member_notes_guard');
    expect(MIGRATION).toContain("'update_member_notes'");
    expect(MANAGEMENT).toContain('ClubRosterService.updateMemberNotes');
    expect(managementCode).not.toMatch(/\.from\('club_members'\)\s*\.update/);
  });

  it('stores only identity-presence rows with a five-minute expiry', () => {
    expect(CACHE).toContain('5 * 60 * 1000');
    expect(CACHE).toContain('sanitizeRosterMemberForCache');
    expect(CACHE).toContain('can_view_financials: false');
    expect(CACHE).toContain('remark: null');
  });

  it('treats malformed cursor numerics as an expired cursor', () => {
    expect(MIGRATION).toContain('v_cursor := NULL');
    expect(MIGRATION).toContain("v_cursor ? 'metric'");
  });

  it('binds cursor v2 to the viewer, club, search, filter and sort context', () => {
    for (const field of ['actor', 'club', 'search', 'filter', 'sort']) {
      expect(HARDENING).toContain(`v_cursor->>''${field}''`);
    }
    expect(HARDENING).toContain("''v'', 2");
  });

  it('bounds literal search at both trust boundaries', () => {
    expect(normalizeRosterSearch(`  ${'x'.repeat(150)}  `)).toHaveLength(120);
    expect(normalizeRosterSearch('  100%_literal  ')).toBe('100%_literal');
    expect(HARDENING).toContain('position(v_search in lower(r.alias))');
    expect(HARDENING).toContain("left(btrim(coalesce(p_search, '''')), 120)");
  });

  it('skips hierarchy and financial aggregation for redacted rows', () => {
    expect(HARDENING).toContain('WHERE v_needs_hierarchy');
    expect(HARDENING).toContain('JOIN access ac ON ac.uid = r.user_id AND ac.sensitive');
  });

  it('returns complete persisted notes for an idempotent replay', () => {
    expect(HARDENING).toContain("'success', true, 'replayed', true");
    expect(HARDENING).toContain("'nickname', v_after_nickname, 'remark', v_after_remark");
    expect(MANAGEMENT).toContain('draftRef.current');
    expect(MANAGEMENT).toContain('Save Notes');
    expect(MANAGEMENT).toContain('The Member Ledger Did Not Respond');
    expect(MANAGEMENT).toContain('Retry Member');
    expect(MANAGEMENT).toContain('setLoadError(true)');
  });

  it('enforces the non-self-editable note capability in the writer', () => {
    expect(NOTE_PARITY).toContain('v_actor = p_target_user_id');
    expect(NOTE_PARITY).toContain('Not Self-Editable Profile Fields');
  });
});

describe('CSV spreadsheet injection protection', () => {
  it.each(['=2+2', '+cmd', '-10+20', '@SUM(A1:A2)', ' =HYPERLINK("x")'])(
    'neutralizes %s',
    (value) => expect(escapeCSVCell(value)).toContain("'")
  );

  it('quotes commas, quotes and line breaks', () => {
    expect(escapeCSVCell('A,"B"\nC')).toBe('"A,""B""\nC"');
  });

  it('builds CRLF-delimited CSV using the safe cell encoder', () => {
    const csv = buildCSV([{ name: '=1+1', note: 'a,b' }]);
    expect(csv).toBe('name,note\r\n\'=1+1,"a,b"');
  });
});
