/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND REVIEW — the flagged queue, and the one read that shows every card
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PHASE 6 of the Previous Hand build plan (2026-09-06).
 * `/clubs/:clubId/hand-review`, beside Reports, Disputes and Blacklist.
 *
 * TWO ACCESS LEVELS ON ONE PAGE, because they are two different questions:
 *
 *   TRIAGE IS STAFF. Seeing that a hand was flagged, by whom, and answering
 *   it is moderation intake - the same level as Reports and Disputes.
 *
 *   THE CARDS ARE CONTROL. Opening a hand shows every seat's holding,
 *   including the ones that folded and the ones that mucked: cards the table
 *   never saw. That is the most sensitive read on this platform, it is owner
 *   and admin only, and every one of them is written to `audit_trail` by the
 *   same function that returns the cards.
 *
 * THE UI GATE BELOW IS COSMETIC AND SAYS SO. `fn_ca_operator_read_hand`
 * refuses a non-control caller whatever this page renders, and there is no
 * other path to those cards - `hand_history` and `ca_hand_facts` both scope to
 * the reader's own rows. Hiding the panel is a courtesy; Postgres is the
 * enforcement.
 *
 * THE OPERATOR WATCHES THE SAME REPLAYER EVERYBODY ELSE DOES. The read returns
 * the `hand_history` row in the shape `replayInputFromRow` already takes, and
 * the cards go in through its `privateHoleCards` seam - the one that exists
 * for exactly this, "read through RLS-scoped tables by the caller and keyed by
 * user id". The only difference from a player's view of their own hand is that
 * no seat is face down.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import ClubIntegrityHeader from '../components/club/ClubIntegrityHeader';
import PageSkeleton from '../components/common/PageSkeleton';
import HandDetailView from '../components/handdetail/HandDetailView';
import { useToast } from '../components/common/Toast';
import { useClubNavigationAccess } from '../hooks/useClubNavigationAccess';
import { resolveClubUUIDStrict } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { buildReplay, replayInputFromRow, type ReplayModel } from '../utils/handReplay';
import {
  handFlagService,
  FLAG_STATUS_LABEL,
  GODMODE_REASON_MIN,
  type HandFlag,
  type HandFlagStatus,
  type OperatorHandRead,
} from '../services/HandFlagService';
import './ClubHandReviewPage.css';

type QueueFilter = HandFlagStatus | 'all';

const FILTERS: Array<{ id: QueueFilter; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'under_review', label: 'Under Review' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'dismissed', label: 'Closed' },
  { id: 'all', label: 'All' },
];

function when(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
}

