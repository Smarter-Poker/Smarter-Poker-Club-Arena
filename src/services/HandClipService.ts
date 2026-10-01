/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND CLIP SERVICE — "Share As Video" for humans (Phase 9.1, 2026-09-30)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The database side (contract C5) is a queue table `hand_clip_jobs` and two
 * functions a signed-in player may call:
 *
 *   fn_hand_clip_request(p_hand_id, p_style)   insert (or return) the player's
 *                                              own job for a hand they played;
 *                                              a FAILED job is re-queued by an
 *                                              explicit request, a ready or
 *                                              published one comes back as is
 *   publish_user_video_reel(...)               post the rendered clip to the
 *                                              player's own feed, as the
 *                                              player, from the player's press
 *
 * The World Hub cron renders one queued job at a time; the row moves
 * queued -> rendering -> ready | failed. NOTHING HERE RETRIES: a failed job
 * stays failed until the person presses Try Again. While the share sheet is
 * open and the job is queued or rendering, the panel reads its own row (RLS:
 * author_id = auth.uid()) every 5 s for at most 6 minutes, then stops and
 * offers a single Check Again.
 *
 * Everything the panel needs that is not React lives here so it can be
 * pinned without a DOM: the RPC calls, the row shape, the reasons a player
 * reads, the reel link.
 */

import { supabase } from '../lib/supabase';
import { WEB_ORIGIN } from '../lib/appBase';

export const HAND_CLIP_STYLE = 'felt-720p';
export const HAND_CLIP_POLL_MS = 5000;
export const HAND_CLIP_POLL_LIMIT_MS = 6 * 60 * 1000;
export const HAND_CLIP_JOB_COLUMNS =
  'id, hand_id, author_id, kind, style, state, video_url, poster_url, social_post_id, social_reel_id, error, created_at, updated_at';

export type HandClipJobState = 'queued' | 'rendering' | 'ready' | 'published' | 'failed';

export interface HandClipJob {
  id: string;
  hand_id: string;
  author_id: string;
  kind: 'horse' | 'user';
  style: string;
  state: HandClipJobState;
  video_url: string | null;
  poster_url: string | null;
  social_post_id: string | null;
  social_reel_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const STATES: readonly HandClipJobState[] = ['queued', 'rendering', 'ready', 'published', 'failed'];

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * A job row as PostgREST hands it back: an object from `.maybeSingle()`, and
 * from a function that RETURNS the row either an object or a one-row array,
 * depending on the client. Null when it is not a job.
 */
export function normaliseHandClipJob(raw: unknown): HandClipJob | null {
  const r = Array.isArray(raw) ? raw[0] : raw;
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const id = str(o.id);
  const handId = str(o.hand_id);
  const state = str(o.state) as HandClipJobState | null;
  if (!id || !handId || !state || !STATES.includes(state)) return null;
  return {
    id,
    hand_id: handId,
    author_id: str(o.author_id) ?? '',
    kind: o.kind === 'horse' ? 'horse' : 'user',
    style: str(o.style) ?? HAND_CLIP_STYLE,
    state,
    video_url: str(o.video_url),
    poster_url: str(o.poster_url),
    social_post_id: str(o.social_post_id),
    social_reel_id: str(o.social_reel_id),
    error: str(o.error),
    created_at: str(o.created_at) ?? '',
    updated_at: str(o.updated_at) ?? '',
  };
}

/** Ask for a clip of a hand the signed-in player played; the job, new or existing. */
export async function requestHandClip(
  handId: string,
  style: string = HAND_CLIP_STYLE
): Promise<HandClipJob> {
  const { data, error } = await supabase.rpc('fn_hand_clip_request', {
    p_hand_id: handId,
    p_style: style,
  });
  if (error) throw error;
  const job = normaliseHandClipJob(data);
  if (!job) throw new Error('fn_hand_clip_request returned no job');
  return job;
}

/** The player's own job for this hand and style, through RLS; null when none. */
export async function readHandClipJob(
  handId: string,
  style: string = HAND_CLIP_STYLE
): Promise<HandClipJob | null> {
  const { data, error } = await supabase
    .from('hand_clip_jobs')
    .select(HAND_CLIP_JOB_COLUMNS)
    .eq('hand_id', handId)
    .eq('style', style)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return normaliseHandClipJob(data);
}

export interface PublishedHandClip {
  postId: string | null;
  reelId: string | null;
}

/**
 * Post a READY clip to the player's own feed, as the player. Consent is the
 * button press; nothing posts by itself. The arguments are contract C4's.
 */
export async function publishHandClipToFeed(
  job: HandClipJob,
  caption: string
): Promise<PublishedHandClip> {
  if (job.state !== 'ready' || !job.video_url) {
    throw new Error('only a ready clip with a video can be posted');
  }
  const { data, error } = await supabase.rpc('publish_user_video_reel', {
    p_video_url: job.video_url,
    p_topic: 'poker',
    p_topic_confirmed: true,
    p_caption: caption ?? '',
    p_thumbnail_url: job.poster_url,
    p_visibility: 'public',
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  return {
    postId: str(row?.social_post_id),
    reelId: str(row?.social_reel_id),
  };
}

/** Where a posted clip lives on the World Hub. */
export function handClipReelUrl(reelId: string): string {
  return `${WEB_ORIGIN}/hub/reels?id=${encodeURIComponent(reelId)}`;
}

/** The sentence a player reads for a failed job's reason code. */
export function handClipFailureReason(code: string | null | undefined): string {
  switch (code) {
    case 'clip_too_long':
      return 'This Hand Runs Too Long For A Clip';
    case 'clip_too_short':
      return 'This Hand Is Too Short For A Clip';
    case 'render_timeout':
    case 'clip_timeout':
      return 'The Render Took Too Long';
    case 'clip_not_ready':
      return 'The Replay Did Not Load For The Render';
    case 'hero_not_in_hand':
      return 'You Were Not Dealt Into This Hand';
    case 'hand_not_found':
      return 'This Hand Is Not In The Record';
    default:
      return 'The Render Did Not Finish';
  }
}

/** True while the row can still change on its own: the renderer owns it. */
export function handClipInProgress(job: HandClipJob | null | undefined): boolean {
  return job?.state === 'queued' || job?.state === 'rendering';
}
