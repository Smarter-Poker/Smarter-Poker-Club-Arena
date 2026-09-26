import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import BonusCompletion from '../../src/components/games/BonusCompletion';
import { BonusReceiptArt } from '../../src/components/games/BonusReceiptArt';
import {
  receiptBucketTint,
  receiptFigure,
  type BonusReceiptGame,
} from '../../src/components/games/bonusReceiptFigure';
import { bucketTint } from '../../src/components/plinko/PlinkoBoard';

const navigate = vi.hoisted(() => vi.fn());
const wheel = vi.hoisted(() => ({ getStateV2: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playWin: vi.fn(), playBigWin: vi.fn() },
}));
vi.mock('../../src/services/DiamondWheelService', () => ({ default: wheel }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const ART_CSS = readFileSync(
  resolve(__dirname, '../../src/components/games/BonusReceiptArt.module.css'),
  'utf8'
);
const reveal = (popup: HTMLElement) =>
  fireEvent.animationEnd(popup.querySelector('[data-motion="keep"]')!);
/** The chip stack is the atlas image; the game art is drawn, never an image. */
const chipStack = (popup: HTMLElement) => popup.querySelector('image[href*="wheel-prize-atlas"]');
const reducedMotion = (reduce: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }))
  );

beforeEach(() => {
  wheel.getStateV2.mockReset().mockResolvedValue({ pending_awards: [] });
  reducedMotion(false);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.documentElement.style.removeProperty('--animation-speed');
});

/**
 * THE RECEIPT WEARS ITS GAME (2026-09-26). A finished bonus game's receipt
 * shows that game's own art and the one number it was about, where every game
 * used to show the same chip stack. Nothing else about the receipt moves: its
 * title, its copy, its two taps and the rule that it never leaves by itself
 * (Dan 2026-09-21, R1) are pinned in BonusCompletion.test.tsx and again here
 * with the art switched on.
 */
