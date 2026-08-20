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

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import KnockoutAnimation from '../../src/components/tournament/KnockoutAnimation';
import MysteryBountyChest, { getTier } from '../../src/components/tournament/MysteryBountyChest';

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
  vi.useFakeTimers();
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
    expect(screen.getByText(/2,500/)).toBeTruthy();
  });

  it('states the PKO head growth, which players consistently miss', () => {
    render(<KnockoutAnimation data={KO} onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByText(/added to your head/)).toBeTruthy();
  });

  it('omits head growth for a flat bounty', () => {
    render(<KnockoutAnimation data={{ ...KO, addedToHead: 0 }} onDone={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.queryByText(/added to your head/)).toBeNull();
  });

  it('clears itself and reports done', () => {
    const onDone = vi.fn();
    render(<KnockoutAnimation data={KO} onDone={onDone} />);
    act(() => {
      vi.advanceTimersByTime(3300);
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
  it('offers TAP TO OPEN to the winner only', () => {
    render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(screen.getByText('TAP THE CHEST TO OPEN')).toBeTruthy();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows spectators who is opening, and does not let them open it', () => {
    render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-other" onDone={() => {}} />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(screen.getByText(/Alice is opening the chest/)).toBeTruthy();
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
    render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />
    );
    // Still in the landing beat.
    fireEvent.click(screen.getByRole('button'));
    expect(soundService.playMysteryChestOpen).not.toHaveBeenCalled();
  });
});

describe('MysteryBountyChest — the reveal sequence', () => {
  it('runs land -> open -> explosion -> reveal in order', () => {
    render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />
    );
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
    render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />
    );
    act(() => {
      vi.advanceTimersByTime(750);
    });
    fireEvent.click(screen.getByRole('button'));
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    // 50000 / 1000 = 50x average -> JACKPOT
    expect(screen.getByText('JACKPOT')).toBeTruthy();
    expect(screen.getByText(/won by/)).toBeTruthy();
  });

  it('is idempotent — a double tap cannot run the sequence twice', () => {
    render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />
    );
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

  it("still shows the winner their prize when the broadcast throws", () => {
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
    render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-winner" onDone={() => {}} />
    );
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
    render(
      <MysteryBountyChest data={CHEST} viewerUserId="user-other" onDone={() => {}} />
    );
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
    expect(getTier(50000, 1000).label).toBe('JACKPOT');
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
