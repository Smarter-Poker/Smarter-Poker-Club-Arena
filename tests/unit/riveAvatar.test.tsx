import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * There is no .riv anywhere yet — the artwork has to be rigged in the Rive
 * editor first. That is exactly why these exist: the integration must be proven
 * WITHOUT art, or it ships as an untested promise.
 *
 * Two things are being proven.
 *
 *  1. THE ZERO-RIG PATH IS FREE AND SILENT. Today every avatar is unrigged.
 *     That is the normal state, not an error, so it must cost one cached 404
 *     and produce no console noise, no retry storm, and no visible change.
 *     If this integration slows a table down while no rig exists, it is wrong.
 *
 *  2. WHEN A RIG DOES LAND, IT IS ACTUALLY DRIVEN. The gestures must reach the
 *     state machine as the documented inputs, so an artist can build against
 *     the contract and have it work with no further code.
 */

const fired: string[] = [];
const boolSet: Record<string, boolean> = {};
let onLoadCb: (() => void) | null = null;
let constructed = 0;

const makeInputs = () => [
  { name: 'Push', fire: () => fired.push('Push') },
  { name: 'Check', fire: () => fired.push('Check') },
  { name: 'Fold', fire: () => fired.push('Fold') },
  { name: 'Celebrate', fire: () => fired.push('Celebrate') },
  { name: 'Lose', fire: () => fired.push('Lose') },
  { name: 'Alert', fire: () => fired.push('Alert') },
  {
    name: 'IsActive',
    get value() {
      return boolSet.IsActive;
    },
    set value(v: boolean) {
      boolSet.IsActive = v;
    },
  },
  {
    name: 'IsFolded',
    get value() {
      return boolSet.IsFolded;
    },
    set value(v: boolean) {
      boolSet.IsFolded = v;
    },
  },
];

vi.mock('@rive-app/canvas', () => ({
  Rive: class {
    constructor(opts: any) {
      constructed++;
      onLoadCb = () => opts.onLoad?.();
    }
    stateMachineInputs() {
      return makeInputs();
    }
    cleanup() {}
  },
}));

vi.mock('../../src/utils/animationSpeed', () => ({
  getAnimationSpeed: () => 1,
  prefersReducedMotion: () => false,
}));

import RiveAvatar, {
  RIVE_STATE_MACHINE,
  RIVE_TRIGGERS,
} from '../../src/components/table/RiveAvatar';
import { __resetRiveManifestCache } from '../../src/utils/riveRigRegistry';

const AVATAR = 'https://smarter.poker/avatars/table/vip_alien@2x.webp';

