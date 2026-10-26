/**
 * LAW: players are told up front that AI opponents may be seated.
 *
 * Dan, 2026-10-25: "ADD ONE LINE TO THE SIGN UP DISCLOSURES". Horses play
 * under ordinary player names and nothing at the table says which seats they
 * hold (CLAUDE.md 10.5). What keeps that honest is one sentence every player
 * is shown before they play: on the native sign-up form, on the Terms of
 * Service page, and in the acceptance modal that gates Club Arena.
 *
 * The sentence lives once, in src/components/legal/aiOpponentsDisclosure.ts.
 * This fails if any surface stops rendering it.
 */
import { readFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import TermsOfServicePage from '../src/pages/legal/TermsOfServicePage';
import TOSAcceptanceModal from '../src/components/legal/TOSAcceptanceModal';
import { AI_OPPONENTS_DISCLOSURE } from '../src/components/legal/aiOpponentsDisclosure';

const flat = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

describe('AI opponents are disclosed before anyone plays', () => {
  afterEach(() => cleanup());

  it('the sentence names AI opponents and says seats are not identified', () => {
    expect(AI_OPPONENTS_DISCLOSURE).toMatch(/AI Opponents/);
    expect(AI_OPPONENTS_DISCLOSURE).toMatch(/Do Not Say Which Seats/);
  });

  it('the Terms of Service page shows it', () => {
    const { container } = render(
      <MemoryRouter>
        <TermsOfServicePage />
      </MemoryRouter>
    );
    expect(flat(container.textContent)).toContain(AI_OPPONENTS_DISCLOSURE);
  });

  it('the acceptance modal every player passes shows it', () => {
    const { container } = render(
      <MemoryRouter>
        <TOSAcceptanceModal onAccept={async () => undefined} />
      </MemoryRouter>
    );
    expect(flat(container.querySelector('.tosc__terms')?.textContent)).toContain(
      AI_OPPONENTS_DISCLOSURE
    );
  });

  it('the sign-up form renders it inside the sign-up mode', () => {
    const src = readFileSync('src/pages/AuthPage.tsx', 'utf8');
    const signup = src.slice(
      src.indexOf("{mode === 'signup' && ("),
      src.indexOf("{mode === 'reset' && (")
    );
    expect(signup).toContain('{AI_OPPONENTS_DISCLOSURE}');
    expect(src).toContain("from '../components/legal/aiOpponentsDisclosure'");
  });
});
