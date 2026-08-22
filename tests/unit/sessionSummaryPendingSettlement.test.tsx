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
 */

import React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

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
  beforeEach(() => clearSessionSummary());
  afterEach(() => {
    cleanup();
    clearSessionSummary();
  });

  it('annotates a deferred cashout as Pending Settlement', () => {
    render(<SessionSummaryHost />);
    act(() => publishSessionSummary(cashPayload({ plPending: true })));
    expect(screen.getByText('Pending Settlement')).toBeTruthy();
  });

  it('does not annotate a settled cashout', () => {
    render(<SessionSummaryHost />);
    act(() => publishSessionSummary(cashPayload()));
    expect(screen.queryByText('Pending Settlement')).toBeNull();
    /* And the card itself did render — the absence above must never pass
       because nothing rendered at all. */
    expect(screen.getByText('Session Complete')).toBeTruthy();
  });
});
