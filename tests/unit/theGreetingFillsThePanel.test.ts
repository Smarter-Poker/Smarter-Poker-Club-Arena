/**
 * THE PANEL IS FULL-SCREEN; THE GREETING WAS NOT.
 *
 * Dan, 2026-09-03: "YOU CLICK ON ANY CLUB LOBBY AND THE PAGE GOES BLACK AFTER
 * LOADING FOR A SPLIT SECOND."
 *
 * Measured live on the Midway Union lobby before the fix:
 *
 *   .club-entry-message-modal   1195px   (full-screen, as designed)
 *   .modal-content              1192px
 *   .club-entry-message          338px   <- collapsed to its own content
 *   .club-entry-message__club    y=132   <- top quarter, not centred
 *
 * `.club-entry-message` asks for `flex: 1`, but the shared Modal wraps its
 * children in `.modal-content`, so the `display: flex` on the panel was not
 * being applied to the greeting's parent. ~850px of empty dark panel sat over
 * the lobby, which is what "the page goes black" looks like.
 *
 * After, same page: wrapper 1144px, body 952px, club name at y=535.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(process.cwd(), 'src/components/club/ClubEntryMessage.css'), 'utf8');

/** The declarations of one rule, whitespace-normalised. */
function ruleBody(selector: string): string {
  const i = CSS.indexOf(selector + ' {');
  expect(i, `${selector} must exist`).toBeGreaterThan(-1);
  return CSS.slice(i + selector.length, CSS.indexOf('}', i)).replace(/\s+/g, ' ');
}

describe('the greeting fills the panel it was given', () => {
  it('the intervening .modal-content is a stretching flex column', () => {
    // The one link that was missing. Without it `flex: 1` on the greeting has
    // no flex parent and collapses to content height.
    const body = ruleBody('.club-entry-message-modal.modal-fullscreen > .modal-content');
    expect(body).toContain('display: flex');
    expect(body).toContain('flex: 1');
    expect(body).toContain('flex-direction: column');
  });

  it('and may shrink, so a long message cannot push past the viewport', () => {
    // A flex child defaults to min-height:auto and refuses to shrink below its
    // content — which would defeat the panel's own 100dvh cap and the
    // wrapper's overflow-y: auto.
    expect(ruleBody('.club-entry-message-modal.modal-fullscreen > .modal-content')).toContain(
      'min-height: 0'
    );
  });

  it('the panel is still the full-screen greeting Dan asked for', () => {
    // The fix is the flex chain, NOT a retreat to a small dialog.
    const panel = ruleBody('.club-entry-message-modal.modal-fullscreen');
    expect(panel).toContain('100dvh');
    expect(panel).toContain('display: flex');
  });

  it('the body still centres what it holds', () => {
    // This was never wrong; it just never had a height to centre within.
    expect(ruleBody('.club-entry-message__body')).toContain('justify-content: center');
  });

  it('the wrapper still scrolls its own overflow', () => {
    expect(ruleBody('.club-entry-message')).toContain('overflow-y: auto');
  });
});
