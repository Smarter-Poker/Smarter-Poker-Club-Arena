/**
 * ONE LIGHTNING CLUSTER, IN FULL (Lightning Phase 12, Spec Phase 21).
 *
 * fn_lightning_operator_cluster(p_cluster_id, p_from, p_to) answers the whole
 * Cluster for the chosen window: its overview row, the latest mode
 * transitions, open holds, the open blind ledger, the stack reconcile, the
 * candidate matcher report, integrity signals, open alerts, latency windows
 * and the latest quality score. Two more doors answer on demand: the hand
 * replay check for one hand and the session trail for one pool session.
 * One door writes: an integrity signal review (reviewed, cleared or
 * actioned, with a note), audited in the database.
 *
 * The inspect half of the Spec's OPERATOR CONTROLS: inspect matcher, holds,
 * blind ledger and conversion state, replay hand, replay player session,
 * replay mode transition, reconcile stack. Nothing here changes a Cluster's
 * mode or moves a player; pause, drain and freeze are Phase 13.
 *
 * No card is ever shown (the doors redact; nothing here renders a card), and
 * horses read exactly like every other player (Law 10.5).
 */
import { lazy, Suspense, useCallback, useState, type ReactNode } from 'react';
import { SpadeConsole, type ConsoleInk } from '../../../components/console/SpadeConsole';
import { useToast } from '../../../components/common/Toast';
import { compactChips } from '../../../utils/format';
import { titleCase } from '../../../utils/titleCase';
import {
  DETAIL_WINDOWS,
  LATENCY_LEGS,
  LATENCY_LEG_LABELS,
  SIGNAL_REVIEW_STATUSES,
  agoLabel,
  alertTitle,
  enumLabel,
  fetchLightningCluster,
  fetchLightningHandReplay,
  fetchLightningSessionTrail,
  foldLabel,
  modeBadge,
  reconcileGap,
  reviewLightningSignal,
  shadowMetricLabel,
  shortId,
  stampLabel,
  verdictLabel,
  type DetailWindowKey,
  type LatencyLeg,
  type LightningClusterDetail as Detail,
  type LightningHandReplay,
  type LightningIntegritySignal,
  type LightningSessionTrail,
  type LightningTransition,
  type OperatorAnswer,
  type SignalReviewStatus,
} from '../../../lightning/lightningOperatorApi';
import { CLUSTER_REFRESH_MS, usePolledAnswer } from '../../../lightning/useLightningOperator';
import { AnswerState, LatencyGrid, MODE_INK, count } from './lightningOperatorParts';
import styles from '../ClubLightningOperationsPage.module.css';

