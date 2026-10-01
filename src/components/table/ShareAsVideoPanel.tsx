/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARE AS VIDEO — the clip panel in the share sheet (Phase 9.1, 2026-09-30)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Rendered by ShareHand when the sheet was opened for a hand that has a
 * `hand_history` id (the archive and the Previous Hand detail have one; the
 * live snapshot taken at the end of a hand does not, so it shows no panel).
 *
 *   Share As Video  ->  fn_hand_clip_request  ->  Your Clip Is In The Queue
 *                                             ->  Rendering Your Clip
 *                                             ->  a preview and Post To Your Feed
 *                                                 -> publish_user_video_reel -> Posted
 *                                             ->  the reason and Try Again
 *
 * The person presses to request and presses again to post; nothing posts by
 * itself. While the sheet is open and the job is queued or rendering the
 * panel reads its own row every 5 s for at most 6 minutes, then stops and
 * offers one Check Again. A failed job is final until Try Again.
 *
 * Title Case on every label, no emoji, no em dash.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HAND_CLIP_POLL_LIMIT_MS,
  HAND_CLIP_POLL_MS,
  handClipFailureReason,
  handClipInProgress,
  handClipReelUrl,
  publishHandClipToFeed,
  readHandClipJob,
  requestHandClip,
  type HandClipJob,
} from '../../services/HandClipService';
import { openInBrowser } from '../../lib/openExternal';
import { reportError } from '../../utils/errorReporter';

export interface ShareAsVideoPanelProps {
  /** The `hand_history` id the sheet was opened for. */
  handId: string;
  /** The caption the post starts with; the person can edit it. */
  caption?: string;
  /** Poll interval and ceiling, overridable for tests. */
  pollMs?: number;
  pollLimitMs?: number;
}

type Phase =
  /** Reading the player's own row for this hand, once, on open. */
  | 'loading'
  /** No job yet: the button. */
  | 'idle'
  /** fn_hand_clip_request in flight. */
  | 'requesting'
  /** A job row is on screen; what it shows depends on `job.state`. */
  | 'job'
  /** publish_user_video_reel in flight. */
  | 'publishing'
  /** Posted from this sheet; the reel link. */
  | 'posted'
  /** The poll ceiling passed while the job was still queued or rendering. */
  | 'stale'
  /** A request or a read failed outright (not a failed JOB). */
  | 'error';

