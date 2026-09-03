/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PENDING SETTLEMENT — the deferred-cashout estimate says it is one
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 3 (2026-08-22). A mid-hand leave defers the cashout to settlement:
 * TableService.leaveTable returns `deferred: true` with `chipsReturned: 0`,
 * and TablePage estimates P/L from the live stack at the moment of leaving
 * (the #243 fix for the fake "LOSS -1,000"). That estimate is usually right,
 * give or take the hand in flight — but it is still an estimate, and the
 * Session Complete card used to present it exactly like a settled number.
 *
 * The payload now carries `plPending` and the card annotates the money line
 * "Pending Settlement". These pin both directions: the annotation appears
 * for a deferred payload, and never for a settled one — an annotation that
 * shows up on every card would train players to ignore it.
 *
 * Phase 4 adds the reconciliation: while the pending card is open the host
 * polls for the settlement's wallet_transactions cashout row (written by the
 * engine's processLeavePending via atomic_credit_wallet_and_log) and swaps
 * the estimate for `amount - totalBuyIn`. The third test pins the swap; the
 * fourth pins that a payload WITHOUT pendingCashout never queries at all.
 */

/* ROUTER (2026-08-28). The host reads useNavigate: the `session_summary`
   house ad inside this card carries its own destination, and a promotion you
   cannot click is worse than none. In the app this component is mounted
   outside <Routes> but inside <BrowserRouter> (App.tsx, beside ConfirmHost),
   so a bare render() was testing a context that does not exist in production.
   MemoryRouter restores it without pulling in a real history. */
import React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* The ledger read the host performs at settlement. One row queue: a test
   pushes the rows it wants found; an empty queue answers `null` (row not
   landed yet), which is also what the non-polling tests should never even
   ask for — `fromCalls` counts the asks. */
const ledgerRows: Array<{ amount: number; created_at: string } | null> = [];
let fromCalls = 0;
vi.mock('../../src/lib/supabase', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: ledgerRows.shift() ?? null, error: null }),
  };
  return {
    supabase: {
      from: () => {
        fromCalls += 1;
        return builder;
      },
    },
  };
});

import SessionSummaryHost from '../../src/components/session/SessionSummaryHost';
import {
  publishSessionSummary,
  clearSessionSummary,
  type SessionSummaryPayload,
} from '../../src/services/pendingSessionSummary';

const cashPayload = (over: Partial<SessionSummaryPayload> = {}): SessionSummaryPayload => ({
  duration: 3600,
  handsPlayed: 42,
  handsWon: 7,
  totalRebuys: 0,
  profitLoss: 157,
  biggestPot: 900,
  peakStack: 2100,
  tableName: 'NLH 5/10',
  vpipPercent: 24,
  totalBuyIn: 1000,
  sessionStart: Date.now() - 3_600_000,
  sessionEnd: Date.now(),
  ...over,
});

describe('SessionSummaryHost — Pending Settlement annotation', () => {
  beforeEach(() => {
    clearSessionSummary();
    ledgerRows.length = 0;
    fromCalls = 0;
  });
  afterEach(() => {
    cleanup();
    clearSessionSummary();
  });

  it('annotates a deferred cashout as Pending Settlement', () => {
    render(
      <MemoryRouter>
        <SessionSummaryHost />
      </MemoryRouter>
    );
    act(() => publishSessionSummary(cashPayload({ plPending: true })));
    expect(screen.getByText('Pending Settlement')).toBeTruthy();
  });

  it('does not annotate a settled cashout', () => {
    render(
      <MemoryRouter>
        <SessionSummaryHost />
      </MemoryRouter>
    );
    act(() => publishSessionSummary(cashPayload()));
    expect(screen.queryByText('Pending Settlement')).toBeNull();
    /* And the card itself did render — the absence above must never pass
       because nothing rendered at all. */
    expect(screen.getByText('Session Complete')).toBeTruthy();
    /* A payload with no pendingCashout must never touch the ledger. */
    expect(fromCalls).toBe(0);
  });

  it('swaps the estimate for the settled figure when the cashout row lands', async () => {
    /* Settlement: 1,400 cashed out against 1,000 bought in = +400, where the
       estimate said +157. The first (immediate) poll finds the row. */
    ledgerRows.push({ amount: 1400, created_at: new Date().toISOString() });
    render(
      <MemoryRouter>
        <SessionSummaryHost />
      </MemoryRouter>
    );
    await act(async () => {
      publishSessionSummary(
        cashPayload({
          plPending: true,
          pendingCashout: { tableId: 't-1', userId: 'u-hero', sinceMs: Date.now() },
        })
      );
      /* Let the immediate check's microtasks drain. */
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('Pending Settlement')).toBeNull();
    expect(screen.getByText('Session Complete')).toBeTruthy();
    expect(fromCalls).toBeGreaterThan(0);
  });

  it('keeps the annotation while the row has not landed', async () => {
    /* Queue stays empty — every poll answers null. */
    render(
      <MemoryRouter>
        <SessionSummaryHost />
      </MemoryRouter>
    );
    await act(async () => {
      publishSessionSummary(
        cashPayload({
          plPending: true,
          pendingCashout: { tableId: 't-1', userId: 'u-hero', sinceMs: Date.now() },
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Pending Settlement')).toBeTruthy();
    expect(fromCalls).toBeGreaterThan(0);
  });
});
