/**
 * Diamond Scene Health on the admin dashboard (2026-10-01): how real phones
 * draw the Diamond games, read from the platform's own rollup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: db }));
import { DiamondSceneHealth } from '../../src/components/admin/DiamondSceneHealth';

afterEach(() => {
  cleanup();
  db.rpc.mockReset();
});

describe('Diamond Scene Health', () => {
  it('shows each game on each kind of device with its frame rate and troubles', async () => {
    db.rpc.mockResolvedValue({
      data: [
        {
          game: 'crash',
          device: 'ios_web',
          sessions: 12,
          fps: '57.4',
          slow_share: '3.1',
          lite_share: '0.0',
          software_share: '0.0',
          failures: 0,
        },
        {
          game: 'crossing',
          device: 'android_web',
          sessions: 4,
          fps: '38.0',
          slow_share: '22.5',
          lite_share: '50.0',
          software_share: '25.0',
          failures: 2,
        },
      ],
      error: null,
    });
    render(<DiamondSceneHealth />);
    expect(await screen.findByText('Diamond Scene Health - Last 7 Days')).toBeInTheDocument();
    expect(db.rpc).toHaveBeenCalledWith('fn_diamond_scene_health', { p_days: 7 });
    expect(screen.getByText('Crash, iPhone Browser')).toBeInTheDocument();
    expect(screen.getByText('57 FPS')).toBeInTheDocument();
    expect(screen.getByText('Donkey Cross, Android Browser')).toBeInTheDocument();
    expect(screen.getByText('38 FPS')).toBeInTheDocument();
    expect(screen.getByText(/2 Could Not Draw/)).toBeInTheDocument();
  });

  it('says nothing to someone it is not for, or when nothing has been recorded', async () => {
    db.rpc.mockResolvedValue({ data: [], error: null });
    const { container } = render(<DiamondSceneHealth />);
    await vi.waitFor(() => expect(db.rpc).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('says plainly when the read failed', async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    render(<DiamondSceneHealth />);
    expect(await screen.findByText('Scene Health Could Not Be Read.')).toBeInTheDocument();
  });
});
