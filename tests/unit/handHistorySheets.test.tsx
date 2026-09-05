/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE TWO HAND-HISTORY SHEETS (Dan 2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three reports, one file:
 *
 *   "the previous hand table when opened should only be 3/4 page, and there
 *    needs to be the padding on the top like there is on all Club Arena pages.
 *    You can't click the X. Also when it's 3/4 page you should be able to click
 *    off to close as well."
 *
 *   "it even glitched in the previous hands, hand summary."  (run it twice)
 *
 * The X was unreachable because .hdm-header paid NO top inset while the panel
 * ran full height from top: 0 under viewport-fit=cover. Clicking off did
 * nothing because the overlay's onClick was already there and the panel covered
 * 100% of it, so the gesture was wired to a target that did not exist. And
 * production hand #3046089 ran THREE boards, all three stored, with neither
 * surface carrying a single reference to rit_boards.
 *
 * The CSS assertions read the stylesheet the way tests/unit/bottomBarReserve.ts
 * does, because the failure is a missing RULE, not a missing pixel. The rest
 * renders the real components: "there is a backdrop element" is not the claim,
 * "tapping it closes the sheet" is.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HandHistoryPanel, { type HandRecord } from '@/components/table/HandHistoryPanel';
import { HandDetailModal } from '@/components/table/HandDetailModal';
import { adaptServiceHandToPanel } from '@/lib/handHistoryAdapter';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const HDM_CSS = read('src/components/table/HandDetailModal.css');
const HH_CSS = read('src/components/table/HandHistoryPanel.css');

const SHEETS: Array<[string, string, string]> = [
  ['HandDetailModal.css', HDM_CSS, '.hdm-header'],
  ['HandHistoryPanel.css', HH_CSS, '.hh-panel__header'],
];

afterEach(cleanup);

/** The body of the first `@media <query>` block, brace-matched. */
function mediaBlock(css: string, query: string): string {
  const at = css.indexOf(`@media ${query}`);
  if (at < 0) return '';
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE PADDING THAT MAKES THE X REACHABLE
   ═══════════════════════════════════════════════════════════════════════════ */

describe('both sheets pay the top inset, in both places it can vanish', () => {
  it('gives the header the phone-breakpoint inset', () => {
    for (const [name, css, header] of SHEETS) {
      const phone = mediaBlock(css, '(max-width: 640px)');
      expect(phone, `${name} has no 640px block at all`).not.toBe('');
      expect(phone, `${name} does not pad ${header} at the phone breakpoint`).toMatch(
        new RegExp(
          `\\${header}\\s*\\{[^}]*padding-top:\\s*calc\\(12px \\+ env\\(safe-area-inset-top, 0px\\)\\)`
        )
      );
    }
  });

  /* env(safe-area-inset-top) resolves to 0 in the installed app on some
     devices, which silently deletes the rule above. The floor is the only
     thing standing between that and the close button under the clock — see
     GlobalHeader.module.css for the measurement. */
  it('floors it in the installed app, where env() can resolve to 0', () => {
    for (const [name, css, header] of SHEETS) {
      const standalone = mediaBlock(css, '(display-mode: standalone), (display-mode: fullscreen)');
      expect(standalone, `${name} has no standalone block`).not.toBe('');
      expect(standalone, `${name} does not floor ${header} in app mode`).toMatch(
        new RegExp(
          `\\${header}\\s*\\{[^}]*padding-top:\\s*calc\\(12px \\+ max\\(env\\(safe-area-inset-top, 0px\\), 24px\\)\\)`
        )
      );
    }
  });

  /* Equal specificity, so source order decides — and a `padding` SHORTHAND
     anywhere below would reset padding-top and undo the floor. This is the
     exact regression GlobalHeader.module.css records having shipped once. */
  it('keeps the app-mode floor last, after every rule that pads that header', () => {
    for (const [name, css, header] of SHEETS) {
      const floorAt = css.indexOf('(display-mode: standalone)');
      const after = css.slice(floorAt + 1);
      const laterPadding = after
        .split('\n')
        .filter((l, i, all) => {
          if (!/padding(-top)?\s*:/.test(l)) return false;
          // Only lines that belong to a rule for this header.
          const before = all.slice(0, i).join('\n');
          const lastSelector = before.lastIndexOf(header);
          const lastBrace = before.lastIndexOf('}');
          return lastSelector > lastBrace;
        })
        .filter((l) => !/max\(env\(safe-area-inset-top/.test(l));
      expect(laterPadding, `${name} pads ${header} after the app-mode floor`).toEqual([]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE SHEET IS THREE QUARTERS, SO THERE IS A BACKDROP TO TAP
   ═══════════════════════════════════════════════════════════════════════════ */

describe('at 375px the sheet leaves a backdrop instead of covering the overlay', () => {
  it('Hand Detail anchors a three-quarter-height sheet to the bottom', () => {
    const phone = mediaBlock(HDM_CSS, '(max-width: 640px)');
    expect(phone).toContain('align-items: flex-end');
    expect(phone).toMatch(/height:\s*75dvh/);
    // `height: 100%` from top:0 is the shape that left no backdrop at all.
    expect(phone).not.toMatch(/height:\s*100%/);
  });

  it('Hand History stops being a 340px right-hand drawer on a phone', () => {
    const phone = mediaBlock(HH_CSS, '(max-width: 640px)');
    expect(phone).toMatch(/\.hh-panel\s*\{[^}]*bottom:\s*0/);
    expect(phone).toMatch(/height:\s*75dvh/);
    expect(phone).toMatch(/top:\s*auto/);
  });

  it('Hand History has a backdrop element under the panel', () => {
    expect(HH_CSS).toMatch(/\.hh-backdrop\s*\{[^}]*position:\s*fixed/);
    expect(HH_CSS).toMatch(/\.hh-backdrop\s*\{[^}]*inset:\s*0/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   TAPPING OFF THE SHEET CLOSES IT — BEHAVIOUR, NOT MARKUP
   ═══════════════════════════════════════════════════════════════════════════ */

const HERO = 'hero-1';
const VILLAIN = 'v-1';

/* The row as production stores it, through the adapter - so what these tests
   render is the same `replay` model the live panel and modal render. Hand
   #3046089: an all-in on the flop, run three times. */
const RIT_BOARDS_RAW = [
  ['7clubs', '2clubs', '9hearts', '6diamonds', '5hearts'],
  ['7clubs', '2clubs', '9hearts', '7hearts', '9spades'],
];

function serviceRow(over: Record<string, unknown> = {}) {
  return {
    id: 'h-1',
    serial_number: '3046089',
    table_id: 't-1',
    table_name: 'Midway 1/2',
    played_at: '2026-08-27T12:00:00.000Z',
    hand_number: 3046089,
    total_hands: 0,
    main_pot: 1470,
    side_pots: [],
    community_cards: ['7clubs', '2clubs', '9hearts', 'Kdiamonds', 'Tclubs'],
    players: [
      {
        seat: 1,
        user_id: HERO,
        username: 'kingfish',
        avatar_url: null,
        position: 'BTN',
        hole_cards: [
          { rank: 'A', suit: 'spades' },
          { rank: 'A', suit: 'hearts' },
        ],
        result: 235,
        is_winner: true,
        showdown_reveal: { reveal_order: 1, mucked: false, hand_name: 'Pair' },
      },
      {
        seat: 2,
        user_id: VILLAIN,
        username: 'Emerson Blackwell',
        avatar_url: null,
        position: 'BB',
        hole_cards: [
          { rank: 'K', suit: 'clubs' },
          { rank: 'Q', suit: 'clubs' },
        ],
        result: -235,
        is_winner: false,
        showdown_reveal: { reveal_order: 2, mucked: false, hand_name: 'High Card' },
      },
    ],
    actions: [
      { player_id: HERO, action: 'raise', amount: 6, street: 'preflop', timestamp: 1 },
      { player_id: VILLAIN, action: 'call', amount: 4, street: 'preflop', timestamp: 2 },
      { player_id: VILLAIN, action: 'check', amount: 0, street: 'flop', timestamp: 3 },
      { player_id: HERO, action: 'all_in', amount: 735, street: 'flop', timestamp: 4 },
      { player_id: VILLAIN, action: 'call', amount: 735, street: 'flop', timestamp: 5 },
    ],
    winners: [{ user_id: HERO, amount: 1470, pot_index: 0, hand_name: 'Pair' }],
    winners_by_board: [],
    rake: 0,
    bbj_fee: 0,
    game_type: 'NLH',
    stakes: '1/2',
    ...over,
  } as unknown as Parameters<typeof adaptServiceHandToPanel>[0];
}

function record(over: Record<string, unknown> = {}): HandRecord {
  return adaptServiceHandToPanel(serviceRow(over), HERO);
}

describe('the backdrop closes the sheet, and the sheet itself does not', () => {
  it('Hand Detail closes when the exposed overlay is tapped', () => {
    const onClose = vi.fn();
    render(<HandDetailModal isOpen onClose={onClose} hands={[record()]} heroId={HERO} />);
    fireEvent.click(document.querySelector('.hdm-overlay') as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Hand Detail does NOT close when the sheet body is tapped', () => {
    const onClose = vi.fn();
    render(<HandDetailModal isOpen onClose={onClose} hands={[record()]} heroId={HERO} />);
    fireEvent.click(document.querySelector('.hdm-panel') as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Hand History closes when its backdrop is tapped', () => {
    const onClose = vi.fn();
    render(<HandHistoryPanel isOpen onClose={onClose} hands={[record()]} heroId={HERO} />);
    const backdrop = document.querySelector('.hh-backdrop');
    expect(backdrop, 'Hand History renders no backdrop at all').toBeTruthy();
    fireEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Hand History closes on Escape, from its own key handler', () => {
    const onClose = vi.fn();
    render(<HandHistoryPanel isOpen onClose={onClose} hands={[record()]} heroId={HERO} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Hand History unbinds Escape when it is closed', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <HandHistoryPanel isOpen onClose={onClose} hands={[record()]} heroId={HERO} />
    );
    rerender(
      <HandHistoryPanel isOpen={false} onClose={onClose} hands={[record()]} heroId={HERO} />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   RUN IT TWICE — hand #3046089, three boards, one of them shown
   ═══════════════════════════════════════════════════════════════════════════

   The real row, as stored:
     community_cards  7c 2c 9h Kd Tc
     rit_boards       [7c 2c 9h 6d 5h], [7c 2c 9h 7h 9s]
   All three share the flop; they diverge from the turn, which is where the
   all-in locked. Both surfaces render the ONE model built from that row. */

describe('both surfaces show every board a hand ran', () => {
  const rit = () => record({ rit_boards: RIT_BOARDS_RAW });

  it('Hand Summary badges all three runs', () => {
    render(<HandDetailModal isOpen onClose={() => {}} hands={[rit()]} heroId={HERO} />);
    const badges = Array.from(document.querySelectorAll('.hdm-board__badge')).map(
      (b) => b.textContent
    );
    expect(badges).toEqual(['Run 1', 'Run 2', 'Run 3']);
  });

  it('Hand Detail draws the extra runs on the streets where they diverge', () => {
    render(<HandDetailModal isOpen onClose={() => {}} hands={[rit()]} heroId={HERO} />);
    fireEvent.click(document.querySelectorAll('.hdm-tab')[1]);
    const labels = Array.from(document.querySelectorAll('.hdv__street-run-label')).map(
      (b) => b.textContent
    );
    // Every street with cards on it (flop, turn, river, showdown) carries
    // Run 2 and Run 3 beside board one; preflop has no board to show.
    expect(labels.filter((l) => l === 'Run 2').length).toBeGreaterThanOrEqual(3);
    expect(labels.filter((l) => l === 'Run 3').length).toBeGreaterThanOrEqual(3);
    expect(labels.filter((l) => l === 'Run 2').length).toBe(
      labels.filter((l) => l === 'Run 3').length
    );
  });

  it('dims the flop the runs share, so the divergence is what reads', () => {
    render(<HandDetailModal isOpen onClose={() => {}} hands={[rit()]} heroId={HERO} />);
    // Three shared cards on each of three boards.
    expect(document.querySelectorAll('.hdm-boards .hdm-card--shared')).toHaveLength(9);
    // Fifteen cards in all.
    expect(document.querySelectorAll('.hdm-boards .card-image')).toHaveLength(15);
  });

  it('Hand History renders the boards in the expanded entry', () => {
    render(<HandHistoryPanel isOpen onClose={() => {}} hands={[rit()]} heroId={HERO} />);
    fireEvent.click(document.querySelector('.hh-entry__summary') as Element);
    const labels = Array.from(document.querySelectorAll('.hh-entry .hdv__street-run-label')).map(
      (b) => b.textContent
    );
    expect(labels).toContain('Run 2');
    expect(labels).toContain('Run 3');
    // And the summary row says so before it is even opened.
    expect(document.querySelector('.hh-entry__tag')?.textContent).toBe('Run 3x');
  });

  it('says nothing about runs on an ordinary single-board hand', () => {
    render(<HandDetailModal isOpen onClose={() => {}} hands={[record()]} heroId={HERO} />);
    expect(document.querySelectorAll('.hdm-board__badge')).toHaveLength(0);
    expect(document.querySelector('.hdm-section-head')?.textContent).toContain('Board');
  });

  it('the adapter carries rit_boards from the service row onto the view model', () => {
    const panelRecord = rit();
    expect(panelRecord.ritBoards).toEqual([
      ['7c', '2c', '9h', '6d', '5h'],
      ['7c', '2c', '9h', '7h', '9s'],
    ]);
    // ...and the model carries them ONCE each, in run order.
    expect(panelRecord.replay.boards).toHaveLength(3);
  });

  /* THE SAME BOARD IS NEVER LISTED TWICE. The engine writes a run both as the
     `rit_boards` column and as a `rit_board_N:` pseudo-action for old readers;
     the model used to concatenate the two, so every run appeared twice. */
  it('a run recorded in the column AND as a pseudo-action is one run', () => {
    const both = record({
      rit_boards: RIT_BOARDS_RAW,
      actions: [
        ...(serviceRow().actions as unknown[]),
        {
          player_id: 'system',
          action: 'rit_board_2:7clubs,2clubs,9hearts,6diamonds,5hearts',
          amount: 0,
          street: 'river',
          timestamp: 9,
        },
      ],
    });
    expect(both.replay.boards).toHaveLength(3);
  });

  /* Per-run winners come from `winners_by_board`. Without them the record
     cannot say who took which run, and does not: the share column is blank on
     runs 2 and 3 rather than the whole-hand net repeated three times. */
  it('with no per-run record, the extra runs carry no invented share', () => {
    render(<HandDetailModal isOpen onClose={() => {}} hands={[rit()]} heroId={HERO} />);
    const nets = Array.from(document.querySelectorAll('.hdm-sd__net'));
    // Two players x three boards.
    expect(nets).toHaveLength(6);
    expect(nets.filter((n) => n.classList.contains('is-blank'))).toHaveLength(4);
  });

  it('with the per-run record, each run names its own winner and share', () => {
    const attributed = record({
      rit_boards: RIT_BOARDS_RAW,
      winners: [
        { user_id: HERO, amount: 980, pot_index: 0, hand_name: 'Pair' },
        { user_id: VILLAIN, amount: 490, pot_index: 0, hand_name: 'Two Pair' },
      ],
      winners_by_board: [
        { board: 1, user_id: HERO, amount: 490, hand_name: 'Pair' },
        { board: 2, user_id: HERO, amount: 490, hand_name: 'Pair' },
        { board: 3, user_id: VILLAIN, amount: 490, hand_name: 'Two Pair' },
      ],
    });
    render(<HandDetailModal isOpen onClose={() => {}} hands={[attributed]} heroId={HERO} />);
    const winners = Array.from(document.querySelectorAll('.hdm-sd.is-winner .hdm-sd__pot')).map(
      (n) => n.textContent
    );
    expect(winners).toEqual(['Board 1', 'Board 2', 'Board 3']);
    const names = Array.from(document.querySelectorAll('.hdm-sd.is-winner .hdm-sd__handname')).map(
      (n) => n.textContent
    );
    expect(names).toEqual(['Pair', 'Pair', 'Two Pair']);
  });
});
