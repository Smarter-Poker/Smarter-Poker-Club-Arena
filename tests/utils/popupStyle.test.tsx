/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POPUP STYLE — Dan's House Rule, Pinned
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20, from a live table: "any and all pop ups need the first
 * letter of every word capitalized, and forbid the use of em bars."
 *
 * The rule lives in the render path (Toast provider -> formatPopupText), so
 * these tests pin two things: the transform itself, and that the Toast layer
 * actually applies it — because a rule enforced at one door is only a rule if
 * every message walks through that door.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatPopupText } from '../../src/utils/popupStyle';
import { ToastProvider, useToast } from '../../src/components/common/Toast';

describe('formatPopupText — Title Case', () => {
  it('capitalizes the first letter of every word', () => {
    expect(formatPopupText('check your connection')).toBe('Check Your Connection');
    expect(formatPopupText('reconnected to the table.')).toBe('Reconnected To The Table.');
  });

  it('preserves interior capitals — acronyms and product names survive', () => {
    expect(formatPopupText('VIP level up')).toBe('VIP Level Up');
    expect(formatPopupText('BBJ hit at NLH table')).toBe('BBJ Hit At NLH Table');
    expect(formatPopupText('your TimeBank is active')).toBe('Your TimeBank Is Active');
  });

  it('capitalizes after brackets and quotes, not just spaces', () => {
    expect(formatPopupText('rebuy failed (insufficient chips)')).toBe(
      'Rebuy Failed (Insufficient Chips)'
    );
    // A quote that OPENS a phrase still starts a word.
    expect(formatPopupText("'quoted phrase' here")).toBe("'Quoted Phrase' Here");
  });

  it('does not break a contraction, which is not a word boundary', () => {
    /**
     * 2026-08-31. The straight apostrophe sat in the word-boundary class next
     * to the quote characters, so every contraction in every toast rendered
     * with a capital in the middle of it. The live one is TablePage's
     * seat-taken error, shown on the felt to a player who clicks a seat they
     * already occupy:
     *
     *     toast.error(`You're already seated at seat ${n}.`)
     *       rendered  "You'Re Already Seated At Seat 3."
     */
    expect(formatPopupText("you're already seated at seat 3")).toBe(
      "You're Already Seated At Seat 3"
    );
    expect(formatPopupText("we can't reach the table")).toBe("We Can't Reach The Table");
    expect(formatPopupText("it's your turn")).toBe("It's Your Turn");
    expect(formatPopupText("that didn't work")).toBe("That Didn't Work");
  });

  it('leaves numbers and punctuation alone', () => {
    expect(formatPopupText('20s granted, 1 use left')).toBe('20s Granted, 1 Use Left');
  });
});

describe('formatPopupText — no em dashes, ever', () => {
  it('turns a clause-break dash into a sentence break', () => {
    expect(formatPopupText('connection lost — the server may fold for you')).toBe(
      'Connection Lost. The Server May Fold For You'
    );
  });

  it('covers the en dash too — it reads the same on a phone', () => {
    expect(formatPopupText('paused – back soon')).toBe('Paused. Back Soon');
  });

  it('an unspaced dash becomes a plain hyphen', () => {
    expect(formatPopupText('auto—fold armed')).toBe('Auto-Fold Armed');
  });

  it('output NEVER contains an em or en dash, whatever comes in', () => {
    for (const nasty of ['a — b — c', '——', 'x–y–z', '— leading', 'trailing —']) {
      const out = formatPopupText(nasty);
      expect(out).not.toMatch(/[—–]/);
    }
  });
});

describe('the Toast layer actually enforces the rule', () => {
  // These used to grep Toast.tsx for the literal string
  // `formatPopupText(message)`. That is a test of how the code is SPELLED, not
  // of what it DOES, and it failed the moment error sanitisation was added
  // between the argument and the transform - a change that strengthened the
  // rule rather than breaking it. A green suite went red over a refactor that
  // was entirely correct, and it blocked the bundle from shipping.
  //
  // Rewritten to assert the behaviour instead: mount the real provider, send a
  // message through the real hook, and read what the player would actually see.
  // Now the test can only fail if the RULE breaks.

  function Harness({ message, type }: { message: string; type: 'info' | 'error' }) {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast.showToast(message, type)}>
        fire
      </button>
    );
  }

  const fire = async (message: string, type: 'info' | 'error' = 'info') => {
    render(
      <ToastProvider>
        <Harness message={message} type={type} />
      </ToastProvider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'fire' }));
  };

  it('title-cases every word a player is shown', async () => {
    await fire('your session expired, please sign in again');
    expect(screen.getByText('Your Session Expired, Please Sign In Again')).toBeTruthy();
  });

  it('never shows an em dash, whatever the caller passed', async () => {
    await fire('connection lost — retrying now');
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region.textContent).not.toMatch(/[—–]/);
  });

  it('applies the rule to errors too, after sanitising them', async () => {
    await fire('could not reach the server', 'error');
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region.textContent).not.toMatch(/[—–]/);
    // whatever survives sanitisation is still Title Cased
    expect(region.textContent).not.toMatch(/\b[a-z]/);
  });

  it('identical popups dedupe instead of stacking', async () => {
    // "connection lost pop ups need to stop" - a retry loop must not build a
    // column of five matching warnings.
    render(
      <ToastProvider>
        <Harness message="connection lost" type="info" />
      </ToastProvider>
    );
    const button = screen.getByRole('button', { name: 'fire' });
    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.click(button);
    expect(screen.getAllByText('Connection Lost')).toHaveLength(1);
  });
});
