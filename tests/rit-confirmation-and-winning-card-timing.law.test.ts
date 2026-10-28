import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { winningCardAwardResetAt } from '../src/utils/winningCardTiming';
afterEach(() => vi.useRealTimers());
import { HAND_COMPLETION as H, handCompletionHoldMs } from '../src/config/handCompletionSpec';
const source = readFileSync(resolve(__dirname, '../src/pages/TablePage.tsx'), 'utf8');
const handler = (event: string, next: string) =>
  source.slice(
    source.indexOf(`if (eventType === '${event}')`),
    source.indexOf(`if (eventType === '${next}')`)
  );
describe('run confirmation and winning card timing', () => {
  it('keeps intermediate accepts off the felt', () => {
    const update = handler('rit_response_update', 'rit_all_accepted');
    expect(update).toContain('setRitAcceptedIds');
    expect(update).not.toContain('showRitFeltBanner(');
  });
  // October 28 owner correction supersedes the former 1500ms confirmation.
  it.each([
    ['rit_all_accepted', 'rit_mandatory'],
    ['rit_mandatory', 'rit_single_run'],
    ['rit_single_run', 'rit_result'],
  ])('removes %s from the felt immediately', (event, next) => {
    const body = handler(event, next);
    expect(body).not.toContain('showRitFeltBanner(');
    expect(body).toMatch(/clearRitWaitingStrip\(\)|resetRitPanelState\(\)/);
  });
  it('has no outcome timer or delayed confirmation to survive the decision', () => {
    expect(source).not.toContain('ritConfirmationShownRef');
    expect(source).not.toContain('ritFeltBannerTimerRef');
  });
  it('adds exactly 1500ms to ordinary and capped showdown reads and each RIT result', () => {
    expect(H.SHOWDOWN_READ_BASE_MS).toBe(1400);
    expect(H.SHOWDOWN_READ_MAX_MS).toBe(2200);
    expect(H.WINNING_CARDS_EXTRA_MS).toBe(1500);
    const push = H.BETS_SWEEP_MS + H.POT_PUSH_MS + H.MUCK_MS + H.POST_PUSH_PAUSE_MS;
    for (const hands of [2, 3, 9]) {
      const oldRead = Math.min(2200, 1400 + Math.max(0, hands - 2) * 350);
      expect(handCompletionHoldMs({ wentToShowdown: true, showdownHands: hands })).toBe(
        oldRead + push + 1500
      );
    }
    expect(H.RIT_RESULT_RUN_MS).toBe(2600 + 1500);
  });
});

it('the actual waiting-strip clear is immediate and never restores itself', () => {
  vi.useFakeTimers();
  const start = source.indexOf('  const clearRitWaitingStrip = useCallback(');
  const end = source.indexOf('  const showRitFeltBanner = useCallback(', start);
  expect(start).toBeGreaterThan(0);
  let state: string | null = 'Waiting For Players.';
  const clear = new Function(
    'useCallback',
    'setRitFeltBanner',
    'RIT_WAITING_BANNER_RENDERED',
    'RIT_WAITING_BANNER',
    ts.transpile(source.slice(start, end) + '; return clearRitWaitingStrip;')
  )(
    (fn: unknown) => fn,
    (update: (previous: string | null) => string | null) => {
      state = update(state);
    },
    state,
    state
  );
  clear();
  expect(state).toBeNull();
  vi.advanceTimersByTime(25000);
  expect(state).toBeNull();
});

it.each([1, 2])(
  'the full extra winning-card read survives a longer pot animation at speed %s',
  (speed) => {
    for (const baseHold of [3500, 5500]) {
      for (const awardEndAt of [1000, 3600, 4300, 9000]) {
        const before = Math.max(baseHold * speed, awardEndAt + 400);
        const after = Math.max(
          (baseHold + 1500) * speed,
          winningCardAwardResetAt(awardEndAt, { wentToShowdown: true, ritRuns: 1, speed })
        );
        expect(after - before).toBe(1500 * speed);
      }
    }
    expect(source).toContain(
      'const wantResetAt = winningCardAwardResetAt(potAwardAnimEndAtRef.current,'
    );
  }
);
it('keeps fold timing and the already-extended RIT result timeline unchanged', () => {
  expect(winningCardAwardResetAt(4300, { wentToShowdown: false, ritRuns: 1, speed: 1 })).toBe(4700);
  for (const ritRuns of [2, 3]) {
    expect(winningCardAwardResetAt(4300, { wentToShowdown: true, ritRuns, speed: 1 })).toBe(4700);
  }
});
