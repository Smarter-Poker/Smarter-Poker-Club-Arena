/**
 * A FAILURE THE PLAYER CANNOT SEE IS THE WORST KIND.
 *
 * Every path in this file used to fail SILENTLY — a `console.warn`, a
 * `console.error`, or an empty catch — in a place where the consequence lands
 * on a real person's money or their seat, and where nobody would ever learn it
 * had happened. They are grouped here because they are one defect wearing five
 * costumes, not five defects.
 *
 * The worst of them by far is the first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* Comments quote the deleted code at length so the next reader knows what was
   here. Strip them, or the tombstone is mistaken for the corpse. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
const read = (p: string) => strip(readFileSync(resolve(__dirname, '../..', p), 'utf8'));
const raw = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

const CARD_IMAGE = read('src/components/table/CardImage.tsx');
const CARD_CSS = raw('src/components/table/CardImage.css');
const TABLE_PAGE = read('src/pages/TablePage.tsx');

describe('the felt never shows a card that is not the card', () => {
  it('an unreadable card is NOT substituted with the ace of spades', () => {
    /* The whole point. `getCardImagePath` used to do:
         const safeSuit = suitName || 'spades';
         const safeRank = rankName || 'a';
       which rendered a real, plausible, PLAYABLE card for input it could not
       parse. A player cannot tell that apart from a genuine deal, and they
       will put money in behind it. Every other failure in this client
       degrades to something visibly broken; this one degraded to something
       that looks correct. */
    expect(
      CARD_IMAGE,
      'the ace-of-spades fallback is back — a wrong card is worse than no card'
    ).not.toMatch(/safeSuit|safeRank/);
    expect(CARD_IMAGE).not.toMatch(/suitName \|\| 'spades'/);
    expect(CARD_IMAGE).not.toMatch(/rankName \|\| 'a'/);
  });

  it('returns null instead, so the caller cannot accidentally render a card', () => {
    // A sentinel STRING would have been rendered by any existing call site.
    // The type change is what makes the old behaviour unreachable.
    expect(CARD_IMAGE).toMatch(/getCardImagePath\([^)]*\):\s*string \| null/);
    expect(CARD_IMAGE).toMatch(/return null;/);
  });

  it('reports the unreadable card rather than only warning', () => {
    expect(CARD_IMAGE).toMatch(/reportError\(/);
    expect(CARD_IMAGE).toMatch(/CardImage\.unreadable_card/);
  });

  it('renders no <img> at all for an unreadable card', () => {
    /* An <img> with an empty src makes the browser re-request the page URL as
       an image, and leaves a slot that can flash something card-shaped. */
    expect(CARD_IMAGE).toMatch(/if \(unreadable\)/);
    expect(CARD_IMAGE).toMatch(/card-image__unreadable/);
  });

  it('the unreadable tile carries no rank and no suit', () => {
    /* The rank and the suit are precisely what we failed to read. Printing
       them would be inventing the same information the fallback existed to
       stop inventing. */
    const tile = CARD_IMAGE.slice(
      CARD_IMAGE.indexOf('if (unreadable)'),
      CARD_IMAGE.indexOf('return (', CARD_IMAGE.indexOf('if (unreadable)'))
    );
    expect(tile).not.toMatch(/card\.rank/);
    expect(tile).not.toMatch(/SUIT_CHAR/);
    expect(tile).not.toMatch(/SUIT_COLOR/);
  });

  it('is styled so it cannot be mistaken for a card', () => {
    const rule = CARD_CSS.slice(CARD_CSS.indexOf('.card-image__unreadable'));
    expect(rule, 'no dashed border — it will read as a real card').toMatch(/border:[^;]*dashed/);
    expect(rule, 'a white face is what a card looks like').not.toMatch(/background:\s*#fff/);
  });
});

describe('a waitlisted player is never stranded behind the horses silently', () => {
  it('the horse-yield failure is reported, not swallowed', () => {
    /* Was: `catch (err) { // Non-critical — silently ignore }`. It is the only
       implementation of "give a horse's seat back when a human is queued", so
       a throw here means a real player waits forever while horses play. */
    expect(TABLE_PAGE).not.toMatch(/Non-critical — silently ignore/);
    expect(TABLE_PAGE).toMatch(/TablePage\.horse_yield_failed/);
  });

  it('reports once per mount, not four times a minute', () => {
    // The yield runs every 15s on every seated client.
    expect(TABLE_PAGE).toMatch(/horseYieldReportedRef/);
    expect(TABLE_PAGE).toMatch(/horseYieldReportedRef\.current = true;/);
  });

  it('stays non-fatal — a failed yield must never take the felt down', () => {
    expect(TABLE_PAGE).not.toMatch(/throw err;\s*\}\s*\}, 15000/);
  });
});

