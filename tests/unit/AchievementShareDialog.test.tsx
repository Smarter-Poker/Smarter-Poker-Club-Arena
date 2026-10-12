import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AchievementShareCard } from '../../src/components/achievements/AchievementShareCard';

const native = vi.hoisted(() => ({ share: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/lib/appBase', () => ({ IS_NATIVE_BUILD: true, isNativePlatform: () => true }));
vi.mock('../../src/lib/native/share', () => ({ nativeShareBlob: native.share }));
vi.mock('../../src/services/HapticService', () => ({ haptic: { success: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ title, titleId, children, plates }: any) => (
    <>
      <h2 id={titleId}>{title}</h2>
      {children}
      <button onClick={plates.secondary.onClick}>Close</button>
      <button onClick={plates.primary.onClick} disabled={plates.primary.disabled}>
        {plates.primary.label}
      </button>
    </>
  ),
}));
const props = {
  icon: '★',
  name: 'Milestone',
  description: 'An Earned Badge',
  rarity: 'rare' as const,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  native.share.mockClear();
});

describe('Achievement Share Dialog', () => {
  it('exports all long copy inside safe margins with separate title, description and footer zones', async () => {
    const painted: { text: string; y: number; width: number }[] = [];
    const context: any = {
      font: '',
      measureText: (text: string) => ({
        width:
          Array.from(text).length * (parseFloat(context.font.replace('bold ', '')) || 16) * 0.6,
      }),
      fillText: (text: string, _x: number, y: number) =>
        painted.push({ text, y, width: context.measureText(text).width }),
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
    };
    const ctx = new Proxy(context, { get: (target, key) => target[key] ?? vi.fn() });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) =>
      cb(new Blob(['image']))
    );
    const name = 'Extraordinary Tournament Milestone Championship Achievement Of The Year';
    const description =
      'Win Multiple Consecutive Tournament Events With Exceptional Play Across Every Competition And Community Challenge Without Losing Any Recorded Achievement Copy';
    render(
      <AchievementShareCard {...props} name={name} description={description} onClose={vi.fn()} />
    );
    fireEvent.click(screen.getByText('Share'));
    await waitFor(() => expect(native.share).toHaveBeenCalledOnce());
    const body = painted.filter((line) => line.y >= 220 && !line.text.startsWith('CLUB ARENA'));
    expect(body.every((line) => line.width <= 544)).toBe(true);
    expect(body.map((line) => line.text).join(' ')).toBe(`${name} ${description}`);
    expect(new Set(body.map((line) => line.y)).size).toBe(body.length);
    const footer = painted.find((line) => line.text.startsWith('CLUB ARENA'))!;
    expect(footer.y).toBeGreaterThan(body.at(-1)!.y + 35);
    expect(document.querySelector('canvas')!.height).toBeGreaterThan(footer.y);
  });

  it('contains keyboard focus, closes on Escape and restores the opening control', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(<AchievementShareCard {...props} onClose={onClose} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Close')));
    screen.getByText('Share').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('Close'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('completes native sharing and dismisses the busy dialog', async () => {
    const context = new Proxy(
      {},
      {
        get: (_, key) =>
          key === 'createRadialGradient'
            ? () => ({ addColorStop: vi.fn() })
            : key === 'measureText'
              ? () => ({ width: 100 })
              : vi.fn(),
        set: () => true,
      }
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) =>
      cb(new Blob(['image']))
    );
    const onClose = vi.fn();
    render(<AchievementShareCard {...props} onClose={onClose} />);
    fireEvent.click(screen.getByText('Share'));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(native.share).toHaveBeenCalledOnce();
    expect(screen.getByText('Share').hasAttribute('disabled')).toBe(false);
  });
});
