import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HAND_COMPLETION as H } from '../../src/config/handCompletionSpec';
const source = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
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
    expect(H.SHOWDOWN_READ_BASE_MS).toBe(1400 + 1500);
    expect(H.SHOWDOWN_READ_MAX_MS).toBe(2200 + 1500);
    expect(H.RIT_RESULT_RUN_MS).toBe(2600 + 1500);
  });
});
