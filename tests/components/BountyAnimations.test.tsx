/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BOUNTY ANIMATIONS — knockout + mystery chest (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan asked for two things and both have a failure mode worth pinning:
 *
 *  KNOCKOUT — must never block input. It fires while you may be IN a hand, so
 *  an overlay that swallowed a click on the fold button would be worse than no
 *  animation at all.
 *
 *  MYSTERY CHEST — must be openable ONLY by the winner, must reach every other
 *  player in real time, and must never strand the table if the winner walks
 *  away or the broadcast is dropped.
 */

// Case-insensitive text matchers on purpose: Dan's house rule Title Cases every
// word on every forward-facing page (scripts/ci/check-title-case.mjs), so pinning
// the casing of copy makes these fail on a styling rule rather than on the
// behaviour they exist to protect. The words are the contract.
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SeatKnockoutLayer, {
  type SeatKnockoutHit,
  SKO_DURATION_MS,
  SKO_IMPACT_AT_MS,
} from '../../src/components/table/SeatKnockout';
import MysteryBountyChest, { getTier } from '../../src/components/tournament/MysteryBountyChest';

// canvas-confetti is stubbed globally via the alias in vitest.config.ts
// (the import is dynamic, so a per-file vi.mock never intercepted it).

vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    playBountyCollected: vi.fn(),
    playKnockoutFlurry: vi.fn(),
    playMysteryChestLand: vi.fn(),
    playMysteryChestOpen: vi.fn(),
    playMysteryChestExplosion: vi.fn(),
    playMysteryBountyReveal: vi.fn(),
    isEnabled: () => true,
  },
  haptic: { light: vi.fn(), medium: vi.fn(), strong: vi.fn(), jackpot: vi.fn() },
}));

import { soundService } from '../../src/services/SoundService';

/** Nine seats' worth of the hero-rotated percentages TablePage renders from. */
const SEATS = Array.from({ length: 9 }, (_, i) => ({ x: 10 + i * 9, y: 20 + i * 7 }));

const hit = (over: Partial<SeatKnockoutHit> = {}): SeatKnockoutHit => ({
  id: 'bob',
  seatIndex: 3,
  eliminatedName: 'Bob',
  ...over,
});

