/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB HOME FAST PATH — one round trip must not become six again
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Painting this page took SIX sequential round trips: club row,
 * membership+wallet, union row, union club ids, member count, then
 * tables+tournaments+BBJ. Measured 2026-08-23 the queries cost ~9ms
 * server-side; the wait was network latency, 150-250ms per trip wired and
 * 250-400ms on mobile.
 *
 * public.get_club_home() returns the whole visible lobby in one call (38ms on
 * the largest club: 1,172 members, 42 tables). It runs ALONGSIDE the existing
 * chain rather than replacing it, so the chain stays authoritative and this
 * only moves the first paint earlier.
 *
 * The property that must never break: the fast path may paint only BEFORE the
 * authoritative data, never over it. If `lobbyPainted` stops being set by the
 * real chain, a slow RPC could replace fresh tables with a stale snapshot —
 * which would look exactly like a flickering lobby and be very hard to trace.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.resolve(__dirname, '../..', 'src/pages/ClubHomePage.tsx'), 'utf8');
const scopedPlayingMigration = readFileSync(
  path.resolve(
    __dirname,
    '../..',
    'supabase/migrations/20260831223000_club_home_playing_is_club_scoped.sql'
  ),
  'utf8'
);

const at = (needle: string) => {
  const i = src.indexOf(needle);
  expect(i, `ClubHomePage no longer contains: ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe('the club lobby paints from one round trip', () => {
  it('calls get_club_home', () => {
    expect(src).toContain("rpc('get_club_home', { p_club_key: clubId })");
  });

  it('fires the RPC before the six-query chain, not after it', () => {
    const rpc = at("rpc('get_club_home'");
    // resolvedId is the first thing the legacy chain derives; every one of its
    // round trips happens after it.
    const chainStart = at('const resolvedId = clubData.id;');
    expect(rpc, 'the fast path is queued behind the chain it exists to beat').toBeLessThan(
      chainStart
    );
  });

  it('never paints over the authoritative data', () => {
    const guardDeclared = at('let lobbyPainted = false;');
    const guardChecked = at('if (lobbyPainted) return;');
    const claimedByChain = src.lastIndexOf('lobbyPainted = true;');
    const chainSetsTables = at('const tableData = tableResult.data;');

    expect(guardChecked).toBeGreaterThan(guardDeclared);
    // The authoritative chain must claim the paint BEFORE it writes tables,
    // so a late RPC response can never overwrite them.
    expect(
      claimedByChain,
      'the authoritative chain no longer claims the paint before setting tables'
    ).toBeLessThan(chainSetsTables);
  });

  it('degrades to the existing chain if the RPC fails', () => {
    // A failure must cost the speed-up and nothing else - the chain below is
    // untouched, so the lobby still loads.
    expect(src).toContain('if (homeErr || !home || home.found !== true) return;');
    expect(src).toMatch(/\.catch\(\(\) => \{/);
  });

  it('respects unmount before touching state', () => {
    const rpcBlock = src.slice(at("rpc('get_club_home'"), at('const resolvedId = clubData.id;'));
    /* The mount check is now half of a wider guard. `stale()` compares a
       per-load token, because `lobbyPainted` is a local of one invocation and
       could never arbitrate between two DIFFERENT loads: club A's in-flight
       RPC landing after a switch to club B still painted A over B. Both
       halves must be present, and they must guard BOTH the players-playing
       write and the list paint. */
    expect(rpcBlock).toContain('if (stale() || (getIsMounted && !getIsMounted())) return;');
    // Declared just above the rpc call, so it is checked against the file.
    expect(src).toContain('const loadToken = ++loadTokenRef.current;');
    expect(src).toContain('const stale = () => loadToken !== loadTokenRef.current;');
    expect(
      rpcBlock.split('if (stale() || (getIsMounted && !getIsMounted())) return;').length - 1,
      'both the players-playing write and the list paint must be guarded'
    ).toBe(2);
  });

  it('never reuses another club’s playing count', () => {
    expect(src).toContain('setPlayersPlaying(null);');
    expect(src).toContain('ClubHomePage.players_playing_realtime_refresh_failed');
    expect(src).toContain("supabase.rpc('get_club_home'");
    expect(src).toContain('refreshScopedPlaying();');
    expect(scopedPlayingMigration).toContain('tb.club_id, tb.is_private, tb.union_id,');
    expect(scopedPlayingMigration).toContain('v_union_id, v_club.id, v_union_club_ids);');
    expect(scopedPlayingMigration).toContain('public.get_club_home(v_club.id::text)');
  });
});
