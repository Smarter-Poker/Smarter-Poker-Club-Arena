/**
 * THE WAITLIST BANNER SHOWS A PLACE IN LINE, NEVER A HELD SEAT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-12: "there is not point to have a pop up with 'This seat is
 * reserved click to take it.' That's already assumed and doesn't need a pop
 * up." The banner used to turn a held seat into a "Seat Held, Tap To Take It"
 * card on top of the very buy-in sheet the hold had opened. It now shows a
 * real place in line and nothing else; a hold removes the card.
 *
 * (This file pinned the hold card's internal clock until today. Dan's newer
 * ruling removes the card, so the pins move to the new rule in the same
 * commit, per CLAUDE.md section 5 rule 8.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The real bus, exactly as globalWaitlistSdkTransport.test.tsx uses it: the
// shared setup replaces it with a stub, and its store imports are inert here.
vi.mock('../../src/stores/useSettingsStore', () => ({ useSettingsStore: {} }));
vi.mock('../../src/stores/useUserStore', () => ({ useUserStore: {} }));
vi.mock('../../src/services/RealtimeChannelService', () => ({ realtimeChannelService: {} }));
vi.unmock('../../src/core/MasterBus');
import { masterBus } from '../../src/core/MasterBus';
import WaitlistBanner from '../../src/components/common/WaitlistBanner';

const code = (p: string) =>
  readFileSync(resolve(__dirname, '../..', p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

function mount() {
  return render(React.createElement(MemoryRouter, null, React.createElement(WaitlistBanner)));
}

describe('the waitlist banner (Dan 2026-10-12)', () => {
  beforeEach(() => masterBus.reset());
  afterEach(() => {
    cleanup();
    masterBus.reset();
  });

  it('shows a real place in line', async () => {
    mount();
    act(() => {
      masterBus.emit('WAITLIST_POSITION_CHANGED', {
        tableId: 't1',
        position: 3,
        tableName: 'NLH 2/5 Classic Feeder',
      } as any);
    });
    expect(await screen.findByText('#3')).toBeTruthy();
    expect(screen.getByText('NLH 2/5 Classic Feeder')).toBeTruthy();
  });

  it('removes the card when the seat is held, and never shows "Seat Held"', async () => {
    mount();
    act(() => {
      masterBus.emit('WAITLIST_POSITION_CHANGED', {
        tableId: 't1',
        position: 1,
        tableName: 'NLH 2/5 Classic Feeder',
      } as any);
    });
    expect(await screen.findByText('#1')).toBeTruthy();
    act(() => {
      masterBus.emit('WAITLIST_SEAT_OFFERED', {
        tableId: 't1',
        tableName: 'NLH 2/5 Classic Feeder',
        holdExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      masterBus.emit('WAITLIST_POSITION_CHANGED', {
        tableId: 't1',
        position: 0,
        tableName: 'NLH 2/5 Classic Feeder',
      } as any);
    });
    expect(screen.queryByTestId('waitlist-banner-card')).toBeNull();
    expect(screen.queryByText(/Seat Held/)).toBeNull();
    expect(screen.queryByText(/Tap To Take It/)).toBeNull();
  });

  it('a hold on a table the player was not queued at shows nothing at all', () => {
    mount();
    act(() => {
      masterBus.emit('WAITLIST_SEAT_OFFERED', {
        tableId: 't9',
        tableName: '',
        holdExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    expect(screen.queryByTestId('waitlist-banner-stack')).toBeNull();
  });

  it('a position of 0 is never rendered as "#0 In Line"', () => {
    mount();
    act(() => {
      masterBus.emit('WAITLIST_POSITION_CHANGED', {
        tableId: 't2',
        position: 0,
        tableName: 'X',
      } as any);
    });
    expect(screen.queryByText('#0')).toBeNull();
  });
});

describe('no hold popup survives anywhere in the waitlist UI', () => {
  it('the banner carries no held-seat card or wording', () => {
    const banner = code('src/components/common/WaitlistBanner.tsx');
    expect(banner).not.toMatch(/Seat Held/);
    expect(banner).not.toMatch(/Tap To Take It/);
    expect(banner).not.toMatch(/holdExpiresAt/);
  });

  it('the listener raises no "A Seat Just Opened For You" toast', () => {
    const listener = code('src/components/common/GlobalWaitlistListener.tsx');
    expect(listener).not.toMatch(/A Seat Just Opened For You/);
    expect(listener).not.toMatch(/toast\./);
  });
});