export default function ClubHandReviewPage() {
  const { clubId: clubParam } = useParams<{ clubId: string }>();
  const toast = useToast();
  const access = useClubNavigationAccess(clubParam ?? '');

  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'notFound'>('loading');
  const [flags, setFlags] = useState<HandFlag[]>([]);
  const [filter, setFilter] = useState<QueueFilter>('open');
  const [busyFlag, setBusyFlag] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});

  /* The lookup. `reason` is not a form field beside the read - it travels into
     the audit row verbatim, and the function refuses one under eight
     characters. */
  const [handNumber, setHandNumber] = useState('');
  const [reason, setReason] = useState('');
  const [opening, setOpening] = useState(false);
  const [read, setRead] = useState<OperatorHandRead | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Hand Review | Smarter Poker';
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!clubParam) return;
      try {
        const uuid = await resolveClubUUIDStrict(clubParam);
        if (!alive) return;
        setClubUuid(uuid);
      } catch (error) {
        if (!alive) return;
        reportError(error, 'ClubHandReviewPage.resolveClub');
        setState('notFound');
      }
    })();
    return () => {
      alive = false;
    };
  }, [clubParam]);

  const loadQueue = useCallback(
    async (which: QueueFilter) => {
      if (!clubUuid) return;
      const result = await handFlagService.clubQueue(clubUuid, which);
      if (result.denied) {
        setState('denied');
        return;
      }
      setFlags(result.flags);
      setState('ready');
    },
    [clubUuid]
  );

  useEffect(() => {
    if (clubUuid) void loadQueue(filter);
  }, [clubUuid, filter, loadQueue]);

  const openHand = useCallback(
    async (numberText: string, why: string) => {
      if (!clubUuid) return;
      const n = Number(String(numberText).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(n) || n <= 0) {
        setReadError('Enter The Hand Number');
        return;
      }
      setOpening(true);
      setReadError(null);
      const result = await handFlagService.openHand(clubUuid, n, why);
      setOpening(false);
      if (!result.ok || !result.read) {
        setRead(null);
        setReadError(result.error ?? 'Could Not Open That Hand');
        return;
      }
      setRead(result.read);
      /* Said out loud, every time, because the reader is about to see cards
         nobody at the table saw. */
      toast.info('This Read Was Logged To The Club Audit Trail');
    },
    [clubUuid, toast]
  );

  const model: ReplayModel | null = useMemo(() => {
    if (!read) return null;
    try {
      return buildReplay(
        replayInputFromRow(read.row as never, {
          /* Every seat's holding, through the seam the reconstruction already
             has for cards a caller read under their own authority. */
          privateHoleCards: read.allHoleCards as never,
        })
      );
    } catch (error) {
      reportError(error, 'ClubHandReviewPage.buildReplay');
      return null;
    }
  }, [read]);

  const resolveFlag = useCallback(
    async (flag: HandFlag, status: HandFlagStatus) => {
      const note = (replyDraft[flag.id] ?? '').trim();
      if ((status === 'resolved' || status === 'dismissed') && !note) {
        toast.error('Closing A Flag Needs A Note The Player Can Read');
        return;
      }
      setBusyFlag(flag.id);
      const result = await handFlagService.resolve(flag.id, status, note || undefined);
      setBusyFlag(null);
      if (!result.ok) {
        toast.error(result.error ?? 'Could Not Update That Flag');
        return;
      }
      toast.success(`Flag Marked ${FLAG_STATUS_LABEL[status]}`);
      setReplyDraft((prev) => ({ ...prev, [flag.id]: '' }));
      void loadQueue(filter);
    },
    [replyDraft, toast, loadQueue, filter]
  );

  const openCount = flags.filter((f) => f.status === 'open' || f.status === 'under_review').length;

  if (state === 'loading' || access.loading) return <PageSkeleton variant="list" />;

  if (state === 'notFound') {
    return (
      <div className="chr-page">
        <p className="chr-empty">That Club Could Not Be Found.</p>
      </div>
    );
  }

  if (state === 'denied' || !access.isClubStaff) {
    return (
      <div className="chr-page">
        <p className="chr-empty">Hand Review Is For Club Operators.</p>
      </div>
    );
  }

  return (
    <div className="chr-page" data-arena-surface="club">
      <ClubIntegrityHeader
        clubId={clubParam}
        active="hand-review"
        eyebrow="Integrity / Hands"
        title="Hand Review"
        description="Hands Your Players Flagged, And The Audited Lookup That Opens Any Hand Dealt At This Club."
        metrics={[
          { label: 'Waiting', value: openCount },
          { label: 'Listed', value: flags.length },
        ]}
      />

      {/* ── THE AUDITED LOOKUP ────────────────────────────────────────────── */}
      {access.canControlClub ? (
        <section className="chr-lookup" aria-label="Open A Hand">
          <div className="chr-lookup__head">
            <h2 className="chr-lookup__title">Open A Hand</h2>
            <p className="chr-lookup__warn">
              Shows All Hole Cards, Including Folded And Mucked Hands. The Reader, The Hand And The
              Reason Are Written To The Club Audit Trail.
            </p>
          </div>
          <div className="chr-lookup__form">
            <input
              className="chr-lookup__number"
              type="text"
              inputMode="numeric"
              value={handNumber}
              placeholder="Hand Number"
              aria-label="Hand Number"
              onChange={(e) => setHandNumber(e.target.value)}
            />
            <input
              className="chr-lookup__reason"
              type="text"
              value={reason}
              placeholder="Why Is This Hand Being Opened?"
              aria-label="Why This Hand Is Being Opened"
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className="chr-lookup__go"
              disabled={opening || reason.trim().length < GODMODE_REASON_MIN || !handNumber.trim()}
              onClick={() => void openHand(handNumber, reason)}
            >
              {opening ? 'Opening' : 'Open Hand'}
            </button>
          </div>
          {readError && (
            <p className="chr-lookup__error" role="status">
              {readError}
            </p>
          )}
        </section>
      ) : (
        <section className="chr-lookup chr-lookup--locked">
          <p className="chr-lookup__warn">
            Opening A Hand Shows All Hole Cards, And Is For A Club Owner Or Admin.
          </p>
        </section>
      )}

      {read && model && (
        <section className="chr-hand" aria-label="The Opened Hand">
          <div className="chr-hand__bar">
            <span className="chr-hand__num">Hand #{String(read.row.hand_number ?? '')}</span>
            {/* SAYS WHAT IT DOES NOT HAVE. `hand_history` reaches back further
                than the per-seat card record does, so an old hand can be short
                - and a missing holding must never read as an empty one. */}
            <span className={`chr-hand__cards${read.cardsComplete ? ' is-complete' : ' is-short'}`}>
              {read.cardsComplete
                ? `All ${read.seatsDealt} Holdings On Record`
                : `${read.seatsWithCards} Of ${read.seatsDealt} Holdings On Record`}
            </span>
            <button type="button" className="chr-hand__close" onClick={() => setRead(null)}>
              Close
            </button>
          </div>
          {!read.cardsComplete && (
            <p className="chr-hand__short">
              The Seats Without Cards Below Are Not Empty Hands. Their Holdings Are No Longer On
              Record.
            </p>
          )}
          <HandDetailView model={model} currentUserId={null} badge="Operator View" />
        </section>
      )}

      {/* ── THE QUEUE ─────────────────────────────────────────────────────── */}
      <div className="chr-filters" role="group" aria-label="Filter Flagged Hands">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`chr-chip${filter === f.id ? ' active' : ''}`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {flags.length === 0 ? (
        <p className="chr-empty">
          {filter === 'open'
            ? 'No Hands Are Waiting On You.'
            : 'No Flagged Hands Match That Filter.'}
        </p>
      ) : (
        <ul className="chr-list">
          {flags.map((flag) => (
            <li key={flag.id} className={`chr-flag is-${flag.status}`}>
              <div className="chr-flag__head">
                <span className="chr-flag__num">
                  Hand #{flag.handNumber ?? '?'}
                  {flag.tableName ? ` · ${flag.tableName}` : ''}
                </span>
                <span className={`chr-flag__status is-${flag.status}`}>
                  {FLAG_STATUS_LABEL[flag.status]}
                </span>
              </div>
              <p className="chr-flag__note">{flag.note}</p>
              <div className="chr-flag__meta">
                <span>Filed {when(flag.createdAt)}</span>
                {flag.reviewedAt && <span>Answered {when(flag.reviewedAt)}</span>}
              </div>

              {flag.operatorNote && (
                <div className="chr-flag__reply">
                  <span className="chr-flag__reply-label">Sent To The Player</span>
                  <p className="chr-flag__reply-body">{flag.operatorNote}</p>
                </div>
              )}

              <div className="chr-flag__actions">
                {access.canControlClub && flag.handNumber != null && (
                  <button
                    type="button"
                    className="chr-flag__open"
                    onClick={() => {
                      setHandNumber(String(flag.handNumber));
                      /* The flag's own words are the reason, which is both the
                         truth and the thing an operator would otherwise
                         retype badly. */
                      const why = `Flagged hand: ${flag.note}`.slice(0, 400);
                      setReason(why);
                      void openHand(String(flag.handNumber), why);
                    }}
                  >
                    Open This Hand
                  </button>
                )}
                <input
                  className="chr-flag__replybox"
                  type="text"
                  value={replyDraft[flag.id] ?? ''}
                  placeholder="What Should The Player Be Told?"
                  aria-label={`Reply To The Flag On Hand ${flag.handNumber ?? ''}`}
                  onChange={(e) =>
                    setReplyDraft((prev) => ({ ...prev, [flag.id]: e.target.value }))
                  }
                />
                {flag.status !== 'under_review' && flag.status !== 'resolved' && (
                  <button
                    type="button"
                    className="chr-flag__btn"
                    disabled={busyFlag === flag.id}
                    onClick={() => void resolveFlag(flag, 'under_review')}
                  >
                    Take It
                  </button>
                )}
                <button
                  type="button"
                  className="chr-flag__btn"
                  disabled={busyFlag === flag.id}
                  onClick={() => void resolveFlag(flag, 'resolved')}
                >
                  Resolve
                </button>
                <button
                  type="button"
                  className="chr-flag__btn chr-flag__btn--quiet"
                  disabled={busyFlag === flag.id}
                  onClick={() => void resolveFlag(flag, 'dismissed')}
                >
                  Close, No Change
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
