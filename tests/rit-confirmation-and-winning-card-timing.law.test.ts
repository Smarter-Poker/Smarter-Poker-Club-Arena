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
  it.each([
    ['rit_all_accepted', 'rit_mandatory'],
    ['rit_mandatory', 'rit_single_run'],
  ])('confirms %s once for 1500ms', (event, next) => {
    const body = handler(event, next);
    expect(body).toContain('if (!ritConfirmationShownRef.current)');
    expect(body).toContain('ritConfirmationShownRef.current = true');
    expect(body).toMatch(/showRitFeltBanner\([\s\S]*?,\s*1500\s*\)/);
  });
  it('resets the once-per-hand guard', () => {
    expect(source).toContain('ritConfirmationShownRef.current = false');
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

it('the actual banner timer clears at 1500ms and never restores the waiting strip', () => {
  vi.useFakeTimers();
  const start = source.indexOf('  const showRitFeltBanner = useCallback(');
  const end = source.indexOf('  }, []);', start) + '  }, []);'.length;
  expect(start).toBeGreaterThan(0);
  const code = ts.transpile(source.slice(start, end) + '; return showRitFeltBanner;', {
    target: ts.ScriptTarget.ES2022,
  });
  let state: string | null = null;
  const ref = { current: null };
  const show = new Function(
    'useCallback',
    'ritFeltBannerTimerRef',
    'setRitFeltBanner',
    'formatPopupText',
    'setTimeout',
    'clearTimeout',
    code
  )(
    (fn: unknown) => fn,
    ref,
    (value: string | null) => {
      state = value;
    },
    (text: string) => text,
    setTimeout,
    clearTimeout
  );
  show('Waiting For Players To Run It Multiple Times.');
  show('Players Have Accepted Running It 3 Times.', 1500);
  vi.advanceTimersByTime(1499);
  expect(state).toBe('Players Have Accepted Running It 3 Times.');
  vi.advanceTimersByTime(1);
  expect(state).toBeNull();
  expect(ref.current).toBeNull();
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
