/**
 * The second-writer scanner reads exactly the parameter names a route sends
 * (phase 7 deep dive, 2026-09-07): a nested object literal used to leak its
 * inner keys into the list and report four correct calls as mismatches.
 */
import { describe, it, expect } from 'vitest';
import { scanRoute, clientRoleOf } from '../../scripts/ci/audit-second-writer.mjs';

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

/**
 * WHICH ROLE THE CALL RUNS AS (2026-09-19). Every EXECUTE verdict used to be
 * asked of `service_role`. Five World Hub routes build a client from the anon
 * key and forward the caller's token, so their RPC runs as `authenticated`.
 * That made `send_wallet_diamond_transfer` look permanently broken when it
 * works, and - the half that matters - meant nothing ever checked the grant
 * the mint route actually depends on.
 */
describe('audit-second-writer client role', () => {
  const USER_SCOPED = `
    const asPlayer = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: bearer } }, auth: { persistSession: false } }
    );
    await asPlayer.rpc('send_wallet_diamond_transfer', { p_amount: 1 });`;

  const SERVICE = `
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await sb.rpc('fn_credit_chips', { p_amount: 1 });`;

  it('an anon key plus a forwarded Authorization header is the caller, not the service', () => {
    expect(clientRoleOf(USER_SCOPED, 'asPlayer')).toBe('authenticated');
    expect(scanRoute(USER_SCOPED, 'x.js').calls[0].role).toBe('authenticated');
  });

  it('the service key is the service role', () => {
    expect(clientRoleOf(SERVICE, 'sb')).toBe('service_role');
    expect(scanRoute(SERVICE, 'x.js').calls[0].role).toBe('service_role');
  });

  it('an anon key WITHOUT a forwarded token is not a caller identity', () => {
    // The browser-style client. It has no auth.uid() to read, so claiming
    // `authenticated` for it would be the same mistake in the other direction.
    const src = `
      const pub = createClient(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
      pub.rpc('check_username_with_suggestions', { p_username: u });`;
    expect(clientRoleOf(src, 'pub')).toBeNull();
  });

  it('a receiver it cannot resolve is null, and the check falls back to service_role', () => {
    // Fail closed: null is what 286 of the World Hub's 332 calls are, and they
    // must keep being checked exactly as they were.
    const src = `(await getClient()).rpc('fn_credit_chips', { p_amount: 1 });`;
    expect(scanRoute(src, 'x.js').calls[0].role).toBeNull();
    expect(clientRoleOf(src, 'nothingNamedThis')).toBeNull();
  });

  it('reads the whole client construction, however many lines it spans', () => {
    // The argument list is read with balanced brackets. A fixed-size window
    // would stop before the Authorization header on a client written out over
    // several lines, and silently downgrade it to an unknown receiver.
    const padded = USER_SCOPED.replace(
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,',
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,\n' +
        '      // a long explanatory comment\n'.repeat(30)
    );
    expect(clientRoleOf(padded, 'asPlayer')).toBe('authenticated');
  });
});
