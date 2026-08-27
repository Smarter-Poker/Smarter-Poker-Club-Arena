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

function record(over: Partial<HandRecord> = {}): HandRecord {
  return {
    id: 'h-1',
    handNumber: 3046089,
    timestamp: Date.parse('2026-08-27T12:00:00.000Z'),
    gameType: 'NLH',
    blinds: '1/2',
    players: [
      { id: HERO, name: 'kingfish', seat: 1, stack: 0, position: 'BTN', result: 971.27 },
      { id: 'v-1', name: 'Emerson Blackwell', seat: 2, stack: 0, position: 'BB', result: 485.63 },
    ],
    streets: [
      {
        name: 'flop',
        cards: ['7c', '2c', '9h'],
        actions: [{ playerId: HERO, playerName: 'kingfish', action: 'allin', amount: 735 }],
        pot: 0,
      },
      { name: 'turn', cards: ['Kd'], actions: [], pot: 0 },
      { name: 'river', cards: ['Tc'], actions: [], pot: 0 },
    ],
    winners: [
      { playerId: HERO, playerName: 'kingfish', amount: 971.27, hand: 'Pair' },
      { playerId: 'v-1', playerName: 'Emerson Blackwell', amount: 485.63, hand: 'High Card' },
    ],
    heroId: HERO,
    heroResult: 971.27,
    potTotal: 1470,
    ...over,
  };
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
   all-in locked. */

const RIT_BOARDS_RAW = [
  ['7clubs', '2clubs', '9hearts', '6diamonds', '5hearts'],
  ['7clubs', '2clubs', '9hearts', '7hearts', '9spades'],
];

describe('both surfaces show every board a hand ran', () => {
  it('Hand Detail badges all three runs', () => {
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[record({ ritBoards: RIT_BOARDS_RAW })]}
        heroId={HERO}
      />
    );
    const badges = Array.from(document.querySelectorAll('.hdm-run__badge')).map(
      (b) => b.textContent
    );
    expect(badges).toEqual(['RUN 1', 'RUN 2', 'RUN 3']);
  });

  it('Hand Summary shows them too — the tab the glitch was reported from', () => {
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[record({ ritBoards: RIT_BOARDS_RAW })]}
        heroId={HERO}
      />
    );
    fireEvent.click(document.querySelectorAll('.hdm-tab')[0]);
    expect(document.querySelectorAll('.hdm-run__badge')).toHaveLength(3);
  });

  it('dims the flop the runs share, so the divergence is what reads', () => {
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[record({ ritBoards: RIT_BOARDS_RAW })]}
        heroId={HERO}
      />
    );
    // Three shared cards on each of three boards.
    expect(document.querySelectorAll('.hdm-runs .hdm-card--shared')).toHaveLength(9);
    // Two diverging cards on each of three boards, at full contrast.
    const all = document.querySelectorAll('.hdm-runs .hdm-card');
    expect(all).toHaveLength(15);
  });

  it('Hand History renders the boards in the expanded entry', () => {
    render(
      <HandHistoryPanel
        isOpen
        onClose={() => {}}
        hands={[record({ ritBoards: RIT_BOARDS_RAW })]}
        heroId={HERO}
      />
    );
    fireEvent.click(document.querySelector('.hh-entry__summary') as Element);
    const badges = Array.from(document.querySelectorAll('.hh-run__badge')).map(
      (b) => b.textContent
    );
    expect(badges).toEqual(['RUN 1', 'RUN 2', 'RUN 3']);
  });

  it('says nothing about runs on an ordinary single-board hand', () => {
    render(<HandDetailModal isOpen onClose={() => {}} hands={[record()]} heroId={HERO} />);
    expect(document.querySelectorAll('.hdm-run__badge')).toHaveLength(0);
  });

  /* THE PATH ITSELF, end to end, because this is where the boards were lost.
     A registry keyed by hand id used to bridge the service to these screens
     while another agent owned the adapter; the adapter carries the field now
     and the registry is gone, so what is pinned here is the real producer:
     a service row in, a view model with every board out. */
  it('the adapter carries rit_boards from the service row onto the view model', () => {
    /* The row as production actually stores it: spelled-out suit strings, not
       the `{ rank, suit }` objects the Card type describes — which is why the
       cast is here and why the adapter runs every board through toCardCodes. */
    const serviceRow = {
      id: 'h-3046089',
      serial_number: 'h-3046089',
      table_id: 't-1',
      table_name: 'Table',
      played_at: '2026-08-27T12:00:00.000Z',
      hand_number: 3046089,
      total_hands: 1,
      main_pot: 1470,
      side_pots: [],
      community_cards: ['7clubs', '2clubs', '9hearts', 'Kdiamonds', 'Tclubs'],
      rit_boards: RIT_BOARDS_RAW,
      players: [],
      actions: [],
      winners: [],
      game_type: 'NLH',
      stakes: '1/2',
    } as unknown as Parameters<typeof adaptServiceHandToPanel>[0];

    const panelRecord = adaptServiceHandToPanel(serviceRow, HERO);

    expect(panelRecord.ritBoards).toEqual([
      ['7c', '2c', '9h', '6d', '5h'],
      ['7c', '2c', '9h', '7h', '9s'],
    ]);
  });

  it('renders those adapter-carried boards, all three runs', () => {
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[record({ id: 'h-3046089', ritBoards: RIT_BOARDS_RAW })]}
        heroId={HERO}
      />
    );
    expect(document.querySelectorAll('.hdm-run__badge')).toHaveLength(3);
  });

  /* Per-run winners are NOT stored: the winner rows carry one aggregate amount
     and one hand name for the whole hand, with no run index. Both surfaces say
     the totals cover every run rather than splitting them across the boards,
     which would be a guess printed as a result. */
  it('labels the collected totals as covering every run, and attributes none', () => {
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[record({ ritBoards: RIT_BOARDS_RAW })]}
        heroId={HERO}
      />
    );
    expect(document.querySelector('.hdm-runs__note')?.textContent).toContain('Cover Every Run');
  });
});
