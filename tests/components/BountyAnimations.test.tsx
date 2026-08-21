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
import KnockoutAnimation from '../../src/components/tournament/KnockoutAnimation';
import MysteryBountyChest, { getTier } from '../../src/components/tournament/MysteryBountyChest';

/**
 * canvas-confetti runs a real requestAnimationFrame loop against a canvas it
 * owns. jsdom keeps firing queued frames after RTL unmounts the chest, so the
 * library calls clearRect on a null context and Vitest reports an UNCAUGHT
 * EXCEPTION — the run exits 1 with every assertion green. That is now a
 * deploy-blocker, not just noise: the client suite gates the bundle publish
 * (build-for-world-hub.yml), and a flaky celebration would stop shipping.
 *
 * The chest's confetti is decoration; these tests assert its phases, classes
 * and sounds, never its pixels. A no-op keeps the coverage and drops the loop.
 */
vi.mock('canvas-confetti', () => {
  const fn = () => Promise.resolve();
  return { default: Object.assign(fn, { reset: () => {}, create: () => fn }) };
});

vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    playBountyCollected: vi.fn(),
    playMysteryChestLand: vi.fn(),
    playMysteryChestOpen: vi.fn(),
    playMysteryChestExplosion: vi.fn(),
    playMysteryBountyReveal: vi.fn(),
    isEnabled: () => true,
  },
  haptic: { light: vi.fn(), medium: vi.fn(), strong: vi.fn(), jackpot: vi.fn() },
}));

import { soundService } from '../../src/services/SoundService';

const KO = {
  knockerName: 'Alice',
  eliminatedName: 'Bob',
  amount: 2500,
  addedToHead: 1250,
};

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
describe('KnockoutAnimation', () => {
  it('renders nothing until a knockout arrives', () => {
    const { container } = render(<KnockoutAnimation data={null} onDone={() => {}} />);
    expect(container.querySelector('.ko')).toBeNull();
  });

  it('shows both players and plays the bounty cue', () => {
    render(<KnockoutAnimation data={KO} onDone={() => {}} />);
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    expect(soundService.playBountyCollected).toHaveBeenCalledTimes(1);
  });

  it('NEVER blocks input — it fires while you may be in a hand', () => {
    const { container } = render(<KnockoutAnimation data={KO} onDone={() => {}} />);
    const overlay = container.querySelector('.ko') as HTMLElement;
    // Asserted on the stylesheet contract rather than computed style, because
    // jsdom does not apply the imported CSS. The class must exist and the rule
    // must say pointer-events: none — checked in the CSS test below.
    expect(overlay).toBeTruthy();
    expect(overlay.className).toContain('ko');
  });

  it('delays the payout so the hit and the money are separate beats', () => {
    render(<KnockoutAnimation data={KO} onDone={() => {}} />);
    // Immediately after impact the bounty has not landed yet.
    expect(screen.queryByText('BOUNTY')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByText('BOUNTY')).toBeTruthy();
  });

  it('counts the bounty UP rather than printing it', () => {
    const { container } = render(<KnockoutAnimation data={KO} onDone={() => {}} />);
    const amount = () =>
      (container.querySelector('.ko__bounty-amount') as HTMLElement | null)?.textContent;

    act(() => {
      vi.advanceTimersByTime(900);
    });
    // Mid-climb it must NOT already read the final figure.
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(amount()).not.toBe('2,500');

    // ...and it must arrive exactly, not approximately. Scoped to the bounty
    // element because the PKO split beat renders the same figure again.
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(amount()).toBe('2,500');
  });

  it('shows the PKO split with BOTH destinations, which players consistently miss', () => {
    render(<KnockoutAnimation data={KO} onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByText(/paid to you/i)).toBeTruthy();
    expect(screen.getByText(/onto your head/i)).toBeTruthy();
    expect(screen.getByText('1,250')).toBeTruthy();
  });

  it('omits the split entirely for a flat bounty', () => {
    render(<KnockoutAnimation data={{ ...KO, addedToHead: 0 }} onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.queryByText(/onto your head/i)).toBeNull();
  });

  it('shows the eliminated head, which is what the bounty actually is', () => {
    const { container } = render(<KnockoutAnimation data={KO} onDone={() => {}} />);
    expect(container.querySelector('.ko__head')).toBeTruthy();
    // No avatar in the payload -> falls back to the initial rather than a gap.
    expect(screen.getByText('B')).toBeTruthy();
  });

  it('uses the eliminated avatar when the payload carries one', () => {
    const { container } = render(
      <KnockoutAnimation
        data={{ ...KO, eliminatedAvatar: 'https://example.test/a.webp' }}
        onDone={() => {}}
      />
    );
    const img = container.querySelector('.ko__head-img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('https://example.test/a.webp');
  });

  it('tells the player more knockouts are queued behind this one', () => {
    render(<KnockoutAnimation data={KO} onDone={() => {}} queuedBehind={2} />);
    expect(screen.getByText(/\+2 more knockouts/i)).toBeTruthy();
  });

  it('says nothing about a queue when there is none', () => {
    render(<KnockoutAnimation data={KO} onDone={() => {}} queuedBehind={0} />);
    expect(screen.queryByText(/more knockout/i)).toBeNull();
  });

  it('clears itself and reports done', () => {
    const onDone = vi.fn();
    render(<KnockoutAnimation data={KO} onDone={onDone} />);
    act(() => {
      vi.advanceTimersByTime(3700);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('stays silent on a background table', () => {
    render(<KnockoutAnimation data={KO} onDone={() => {}} playSounds={false} />);
    expect(soundService.playBountyCollected).not.toHaveBeenCalled();
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
    resolve(__dirname, '../../src/components/tournament/KnockoutAnimation.css'),
    'utf8'
  );
  const mbcCss = readFileSync(
    resolve(__dirname, '../../src/components/tournament/MysteryBountyChest.css'),
    'utf8'
  );

  it('the knockout overlay does not capture pointer events', () => {
    const rule = koCss.match(/\n\.ko \{([^}]*)\}/);
    expect(rule, 'expected a top-level .ko rule').toBeTruthy();
    expect(
      rule![1],
      'a knockout fires while you may be in a hand — it must never eat the fold button'
    ).toMatch(/pointer-events:\s*none/);
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
      expect(n, `${n} must be prefixed — @keyframes is a GLOBAL namespace`).toMatch(/^(ko|mbc)/);
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