const CHEST = {
  knockerUserId: 'user-winner',
  knockerName: 'Alice',
  eliminatedName: 'Bob',
  amount: 50000,
  avgBounty: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Fake requestAnimationFrame too: both components drive their count-up with
  // rAF, and without this advanceTimersByTime never moves the number.
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('SeatKnockout — the glove, the star, the stamp', () => {
  const layer = (hits: SeatKnockoutHit[], props: Record<string, unknown> = {}) =>
    render(<SeatKnockoutLayer hits={hits} seatPositions={SEATS} onDone={() => {}} {...props} />);

  it('fires ONE cue for the whole flurry, on the audio clock, scaled by speed', () => {
    // REWRITTEN 2026-08-29 with the mechanism. playKnockoutSwing +
    // playKnockoutImpact were built for a single glove that crept in and
    // struck once; there are three landings now and they are 140ms apart, so
    // scheduling them with setTimeout would put their spacing at the mercy of
    // a main thread that is busy re-laying-out a table which just lost a seat.
    // One cue, and SoundService schedules the beats on the AudioContext clock.
    layer([hit()]);
    expect(soundService.playKnockoutFlurry).toHaveBeenCalledTimes(1);
    const arg = (soundService.playKnockoutFlurry as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as {
      isHero: boolean;
      speed: number;
      punchesAtMs: readonly number[];
      stampAtMs: number;
    };
    expect(arg.punchesAtMs, 'three landings, the last one IS the impact beat').toEqual([
      180,
      320,
      SKO_IMPACT_AT_MS,
    ]);
    expect(arg.stampAtMs).toBe(930);
    expect(arg.speed, 'the audio stretches with the CSS, not against it').toBeGreaterThan(0);
  });

  it("tells the cue when it is the viewer's own knockout", () => {
    layer([hit({ isHero: true })]);
    expect(
      (soundService.playKnockoutFlurry as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0][0]
    ).toMatchObject({ isHero: true });
  });

  it('NEVER blocks input — it fires while you may be in a hand', () => {
    // Asserted on the stylesheet contract rather than computed style, because
    // jsdom does not apply the imported CSS. The class must exist and the rule
    // must say pointer-events: none — checked in the CSS test below.
    const { container } = layer([hit()]);
    expect(container.querySelector('.sko-layer')).toBeTruthy();
  });

  it('draws every piece of the reference: glove, star, sparks, stamp', () => {
    // REWRITTEN 2026-08-29 alongside the rebuild it pins, per the animation
    // law: "if you deliberately replace a mechanism with a better one, move
    // the pin to the new mechanism IN THE SAME COMMIT."
    //   - the burst was 12 `.sko__ray` divs at exact 30-degree increments and
    //     is now ONE irregular `<path>`; twelve even spokes cannot be
    //     irregular, and it cost twelve elements per knockout;
    //   - the stamp was a text node in 'Arial Black', which Android does not
    //     have, so the one element here carrying INFORMATION rather than drama
    //     was the one rendering differently per device. It is glyph paths now;
    //   - and the hand-drawn glove became Dan's two branded renders, which
    //     retired the ghost and the speed streak with it.
    const { container } = layer([hit()]);
    /* TWO GLOVES, and they are Dan's RENDERS, not a drawing of them. The
       hand-drawn SVG glove and the ghost/streak that faked its motion blur are
       all retired: with two real gloves alternating there is nothing left for
       a silhouette copy to add, and the flurry carries the speed by itself. */
    const gloves = container.querySelectorAll('img.sko__glove');
    expect(gloves, 'a left glove and a right glove').toHaveLength(2);
    expect((gloves[0] as HTMLImageElement).src, 'right glove render').toContain(
      'images/knockout/glove-right.webp'
    );
    expect((gloves[1] as HTMLImageElement).src, 'left glove render').toContain(
      'images/knockout/glove-left.webp'
    );
    expect(container.querySelector('.sko__glove svg'), 'the drawn glove is gone').toBeNull();
    expect(container.querySelector('.sko__ghost'), 'and its motion-blur ghost').toBeNull();
    expect(container.querySelector('.sko__streak'), 'and its speed streak').toBeNull();
    expect(container.querySelectorAll('.sko__ray'), 'the ray divs are retired').toHaveLength(0);
    /* ONE element flashes a warm burst at BOTH jab landings. */
    expect(container.querySelector('.sko__hit path'), 'each jab throws a burst').toBeTruthy();
    expect(container.querySelector('.sko__star-main path'), 'the star is one path').toBeTruthy();
    expect(container.querySelector('.sko__star-alt path'), 'and a second for depth').toBeTruthy();
    expect(container.querySelector('.sko__shards path'), 'impact throws debris').toBeTruthy();
    expect(container.querySelector('.sko__core')).toBeTruthy();
    expect(container.querySelector('.sko__ring'), 'the impact cracks').toBeTruthy();
    expect(container.querySelector('.sko__light'), 'the felt is lit').toBeTruthy();
    // 14-18 sparks with varied size and lifetime; eight identical dots read as
    // a pattern rather than as an explosion.
    const sparks = container.querySelectorAll('.sko__ember');
    expect(sparks.length).toBeGreaterThanOrEqual(14);
    expect(
      new Set([...sparks].map((s) => (s as HTMLElement).style.getPropertyValue('--sko-ember-size')))
        .size
    ).toBeGreaterThan(4);
    expect(container.querySelector('.sko__stamp svg'), 'KO is glyph paths').toBeTruthy();
    expect(
      container.querySelector('.sko__stamp')!.textContent,
      'and therefore carries no text node to fall back to a missing font'
    ).toBe('');
  });

  it('never hardcodes an SVG gradient id — a multi-table view mounts several', () => {
    // SVG <defs> ids are global to the DOCUMENT. MultiTablePage mounts one of
    // these layers per table, so two knockouts with the same gradient id
    // silently repaint each other. The FIRST cut of this component avoided the
    // problem by having no gradients at all, which is why the art read as a
    // red blob; useId() solves it properly and this stops anyone undoing it.
    const { container } = render(
      <SeatKnockoutLayer
        hits={[hit({ id: 'a' }), hit({ id: 'b', seatIndex: 6 })]}
        seatPositions={SEATS}
        onDone={() => {}}
      />
    );
    const ids = [...container.querySelectorAll('[id]')].map((n) => n.id);
    expect(ids.length, 'the art is gradient-shaded, so there ARE defs ids').toBeGreaterThan(4);
    expect(new Set(ids).size, 'every id is unique across both knockouts').toBe(ids.length);
    for (const id of ids) {
      expect(id, `${id} must be instance-suffixed`).toMatch(/^sko-[a-z]+-[A-Za-z0-9]+$/);
    }
  });

  it('exempts the stamp from the global reduced-motion collapse', () => {
    // Everything else here is drama and may collapse. The stamp is the ANSWER
    // to "why did that chair just empty" — collapsed to 1ms it flashes for one
    // frame, which is the same as deleting it.
    const { container } = layer([hit()]);
    expect(container.querySelector('.sko__stamp')!.getAttribute('data-motion')).toBe('keep');
    expect(container.querySelector('.sko__glove')!.getAttribute('data-motion')).toBeNull();
  });

  it('expires itself and reports done, per seat', () => {
    const onDone = vi.fn();
    render(
      <SeatKnockoutLayer
        hits={[hit({ id: 'bob' }), hit({ id: 'carol', seatIndex: 6 })]}
        seatPositions={SEATS}
        onDone={onDone}
      />
    );
    act(() => {
      vi.advanceTimersByTime(SKO_DURATION_MS + 50);
    });
    expect(onDone.mock.calls.map((c) => c[0]).sort()).toEqual(['bob', 'carol']);
  });

  it('a knockout it cannot place still EXPIRES', () => {
    // A bust at another table, or one whose seat this client never saw. It
    // draws nothing — a 50/50 fallback would put a boxing glove on the board —
    // but it must still tell the parent, or it leaks in the hits array forever.
    const onDone = vi.fn();
    const { container } = render(
      <SeatKnockoutLayer hits={[hit({ seatIndex: 42 })]} seatPositions={SEATS} onDone={onDone} />
    );
    expect(container.querySelector('.sko')).toBeNull();
    expect(soundService.playKnockoutFlurry, 'invisible means inaudible too').not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(SKO_DURATION_MS + 50);
    });
    expect(onDone).toHaveBeenCalledWith('bob');
  });

  it('stays silent on a background table', () => {
    layer([hit()], { playSounds: false });
    act(() => {
      vi.advanceTimersByTime(SKO_IMPACT_AT_MS + 20);
    });
    expect(soundService.playKnockoutFlurry).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('MysteryBountyChest — who may open it', () => {
  it('offers the open prompt to the winner only', () => {
    render(<MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(750);
    });
    // Title Case, per Dan's binding house rule (2026-08-21) — 8bb24cd05 applied
    // it to every label the chest shows, so asserting SHOUTING here would lock
    // in copy the product has deliberately moved away from.
    expect(screen.getByText('Tap The Chest To Open')).toBeTruthy();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows spectators who is opening, and does not let them open it', () => {
    render(<MysteryBountyChest data={CHEST} viewerUserId="user-other" onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(750);
    });
    // The name and the animated "..." live in sibling nodes inside the prompt,
    // so the string is split across elements and a plain text matcher cannot
    // see it. Match on the element's own textContent instead.
    expect(
      screen.getByText((_content, el) => !!el?.textContent?.match(/Alice Is Opening The Chest/), {
        selector: '.mbc__prompt-main--waiting',
      })
    ).toBeTruthy();
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.click(btn);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // A spectator's click must not open it.
    expect(soundService.playMysteryChestOpen).not.toHaveBeenCalled();
  });

  it('cannot be opened before it has landed', () => {
    render(<MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />);
    // Still in the landing beat.
    fireEvent.click(screen.getByRole('button'));
    expect(soundService.playMysteryChestOpen).not.toHaveBeenCalled();
  });
});

describe('MysteryBountyChest — the reveal sequence', () => {
  it('runs land -> open -> explosion -> reveal in order', () => {
    render(<MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />);
    expect(soundService.playMysteryChestLand).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(750);
    });
    fireEvent.click(screen.getByRole('button'));
    expect(soundService.playMysteryChestOpen).toHaveBeenCalledTimes(1);
    // The explosion must NOT be simultaneous with the lid opening.
    expect(soundService.playMysteryChestExplosion).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(950);
    });
    expect(soundService.playMysteryChestExplosion).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(650);
    });
    expect(soundService.playMysteryBountyReveal).toHaveBeenCalledTimes(1);
  });

  it('reveals the amount and the tier', () => {
    render(<MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(750);
    });
    fireEvent.click(screen.getByRole('button'));
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    // 50000 / 1000 = 50x average -> the top tier
    expect(screen.getByText('Jackpot')).toBeTruthy();
    // "Won By" is Title Case too, so match case-insensitively rather than
    // re-encoding the exact casing in two separate places.
    expect(screen.getByText(/won by/i)).toBeTruthy();
  });

  it('is idempotent — a double tap cannot run the sequence twice', () => {
    render(<MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(750);
    });
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(soundService.playMysteryChestOpen).toHaveBeenCalledTimes(1);
  });
});

