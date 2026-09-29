/**
 * THE DEVICE CHECK (2026-09-26): the phone answers for itself. Every test
 * button does what it says, asks the player what happened, and the answers go
 * into a report that can be copied and pasted back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const sound = vi.hoisted(() => ({
  on: true,
  playWin: vi.fn(),
  isEnabled: vi.fn(),
  audioState: vi.fn(() => 'running'),
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    playWin: sound.playWin,
    isEnabled: () => sound.on,
    audioState: sound.audioState,
  },
}));
import { DeviceCheck, SMOOTHNESS_SAMPLE_MS } from '../../src/components/device/DeviceCheck';

const row = (label: string) => {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? '';
};

let buzzes: Array<number | number[]> = [];
beforeEach(() => {
  sound.on = true;
  buzzes = [];
  localStorage.clear();
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140 Mobile',
    maxTouchPoints: 5,
    vibrate: (p: number | number[]) => {
      buzzes.push(p);
      return true;
    },
    clipboard: { writeText: vi.fn(() => Promise.resolve()) },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the device check', () => {
  it('says what the device is and what it can do', () => {
    render(<DeviceCheck isOpen onClose={() => {}} />);
    expect(row('Device')).toBe('Android Browser');
    expect(row('Vibration')).toMatch(/^Full/);
    expect(row('Vibrations Setting')).toBe('On');
    expect(row('Sounds Setting')).toBe('On');
    expect(row('Sound Engine')).toBe('Running');
    expect(row('Silent Switch')).toBe('Not Applicable On This Browser');
    expect(row('Test Buzz')).toBe('Not Tried');
  });

  it('buzzes on Test Vibration, even with Vibrations off, then asks and records the answer', () => {
    localStorage.setItem('vibrationsEnabled', 'false');
    render(<DeviceCheck isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test Vibration' }));
    expect(buzzes).toEqual([[40, 60, 40]]);
    expect(row('Test Buzz')).toBe('Waiting For Your Answer');
    const ask = screen.getByRole('group', { name: 'Did You Feel The Buzz?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Yes' }));
    expect(row('Test Buzz')).toBe('Felt It');
  });

  it('plays a sound on Test Sound, or says sound is off', () => {
    render(<DeviceCheck isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test Sound' }));
    expect(sound.playWin).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Did You Hear The Sound?' })).getByRole('button', {
        name: 'No',
      })
    );
    expect(row('Test Sound')).toBe('Heard Nothing');
    cleanup();
    sound.on = false;
    render(<DeviceCheck isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test Sound' }));
    expect(sound.playWin).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText('Sounds Are Off In Settings. Turn Them On To Test.')
    ).toBeInTheDocument();
  });

  it('measures smoothness for three seconds on the display clock', () => {
    let frame: FrameRequestCallback | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((fn) => {
      frame = fn;
      return 1;
    });
    render(<DeviceCheck isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Measure Smoothness' }));
    expect(row('Smoothness')).toBe('Measuring');
    for (let t = 0; t <= SMOOTHNESS_SAMPLE_MS + 20; t += 1000 / 60) {
      const run = frame;
      frame = null;
      act(() => run?.(t));
    }
    expect(row('Smoothness')).toMatch(/^6[01] Frames A Second, 0% Slow$/);
  });

  it('puts the answers in the report, and a box to copy by hand when the clipboard is refused', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('blocked'));
    render(<DeviceCheck isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test Vibration' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Did You Feel The Buzz?' })).getByRole('button', {
        name: 'No',
      })
    );
    expect(row('Device Accepted Buzz')).toBe('Yes');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Report' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Copy Was Blocked');
    const box = screen.getByRole('textbox', { name: 'Device Check Report' }) as HTMLTextAreaElement;
    expect(box.value).toContain('Test Buzz: Felt Nothing');
    expect(box.value).toContain('Device Accepted Buzz: Yes');
  });

  it('says so instead of asking when there is no sound engine', () => {
    sound.audioState.mockReturnValue('unavailable');
    render(<DeviceCheck isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test Sound' }));
    expect(sound.playWin).not.toHaveBeenCalled();
    expect(
      screen.getByText('This Browser Has No Working Sound Engine, So Nothing Can Play.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Did You Hear The Sound?' })).toBeNull();
    sound.audioState.mockReturnValue('running');
  });

  it('reports a session already in playback as heard on silent', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/15E148 Safari/604.1',
      audioSession: { type: 'playback' },
    });
    render(<DeviceCheck isOpen onClose={() => {}} />);
    expect(row('Silent Switch')).toBe('Heard With The Silent Switch On');
    expect(row('Device')).toBe('IPhone Or IPad Browser (Safari 26.5)');
  });

  it('stops measuring when the check is closed', () => {
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame');
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 7);
    const view = render(<DeviceCheck isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Measure Smoothness' }));
    view.rerender(<DeviceCheck isOpen={false} onClose={() => {}} />);
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('copies the whole report', async () => {
    render(<DeviceCheck isOpen onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Report' }));
    });
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0] as string;
    expect(text.split('\n')[0]).toBe('Club Arena Device Check');
    expect(text).toContain('Device: Android Browser');
    expect(text).toContain('Vibration: Full');
    expect(screen.getByRole('status')).toHaveTextContent('Report Copied');
  });
});