const LightningLatencyChart = lazy(() => import('./LightningLatencyChart'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEVERITY_INK: Record<string, ConsoleInk> = { high: 'red', medium: 'gold', low: 'blue' };

function Row({ label, value, ink = 'silver' }: { label: string; value: string; ink?: ConsoleInk }) {
  return (
    <div className={styles.row}>
      <span className={`${styles.rowLabel} sc-ink--blue`}>{label}</span>
      <span className={`${styles.rowValue} sc-ink--${ink}`}>{value}</span>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={`${styles.sectionTitle} sc-label sc-ink--silver`}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className={`${styles.empty} sc-copy sc-ink--muted`}>{children}</p>;
}

function signed(n: number | null, digits = 1): string {
  if (n === null) return '-';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
}

/** A candidate component is a 0..1 ratio (two decimals) or a raw reading
 *  such as a wait in milliseconds (whole). */
function reading(n: number | null): string {
  if (n === null) return '-';
  return Math.abs(n) >= 10 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2);
}

function signedReading(n: number | null): string {
  if (n === null) return '-';
  return `${n > 0 ? '+' : ''}${reading(n)}`;
}

/** One mode transition in a line: an epoch, a conversion or the freeze. */
function transitionLine(t: LightningTransition): string {
  if (t.kind === 'conversion') {
    const path =
      t.fromMode && t.mode
        ? `${modeBadge(t.fromMode).label} To ${modeBadge(t.mode).label}`
        : modeBadge(t.mode).label;
    return `Conversion, ${path}${t.status ? `, ${enumLabel(t.status)}` : ''}${t.reason ? `, ${enumLabel(t.reason)}` : ''}`;
  }
  if (t.kind === 'freeze') {
    return `Frozen${t.epoch !== null ? ` At Epoch ${t.epoch}` : ''}${t.reason ? `, ${enumLabel(t.reason)}` : ''}`;
  }
  return `Epoch ${t.epoch ?? '-'}, ${modeBadge(t.mode).label}${t.reason ? `, ${enumLabel(t.reason)}` : ''}`;
}

function score(n: number | null): string {
  return n === null ? '-' : n.toFixed(1);
}

function share(n: number | null): string {
  return n === null ? '-' : `${(n * 100).toFixed(1)}%`;
}

// ─── Integrity signal review ───────────────────────────────────────────────

const REVIEW_LABELS: Record<SignalReviewStatus, string> = {
  reviewed: 'Reviewed',
  cleared: 'Cleared',
  actioned: 'Actioned',
};

function SignalRecord({
  signal: s,
  onReviewed,
}: {
  signal: LightningIntegritySignal;
  onReviewed: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SignalReviewStatus>('reviewed');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!s.id || saving) return;
    setSaving(true);
    try {
      const answer = await reviewLightningSignal(s.id, status, note);
      if (answer.status === 'ok') {
        toast.success(`Signal Marked ${REVIEW_LABELS[status]}`);
        setOpen(false);
        setNote('');
        onReviewed();
      } else if (answer.status === 'denied') {
        toast.error('Only Club Owners And Administrators Can Review Signals');
      } else if (answer.status === 'unavailable') {
        toast.error('Signal Review Is Not Available Yet');
      } else if (answer.status === 'refused') {
        toast.error(`Review Refused: ${enumLabel(answer.code)}`);
      } else {
        toast.error('The Review Could Not Be Saved');
      }
    } finally {
      setSaving(false);
    }
  };

  const ink = SEVERITY_INK[s.severity ?? ''] ?? 'muted';
  const players = [s.playerA, s.playerB].filter(Boolean).map((p) => shortId(p));
  return (
    <li className={styles.record} data-signal-id={s.id ?? undefined}>
      <div className={styles.recordHead}>
        <span className={`${styles.recordName} sc-ink--silver`}>
          {s.pattern ? enumLabel(s.pattern) : 'Signal'}
        </span>
        <span className={`${styles.mode} sc-ink--${ink}`}>
          {s.severity ? enumLabel(s.severity) : 'Unrated'}
        </span>
      </div>
      <span className={`${styles.recordMeta} sc-ink--muted`}>
        {`Score ${s.score ?? '-'}, ${s.status ? enumLabel(s.status) : 'Open'}`}
        {players.length ? `, Players ${players.join(' And ')}` : ''}
        {s.windowEnd ? `, ${stampLabel(s.windowStart)} To ${stampLabel(s.windowEnd)}` : ''}
      </span>
      {s.notes ? <p className={`sc-copy sc-ink--muted ${styles.state}`}>{s.notes}</p> : null}
      {open ? (
        <div className={styles.review}>
          <div className={styles.words} role="group" aria-label="Review Decision">
            {SIGNAL_REVIEW_STATUSES.map((st) => (
              <button
                key={st}
                type="button"
                className={`${styles.word} ${status === st ? 'sc-ink--white' : 'sc-ink--muted'}`}
                aria-pressed={status === st}
                onClick={() => setStatus(st)}
              >
                {REVIEW_LABELS[st]}
              </button>
            ))}
          </div>
          <label className={styles.field}>
            <span className="sc-label sc-ink--blue">Review Note</span>
            <input
              className={styles.fieldInput}
              value={note}
              maxLength={2000}
              placeholder="What You Found"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className={styles.words}>
            <button
              type="button"
              className={`${styles.word} sc-ink--muted`}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${styles.word} sc-ink--white`}
              onClick={() => void save()}
              disabled={saving || !s.id}
            >
              {saving ? 'Saving' : 'Save Review'}
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.words}>
          <button
            type="button"
            className={`${styles.word} sc-ink--white`}
            onClick={() => setOpen(true)}
            disabled={!s.id}
          >
            Review
          </button>
        </div>
      )}
    </li>
  );
}

// ─── Hand replay and session trail (on demand) ─────────────────────────────

function HandReplayCheck({ clusterId }: { clusterId: string }) {
  const [handId, setHandId] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<OperatorAnswer<LightningHandReplay> | null>(null);
  const valid = UUID.test(handId.trim());

  const check = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      setAnswer(await fetchLightningHandReplay(clusterId, handId.trim()));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="lightning-hand-replay" title="Hand Replay Check">
      <label className={styles.field}>
        <span className="sc-label sc-ink--blue">Hand ID</span>
        <input
          className={styles.fieldInput}
          value={handId}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="The Lightning Hand ID"
          onChange={(e) => {
            setHandId(e.target.value);
            setAnswer(null);
          }}
        />
      </label>
      <div className={styles.words}>
        <button
          type="button"
          className={`${styles.word} sc-ink--white`}
          onClick={() => void check()}
          disabled={!valid || busy}
        >
          {busy ? 'Checking' : 'Check Hand'}
        </button>
      </div>
      {answer && answer.status !== 'ok' ? (
        <AnswerState answer={answer} onRetry={() => void check()} />
      ) : null}
      {answer?.status === 'ok' ? (
        <div>
          <Row
            label="Replay"
            value={answer.data.consistent ? 'Consistent' : 'Defects Found'}
            ink={answer.data.consistent ? 'green' : 'red'}
          />
          <Row
            label="Settled"
            value={answer.data.settled === null ? 'Unknown' : answer.data.settled ? 'Yes' : 'No'}
          />
          <Row label="Epoch" value={count(answer.data.epoch)} />
          {answer.data.handNumber !== null ? (
            <Row label="Hand Number" value={String(answer.data.handNumber)} />
          ) : null}
          {answer.data.players.length > 0 ? (
            <ul className={styles.grid} aria-label="Hand Players">
              <li className={styles.gridRow}>
                <span className={`${styles.gridHead} sc-ink--muted`}>Seat</span>
                <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>
                  Before
                </span>
                <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>After</span>
                <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>Net</span>
              </li>
              {answer.data.players.map((p, i) => (
                <li className={styles.gridRow} key={p.playerId ?? i}>
                  <span className={`${styles.gridName} sc-ink--blue`}>
                    {`${p.seat ?? '-'}, ${shortId(p.playerId)}`}
                    {foldLabel(p.foldType) ? `, ${foldLabel(p.foldType)}` : ''}
                  </span>
                  <span className={`${styles.gridCell} sc-ink--silver`}>
                    {p.stackBefore === null ? '-' : compactChips(p.stackBefore)}
                  </span>
                  <span className={`${styles.gridCell} sc-ink--silver`}>
                    {p.stackAfter === null ? '-' : compactChips(p.stackAfter)}
                  </span>
                  <span
                    className={`${styles.gridCell} sc-ink--${(p.net ?? 0) < 0 ? 'red' : (p.net ?? 0) > 0 ? 'green' : 'silver'}`}
                  >
                    {p.net === null ? '-' : compactChips(p.net)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {answer.data.defects.map((d, i) => (
            <Row
              key={`${d.code}-${i}`}
              label={enumLabel(d.code)}
              value={d.detail ?? 'Defect'}
              ink="red"
            />
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function SessionTrail({
  clusterId,
  poolSessionId,
  onPoolSessionId,
}: {
  clusterId: string;
  poolSessionId: string;
  onPoolSessionId: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<OperatorAnswer<LightningSessionTrail> | null>(null);
  const [answered, setAnswered] = useState('');
  const wanted = poolSessionId.trim();
  const valid = UUID.test(wanted);

  const show = useCallback(
    async (id: string) => {
      if (!UUID.test(id)) return;
      setBusy(true);
      try {
        const next = await fetchLightningSessionTrail(clusterId, id);
        setAnswer(next);
        setAnswered(id);
      } finally {
        setBusy(false);
      }
    },
    [clusterId]
  );

  const current = answered === wanted ? answer : null;
  const trail = current?.status === 'ok' ? current.data : null;
  return (
    <Section id="lightning-session-trail" title="Player Session Trail">
      <label className={styles.field}>
        <span className="sc-label sc-ink--blue">Pool Session ID</span>
        <input
          className={styles.fieldInput}
          value={poolSessionId}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="Tap Trail On A Reconcile Row, Or Paste One"
          onChange={(e) => onPoolSessionId(e.target.value)}
        />
      </label>
      <div className={styles.words}>
        <button
          type="button"
          className={`${styles.word} sc-ink--white`}
          onClick={() => void show(wanted)}
          disabled={!valid || busy}
        >
          {busy ? 'Reading' : 'Show Trail'}
        </button>
      </div>
      {current && current.status !== 'ok' ? (
        <AnswerState answer={current} onRetry={() => void show(wanted)} />
      ) : null}
      {trail ? (
        <>
          <Row label="State" value={trail.state ? enumLabel(trail.state) : 'Unknown'} />
          <Row label="Entered" value={stampLabel(trail.enteredAt)} />
          <Row
            label="Exited"
            value={
              trail.exitedAt
                ? `${stampLabel(trail.exitedAt)}${trail.exitReason ? `, ${enumLabel(trail.exitReason)}` : ''}`
                : 'Still In The Pool'
            }
          />
          <span className={`${styles.recordMeta} sc-ink--muted`}>Session Steps</span>
          {trail.steps.length === 0 ? (
            <Empty>No Steps Recorded</Empty>
          ) : (
            <ol className={styles.trail} aria-label="Session Steps">
              {trail.steps.map((step, i) => (
                <li className={styles.trailStep} key={`${step.at}-${i}`}>
                  <span className={`${styles.gridName} sc-ink--silver`}>
                    {step.label}
                    {step.detail ? `, ${step.detail}` : ''}
                  </span>
                  <span className={`${styles.gridCell} sc-ink--muted`}>{stampLabel(step.at)}</span>
                </li>
              ))}
            </ol>
          )}
          <span className={`${styles.recordMeta} sc-ink--muted`}>
            Mode Transitions During This Session
          </span>
          {trail.transitions.length === 0 ? (
            <Empty>No Mode Transition Overlapped This Session</Empty>
          ) : (
            <ol className={styles.trail} aria-label="Overlapping Mode Transitions">
              {trail.transitions.map((t, i) => (
                <li className={styles.trailStep} key={`${t.kind}-${t.at}-${i}`}>
                  <span className={`${styles.gridName} sc-ink--silver`}>{transitionLine(t)}</span>
                  <span className={`${styles.gridCell} sc-ink--muted`}>{stampLabel(t.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </Section>
  );
}

// ─── The latency section ───────────────────────────────────────────────────

function LatencySection({ detail }: { detail: Detail }) {
  const withData = LATENCY_LEGS.filter((leg) =>
    detail.latencyWindows.some((w) => w.legs[leg] !== undefined)
  );
  const [picked, setPicked] = useState<LatencyLeg | null>(null);
  const leg: LatencyLeg | null =
    picked && withData.includes(picked) ? picked : (withData[0] ?? null);
  const latest = detail.latencyWindows[0] ?? null;

  return (
    <Section id="lightning-latency" title="Action Latency">
      {detail.latencyWindows.length === 0 || !leg ? (
        <Empty>No Latency Windows In This Range</Empty>
      ) : (
        <>
          <div className={styles.words} role="group" aria-label="Latency Leg">
            {withData.map((l) => (
              <button
                key={l}
                type="button"
                className={`${styles.word} ${l === leg ? 'sc-ink--white' : 'sc-ink--muted'}`}
                aria-pressed={l === leg}
                onClick={() => setPicked(l)}
              >
                {LATENCY_LEG_LABELS[l]}
              </button>
            ))}
          </div>
          <Suspense fallback={<div className={styles.chart} aria-hidden="true" />}>
            <LightningLatencyChart windows={detail.latencyWindows} leg={leg} />
          </Suspense>
          {latest ? (
            <>
              <span className={`${styles.recordMeta} sc-ink--muted`}>
                {`Latest Window, ${stampLabel(latest.windowTo)}`}
              </span>
              <LatencyGrid legs={latest.legs} />
            </>
          ) : null}
        </>
      )}
    </Section>
  );
}

// ─── The detail console ────────────────────────────────────────────────────

export default function LightningClusterDetail({
  clusterId,
  onBack,
}: {
  clusterId: string;
  onBack: () => void;
}) {
  const [windowKey, setWindowKey] = useState<DetailWindowKey>('24h');
  const [poolSessionId, setPoolSessionId] = useState('');
  const span = DETAIL_WINDOWS.find((w) => w.key === windowKey) ?? DETAIL_WINDOWS[2];

  const read = usePolledAnswer<Detail>(
    `cluster:${clusterId}:${windowKey}`,
    () => {
      const to = new Date();
      return fetchLightningCluster(clusterId, new Date(to.getTime() - span.ms), to);
    },
    CLUSTER_REFRESH_MS
  );
  const answer = read.answer;
  const detail = answer?.status === 'ok' ? answer.data : null;
  const c = detail?.cluster ?? null;
  const badge = modeBadge(c?.mode ?? null);
  const now = read.refreshedAt ?? Date.now();

  return (
    <SpadeConsole
      className={styles.console}
      family="riveted"
      eyebrow="Lightning"
      title={c?.name ? titleCase(c.name) : 'Lightning Cluster'}
      titleId="lightning-cluster-title"
      pill={c ? badge.label : 'Cluster'}
      pillInk={c ? MODE_INK[badge.tone] : 'muted'}
      plates={{
        secondary: { label: 'All Clusters', onClick: onBack },
        primary: {
          label: read.loading ? 'Reading' : 'Refresh',
          ink: 'white',
          onClick: read.refresh,
        },
      }}
    >
      <div className={styles.words} role="group" aria-label="Time Window">
        {DETAIL_WINDOWS.map((w) => (
          <button
            key={w.key}
            type="button"
            className={`${styles.word} ${windowKey === w.key ? 'sc-ink--white' : 'sc-ink--muted'}`}
            aria-pressed={windowKey === w.key}
            onClick={() => setWindowKey(w.key)}
          >
            {w.label}
          </button>
        ))}
      </div>

      {!detail ? (
        <AnswerState answer={answer} onRetry={read.refresh} />
      ) : (
        <>
          <Section id="lightning-status" title="Conversion State">
            <Row
              label="Mode"
              value={badge.detail ? `${badge.label}, ${badge.detail}` : badge.label}
              ink={MODE_INK[badge.tone]}
            />
            <Row label="Epoch" value={count(c?.epoch ?? null)} />
            <Row
              label="Live Eligible / On / Off"
              value={`${count(c?.liveEligible ?? null)} / ${count(c?.onThreshold ?? null)} / ${count(c?.offThreshold ?? null)}`}
            />
            {c?.modeSince ? <Row label="In Mode Since" value={agoLabel(c.modeSince, now)} /> : null}
            {c?.frozen ? (
              <Row
                label="Frozen"
                value={`${c.frozen.reason ? enumLabel(c.frozen.reason) : 'Frozen'}${c.frozen.invariant ? `, ${enumLabel(c.frozen.invariant)}` : ''}`}
                ink="red"
              />
            ) : null}
            {c?.stuckConversion ? (
              <Row
                label="Conversion Stuck"
                value={`${
                  c.stuckConversion.fromMode && c.stuckConversion.toMode
                    ? `${modeBadge(c.stuckConversion.fromMode).label} To ${modeBadge(c.stuckConversion.toMode).label}, `
                    : ''
                }Open Since ${agoLabel(c.stuckConversion.openedAt, now)}`}
                ink="red"
              />
            ) : null}
            <Row
              label="Quality Score"
              value={detail.quality ? score(detail.quality.score) : 'Not Scored Yet'}
            />
            <Row label="Worker" value={c?.workerMode ? enumLabel(c.workerMode) : 'Unknown'} />
          </Section>

          <Section id="lightning-transitions" title="Mode Transitions">
            {detail.transitions.length === 0 ? (
              <Empty>No Mode Transitions Recorded</Empty>
            ) : (
              <ol className={styles.trail} aria-label="Mode Transitions">
                {detail.transitions.map((t, i) => (
                  <li className={styles.trailStep} key={`${t.kind}-${t.at}-${i}`}>
                    <span
                      className={`${styles.gridName} sc-ink--${t.kind === 'freeze' ? 'red' : 'silver'}`}
                    >
                      {transitionLine(t)}
                    </span>
                    <span className={`${styles.gridCell} sc-ink--muted`}>{stampLabel(t.at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section id="lightning-holds" title="Open Holds">
            {detail.reservations.length === 0 ? (
              <Empty>No Open Holds</Empty>
            ) : (
              detail.reservations.map((r, i) => (
                <Row
                  key={r.id ?? i}
                  label={`Seat ${r.seatNumber ?? '-'}, Player ${shortId(r.playerId)}`}
                  value={`${r.orphan ? 'Orphan, ' : ''}${r.state ? enumLabel(r.state) : 'Unknown'}${r.expiresAt ? `, Expires ${stampLabel(r.expiresAt)}` : ''}`}
                  ink={r.orphan ? 'red' : 'silver'}
                />
              ))
            )}
          </Section>

          <Section id="lightning-blind-ledger" title="Blind Ledger">
            {detail.blindLedger.length === 0 ? (
              <Empty>No Open Blind Obligations</Empty>
            ) : (
              <ul className={styles.grid} aria-label="Open Blind Obligations">
                <li className={styles.gridRow}>
                  <span className={`${styles.gridHead} sc-ink--muted`}>Player</span>
                  <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>
                    Missed BB
                  </span>
                  <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>
                    Missed SB
                  </span>
                  <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>
                    Owed
                  </span>
                </li>
                {detail.blindLedger.map((b, i) => (
                  <li className={styles.gridRow} key={b.playerId ?? i}>
                    <span className={`${styles.gridName} sc-ink--blue`}>{shortId(b.playerId)}</span>
                    <span className={`${styles.gridCell} sc-ink--silver`}>
                      {count(b.missedBbDebt)}
                    </span>
                    <span className={`${styles.gridCell} sc-ink--silver`}>
                      {count(b.missedSbDebt)}
                    </span>
                    <span className={`${styles.gridCell} sc-ink--silver`}>
                      {b.bbOwed === null && b.sbOwed === null
                        ? '-'
                        : compactChips((b.bbOwed ?? 0) + (b.sbOwed ?? 0))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="lightning-reconcile" title="Stack Reconcile">
            {detail.reconcile.length === 0 ? (
              <Empty>No Open Pool Sessions To Reconcile</Empty>
            ) : (
              <ul className={styles.grid} aria-label="Stack Reconcile">
                <li className={styles.gridRow}>
                  <span className={`${styles.gridHead} sc-ink--muted`}>Player</span>
                  <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>
                    Anchor
                  </span>
                  <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>
                    Exposure
                  </span>
                  <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>
                    Pool
                  </span>
                </li>
                {detail.reconcile.map((r, i) => {
                  const ink: ConsoleInk = r.ok ? 'silver' : 'red';
                  const gap = reconcileGap(r);
                  const note = r.ok
                    ? ''
                    : gap !== null && Math.abs(gap) >= 1
                      ? `, Off By ${compactChips(gap)}`
                      : ', Not Reconciled';
                  return (
                    <li
                      className={styles.gridRow}
                      key={r.poolSessionId ?? i}
                      data-reconciled={r.ok ? 'true' : 'false'}
                    >
                      <span className={`${styles.gridName} sc-ink--${r.ok ? 'blue' : 'red'}`}>
                        {`${shortId(r.playerId)}${note}`}
                        {r.poolSessionId ? (
                          <button
                            type="button"
                            className={`${styles.word} ${styles.cellWord} sc-ink--white`}
                            onClick={() => setPoolSessionId(r.poolSessionId as string)}
                          >
                            Trail
                          </button>
                        ) : null}
                      </span>
                      <span className={`${styles.gridCell} sc-ink--${ink}`}>
                        {r.anchorStack === null ? '-' : compactChips(r.anchorStack)}
                      </span>
                      <span className={`${styles.gridCell} sc-ink--${ink}`}>
                        {r.exposure === null ? '-' : compactChips(r.exposure)}
                      </span>
                      <span className={`${styles.gridCell} sc-ink--${ink}`}>
                        {r.poolStack === null ? '-' : compactChips(r.poolStack)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section id="lightning-shadow" title="Candidate Matcher">
            {detail.shadow.length === 0 ? (
              <Empty>No Candidate Comparisons In This Range</Empty>
            ) : (
              detail.shadow.map((p, i) => (
                <div key={`${p.liveVersion}-${p.candidateVersion}-${i}`}>
                  <Row
                    label={
                      p.aaCalibration
                        ? `Calibration: Live ${p.liveVersion ?? '-'} / Port ${p.candidateVersion ?? '-'}`
                        : `Live ${p.liveVersion ?? '-'} / Candidate ${p.candidateVersion ?? '-'}`
                    }
                    value={verdictLabel(p.verdict)}
                    ink={
                      p.verdict === 'shadow_leads' || p.verdict === 'calibrated'
                        ? 'green'
                        : p.verdict === 'calibration_bias'
                          ? 'red'
                          : p.verdict === 'live_leads'
                            ? 'silver'
                            : 'muted'
                    }
                  />
                  <Row
                    label="Comparisons / Windows"
                    value={`${count(p.comparisons)} / ${count(p.windows)}`}
                  />
                  <Row
                    label="Live / Candidate Quality"
                    value={`${score(p.liveQualityMean)} / ${score(p.candidateQualityMean)}`}
                  />
                  <Row
                    label="Delta Mean (Min / Max)"
                    value={`${signed(p.deltaMean)} (${signed(p.deltaMin)} / ${signed(p.deltaMax)})`}
                  />
                  <Row label="Candidate Better" value={share(p.candidateBetterShare)} />
                  {p.components.length > 0 ? (
                    <ul className={styles.grid} aria-label="Candidate Components">
                      <li className={styles.gridRow}>
                        <span className={`${styles.gridHead} sc-ink--muted`}>Component</span>
                        <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>
                          Live
                        </span>
                        <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>
                          Candidate
                        </span>
                        <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>
                          Delta
                        </span>
                      </li>
                      {p.components.map((m) => (
                        <li className={styles.gridRow} key={m.key}>
                          <span className={`${styles.gridName} sc-ink--blue`}>
                            {shadowMetricLabel(m.key)}
                          </span>
                          <span className={`${styles.gridCell} sc-ink--silver`}>
                            {reading(m.live)}
                          </span>
                          <span className={`${styles.gridCell} sc-ink--silver`}>
                            {reading(m.candidate)}
                          </span>
                          <span className={`${styles.gridCell} sc-ink--silver`}>
                            {signedReading(m.delta)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))
            )}
          </Section>

          <Section id="lightning-signals" title="Integrity Signals">
            {detail.signals.length === 0 ? (
              <Empty>No Integrity Signals In This Range</Empty>
            ) : (
              <ul className={styles.records} aria-label="Integrity Signals">
                {detail.signals.map((s, i) => (
                  <SignalRecord key={s.id ?? i} signal={s} onReviewed={read.refresh} />
                ))}
              </ul>
            )}
          </Section>

          <Section id="lightning-alerts" title="Open Alerts">
            {detail.alerts.length === 0 ? (
              <Empty>No Open Alerts</Empty>
            ) : (
              detail.alerts.map((a, i) => (
                <Row
                  key={a.id ?? i}
                  label={alertTitle(a)}
                  value={`${a.severity ? enumLabel(a.severity) : 'Alert'}, ${agoLabel(a.createdAt, now)}`}
                  ink={
                    a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'gold' : 'silver'
                  }
                />
              ))
            )}
          </Section>

          <LatencySection detail={detail} />

          <HandReplayCheck clusterId={clusterId} />

          <SessionTrail
            clusterId={clusterId}
            poolSessionId={poolSessionId}
            onPoolSessionId={setPoolSessionId}
          />
        </>
      )}
    </SpadeConsole>
  );
}