describe('MysteryBountyChest — real-time sync', () => {
  it("broadcasts the winner's tap so the rest of the table sees it", () => {
    const onBroadcastOpen = vi.fn();
    render(
      <MysteryBountyChest
        data={CHEST}
        viewerUserId="user-winner"
        onDone={() => {}}
        onBroadcastOpen={onBroadcastOpen}
      />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    fireEvent.click(screen.getByRole('button'));
    expect(onBroadcastOpen).toHaveBeenCalledTimes(1);
  });

  it('opens a spectator’s chest when the broadcast arrives', () => {
    const { rerender } = render(
      <MysteryBountyChest
        data={CHEST}
        viewerUserId="user-other"
        onDone={() => {}}
        remoteOpened={false}
      />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(soundService.playMysteryChestOpen).not.toHaveBeenCalled();

    rerender(
      <MysteryBountyChest
        data={CHEST}
        viewerUserId="user-other"
        onDone={() => {}}
        remoteOpened={true}
      />
    );
    expect(soundService.playMysteryChestOpen).toHaveBeenCalledTimes(1);
  });

  it('still shows the winner their prize when the broadcast throws', () => {
    const onBroadcastOpen = vi.fn(() => {
      throw new Error('channel down');
    });
    render(
      <MysteryBountyChest
        data={CHEST}
        viewerUserId="user-winner"
        onDone={() => {}}
        onBroadcastOpen={onBroadcastOpen}
      />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow();
    expect(soundService.playMysteryChestOpen).toHaveBeenCalledTimes(1);
  });

  it('opens itself if an AFK winner never taps', () => {
    render(<MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(soundService.playMysteryChestOpen).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(9100);
    });
    expect(soundService.playMysteryChestOpen).toHaveBeenCalledTimes(1);
  });

  it('does not strand spectators when no broadcast ever arrives', () => {
    render(<MysteryBountyChest data={CHEST} viewerUserId="user-other" onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(750);
    });
    // Spectators wait LONGER than the winner's own auto-open, so the normal
    // path is always the broadcast — this is only a failsafe.
    act(() => {
      vi.advanceTimersByTime(9500);
    });
    expect(soundService.playMysteryChestOpen).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(soundService.playMysteryChestOpen).toHaveBeenCalledTimes(1);
  });

  it('only the winner broadcasts — spectators must never fan out N messages', () => {
    const onBroadcastOpen = vi.fn();
    render(
      <MysteryBountyChest
        data={CHEST}
        viewerUserId="user-other"
        onDone={() => {}}
        onBroadcastOpen={onBroadcastOpen}
      />
    );
    act(() => {
      vi.advanceTimersByTime(750);
      vi.advanceTimersByTime(15000);
    });
    expect(onBroadcastOpen).not.toHaveBeenCalled();
  });
});

describe('MysteryBountyChest — suspense and context', () => {
  it('escalates tension the longer it sits unopened', () => {
    const { container } = render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    const root = container.querySelector('.mbc') as HTMLElement;
    expect(root.style.getPropertyValue('--mbc-tension')).toBe('0');

    act(() => {
      vi.advanceTimersByTime(3100);
    });
    // Suspense held at one intensity stops being suspense.
    expect(Number(root.style.getPropertyValue('--mbc-tension'))).toBeGreaterThanOrEqual(3);
  });

  it('caps the tension so it can never become a strobe', () => {
    const { container } = render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-other" onDone={() => {}} />
    );
    act(() => {
      vi.advanceTimersByTime(750);
      vi.advanceTimersByTime(12000);
    });
    const root = container.querySelector('.mbc') as HTMLElement;
    const t = Number(root.style.getPropertyValue('--mbc-tension'));
    expect(t).toBeLessThanOrEqual(6);
  });

  it('gives the winner press feedback, and never the spectator', () => {
    const { container, rerender } = render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    fireEvent.pointerDown(screen.getByRole('button'));
    expect(container.querySelector('.mbc--pressed')).toBeTruthy();
    fireEvent.pointerUp(screen.getByRole('button'));
    expect(container.querySelector('.mbc--pressed')).toBeNull();

    rerender(<MysteryBountyChest data={CHEST} viewerUserId="user-other" onDone={() => {}} />);
    fireEvent.pointerDown(screen.getByRole('button'));
    expect(container.querySelector('.mbc--pressed')).toBeNull();
  });

  it('releases the press state if the finger slides off', () => {
    const { container } = render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    fireEvent.pointerDown(screen.getByRole('button'));
    expect(container.querySelector('.mbc--pressed')).toBeTruthy();
    fireEvent.pointerLeave(screen.getByRole('button'));
    expect(container.querySelector('.mbc--pressed')).toBeNull();
  });

  it('says what the number MEANS, not just what it is', () => {
    render(<MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(750);
    });
    fireEvent.click(screen.getByRole('button'));
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    // 50000 / 1000 = 50x. A big figure with no reference point is just a big
    // figure — that is what this test exists to reject, and it still does.
    //
    // 8bb24cd05 deliberately removed the "N× the average bounty" line, so the
    // old assertion was testing copy the product had chosen to drop. Meaning is
    // now carried by the TIER, which is the same idea in a better form: it
    // answers "is this a lot?" without making the player do arithmetic mid-hand.
    expect(screen.getByText('Jackpot')).toBeTruthy();

    // The property that actually matters, and the reason a tier is not just
    // decoration: the SAME figure must read differently depending on what is
    // normal for the tournament. 50,000 is a jackpot where the average bounty
    // is 1,000 and merely respectable where the average IS 50,000.
    expect(getTier(50_000, 1_000).label).toBe('Jackpot');
    expect(getTier(50_000, 50_000).label).toBe('Small Prize');
  });

  it('omits the multiple when it is not notable', () => {
    render(
      <MysteryBountyChest
        data={{ ...CHEST, amount: 1100, avgBounty: 1000 }}
        viewerUserId="user-winner"
        onDone={() => {}}
      />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    fireEvent.click(screen.getByRole('button'));
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    // 1.1x is noise, not news.
    expect(screen.queryByText(/the average bounty/i)).toBeNull();
  });

  it('never divides by zero when no average is known', () => {
    render(
      <MysteryBountyChest
        data={{ ...CHEST, avgBounty: 0 }}
        viewerUserId="user-winner"
        onDone={() => {}}
      />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    fireEvent.click(screen.getByRole('button'));
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(screen.queryByText(/the average bounty/i)).toBeNull();
    expect(screen.queryByText(/NaN|Infinity/i)).toBeNull();
  });

  it('tells the player more bounties are queued behind this one', () => {
    render(
      <MysteryBountyChest
        data={CHEST}
        viewerUserId="user-winner"
        onDone={() => {}}
        queuedBehind={2}
      />
    );
    // Title Case, and the pluralisation is built from a split expression
    // (`Bount{n > 1 ? 'ies' : 'y'}`), so the string is spread across text nodes
    // and only the element's textContent sees it whole.
    expect(
      screen.getByText((_content, el) => !!el?.textContent?.match(/\+2 More Bounties To Reveal/), {
        selector: '.mbc__queued',
      })
    ).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CSS contracts. jsdom does not apply imported stylesheets, so the two
// properties that actually matter for correctness are asserted at the source.
describe('CSS contracts', () => {
  const koCss = readFileSync(
    resolve(__dirname, '../../src/components/table/SeatKnockout.css'),
    'utf8'
  );
  const mbcCss = readFileSync(
    resolve(__dirname, '../../src/components/tournament/MysteryBountyChest.css'),
    'utf8'
  );

  it('the knockout layer does not capture pointer events', () => {
    const rule = koCss.match(/\n\.sko-layer \{([^}]*)\}/);
    expect(rule, 'expected a top-level .sko-layer rule').toBeTruthy();
    expect(
      rule![1],
      'a knockout fires while you may be in a hand — it must never eat the fold button'
    ).toMatch(/pointer-events:\s*none/);
  });

  it('every knockout duration is scaled by the speed the player chose', () => {
    // The retired overlay scaled only its JS beats, so at 0.5x its CSS ran at
    // double speed against its own timers and the stamp was stripped
    // mid-keyframe. Both halves multiply by the same variable now.
    const durations = [...koCss.matchAll(/animation:[^;]*?(\d+(?:\.\d+)?)s/g)];
    expect(durations.length).toBeGreaterThan(4);
    for (const m of [...koCss.matchAll(/animation:\s*([^;]+);/g)]) {
      // `animation: none` is the reduced-motion switch-off and has no duration
      // to scale; everything that DOES run a duration must scale it.
      expect(m[1], `"${m[1].trim()}" must scale with --animation-speed`).toMatch(
        /var\(--animation-speed, 1\)|^\s*none\b/
      );
    }
  });

  it('the chest DOES capture pointer events — it is asking to be tapped', () => {
    const rule = mbcCss.match(/\n\.mbc \{([^}]*)\}/);
    expect(rule).toBeTruthy();
    expect(rule![1]).toMatch(/pointer-events:\s*auto/);
  });

  it("a spectator's chest is disabled but not dimmed", () => {
    // Browsers fade disabled buttons; a spectator's chest must stay fully lit.
    expect(mbcCss).toMatch(/\.mbc__chest:disabled\s*\{[^}]*opacity:\s*1/);
  });

  it('both components namespace every keyframe (global @keyframes namespace)', () => {
    // Require the opening brace: the prose "@keyframes is a global namespace"
    // appears in both files' header comments and is not a declaration.
    const DECL = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
    const names = [
      ...[...koCss.matchAll(DECL)].map((m) => m[1]),
      ...[...mbcCss.matchAll(DECL)].map((m) => m[1]),
    ];
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) {
      expect(n, `${n} must be prefixed — @keyframes is a GLOBAL namespace`).toMatch(/^(sko|mbc)/);
    }
  });

  it('both honour prefers-reduced-motion without hiding the information', () => {
    for (const css of [koCss, mbcCss]) {
      expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    }
    // The full-screen white flash is the single most unpleasant element here
    // for a motion-sensitive player, so it must be among what is removed.
    const reduced = mbcCss.slice(mbcCss.indexOf('prefers-reduced-motion'));
    expect(reduced).toMatch(/\.mbc__flash/);
  });
});

describe('getTier', () => {
  it('matches the legacy thresholds so one prize never gets two names', () => {
    // Title Case like every other tier — this one line was missed when
    // 8bb24cd05 applied the house rule, which is why it was the only
    // threshold assertion still failing.
    expect(getTier(50000, 1000).label).toBe('Jackpot');
    expect(getTier(20000, 1000).label).toBe('Grand Prize');
    expect(getTier(10000, 1000).label).toBe('Mega Prize');
    expect(getTier(5000, 1000).label).toBe('Huge Prize');
    expect(getTier(2500, 1000).label).toBe('Large Prize');
    expect(getTier(1500, 1000).label).toBe('Medium Prize');
    expect(getTier(500, 1000).label).toBe('Small Prize');
    expect(getTier(100, 1000).label).toBe('Min Prize');
  });

  it('degrades safely when no average is known', () => {
    expect(getTier(1234, 0).label).toBe('Prize');
  });
});