export default function ShareAsVideoPanel({
  handId,
  caption: initialCaption = '',
  pollMs = HAND_CLIP_POLL_MS,
  pollLimitMs = HAND_CLIP_POLL_LIMIT_MS,
}: ShareAsVideoPanelProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [job, setJob] = useState<HandClipJob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reelId, setReelId] = useState<string | null>(null);
  const [caption, setCaption] = useState(initialCaption);
  const alive = useRef(true);
  /* When the current stretch of polling began; reset by every request. */
  const pollStartedAt = useRef<number | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /* On open: the player's own row, if there is one, so a clip already
     rendered shows as ready and one still rendering keeps being watched. A
     read that fails (the table not reachable, a network blip) is the button:
     the request itself will say if something is wrong. */
  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setJob(null);
    setMessage(null);
    setReelId(null);
    pollStartedAt.current = null;
    (async () => {
      try {
        const existing = await readHandClipJob(handId);
        if (cancelled) return;
        if (existing) {
          setJob(existing);
          setPhase('job');
        } else {
          setPhase('idle');
        }
      } catch (e) {
        if (cancelled) return;
        reportError(e, 'ShareAsVideoPanel.Failed_to_read_job');
        setPhase('idle');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handId]);

  /* The poll: only while a job is queued or rendering, only while the sheet
     is open, every `pollMs`, for at most `pollLimitMs` from when watching
     began. The timer is the schedule, not a retry: it reads, it never writes. */
  /* A ready row with no video yet is the renderer mid-write: watched too. */
  const watching =
    phase === 'job' && (handClipInProgress(job) || (job?.state === 'ready' && !job.video_url));
  useEffect(() => {
    if (!watching) return;
    if (pollStartedAt.current === null) pollStartedAt.current = Date.now();
    const t = setTimeout(async () => {
      if (Date.now() - (pollStartedAt.current ?? Date.now()) >= pollLimitMs) {
        if (alive.current) setPhase('stale');
        return;
      }
      try {
        const next = await readHandClipJob(handId);
        if (!alive.current) return;
        /* A new object either way: the effect re-arms off its identity. */
        setJob((j) => (next ? { ...next } : j ? { ...j } : j));
      } catch (e) {
        reportError(e, 'ShareAsVideoPanel.Failed_to_poll_job');
        /* A missed read is a missed read; the next tick reads again until
           the ceiling, and the ceiling is what ends it. */
        if (alive.current) setJob((j) => (j ? { ...j } : j));
      }
    }, pollMs);
    return () => clearTimeout(t);
  }, [watching, job, handId, pollMs, pollLimitMs]);

  const request = useCallback(async () => {
    setPhase('requesting');
    setMessage(null);
    setReelId(null);
    pollStartedAt.current = null;
    try {
      const next = await requestHandClip(handId);
      if (!alive.current) return;
      setJob(next);
      setPhase('job');
    } catch (e) {
      reportError(e, 'ShareAsVideoPanel.Failed_to_request_clip');
      if (!alive.current) return;
      setMessage('Could Not Request A Clip Of This Hand');
      setPhase('error');
    }
  }, [handId]);

  const checkAgain = useCallback(async () => {
    setPhase('loading');
    try {
      const next = await readHandClipJob(handId);
      if (!alive.current) return;
      pollStartedAt.current = null;
      if (next) setJob(next);
      setPhase(next ? 'job' : 'idle');
    } catch (e) {
      reportError(e, 'ShareAsVideoPanel.Failed_to_check_job');
      if (!alive.current) return;
      setPhase(job ? 'stale' : 'idle');
    }
  }, [handId, job]);

  const publish = useCallback(async () => {
    if (!job) return;
    setPhase('publishing');
    setMessage(null);
    try {
      const posted = await publishHandClipToFeed(job, caption.trim());
      if (!alive.current) return;
      setReelId(posted.reelId);
      setPhase('posted');
    } catch (e) {
      reportError(e, 'ShareAsVideoPanel.Failed_to_publish_clip');
      if (!alive.current) return;
      setMessage('Could Not Post Your Clip. Try Again.');
      setPhase('job');
    }
  }, [job, caption]);

  const reelLink = (id: string) => {
    const url = handClipReelUrl(id);
    return (
      <a
        className="share-hand__video-link"
        href={url}
        onClick={(e) => {
          e.preventDefault();
          openInBrowser(url);
        }}
      >
        View On Your Feed
      </a>
    );
  };

  let body: React.ReactNode;
  if (phase === 'loading') {
    body = <p className="share-hand__video-status">Checking For A Clip</p>;
  } else if (phase === 'idle') {
    body = (
      <>
        <button type="button" className="share-hand__video-btn" onClick={request}>
          Share As Video
        </button>
        <p className="share-hand__video-hint">
          A Short Clip Of This Hand, Rendered For You To Post To Your Feed
        </p>
      </>
    );
  } else if (phase === 'requesting') {
    body = <p className="share-hand__video-status">Requesting Your Clip</p>;
  } else if (phase === 'error') {
    body = (
      <>
        <p className="share-hand__video-status share-hand__video-status--failed">{message}</p>
        <button type="button" className="share-hand__video-btn" onClick={request}>
          Try Again
        </button>
      </>
    );
  } else if (phase === 'stale') {
    body = (
      <>
        <p className="share-hand__video-status">
          Still Working On Your Clip. Check Again In A Moment.
        </p>
        <button type="button" className="share-hand__video-btn" onClick={checkAgain}>
          Check Again
        </button>
      </>
    );
  } else if (phase === 'publishing') {
    body = <p className="share-hand__video-status">Posting Your Clip</p>;
  } else if (phase === 'posted') {
    body = (
      <>
        <p className="share-hand__video-status share-hand__video-status--done">Posted</p>
        {reelId && reelLink(reelId)}
      </>
    );
  } else if (job?.state === 'queued') {
    body = (
      <>
        <p className="share-hand__video-status">Your Clip Is In The Queue</p>
        <p className="share-hand__video-hint">This Usually Takes A Minute Or Two</p>
      </>
    );
  } else if (job?.state === 'rendering') {
    body = <p className="share-hand__video-status">Rendering Your Clip</p>;
  } else if (job?.state === 'ready' && job.video_url) {
    body = (
      <>
        <video
          className="share-hand__video-preview"
          src={job.video_url}
          poster={job.poster_url ?? undefined}
          controls
          playsInline
          preload="metadata"
          aria-label="Clip Preview"
        />
        <input
          type="text"
          className="share-hand__video-caption"
          value={caption}
          maxLength={280}
          placeholder="Add A Caption (Optional)"
          aria-label="Clip Caption"
          onChange={(e) => setCaption(e.target.value)}
        />
        {message && (
          <p className="share-hand__video-status share-hand__video-status--failed">{message}</p>
        )}
        <button type="button" className="share-hand__video-btn" onClick={publish}>
          Post To Your Feed
        </button>
      </>
    );
  } else if (job?.state === 'published') {
    body = (
      <>
        <p className="share-hand__video-status share-hand__video-status--done">Posted</p>
        {job.social_reel_id && reelLink(job.social_reel_id)}
      </>
    );
  } else if (job?.state === 'failed') {
    body = (
      <>
        <p className="share-hand__video-status share-hand__video-status--failed">
          Your Clip Could Not Be Rendered
        </p>
        <p className="share-hand__video-hint">{handClipFailureReason(job.error)}</p>
        <button type="button" className="share-hand__video-btn" onClick={request}>
          Try Again
        </button>
      </>
    );
  } else {
    /* A ready job with no video is a row the renderer has not finished
       writing; it reads like rendering until the next poll says otherwise. */
    body = <p className="share-hand__video-status">Rendering Your Clip</p>;
  }

  return (
    <div className="share-hand__video" data-clip-phase={phase} data-clip-job-state={job?.state}>
      {body}
    </div>
  );
}
