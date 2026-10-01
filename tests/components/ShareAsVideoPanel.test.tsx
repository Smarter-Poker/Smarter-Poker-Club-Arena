/**
 * SHARE AS VIDEO (Phase 9.1, 2026-09-30): the clip panel in the share sheet.
 *
 * - Pressing Share As Video calls fn_hand_clip_request(p_hand_id, p_style
 *   'felt-720p') and shows the job: queued -> rendering -> ready (a preview
 *   and Post To Your Feed) -> Posted with the reel link.
 * - Post To Your Feed calls publish_user_video_reel with p_topic 'poker',
 *   p_topic_confirmed true, p_thumbnail_url = poster_url, p_video_url =
 *   video_url, p_caption the sheet's caption, p_visibility 'public'.
 * - A failed job shows its reason and Try Again, which requests again.
 * - The poll stops at its ceiling and offers one Check Again.
 * - ShareHand renders the panel only when it was given a hand_history id.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';

const rpc = vi.fn();
const reads: Array<Record<string, unknown> | null> = [];
let lastRead: Record<string, unknown> | null = null;
const maybeSingle = vi.fn(async () => {
  const next = reads.length > 0 ? reads.shift()! : lastRead;
  lastRead = next;
  return { data: next, error: null };
});
const chain = {
  select: vi.fn(() => chain),
  eq: vi.fn(() => chain),
  order: vi.fn(() => chain),
  limit: vi.fn(() => chain),
  maybeSingle,
};
const from = vi.fn(() => chain);
vi.mock('@/lib/supabase', () => ({ supabase: { rpc, from } }));
vi.mock('@/services/SoundService', () => ({
  soundService: new Proxy({}, { get: () => vi.fn() }),
  haptic: new Proxy({}, { get: () => vi.fn() }),
}));
const openInBrowser = vi.fn();
vi.mock('@/lib/openExternal', () => ({ openInBrowser, leaveForHub: vi.fn() }));

const HAND = 'hand-uuid';
const job = (state: string, extra: Record<string, unknown> = {}) => ({
  id: 'job-uuid',
  hand_id: HAND,
  author_id: 'me',
  kind: 'user',
  style: 'felt-720p',
  state,
  video_url: null,
  poster_url: null,
  social_post_id: null,
  social_reel_id: null,
  error: null,
  created_at: '2026-09-30T12:00:00.000Z',
  updated_at: '2026-09-30T12:00:00.000Z',
  ...extra,
});
const READY = job('ready', {
  video_url:
    'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/social-media/videos/me/hand-clip-hand-uuid-felt-720p.mp4',
  poster_url:
    'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/social-media/videos/me/hand-clip-hand-uuid-felt-720p.jpg',
});

async function openPanel(props: Record<string, unknown> = {}) {
  const { default: ShareAsVideoPanel } = await import('@/components/table/ShareAsVideoPanel');
  render(<ShareAsVideoPanel handId={HAND} pollMs={5} pollLimitMs={60000} {...props} />);
}

beforeEach(() => {
  rpc.mockReset();
  from.mockClear();
  maybeSingle.mockClear();
  reads.length = 0;
  lastRead = null;
  openInBrowser.mockClear();
});
afterEach(cleanup);

describe('Share As Video', () => {
  it('requests the clip and follows the job from the queue to the feed', async () => {
    reads.push(null);
    rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_hand_clip_request') return { data: job('queued'), error: null };
      if (name === 'publish_user_video_reel')
        return {
          data: [{ social_post_id: 'post-uuid', social_reel_id: 'reel-uuid' }],
          error: null,
        };
      return { data: null, error: new Error(`unexpected rpc ${name}`) };
    });
    await openPanel({ pollMs: 25 });
    const button = await screen.findByRole('button', { name: 'Share As Video' });
    expect(rpc).not.toHaveBeenCalled();

    /* The poll will read rendering, then ready. */
    reads.push(job('rendering'), READY);
    fireEvent.click(button);
    expect(rpc).toHaveBeenCalledWith('fn_hand_clip_request', {
      p_hand_id: HAND,
      p_style: 'felt-720p',
    });
    expect(await screen.findByText('Your Clip Is In The Queue')).toBeTruthy();
    expect(await screen.findByText('Rendering Your Clip')).toBeTruthy();
    const post = await screen.findByRole('button', { name: 'Post To Your Feed' });
    const video = document.querySelector('video.share-hand__video-preview') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.getAttribute('src')).toBe(READY.video_url);
    expect(video.getAttribute('poster')).toBe(READY.poster_url);
    /* Reads went through the player's own row: hand_clip_jobs by hand and style. */
    expect(from).toHaveBeenCalledWith('hand_clip_jobs');
    expect(chain.eq).toHaveBeenCalledWith('hand_id', HAND);
    expect(chain.eq).toHaveBeenCalledWith('style', 'felt-720p');

    fireEvent.change(screen.getByLabelText('Clip Caption'), {
      target: { value: 'River bluff, called' },
    });
    fireEvent.click(post);
    expect(await screen.findByText('Posted')).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('publish_user_video_reel', {
      p_video_url: READY.video_url,
      p_topic: 'poker',
      p_topic_confirmed: true,
      p_caption: 'River bluff, called',
      p_thumbnail_url: READY.poster_url,
      p_visibility: 'public',
    });
    const link = screen.getByText('View On Your Feed') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://smarter.poker/hub/reels?id=reel-uuid');
    fireEvent.click(link);
    expect(openInBrowser).toHaveBeenCalledWith('https://smarter.poker/hub/reels?id=reel-uuid');
    /* Nothing posts by itself: one publish call, from the press. */
    expect(rpc.mock.calls.filter((c) => c[0] === 'publish_user_video_reel')).toHaveLength(1);
  });

  it('a failed job shows the reason and Try Again, which requests again', async () => {
    reads.push(job('failed', { error: 'clip_too_long' }));
    rpc.mockResolvedValue({ data: job('queued'), error: null });
    await openPanel();
    expect(await screen.findByText('Your Clip Could Not Be Rendered')).toBeTruthy();
    expect(screen.getByText('This Hand Runs Too Long For A Clip')).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
    reads.push(job('queued'));
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(rpc).toHaveBeenCalledWith('fn_hand_clip_request', {
      p_hand_id: HAND,
      p_style: 'felt-720p',
    });
    expect(await screen.findByText('Your Clip Is In The Queue')).toBeTruthy();
  });

  it('an already published job is a link, not a button', async () => {
    reads.push(job('published', { social_reel_id: 'reel-2' }));
    await openPanel();
    expect(await screen.findByText('Posted')).toBeTruthy();
    expect(screen.getByText('View On Your Feed').getAttribute('href')).toBe(
      'https://smarter.poker/hub/reels?id=reel-2'
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a request that fails outright says so and offers Try Again', async () => {
    reads.push(null);
    rpc.mockResolvedValue({ data: null, error: new Error('permission denied') });
    await openPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Share As Video' }));
    expect(await screen.findByText('Could Not Request A Clip Of This Hand')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });

  it('stops polling at the ceiling and offers one Check Again', async () => {
    reads.push(job('queued'));
    await openPanel({ pollMs: 5, pollLimitMs: 40 });
    expect(await screen.findByText('Your Clip Is In The Queue')).toBeTruthy();
    const check = await screen.findByRole('button', { name: 'Check Again' });
    const polls = maybeSingle.mock.calls.length;
    /* Nothing reads on its own once the ceiling is passed. */
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(maybeSingle.mock.calls.length).toBe(polls);
    reads.push(READY);
    fireEvent.click(check);
    expect(await screen.findByRole('button', { name: 'Post To Your Feed' })).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a read that fails on open still offers the button', async () => {
    maybeSingle.mockImplementationOnce(async () => ({
      data: null,
      error: new Error('relation does not exist'),
    }));
    await openPanel();
    expect(await screen.findByRole('button', { name: 'Share As Video' })).toBeTruthy();
  });
});

describe('the share sheet', () => {
  const hand = {
    id: HAND,
    tableName: 'Midway',
    variant: 'NLH' as const,
    stakes: '1/2',
    timestamp: 1759233600000,
    buttonSeat: 1,
    players: [
      { seat: 1, name: 'kingfish', stack: 200, isHero: true, isWinner: true },
      { seat: 2, name: 'Emerson', stack: 100 },
    ],
    preflop: [],
    potTotal: 12,
    winners: [{ seat: 1, amount: 12 }],
  };

  it('renders the panel only when it was given a hand_history id', async () => {
    reads.push(null);
    const { ShareHand } = await import('@/components/table/ShareHand');
    const { unmount } = render(
      <ShareHand isOpen onClose={() => undefined} hand={hand as never} handId={HAND} />
    );
    expect(await screen.findByRole('button', { name: 'Share As Video' })).toBeTruthy();
    unmount();
    render(<ShareHand isOpen onClose={() => undefined} hand={hand as never} />);
    await waitFor(() => expect(screen.getByText('Share Hand')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Share As Video' })).toBeNull();
    expect(document.querySelector('.share-hand__video')).toBeNull();
  });
});