describe('a slow socket does not mean an empty table', () => {
  it('the seat prefetch retries instead of giving up on first rejection', () => {
    /* Was `.catch(console.warn)`. This fetch is what paints the seats in the
       3-5s before the websocket is up, so one rejection showed an EMPTY felt
       with no retry — on exactly the slow-socket table this prefetch exists
       to serve. */
    expect(TABLE_PAGE).toMatch(/PREFETCH_ATTEMPTS/);
    expect(TABLE_PAGE).toMatch(/TablePage\.seat_prefetch_failed/);
  });

  it('the timer is cleared on unmount', () => {
    // A retry firing into an unmounted table is a setState-after-unmount.
    expect(TABLE_PAGE).toMatch(/if \(timer\) clearTimeout\(timer\);/);
  });

  it('does not toast the player about a redundant prefetch', () => {
    /* The engine snapshot supersedes this data the moment it lands. A player
       whose socket connects normally must never see an error about it. */
    const block = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf('const PREFETCH_ATTEMPTS'),
      TABLE_PAGE.indexOf('}, [tableId, userId]);')
    );
    expect(block).not.toMatch(/toast\.(error|warn)/);
  });
});

describe('a jackpot that paid always announces', () => {
  /* THE PINS MOVED WITH THE MECHANISM (BBJ phase 3.1, 2026-09-06). This
     guarded TablePage's `bbj_pools` hit_count subscription. The announcement
     now comes from the `bbj_winners` INSERT - one row per jackpot, written
     inside the payout transaction - so the same three guarantees are pinned
     against lib/bbjHitFeed, which is where they now live. The guarantee is
     unchanged and it is the reason this describe exists: the row only exists
     because the money moved, so nothing downstream may decide not to
     announce; it may only decide how much it knows. */
  const HIT_FEED = read('src/lib/bbjHitFeed.ts');

  it('announces even when the detail lookup fails', () => {
    /* The old code marked the hit seen before the try and then swallowed the
       error, so a single failed fetch meant the biggest event on the platform
       passed in total silence, permanently, for everyone at the table. */
    expect(HIT_FEED).toMatch(/if \(hit\) \{/);
    expect(HIT_FEED).toMatch(/row\.winner_display_name/);
    expect(HIT_FEED).toMatch(/Number\(row\.total_payout\)/);
  });

  it('retries the detail lookup before falling back', () => {
    // The award and the ledger row can be read between under replica lag.
    expect(HIT_FEED).toMatch(/attempt <= 2/);
    expect(HIT_FEED).toMatch(/ENRICH_RETRY_MS/);
  });

  it('reports the degraded announcement', () => {
    expect(HIT_FEED).toMatch(/bbjHitFeed\.enrich_failed/);
    expect(HIT_FEED).toMatch(/bbjHitFeed\.hit_without_table/);
  });
});

describe('a busted player always leaves with their result', () => {
  it('the elimination check retries', () => {
    /* The row is written by the engine at the moment of elimination, so this
       read can genuinely race it. */
    expect(TABLE_PAGE).toMatch(/ELIM_ATTEMPTS/);
    expect(TABLE_PAGE).not.toMatch(/Tournament elimination check error/);
  });

  it('routes the player to the lobby even when every attempt fails', () => {
    /* The alternative is a player parked on a table they are no longer in,
       with no result screen and no sight of a prize they may have won. */
    expect(TABLE_PAGE).toMatch(/tp\?\.status === 'eliminated' \|\| elimErr/);
    expect(TABLE_PAGE).toMatch(/TablePage\.tournament_elimination_check_failed/);
  });

  it('a failed rebuy check is reported as the lost purchase it is', () => {
    expect(TABLE_PAGE).not.toMatch(/Tournament rebuy check error/);
    expect(TABLE_PAGE).toMatch(/TablePage\.tournament_rebuy_check_failed/);
  });
});
