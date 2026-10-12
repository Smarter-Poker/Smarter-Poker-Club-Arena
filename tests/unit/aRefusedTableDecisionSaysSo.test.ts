/**
 * A REFUSED TABLE DECISION SAYS SO (launch audit 2026-10-05). Run It Twice
 * accept and chooser answers were drawn as made before the engine answered
 * and left that way on a refusal; a refused Show Hand did nothing visible.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', '..', 'src', 'pages', 'TablePage.tsx'), 'utf8');

function after(marker: string, needle: string): boolean {
  const at = src.indexOf(marker);
  return at > -1 && src.indexOf(needle, at) > at && src.indexOf(needle, at) - at < 900;
}

describe('a refused table decision says so', () => {
  it('a refused accept takes its check back and tells the player', () => {
    const marker = "respondToRIT(tableId, { response: 'accept' });";
    expect(after(marker, 'setRitHeroAccepted(false);')).toBe(true);
    expect(after(marker, 'prev.filter((id) => id !== userId)')).toBe(true);
    expect(after(marker, "toast?.error('Your Answer Was Not Received. Accept Again.');")).toBe(
      true
    );
  });

  it('a refused chooser decision gives the choice back and tells the player', () => {
    const marker = "reportError(result.error, 'TablePage.Chooser_decide_failed');";
    expect(after(marker, 'setRitChooserHasDecided(false);')).toBe(true);
    expect(
      after(marker, "toast?.error('Your Run It Choice Was Not Received. Choose Again.');")
    ).toBe(true);
  });

  it('a refused Show Hand tells the player', () => {
    expect(
      after(
        "reportError(result.error, 'TablePage.Failed');",
        "toast?.error('Your Hand Could Not Be Shown');"
      )
    ).toBe(true);
  });
});
