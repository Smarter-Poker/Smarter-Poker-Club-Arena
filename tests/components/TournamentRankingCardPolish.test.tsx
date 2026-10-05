/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE RESULT CARD, FINISHED (Dan 2026-10-05: "FULLY BUILD, FIX AND ENHANCE ALL
 *  OF THESE")
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * One pin per defect closed in that pass, each asserting what the player sees:
 *
 *   - the player's number is labelled "ID:", never a bare "1" under a "#1";
 *   - the X is the card's one close control (the foot word is retired);
 *   - a satellite qualifier gets a full head and medal, not an empty pill
 *     slot and a "-";
 *   - a long event name is cut at a word and marked, not shrunk to dust;
 *   - the payout counts up WITHOUT the running number ever being card text;
 *   - Share hands over the painted image when the platform can take it, and
 *     saves it through the estate's one file door when there is no sheet.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TournamentRankingCard from '../../src/components/tournament/TournamentRankingCard';
import type { TournamentResult } from '../../src/services/pendingSessionSummary';
import { CHIP_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: { username: 'KingFish', player_number: '7', avatar_url: null },
              error: null,
            }),
        }),
      }),
    }),
  },
}));

vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => ({ userId: 'u1' }) }));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

const painted = vi.hoisted(() => ({ blob: null as Blob | null }));
vi.mock('../../src/components/tournament/rankingShareImage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/components/tournament/rankingShareImage')>();
  return { ...actual, paintRankingShareImage: vi.fn(async () => painted.blob) };
});

const door = vi.hoisted(() => ({ downloadBlob: vi.fn(() => true) }));
vi.mock('../../src/utils/downloadCsv', () => ({ downloadBlob: door.downloadBlob }));

function result(over: Partial<TournamentResult> = {}): TournamentResult {
  return {
    name: 'NLH Heads-Up 1',
    finishPlace: 1,
    entrants: 2,
    prize: 1.9,
    bountyWinnings: 0,
    knockouts: 0,
    rebuys: 0,
    addOns: 0,
    isSpin: false,
    ...over,
  };
}

function renderCard(r: TournamentResult = result()) {
  return render(
    <TournamentRankingCard result={r} onDismiss={vi.fn()} unitCents={CHIP_UNIT_CENTS} />
  );
}

const nav = navigator as Navigator & Record<string, unknown>;

afterEach(() => {
  delete nav.share;
  delete nav.canShare;
  painted.blob = null;
  door.downloadBlob.mockClear();
});

describe('the result card, finished', () => {
  it('labels the player number as an ID, so it never reads as a second place', async () => {
    renderCard();
    expect(await screen.findByText('ID: 7')).toBeInTheDocument();
    expect(screen.getByText('KingFish')).toBeInTheDocument();
  });

  it('has exactly one close control, the X in the head', () => {
    renderCard();
    const closes = screen.getAllByRole('button', { name: /close/i });
    expect(closes).toHaveLength(1);
    expect(closes[0].closest('.sc__head')).not.toBeNull();
    expect(document.querySelector('.trc2__close, .trc2__exit')).toBeNull();
  });

  it('gives a satellite qualifier a named pill, a won seat and a cup, never a "-"', () => {
    renderCard(
      result({
        finishPlace: null,
        satelliteQualification: { targetId: 't', deliveryKind: 'ticket', amount: 50 },
      })
    );
    expect(screen.getByText('Ticket')).toBeInTheDocument();
    expect(screen.getByText('Ticket Won')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Satellite Trophy' })).toBeInTheDocument();
    expect(document.querySelector('.trc2__medal-place')).toBeNull();
    expect(document.querySelector('.trc2__medal.trc2__medal--gold')).not.toBeNull();
  });

  it('cuts a long event name at a word and marks the cut', () => {
    renderCard(result({ name: 'Sunday Deepstack Bounty Heads Up Turbo Hyper Edition' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Sunday Deepstack Bounty Heads Up…');
    expect(dialog.textContent).not.toContain('Hyper Edition');
  });

  it('counts the payout without the running figure ever being card text', () => {
    renderCard(result({ prize: 4200 }));
    const value = document.querySelector('.trc2__reward-value')!;
    // The real figure is in the DOM from the first frame...
    expect(value.querySelector('.trc2__reward-final')!.textContent).toBe('4,200');
    // ...and the count, while it runs, is printed by the stylesheet only.
    const count = value.querySelector('.trc2__reward-count');
    if (count) {
      expect(count.textContent).toBe('');
      expect(count.getAttribute('aria-hidden')).toBe('true');
    }
    expect(value.textContent).toBe('4,200');
  });

  it('shares the painted image through the system sheet when it can carry files', async () => {
    painted.blob = new Blob(['png'], { type: 'image/png' });
    const share = vi.fn(async () => {});
    nav.share = share;
    nav.canShare = vi.fn((d: ShareData) => Array.isArray(d.files) && d.files.length === 1);
    renderCard();
    // Let the pre-paint land before the tap, as it does in a browser.
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const data = share.mock.calls[0][0] as ShareData;
    expect(data.files?.[0]?.type).toBe('image/png');
    expect(data.text).toMatch(/I finished 1st in NLH Heads-Up 1 on Smarter\.Poker for 1\.90\./);
    expect(data.text).toContain('/hub/club-arena');
  });

  it('saves the image through the one file door when there is no share sheet', async () => {
    painted.blob = new Blob(['png'], { type: 'image/png' });
    renderCard();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(door.downloadBlob).toHaveBeenCalledWith('smarter-poker-result.png', painted.blob)
    );
    expect(await screen.findByText('Image Saved')).toBeInTheDocument();
  });
});
