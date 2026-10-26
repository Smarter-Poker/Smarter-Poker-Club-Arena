/**
 * LIGHTNING IS STARTING (Dan approved 2026-10-26: "show Lightning Is Starting
 * during the switch"). While a MUST MOVE game converts into Lightning
 * (pending_on) its tables finish the hand in play and deal no other, for 54 s
 * on average; the felt said nothing about why. A physical table of that game
 * now shows "Lightning Is Starting" for the switch, and re-reads its game every
 * 5 s while a switch is possible so the line is on time. Classic games and
 * Lightning rooms never show it.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import LightningStartingNotice from '../../src/components/table/LightningStartingNotice';
import {
  LIGHTNING_STARTING_TEXT,
  lightningStartingOnTable,
} from '../../src/lightning/lightningHand';
import {
  LIGHTNING_LOBBY_REFRESH_MS,
  LIGHTNING_SWITCH_WATCH_REFRESH_MS,
  lightningTableRefreshMs,
} from '../../src/lightning/lightningLobbyFeed';

const ROOT = resolve(__dirname, '../..');
const PAGE = readFileSync(join(ROOT, 'src/pages/TablePage.tsx'), 'utf8');
const state = (clusterMode: string | null, lightningEnabled?: boolean) => ({
  clusterMode,
  liveEligible: null,
  onThreshold: null,
  offThreshold: null,
  ...(lightningEnabled === undefined ? {} : { lightningEnabled }),
});

afterEach(cleanup);

describe('Lightning Is Starting', () => {
  it('says exactly the approved words, Title Case, no dashes', () => {
    expect(LIGHTNING_STARTING_TEXT).toBe('Lightning Is Starting');
    expect(LIGHTNING_STARTING_TEXT).not.toMatch(/[–—-]/);
  });

  it('shows only on a physical table whose game is switching into Lightning', () => {
    expect(lightningStartingOnTable({ lightningRoom: false, clusterMode: 'pending_on' })).toBe(
      true
    );
    for (const mode of [
      'must_move',
      'lightning',
      'pending_off',
      'draining',
      'paused',
      null,
      undefined,
    ])
      expect(lightningStartingOnTable({ lightningRoom: false, clusterMode: mode })).toBe(false);
    expect(lightningStartingOnTable({ lightningRoom: true, clusterMode: 'pending_on' })).toBe(
      false
    );
  });

  it('renders the line as a status, and nothing when not shown', () => {
    const { rerender } = render(<LightningStartingNotice show />);
    expect(screen.getByTestId('lightning-starting').textContent).toBe('Lightning Is Starting');
    expect(screen.getByRole('status')).toBeTruthy();
    rerender(<LightningStartingNotice show={false} />);
    expect(screen.queryByTestId('lightning-starting')).toBeNull();
  });

  it('watches a game that can switch every 5 s, and everything else every 30 s', () => {
    expect(LIGHTNING_SWITCH_WATCH_REFRESH_MS).toBe(5_000);
    expect(LIGHTNING_LOBBY_REFRESH_MS).toBe(30_000);
    expect(lightningTableRefreshMs(state('pending_on'))).toBe(5_000);
    expect(lightningTableRefreshMs(state('must_move', true))).toBe(5_000);
    expect(lightningTableRefreshMs(state('must_move', false))).toBe(30_000);
    expect(lightningTableRefreshMs(state('must_move'))).toBe(30_000);
    expect(lightningTableRefreshMs(state('lightning', true))).toBe(30_000);
    expect(lightningTableRefreshMs(null)).toBe(30_000);
  });

  it('the table wires the line into the felt band and the 5 s watch into its game read', () => {
    expect(PAGE).toContain('refreshMs: anchorLightningRefreshMs,');
    expect(PAGE).toMatch(
      /const lightningStartingHere = lightningStartingOnTable\(\{\s*lightningRoom: lightningRoom !== null,\s*clusterMode: tableGameLightningState\?\.clusterMode,/
    );
    expect(PAGE).toMatch(
      /\) : lightningStartingHere \? \(\s*<div className="lightning-felt-notices" data-testid="lightning-felt-notices">\s*<LightningStartingNotice show \/>/
    );
  });
});
