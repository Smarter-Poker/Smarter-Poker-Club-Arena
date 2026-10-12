/**
 * LAW: a legal document's date moves with its words.
 *
 * 2026-09-29, found while walking the app for store review: the Terms page
 * and the in-app acceptance modal both said January 2026, three weeks after
 * the chip wording in both changed (2026-09-08), and the Privacy Policy said
 * January 29 after a "Third-Party Services" section was added (2026-09-08)
 * and Sentry was taken out of it (2026-09-16). A date on a legal document
 * that does not move with the text is a false statement, and nothing noticed.
 *
 * Each document's RENDERED words (so a Prettier re-wrap is not a change) are
 * fingerprinted here beside the date they carry. Change the words and this
 * fails until the date in src/components/legal/legalDates.ts is moved to the
 * day the change ships and the fingerprint below is re-recorded, in the same
 * commit. Wording is Dan's (CLAUDE.md 10.9); the date is just the truth
 * about when it last changed.
 */
import { createHash } from 'node:crypto';
import type { ReactElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import TermsOfServicePage from '../src/pages/legal/TermsOfServicePage';
import PrivacyPolicyPage from '../src/pages/legal/PrivacyPolicyPage';
import TOSAcceptanceModal from '../src/components/legal/TOSAcceptanceModal';
import { PRIVACY_LAST_UPDATED, TERMS_LAST_UPDATED } from '../src/components/legal/legalDates';

/** Re-record in the same commit as the words, with the date they shipped. */
const RECORDED = {
  terms: { date: 'September 8, 2026', words: '5e16a8b238dea596' },
  acceptanceModal: { date: 'September 8, 2026', words: '7b0d81c16ee4cc6c' },
  privacy: { date: 'September 16, 2026', words: '9995740553602c75' },
};

function fingerprint(ui: ReactElement, selector: string, date: string): string {
  const { container } = render(<MemoryRouter>{ui}</MemoryRouter>);
  const nodes = [...container.querySelectorAll(selector)];
  if (nodes.length === 0) throw new Error(`nothing matched ${selector}`);
  const text = nodes
    .map((n) => n.textContent || '')
    .join(' ')
    .split(date)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const HOW =
  'The words changed and the date did not (or the other way round). Move the date in ' +
  'src/components/legal/legalDates.ts to the day this ships, then re-record RECORDED ' +
  'in this file - both in the same commit.';

describe('legal dates move with the words', () => {
  afterEach(() => cleanup());

  it('the Terms of Service page', () => {
    const words = fingerprint(<TermsOfServicePage />, 'article section', TERMS_LAST_UPDATED);
    expect({ date: TERMS_LAST_UPDATED, words }, HOW).toEqual(RECORDED.terms);
  });

  it('the acceptance modal, which summarises the Terms and carries their date', () => {
    const words = fingerprint(
      <TOSAcceptanceModal onAccept={async () => undefined} />,
      '.tosc__terms',
      TERMS_LAST_UPDATED
    );
    expect({ date: TERMS_LAST_UPDATED, words }, HOW).toEqual(RECORDED.acceptanceModal);
  });

  it('the Privacy Policy page', () => {
    const words = fingerprint(<PrivacyPolicyPage />, 'article section', PRIVACY_LAST_UPDATED);
    expect({ date: PRIVACY_LAST_UPDATED, words }, HOW).toEqual(RECORDED.privacy);
  });
});
