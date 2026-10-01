/**
 * LIGHTNING PHASE 6: the table view on a pool-session room.
 *
 * TablePage is far too large to mount in a unit test, so its Lightning
 * contract is pinned at the source, the way this repo pins its other table
 * laws: no `tables` row is read for a pool session, the felt is described
 * from the Cluster and the engine snapshot, the engine room is the pool
 * session id for the whole session (the client never switches rooms between
 * hands), and every non-Lightning path is guarded by a room check that is
 * null at every table. The JOIN LIGHTNING hand-off hook, which is the one
 * place a tab is re-pointed, is exercised for real below.
 */
import { sliceMethod } from '../helpers/sourceWindow';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const PAGE = read('src/pages/TablePage.tsx');

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return chain;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { useLightningAnchorHandoff } from '../../src/lightning/useLightningAnchorHandoff';
import {
  getLightningPoolSession,
  resetLightningRegistryForTests,
  setLightningEntryIntent,
} from '../../src/lightning/lightningSession';

const POOL = '11111111-1111-4111-8111-111111111111';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';

describe('TablePage on a pool-session id', () => {
  it('reads no tables row for a pool session: every read is behind the room check', () => {
    const lines = PAGE.split('\n');
    const reads = lines.flatMap((l, i) => (l.includes(".from('tables')") ? [i] : []));
    expect(reads.length).toBe(4);
    for (const i of reads) {
      const before = lines.slice(Math.max(0, i - 120), i).join('\n');
      expect(before, `tables read at line ${i + 1}`).toMatch(/lightningRoomRef\.current/);
    }
    const boot = sliceMethod(PAGE, 'async function loadTableInfo() {');
    expect(boot).toContain('if (lightningRoomRef.current) return;');
  });

  it('describes the felt from the Cluster and then the snapshot', () => {
    expect(PAGE).toContain('lightningTableSeed(lightningMeta)');
    expect(PAGE).toContain('lightningSnapshotPatch(engineSnapshot as LightningSnapshotFields)');
    expect(PAGE).toMatch(/useLightningPoolSession\(tableId\)/);
  });

  it('subscribes to one room, the route id, for every hand', () => {
    expect(PAGE).toMatch(/useEngineTableState\(tableId \|\| undefined,/);
    const block = PAGE.slice(
      PAGE.indexOf('LIGHTNING PHASE 6: ONE ROOM, MANY HANDS'),
      PAGE.indexOf('useLightningAnchorHandoff({')
    );
    expect(block).not.toMatch(/navigate\(/);
    expect(block).not.toMatch(/movedToTableId/);
  });

  it('binds an armed pre-action to its hand and never restores it in a Lightning room', () => {
    expect(PAGE).toContain(
      'preActionBelongsToHand(lightningArmRef.current.key, lightningHandKeyNow)'
    );
    expect(PAGE).toMatch(
      /if \(lightningRoomRef\.current\) \{\s*\/\/ Lightning: left disarmed \(see above\)\.\s*\} else if \(armed\) setPreAction\(armed\);/
    );
    expect(PAGE).toContain(
      'await serverSetPreAction(tableId, serverAction, armCap, lightningArmHandId)'
    );
  });

  it("drives the Lightning controls from the engine's fast_fold_available flag", () => {
    expect(PAGE).toContain('lightningFastFoldFlag(engineSnapshot as LightningSnapshotFields)');
  });

  it('mounts the Lightning controls only in a Lightning room', () => {
    expect(PAGE).toMatch(/\{lightningRoom && tableState\.heroSeat > 0 \? \(\s*<LightningFoldBar/);
    expect(PAGE).toMatch(/\{lightningRoom \? \(\s*<LightningNextHand/);
  });
});

describe('JOIN LIGHTNING hand-off from the anchor table', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetLightningRegistryForTests();
    rpc.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('does nothing at a table without an intent (every table today)', async () => {
    const follow = vi.fn();
    renderHook(() =>
      useLightningAnchorHandoff({
        tableId: ANCHOR,
        isPoolSession: false,
        heroBoughtIn: true,
        follow,
      })
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(rpc).not.toHaveBeenCalled();
    expect(follow).not.toHaveBeenCalled();
  });

  it('does nothing in the pool-session room itself', async () => {
    setLightningEntryIntent(POOL, CLUSTER);
    const follow = vi.fn();
    renderHook(() =>
      useLightningAnchorHandoff({ tableId: POOL, isPoolSession: true, heroBoughtIn: true, follow })
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(rpc).not.toHaveBeenCalled();
  });

  it('after the buy-in, re-points this tab at the pool session once it exists', async () => {
    setLightningEntryIntent(ANCHOR, CLUSTER);
    rpc.mockResolvedValue({ data: { pool_session_id: POOL, state: 'active' }, error: null });
    const follow = vi.fn();
    renderHook(() =>
      useLightningAnchorHandoff({
        tableId: ANCHOR,
        isPoolSession: false,
        heroBoughtIn: true,
        follow,
      })
    );
    await waitFor(() => expect(follow).toHaveBeenCalledWith(POOL));
    expect(follow).toHaveBeenCalledTimes(1);
    expect(getLightningPoolSession(POOL)?.clusterId).toBe(CLUSTER);
  });
});

describe('player-visible terminology', () => {
  const FILES = [
    ...readdirSync(join(ROOT, 'src/lightning')).map((f) => `src/lightning/${f}`),
    'src/components/table/LightningFoldBar.tsx',
    'src/components/table/LightningFoldBar.css',
    'src/components/table/LightningNextHand.tsx',
    'src/pages/LightningEntryPage.tsx',
    'src/pages/LightningEntryPage.css',
  ];
  const BANNED = [
    /\bzoom\b/i,
    /\brush\b/i,
    /\bsnap\b/i,
    /\bzone\b/i,
    /\bblitz\b/i,
    /\bfast[\s-]?forward\b/i,
    /\bspeed poker\b/i,
    /\bswift\b/i,
    /\bfast[\s-]fold\b/i,
  ];
  it('no competitor product name appears in any new Lightning file', () => {
    for (const f of FILES) {
      const text = read(f);
      for (const re of BANNED) expect(re.test(text), `${f} matches ${re}`).toBe(false);
    }
  });
  it('the controls use only the approved terms', async () => {
    const hand = await import('../../src/lightning/lightningHand');
    expect(hand.LIGHTNING_FOLD_LABEL).toBe('LIGHTNING FOLD');
    expect(hand.LIGHTNING_FOLD_WATCH_LABEL).toBe('FOLD & WATCH');
    const lobby = await import('../../src/lightning/lightningLobby');
    expect(
      lobby.lightningLobbyBadge({ clusterMode: 'lightning', state: null, boardPlayers: 0 }).label
    ).toBe('LIGHTNING LIVE');
    expect(
      lobby.lightningLobbyBadge({ clusterMode: 'must_move', state: null, boardPlayers: 0 }).label
    ).toBe('MUST MOVE');
  });
});
