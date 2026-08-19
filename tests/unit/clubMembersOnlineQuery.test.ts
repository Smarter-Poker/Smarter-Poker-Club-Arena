/**
 * REGRESSION (2026-08-19): "Online Now" was stuck at 1 while ~133 members were
 * seated in live hands.
 *
 * The seated-players lookup filtered `tables` on `.eq('is_active', true)`.
 * That column does not exist, so PostgREST returned
 *   "column tables.is_active does not exist"
 * and — because supabase-js RETURNS errors rather than throwing — the
 * surrounding try/catch never fired, `data` was silently null, and the seated
 * set stayed empty forever.
 *
 * Two invariants are locked here:
 *   1. The query filters on `status`, never on a non-existent `is_active`.
 *   2. Query errors are inspected, not swallowed.
 *
 * These are source-level assertions because the defect was a schema mismatch:
 * it cannot be reproduced with a mocked client that happily accepts any column.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = readFileSync(resolve(__dirname, '../../src/pages/ClubMembersPage.tsx'), 'utf8');

/** Source with comment lines stripped — the comments deliberately name the bug. */
const CODE = SRC.split('\n')
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  })
  .join('\n');

// The block that resolves which of this club's tables are live.
const seatedBlock = SRC.slice(SRC.indexOf('const loadSeated'), SRC.indexOf('loadSeated();'));

describe('ClubMembersPage seated-online query', () => {
  it('has a seated-online lookup at all', () => {
    expect(seatedBlock.length).toBeGreaterThan(200);
    expect(seatedBlock).toContain("from('tables')");
    expect(seatedBlock).toContain("from('table_seats')");
  });

  it('never filters tables on the non-existent is_active column', () => {
    expect(CODE).not.toContain('is_active');
  });

  it('filters tables by live status instead', () => {
    expect(seatedBlock).toMatch(/\.in\(\s*'status'\s*,\s*\[[^\]]*'waiting'[^\]]*'running'[^\]]*\]/);
  });

  it('excludes closed tables so stale seats do not count as online', () => {
    expect(seatedBlock).not.toMatch(/'closed'/);
  });

  it('only counts seats that have not been left', () => {
    expect(seatedBlock).toContain("is('left_at', null)");
  });

  it('inspects query errors rather than swallowing them', () => {
    // supabase-js returns { data, error }; a bare try/catch cannot see failures.
    expect(seatedBlock).toMatch(/error:\s*tablesErr/);
    expect(seatedBlock).toMatch(/if\s*\(\s*tablesErr\s*\)/);
    expect(seatedBlock).toMatch(/error:\s*seatsErr/);
    expect(seatedBlock).toMatch(/if\s*\(\s*seatsErr\s*\)/);
  });
});

describe('ClubMembersPage horse anonymity', () => {
  it('exposes no horse flag, badge or filter to the client', () => {
    expect(CODE).not.toContain('is_horse');
    expect(CODE).not.toContain('HORSE');
    expect(CODE).not.toMatch(/'horses'/);
  });

  it('renders display_name so names are not forced lowercase by the DB trigger', () => {
    expect(SRC).toContain('display_name');
  });
});
