/**
 * The second-writer scanner reads exactly the parameter names a route sends
 * (phase 7 deep dive, 2026-09-07): a nested object literal used to leak its
 * inner keys into the list and report four correct calls as mismatches.
 */
import { describe, it, expect } from 'vitest';
import { scanRoute } from '../../scripts/ci/audit-second-writer.mjs';

describe('audit-second-writer scanner', () => {
  it('takes only top-level keys, through nested objects, arrays, strings and comments', () => {
    const src = `
      await sb.rpc('record_arena_audit_log', {
        p_club_id: clubId,            // trailing comment, with: a colon
        p_details: { hand, equity: e.q, list: [1, { deep: true }] },
        p_note: "a string, with commas: yes",
        p_when: fn(a, b),
        /* block, comment */ p_last
      });`;
    const { calls } = scanRoute(src, 'x.js');
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('record_arena_audit_log');
    expect(calls[0].keys).toEqual(['p_club_id', 'p_details', 'p_note', 'p_when', 'p_last']);
  });

  it('a spread or a variable payload is UNCHECKED, never a guess', () => {
    const { calls } = scanRoute(
      `sb.rpc('a', { ...rest, p_x: 1 }); sb.rpc('b', args); sb.rpc('c');`,
      'x.js'
    );
    expect(calls.map((c) => [c.fn, c.keys])).toEqual([
      ['a', null],
      ['b', null],
      ['c', null],
    ]);
  });

  it('a written exemption travels with the call', () => {
    const src = `
      // second-writer-exempt: legacy engine, no production request since the Hetzner engine took every table
      sb.rpc('award_bbj', { p_club_id: id });
      sb.rpc('fn_credit_chips', { p_club_id: id, p_user_id: u, p_amount: 1 });`;
    const { calls } = scanRoute(src, 'x.js');
    expect(calls[0].exempt).toMatch(/legacy engine/);
    expect(calls[1].exempt).toBeNull();
  });

  it('a direct balance write is a finding; a literal zero on an insert is provisioning', () => {
    const src = `
      await sb.from('club_members').insert({ club_id: c, user_id: u, chip_balance: 0 });
      await sb.from('club_members').update({ credit_limit: newLimit }).eq('club_id', c);
      await sb.from('bbj_pools').insert({ union_id: x, main_balance: seed });
      await sb.from('clubs').select('chip_treasury');`;
    const { directWrites } = scanRoute(src, 'x.js');
    expect(directWrites.map((d) => `${d.table}.${d.op}:${d.columns.join('+')}`)).toEqual([
      'club_members.update:credit_limit',
      'bbj_pools.insert:main_balance',
    ]);
  });
});