beforeEach(() => {
  fired.length = 0;
  constructed = 0;
  onLoadCb = null;
  __resetRiveManifestCache();
  /**
   * VITE_RIVE_RIGS gates the runtime OUT OF THE BUILD while no .riv exists
   * (2026-08-21) — Vite inlines the literal, so rollup drops the dynamic
   * import and the artefact loses 182kB raw / 52kB gzipped.
   *
   * These tests exist precisely to prove the integration WITHOUT art, so they
   * turn the flag on. The shipped default is covered explicitly below: with
   * the flag off, nothing loads at all. Both states are pinned, because
   * testing only the flag-on path would leave the behaviour every player
   * actually gets unasserted.
   */
  vi.stubEnv('VITE_RIVE_RIGS', 'on');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Manifest fetch returning 404 — today's real state. */
function stubNoManifest() {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 404 });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** Manifest fetch listing a rig for vip_alien. */
function stubManifest() {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ rigs: { vip_alien: 'vip_alien.riv' } }),
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('RiveAvatar — the unrigged case, which is every avatar today', () => {
  it('never constructs the runtime when there is no manifest', async () => {
    stubNoManifest();
    const onRigActive = vi.fn();
    render(
      <RiveAvatar
        avatarUrl={AVATAR}
        gesture={null}
        isActive={false}
        isFolded={false}
        size={84}
        onRigActive={onRigActive}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(constructed, 'the 4.7MB runtime must not load without a rig').toBe(0);
    expect(onRigActive).not.toHaveBeenCalledWith(true);
  });

  it('asks for the manifest ONCE per session however many seats mount', async () => {
    const fetchSpy = stubNoManifest();
    for (let i = 0; i < 9; i++) {
      render(
        <RiveAvatar avatarUrl={AVATAR} gesture={null} isActive={false} isFolded={false} size={84} />
      );
    }
    await act(async () => {
      await Promise.resolve();
    });
    // Nine seats, one request. A per-seat probe would be nine 404s per table.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores avatars that are not library bust art', async () => {
    const fetchSpy = stubManifest();
    render(
      <RiveAvatar
        avatarUrl="https://cdn.example/storage/uploads/photo.jpg"
        gesture={null}
        isActive={false}
        isFolded={false}
        size={84}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    // An uploaded photo has nothing to rig, so it must not even look.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(constructed).toBe(0);
  });
});

describe('RiveAvatar — the shipped default, with the runtime gated out', () => {
  it('loads nothing at all when VITE_RIVE_RIGS is off, even WITH a manifest', async () => {
    // This is what every player gets today. The flag is what keeps the 4.7MB
    // package out of the build entirely rather than merely out of the
    // critical path, and it must hold even if a manifest somehow answers.
    vi.stubEnv('VITE_RIVE_RIGS', '');
    const fetchSpy = stubManifest();
    const onRigActive = vi.fn();
    render(
      <RiveAvatar
        avatarUrl={AVATAR}
        gesture={null}
        isActive={false}
        isFolded={false}
        size={84}
        onRigActive={onRigActive}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(constructed, 'the gated-out runtime must never be constructed').toBe(0);
    expect(onRigActive).not.toHaveBeenCalledWith(true);
    // It returns before touching the network too: a build with no rig support
    // should not be asking for a manifest it could not use.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('RiveAvatar — when a rig exists', () => {
  it('loads it and reports the rig live so the seat can hide the static art', async () => {
    stubManifest();
    const onRigActive = vi.fn();
    render(
      <RiveAvatar
        avatarUrl={AVATAR}
        gesture={null}
        isActive={false}
        isFolded={false}
        size={84}
        onRigActive={onRigActive}
      />
    );
    await waitFor(() => expect(constructed).toBe(1));
    await act(async () => {
      onLoadCb?.();
    });
    expect(onRigActive).toHaveBeenCalledWith(true);
  });

  it('fires the documented trigger for each gesture', async () => {
    stubManifest();
    const { rerender } = render(
      <RiveAvatar avatarUrl={AVATAR} gesture={null} isActive={false} isFolded={false} size={84} />
    );
    await waitFor(() => expect(constructed).toBe(1));
    await act(async () => {
      onLoadCb?.();
    });

    for (const g of ['push', 'check', 'fold', 'celebrate', 'lose', 'alert'] as const) {
      rerender(
        <RiveAvatar avatarUrl={AVATAR} gesture={g} isActive={false} isFolded={false} size={84} />
      );
      // Back to idle so the next gesture is a genuine change.
      rerender(
        <RiveAvatar avatarUrl={AVATAR} gesture={null} isActive={false} isFolded={false} size={84} />
      );
    }

    // The contract an artist builds against — assert the NAMES, not just that
    // something fired, because the names are the interface.
    expect(fired).toEqual(['Push', 'Check', 'Fold', 'Celebrate', 'Lose', 'Alert']);
    expect(Object.values(RIVE_TRIGGERS)).toEqual([
      'Push',
      'Check',
      'Fold',
      'Celebrate',
      'Lose',
      'Alert',
    ]);
    expect(RIVE_STATE_MACHINE).toBe('SeatState');
  });

  it('drives held conditions as booleans, not triggers', async () => {
    stubManifest();
    const { rerender } = render(
      <RiveAvatar avatarUrl={AVATAR} gesture={null} isActive={false} isFolded={false} size={84} />
    );
    await waitFor(() => expect(constructed).toBe(1));
    await act(async () => {
      onLoadCb?.();
    });
    rerender(<RiveAvatar avatarUrl={AVATAR} gesture={null} isActive isFolded={false} size={84} />);
    expect(boolSet.IsActive).toBe(true);
    rerender(<RiveAvatar avatarUrl={AVATAR} gesture={null} isActive={false} isFolded size={84} />);
    expect(boolSet.IsActive).toBe(false);
    expect(boolSet.IsFolded).toBe(true);
  });
});