describe('the bonus receipt shows the game that produced it', () => {
  const cases: Array<[BonusReceiptGame, number, string, string]> = [
    ['crash', 2.35, '2.35x', 'Booked At'],
    ['crossing', 7, 'Street 7', 'Made It To'],
    ['plinko', 5, '5x', 'Best Bucket'],
    ['mines', 4, '4', 'Gems Found'],
  ];
  for (const [game, figure, label, caption] of cases)
    it(`draws ${game}'s own art with its figure, and no chip stack`, () => {
      render(
        <BonusCompletion
          clubId="shark-club"
          chips={3.5}
          detail="Round Complete."
          game={game}
          figure={figure}
        />
      );
      const popup = screen.getByRole('dialog', { name: '3.50 Chips' });
      const art = popup.querySelector(`[data-receipt-art="${game}"]`);
      expect(art).not.toBeNull();
      expect(art!.querySelector('svg')).not.toBeNull();
      expect(art!.querySelector(`[data-receipt-figure="${game}"]`)).toHaveTextContent(
        `${caption}${label}`
      );
      expect(chipStack(popup)).toBeNull();
      // The art is a picture: the figure it prints is already in the copy line
      // and the title, so assistive technology does not hear it twice.
      expect(art!.closest('[aria-hidden="true"]')).not.toBeNull();
    });

  it('keeps the chip stack when no game is named', () => {
    render(<BonusCompletion clubId="shark-club" chips={1} detail="Done." />);
    const popup = screen.getByRole('dialog', { name: '1.00 Chips' });
    expect(chipStack(popup)).not.toBeNull();
    expect(popup.querySelector('[data-receipt-art]')).toBeNull();
  });

  it('keeps every word, both taps and the no-auto-start rule with the art on', () => {
    vi.useFakeTimers();
    render(
      <BonusCompletion
        clubId="shark-club"
        chips={12345.67}
        detail="All Drops Completed."
        game="plinko"
        figure={20}
      />
    );
    const popup = screen.getByRole('dialog', { name: '12,345.67 Chips' });
    expect(popup).toHaveTextContent('You Won');
    expect(popup).toHaveTextContent('Your Prize Is Booked. All Drops Completed.');
    const back = within(popup).getByRole('button', { name: 'Back To The Wheel' });
    expect(back).toBeDisabled();
    // The art's own entrance ending is not the receipt's: it never arms the plate.
    fireEvent.animationEnd(popup.querySelector('[data-receipt-figure]')!);
    expect(back).toBeDisabled();
    reveal(popup);
    expect(back).toBeEnabled();
    act(() => vi.advanceTimersByTime(120_000));
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(back);
    fireEvent.click(back);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/clubs/shark-club/wheel', { replace: true });
  });

  it('still offers Play Next Bonus Game beside the art', async () => {
    wheel.getStateV2.mockResolvedValue({
      pending_awards: [
        { id: 'next', game: 'crash', base_diamonds: 100, boost_multiplier: 1, entry_diamonds: 100 },
      ],
    });
    render(
      <BonusCompletion
        clubId="shark-club"
        clubUuid="00000000-0000-0000-0000-000000000003"
        chips={2}
        detail="Done."
        game="mines"
        figure={3}
      />
    );
    await act(async () => {});
    const popup = screen.getByRole('dialog', { name: '2.00 Chips' });
    expect(popup).toHaveTextContent('Another Bonus Game Is Waiting For You.');
    reveal(popup);
    fireEvent.click(within(popup).getByRole('button', { name: 'Play Next Bonus Game' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/clubs/shark-club/crash?wheelAward=next', {
      replace: true,
    });
  });

  it('crowns a Crash round booked at the 25.00x max, and only that', () => {
    render(<BonusReceiptArt game="crash" figure={25} />);
    expect(document.querySelector('[data-receipt-art="crash"]')).toHaveAttribute('data-crown');
    expect(screen.getByText('25.00x')).toBeInTheDocument();
    cleanup();
    render(<BonusReceiptArt game="crash" figure={24.99} />);
    expect(document.querySelector('[data-receipt-art="crash"]')).not.toHaveAttribute('data-crown');
    cleanup();
    // A crash at the ceiling is not a booking: no crown on a lost round.
    render(<BonusReceiptArt game="crash" figure={25} dim />);
    expect(document.querySelector('[data-receipt-art="crash"]')).not.toHaveAttribute('data-crown');
  });

  it('crowns a round booked at its own cap, not at a fixed 25x', () => {
    const crowned = () =>
      document.querySelector('[data-receipt-art="crash"]')!.hasAttribute('data-crown');
    // A 20x round booked at its 20x max is the max.
    render(<BonusReceiptArt game="crash" figure={20} cap={20} />);
    expect(crowned()).toBe(true);
    cleanup();
    render(<BonusReceiptArt game="crash" figure={19.99} cap={20} />);
    expect(crowned()).toBe(false);
    cleanup();
    // A higher cap: 25x booked on a 50x round is not its max.
    render(<BonusReceiptArt game="crash" figure={25} cap={50} />);
    expect(crowned()).toBe(false);
    cleanup();
    // The page hands the cap through the receipt.
    render(
      <BonusCompletion
        clubId="shark-club"
        chips={2}
        detail="The Flight Crashed At 31.20x."
        silent
        game="crash"
        figure={20}
        cap={20}
      />
    );
    expect(crowned()).toBe(true);
  });

  it('shows no gem beside "0 Gems Found": a first-pick loss gets one ghost outline', () => {
    render(<BonusReceiptArt game="mines" figure={0} dim />);
    const fan = document.querySelectorAll('[data-receipt-art="mines"] svg g[style*="--fan-angle"]');
    expect(fan).toHaveLength(1);
    expect(fan[0]).toHaveAttribute('data-empty', 'true');
    cleanup();
    render(<BonusReceiptArt game="mines" figure={3} />);
    const three = document.querySelectorAll(
      '[data-receipt-art="mines"] svg g[style*="--fan-angle"]'
    );
    expect(three).toHaveLength(3);
    expect(three[0]).not.toHaveAttribute('data-empty');
  });

  it('dresses a lost round down: the same art, dimmed, the figure out of gold', () => {
    render(
      <BonusCompletion
        clubId="shark-club"
        chips={0.5}
        detail="Hit At Street 3."
        eyebrow="Guarantee Paid"
        silent
        game="crossing"
        figure={3}
      />
    );
    const popup = screen.getByRole('dialog', { name: '0.50 Chips' });
    expect(popup).toHaveTextContent('Guarantee Paid');
    const art = popup.querySelector('[data-receipt-art="crossing"]');
    expect(art).toHaveAttribute('data-dim');
    expect(art).toHaveTextContent('Hit AtStreet 3');
    expect(ART_CSS).toMatch(/\.stage\[data-dim\] \.art \{[^}]*opacity: 0\.5/);
    expect(ART_CSS).toMatch(/\.stage\[data-dim\] \.value \{[^}]*color: #e4e7ec/);
    cleanup();
    render(
      <BonusCompletion clubId="shark-club" chips={5} detail="Done." game="crossing" figure={5} />
    );
    expect(document.querySelector('[data-receipt-art="crossing"]')).not.toHaveAttribute('data-dim');
  });

  it('is static under reduced motion, and animated otherwise', () => {
    render(<BonusReceiptArt game="mines" figure={6} />);
    expect(document.querySelector('[data-receipt-art]')).not.toHaveAttribute('data-reduced');
    cleanup();
    reducedMotion(true);
    render(<BonusReceiptArt game="mines" figure={6} />);
    const art = document.querySelector('[data-receipt-art="mines"]');
    expect(art).toHaveAttribute('data-reduced');
    // Nothing is taken away: every gem of the fan and the count still print.
    expect(art!.querySelectorAll('svg use')).toHaveLength(6);
    expect(art).toHaveTextContent('Gems Found6');
    expect(ART_CSS).toMatch(/\.stage\[data-reduced\] \*[^{]*\{\s*animation: none;/);
    expect(ART_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.stage \*[^{]*\{\s*animation: none;/
    );
  });

  it('scales every entrance by Animation Speed', () => {
    /** Every top-level calc() in a declaration, balanced. */
    const calcs = (text: string) => {
      const found: string[] = [];
      let rest = text;
      for (let at = rest.indexOf('calc('); at >= 0; at = rest.indexOf('calc(')) {
        let depth = 0;
        let end = at + 4;
        do {
          if (rest[end] === '(') depth++;
          else if (rest[end] === ')') depth--;
          end++;
        } while (depth > 0 && end < rest.length);
        found.push(rest.slice(at, end));
        rest = rest.slice(0, at) + rest.slice(end);
      }
      return { found, rest };
    };
    const declarations = ART_CSS.match(/animation:[^;]+;/g) ?? [];
    expect(declarations.length).toBeGreaterThan(10);
    for (const declaration of declarations) {
      if (/animation: none/.test(declaration)) continue;
      const { found, rest } = calcs(declaration);
      // The duration and any delay are both scaled; no bare time is left over.
      expect(found.length, declaration).toBeGreaterThanOrEqual(1);
      for (const time of found) expect(time, declaration).toContain('* var(--animation-speed, 1)');
      expect(rest, declaration).not.toMatch(/\d+m?s\b/);
    }
    document.documentElement.style.setProperty('--animation-speed', '2');
    render(<BonusReceiptArt game="plinko" figure={1.5} />);
    const stage = document.querySelector<HTMLElement>('[data-receipt-art="plinko"]')!;
    expect(stage.style.getPropertyValue('--animation-speed')).toBe('2');
    // Plinko's plate is lit in the bucket's own tint.
    expect(stage.style.getPropertyValue('--receipt-tint')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("lights Plinko's plate in exactly the board's own bucket tint", () => {
    for (let cents = 0; cents <= 3000; cents += 1)
      expect(receiptBucketTint(cents)).toBe(bucketTint(cents));
    expect(receiptBucketTint(Number.NaN)).toBe(bucketTint(Number.NaN));
  });

  it('prints each figure the way its game prints it, and nothing for a missing one', () => {
    expect(receiptFigure('crash', 25)).toBe('25.00x');
    expect(receiptFigure('crash', 1.2)).toBe('1.20x');
    expect(receiptFigure('plinko', 0.08)).toBe('0.08x');
    expect(receiptFigure('plinko', 7.5)).toBe('7.5x');
    expect(receiptFigure('crossing', 12)).toBe('Street 12');
    expect(receiptFigure('mines', 0)).toBe('0');
    expect(receiptFigure('mines', null)).toBeNull();
    expect(receiptFigure('crash', Number.NaN)).toBeNull();
    render(<BonusReceiptArt game="crossing" />);
    const art = document.querySelector('[data-receipt-art="crossing"]');
    expect(art!.querySelector('svg')).not.toBeNull();
    expect(art!.querySelector('[data-receipt-figure]')).toBeNull();
  });
});
