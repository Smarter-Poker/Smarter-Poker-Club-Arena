/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SUFFIX IS NOT A WORD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-31. The casing sweep that closed the attribute/template/i18n gaps
 * also cased two things that are not words, and both shipped:
 *
 *   "3 GameS Are Open In This Club"   (club home page, three times on screen)
 *   "View Alice'S Profile"            (five labels, incl. two aria-labels)
 *
 * Both are the SAME mistake in two costumes: a fragment that finishes the word
 * before it got treated as a word of its own.
 *
 *   `Game{n === 1 ? ' is' : 's are'} Open In`  ->  the 's' completes "Game"
 *   `${username}'s Profile`                    ->  the 's' completes the name
 *
 * The second is the worse of the two: `aria-label` is what a screen reader
 * announces, and it read "Alice apostrophe S Profile".
 *
 * check-title-case's own header already warned about exactly this - "that
 * particular one is the plural suffix of the word before it, and capitalising
 * it renders GameS". The guard existed and could not see a suffix with a
 * sentence attached, nor one separated from its word by an interpolation.
 */

import { describe, it, expect } from 'vitest';
import { titleCaseText, titleCaseBranch } from '../../scripts/ci/check-title-case.mjs';

describe('the possessive is a suffix', () => {
  it('never capitalises a lone s after an apostrophe', () => {
    // This is the shape a template span has: the name is in the hole before it.
    expect(titleCaseText("'s Profile")).toBe("'s Profile");
    expect(titleCaseText("'s Hand History")).toBe("'s Hand History");
    expect(titleCaseText('’s Tables')).toBe('’s Tables');
  });

  it('still cases the words around it', () => {
    expect(titleCaseText("'s hand history")).toBe("'s Hand History");
  });

  it('leaves a possessive alone when its word is attached', () => {
    // "dan's" is one word to the tokenizer, so only the D is cased. The bug
    // only ever appeared when the apostrophe STARTED the span, which is what a
    // template hole does: `${name}` + `'s Profile`.
    expect(titleCaseText("dan's table")).toBe("Dan's Table");
  });
});

describe('a conditional branch may open with a plural suffix', () => {
  it('protects the suffix and cases the rest', () => {
    // `Game{n === 1 ? ' is' : 's are'} Open In This Club`
    expect(titleCaseBranch('s are')).toBe('s Are');
    expect(titleCaseBranch(' is')).toBe(' Is');
  });

  it('does not protect a real word that happens to be short', () => {
    expect(titleCaseBranch('go now')).toBe('Go Now');
    expect(titleCaseBranch('all in')).toBe('All In');
  });

  it('protects a possessive branch too', () => {
    expect(titleCaseBranch("'s turn")).toBe("'s Turn");
  });
});

describe('the copy that actually shipped', () => {
  it('renders the club home page count correctly', () => {
    const rendered = `Game${titleCaseBranch('s are')} Open In This Club`;
    expect(rendered).toBe('Games Are Open In This Club');
    expect(rendered).not.toContain('GameS');
  });

  it('renders a profile label a screen reader can pronounce', () => {
    const rendered = `View Alice${titleCaseText("'s Profile")}`;
    expect(rendered).toBe("View Alice's Profile");
    expect(rendered).not.toContain("'S");
  });
});
