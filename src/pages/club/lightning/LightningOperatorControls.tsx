/**
 * LIGHTNING OPERATOR CONTROLS (Lightning Phase 13, Spec Phase 22: Operator
 * Controls, Emergency Drain, Cluster Freeze, Rollback).
 *
 * The act half of the Spec's OPERATOR CONTROLS, printed in the Cluster
 * detail beneath its Conversion State: pause and resume, disable and enable
 * joins, drain Lightning, freeze (and, for a platform administrator,
 * unfreeze), enable and disable Lightning, the matcher version (set,
 * disable, enable, roll back) and the feature flags. Beside them, the drain's
 * live progress and the Rollout Readiness verdict.
 *
 * Every control goes through ONE door, fn_lightning_operator_control, behind
 * a confirm dialog that requires a reason and sends a fresh request id; the
 * three that stop a Cluster hard (Drain Lightning, Freeze Cluster, Disable
 * Lightning) also ask the operator to type the Cluster's name. The dialog
 * shows what the door says changed, before and after, or the refusal in plain
 * words. It sends once: the button is disabled and a ref guards the call
 * while it is in flight, and a retry after a fault reuses the same request
 * id, so the door answers it idempotently instead of acting twice.
 *
 * The database decides every outcome. A drain is the database's state
 * machine; nothing here moves a player (Law 10.6), reads which players are
 * horses (Law 10.5) or shows a card.
 *
 * #ClubArenaConsole: the section prints on the detail console's glass as
 * rows and lit words; the confirm dialog is its own spade console with the
 * two painted plates (Cancel on steel, the action on blue glass, or red ink
 * when it stops the Cluster), and the only things drawn are the underlines
 * of its text fields.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SpadeConsole, type ConsoleInk } from '../../../components/console/SpadeConsole';
import { useToast } from '../../../components/common/Toast';
import { formatPopupText } from '../../../utils/popupStyle';
import { titleCase } from '../../../utils/titleCase';
import {
  agoLabel,
  enumLabel,
  modeBadge,
  shortId,
  stampLabel,
  type LightningDrain,
  type LightningOverviewCluster,
  type OperatorAnswer,
} from '../../../lightning/lightningOperatorApi';
import {
  ACTION_EXPLAINERS,
  ACTION_LABELS,
  MIN_REASON_LENGTH,
  READINESS_LABELS,
  SWITCHABLE_FLAGS,
  confirmationMatches,
  confirmationPhrase,
  deadlineLabel,
  deadlineSeconds,
  drainPhaseLabel,
  fetchRolloutReadiness,
  flagLabel,
  isDestructive,
  matcherVersionChoices,
  newRequestId,
  reasonIsValid,
  refusalWords,
  sendOperatorControl,
  specFlags,
  stateChanges,
  type ControlResult,
  type LightningReadiness,
  type OperatorAction,
} from '../../../lightning/lightningOperatorControls';
import { AnswerState, count } from './lightningOperatorParts';
import styles from '../ClubLightningOperationsPage.module.css';

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

/** One lit word that opens a control. Red ink for the three that stop a Cluster. */
function ControlWord({
  action,
  label,
  onPick,
  disabled,
}: {
  action: OperatorAction;
  label?: string;
  onPick: (action: OperatorAction) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${styles.word} ${isDestructive(action) ? 'sc-ink--red' : 'sc-ink--white'}`}
      data-control={action}
      onClick={() => onPick(action)}
      disabled={disabled}
    >
      {label ?? ACTION_LABELS[action]}
    </button>
  );
}

const SUCCESS_WORDS: Record<OperatorAction, string> = {
  pause: 'Cluster Paused',
  resume: 'Cluster Resumed',
  disable_joins: 'Lightning Joins Disabled',
  enable_joins: 'Lightning Joins Enabled',
  drain: 'Lightning Drain Started',
  freeze: 'Cluster Frozen',
  unfreeze: 'Cluster Unfrozen',
  enable_lightning: 'Lightning Enabled',
  disable_lightning: 'Lightning Disabled',
  set_matcher_version: 'Matcher Version Set',
  disable_matcher_version: 'Matcher Version Disabled',
  enable_matcher_version: 'Matcher Version Enabled',
  rollback_matcher_version: 'Matcher Rolled Back',
  set_flag: 'Feature Flag Changed',
};

// ─── The confirm dialog ────────────────────────────────────────────────────

export interface ControlRequest {
  action: OperatorAction;
  /** set_flag only: which flag and the value it is set to. */
  flag?: string;
  value?: boolean;
}

type DialogPhase =
  | { kind: 'compose' }
  | { kind: 'sending' }
  | { kind: 'done'; result: ControlResult }
  | { kind: 'refused'; code: string }
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string };

const VERSIONED: ReadonlySet<OperatorAction> = new Set<OperatorAction>([
  'set_matcher_version',
  'disable_matcher_version',
  'enable_matcher_version',
]);

/** The versions a matcher action may be pointed at (for a set, the ones
 *  that would change the chosen role: not its current version, not disabled). */
export function versionsFor(
  action: OperatorAction,
  c: LightningOverviewCluster,
  role: 'live' | 'shadow' = 'live'
): string[] {
  const all = matcherVersionChoices(c.matcher);
  const current = (role === 'live' ? c.matcher?.version : c.matcher?.shadowVersion) ?? null;
  const disabled = c.matcher?.disabled ?? [];
  if (action === 'set_matcher_version') {
    return all.filter((v) => v !== current && !disabled.includes(v));
  }
  if (action === 'disable_matcher_version') return all.filter((v) => !disabled.includes(v));
  if (action === 'enable_matcher_version') return disabled;
  return [];
}

export function ControlDialog({
  cluster: c,
  request,
  onClose,
  onChanged,
}: {
  cluster: LightningOverviewCluster;
  request: ControlRequest;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { action } = request;
  const destructive = isDestructive(action);
  const clusterName = c.name ? titleCase(c.name) : null;
  const phrase = confirmationPhrase(action, clusterName);
  /* set_matcher_version sets the live matcher or the candidate the engine
     shadows. The live one can only be a version the SQL matcher implements;
     the door says so (NOT_SQL_MATCHER) if another is asked for. */
  const [role, setRole] = useState<'live' | 'shadow'>('live');
  const versions = VERSIONED.has(action) ? versionsFor(action, c, role) : [];

  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [picked, setVersion] = useState<string | null>(null);
  // A pick the role no longer offers is no pick; a single choice is made for you.
  const version =
    picked && versions.includes(picked) ? picked : versions.length === 1 ? versions[0] : null;
  const [phase, setPhase] = useState<DialogPhase>({ kind: 'compose' });

  /* ONE request id per decision. Made when the dialog opens; kept across a
     retry after a fault (the door may have acted, and the same id makes the
     repeat idempotent); replaced after a refusal, which acted on nothing. */
  const requestIdRef = useRef<string>(newRequestId());
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sending = phase.kind === 'sending';
  const settled = phase.kind === 'done' || phase.kind === 'denied' || phase.kind === 'unavailable';
  const reasonOk = reasonIsValid(reason);
  const typedOk = !destructive || confirmationMatches(typed, phrase);
  const versionOk = !VERSIONED.has(action) || version !== null;
  const ready = reasonOk && typedOk && versionOk && !sending && !settled;

  const submit = async () => {
    if (!ready || inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase({ kind: 'sending' });
    const args: Record<string, unknown> & { request_id: string } = {
      request_id: requestIdRef.current,
    };
    if (VERSIONED.has(action) && version) args.version = version;
    if (action === 'set_matcher_version') args.role = role;
    if (action === 'set_flag') {
      args.flag = request.flag;
      args.value = request.value;
    }
    let answer: OperatorAnswer<ControlResult>;
    try {
      answer = await sendOperatorControl(c.clusterId, action, reason, args);
    } finally {
      inFlightRef.current = false;
    }
    if (!mountedRef.current) return;
    if (answer.status === 'ok') {
      setPhase({ kind: 'done', result: answer.data });
      if (answer.data.already) toast.info('Already In That State. Nothing Changed');
      else if (answer.data.idempotent) toast.info('Already Done. Nothing Changed Twice');
      else toast.success(SUCCESS_WORDS[action]);
      onChanged();
    } else if (answer.status === 'refused') {
      requestIdRef.current = newRequestId();
      setPhase({ kind: 'refused', code: answer.code });
      toast.error(refusalWords(answer.code));
    } else if (answer.status === 'denied') {
      setPhase({ kind: 'denied' });
    } else if (answer.status === 'unavailable') {
      setPhase({ kind: 'unavailable' });
    } else {
      setPhase({ kind: 'failed', message: answer.message });
    }
  };

  // Escape closes unless a send is in flight; Tab cannot leave the dialog.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!inFlightRef.current) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', onKeyDown);
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [onKeyDown]);

  const flagLine =
    action === 'set_flag' && request.flag
      ? `${flagLabel(request.flag)}: Turn ${request.value ? 'On' : 'Off'}`
      : null;
  const title =
    action === 'set_flag' && request.flag ? flagLabel(request.flag) : ACTION_LABELS[action];
  const closeUnlessSending = sending ? undefined : onClose;

  const body = (
    <>
      <p className={`sc-copy sc-copy--center ${styles.dialogCopy}`}>
        {formatPopupText(ACTION_EXPLAINERS[action])}
      </p>
      {flagLine ? <Row label="Change" value={flagLine} ink="white" /> : null}

      {phase.kind === 'done' ? (
        <DoneView result={phase.result} />
      ) : phase.kind === 'denied' ? (
        <p className={`sc-copy sc-copy--center ${styles.state}`} role="status">
          {action === 'unfreeze'
            ? 'Only A Platform Administrator Can Unfreeze A Cluster.'
            : 'Operator Controls Are Available To Club Owners And Administrators.'}
        </p>
      ) : phase.kind === 'unavailable' ? (
        <p className={`sc-copy sc-copy--center ${styles.state}`} role="status">
          Not Available Yet. Operator Controls Arrive With The Next Database Release.
        </p>
      ) : (
        <>
          {action === 'set_matcher_version' ? (
            <div className={styles.field}>
              <span className="sc-label sc-ink--blue">Set As</span>
              <div className={styles.words} role="group" aria-label="Matcher Role">
                {(['live', 'shadow'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`${styles.word} ${role === r ? 'sc-ink--white' : 'sc-ink--muted'}`}
                    aria-pressed={role === r}
                    onClick={() => setRole(r)}
                    disabled={sending}
                  >
                    {r === 'live' ? 'Live Matcher' : 'Candidate'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {VERSIONED.has(action) ? (
            versions.length === 0 ? (
              <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--muted`}>
                No Version Can Take This Change Right Now
              </p>
            ) : (
              <div className={styles.field}>
                <span className="sc-label sc-ink--blue">Version</span>
                <div className={styles.words} role="group" aria-label="Matcher Version">
                  {versions.map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`${styles.word} ${version === v ? 'sc-ink--white' : 'sc-ink--muted'}`}
                      aria-pressed={version === v}
                      onClick={() => setVersion(v)}
                      disabled={sending}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : null}
          <label className={styles.field}>
            <span className="sc-label sc-ink--blue">Reason</span>
            <input
              ref={firstFieldRef}
              className={styles.fieldInput}
              value={reason}
              maxLength={500}
              placeholder="Why, For The Audit Trail"
              aria-describedby="lightning-control-reason-rule"
              onChange={(e) => setReason(e.target.value)}
              disabled={sending}
            />
            <span
              id="lightning-control-reason-rule"
              className={`${styles.fieldHint} sc-ink--muted`}
            >
              {`At Least ${MIN_REASON_LENGTH} Characters`}
            </span>
          </label>
          {destructive ? (
            <label className={styles.field}>
              <span className="sc-label sc-ink--red">{`Type ${phrase} To Confirm`}</span>
              <input
                className={styles.fieldInput}
                value={typed}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                placeholder={phrase}
                onChange={(e) => setTyped(e.target.value)}
                disabled={sending}
              />
            </label>
          ) : null}
          {phase.kind === 'refused' ? (
            <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--red`} role="alert">
              {refusalWords(phase.code)}
            </p>
          ) : null}
          {phase.kind === 'failed' ? (
            <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--red`} role="alert">
              {`${phase.message}. Sending Again Is Safe: It Cannot Act Twice.`}
            </p>
          ) : null}
        </>
      )}
      {settled ? (
        <div className={styles.words}>
          <button type="button" className={`${styles.word} sc-ink--white`} onClick={onClose}>
            Close
          </button>
        </div>
      ) : null}
    </>
  );

  const dialog = (
    <div className={styles.dialogBackdrop} onClick={closeUnlessSending}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lightning-control-title"
        aria-busy={sending || undefined}
        data-popup-chassis="none"
        data-control-dialog={action}
        onClick={(e) => e.stopPropagation()}
      >
        {settled ? (
          <SpadeConsole
            as="div"
            family="spade"
            eyebrow={clusterName ?? 'Lightning'}
            title={title}
            titleId="lightning-control-title"
            pill={
              phase.kind === 'done' ? 'Done' : phase.kind === 'denied' ? 'Restricted' : 'Not Yet'
            }
            pillInk={phase.kind === 'done' ? 'green' : 'muted'}
            foot="foot"
            onClose={onClose}
          >
            {body}
          </SpadeConsole>
        ) : (
          <SpadeConsole
            as="div"
            family="spade"
            eyebrow={clusterName ?? 'Lightning'}
            title={title}
            titleId="lightning-control-title"
            pill={phase.kind === 'refused' ? 'Refused' : destructive ? 'Sure?' : 'Confirm'}
            pillInk={phase.kind === 'refused' || destructive ? 'red' : 'blue'}
            onClose={closeUnlessSending}
            plates={{
              secondary: { label: 'Cancel', onClick: onClose, disabled: sending },
              primary: {
                label: sending ? 'Sending' : phase.kind === 'failed' ? 'Send Again' : 'Confirm',
                ink: destructive ? 'red' : 'white',
                onClick: () => void submit(),
                disabled: !ready,
              },
            }}
          >
            {body}
          </SpadeConsole>
        )}
      </div>
    </div>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

function DoneView({ result }: { result: ControlResult }) {
  const changes = stateChanges(result.before, result.after);
  const changed = changes.filter((ch) => ch.changed);
  return (
    <div>
      {result.already ? (
        <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--gold`} role="status">
          The Cluster Is Already In That State. Nothing Changed.
        </p>
      ) : result.idempotent ? (
        <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--gold`} role="status">
          This Request Was Already Answered. Nothing Changed Twice.
        </p>
      ) : null}
      <ul className={styles.grid} aria-label="Before And After">
        <li className={styles.changeRow}>
          <span className={`${styles.gridHead} sc-ink--muted`}>State</span>
          <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>Before</span>
          <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>After</span>
        </li>
        {changes.map((ch) => (
          <li
            className={styles.changeRow}
            key={ch.label}
            data-changed={ch.changed ? 'true' : 'false'}
          >
            <span className={`${styles.gridName} sc-ink--blue`}>{ch.label}</span>
            <span className={`${styles.gridCell} sc-ink--${ch.changed ? 'silver' : 'muted'}`}>
              {ch.before}
            </span>
            <span className={`${styles.gridCell} sc-ink--${ch.changed ? 'green' : 'muted'}`}>
              {ch.changed ? `→ ${ch.after}` : ch.after}
            </span>
          </li>
        ))}
      </ul>
      {changed.length === 0 && !result.idempotent ? (
        <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--muted`}>
          Recorded. The Change Takes Effect At The Next Boundary.
        </p>
      ) : null}
      {result.eventId ? <Row label="Audit Event" value={`#${result.eventId}`} /> : null}
    </div>
  );
}

// ─── The drain, live ───────────────────────────────────────────────────────

export function DrainProgress({ drain }: { drain: LightningDrain }) {
  // A second-by-second clock for the deadline, only while a drain is shown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const secs = deadlineSeconds(drain.deadlineAt, now);
  const deadlineInk: ConsoleInk = secs === null ? 'muted' : secs <= 10 ? 'red' : 'gold';
  return (
    <Section id="lightning-drain" title="Drain Progress">
      <div role="status" aria-live="polite">
        <Row label="Step" value={drainPhaseLabel(drain.phase)} ink="gold" />
      </div>
      <Row
        label="Requested"
        value={`${agoLabel(drain.requestedAt, now)}${drain.requestedBy ? `, By ${shortId(drain.requestedBy)}` : ''}`}
      />
      {drain.reason ? <Row label="Reason" value={titleCase(drain.reason)} /> : null}
      {drain.fromMode ? <Row label="Drained From" value={modePhrase(drain.fromMode)} /> : null}
      <Row
        label="Deadline"
        value={drain.overdue ? 'Passed' : deadlineLabel(drain.deadlineAt, now)}
        ink={drain.overdue ? 'red' : deadlineInk}
      />
      <Row label="Instances Remaining" value={count(drain.instancesRemaining)} />
      <Row label="Hands Remaining" value={count(drain.handsRemaining)} />
      <Row label="Sessions Remaining" value={count(drain.sessionsRemaining)} />
      <p className={`sc-copy ${styles.empty} sc-ink--muted`}>
        Hands Already Dealing Are Never Cut. After The Deadline Only Instances That Never Dealt Are
        Abandoned, And No Chips Move.
      </p>
    </Section>
  );
}

// ─── Rollout readiness ─────────────────────────────────────────────────────

const VERDICT_INK: Record<string, ConsoleInk> = {
  go: 'green',
  no_go: 'red',
  insufficient_evidence: 'gold',
};

export function RolloutReadiness({ clusterId }: { clusterId: string }) {
  const [answer, setAnswer] = useState<OperatorAnswer<LightningReadiness> | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const liveRef = useRef(true);

  const check = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const next = await fetchRolloutReadiness(clusterId);
      if (liveRef.current) setAnswer(next);
    } finally {
      busyRef.current = false;
      if (liveRef.current) setBusy(false);
    }
  }, [clusterId]);

  // Read once when the Cluster opens. It is not polled: a verdict is asked for.
  useEffect(() => {
    liveRef.current = true;
    setAnswer(null);
    void check();
    return () => {
      liveRef.current = false;
    };
  }, [check]);

  const r = answer?.status === 'ok' ? answer.data : null;
  return (
    <Section id="lightning-readiness" title="Rollout Readiness">
      {!r ? (
        <AnswerState answer={answer} onRetry={() => void check()} />
      ) : (
        <>
          <Row
            label="Verdict"
            value={r.verdict ? READINESS_LABELS[r.verdict] : 'Unknown'}
            ink={VERDICT_INK[r.verdict ?? ''] ?? 'muted'}
          />
          {r.reasons.length === 0 ? (
            <p className={`sc-copy ${styles.empty} sc-ink--muted`}>Nothing Stands In The Way</p>
          ) : (
            <ul className={styles.reasons} aria-label="Readiness Reasons">
              {r.reasons.map((reason, i) => (
                <li
                  key={`${reason.code}-${i}`}
                  className={styles.reason}
                  data-reason-code={reason.code}
                >
                  <span
                    className={`${styles.reasonSeverity} sc-ink--${reason.severity === 'blocking' ? 'red' : 'gold'}`}
                  >
                    {reason.severity === 'blocking' ? 'Blocking' : 'Evidence'}
                  </span>
                  <span className="sc-ink--silver">
                    {reason.text}
                    {reason.detail ? `: ${reason.detail}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {r.checks.length > 0 ? (
            <ul className={styles.grid} aria-label="Readiness Evidence">
              {r.checks.map((ch) => (
                <li className={styles.trailStep} key={ch.label}>
                  <span className={`${styles.gridName} sc-ink--blue`}>
                    {ch.label}
                    {ch.detail ? `, ${ch.detail}` : ''}
                  </span>
                  <span
                    className={`${styles.gridCell} sc-ink--${ch.ok === null ? 'muted' : ch.ok ? 'green' : 'red'}`}
                  >
                    {ch.ok === null ? '-' : ch.ok ? 'Pass' : 'Fail'}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {r.asOf ? (
            <span
              className={`${styles.recordMeta} sc-ink--muted`}
            >{`Checked ${stampLabel(r.asOf)}`}</span>
          ) : null}
        </>
      )}
      <div className={styles.words}>
        <button
          type="button"
          className={`${styles.word} sc-ink--white`}
          onClick={() => void check()}
          disabled={busy}
        >
          {busy ? 'Checking' : 'Check Again'}
        </button>
      </div>
    </Section>
  );
}

// ─── The section ───────────────────────────────────────────────────────────

/** "Must Move", "Lightning", "Converting To Lightning": a mode in a phrase. */
function modePhrase(mode: string): string {
  const b = modeBadge(mode);
  return b.detail && b.tone === 'pending' && mode.startsWith('pending') ? b.detail : b.label;
}

/**
 * Unfreeze is shown on every frozen Cluster: the doors do not say whether the
 * viewer is a platform administrator, so the control door judges, and a club
 * operator who asks is told plainly that only a platform administrator can.
 */
export default function LightningOperatorControls({
  cluster: c,
  onChanged,
}: {
  cluster: LightningOverviewCluster;
  onChanged: () => void;
}) {
  const [request, setRequest] = useState<ControlRequest | null>(null);
  const pick = (action: OperatorAction) => setRequest({ action });

  const frozen = c.mode === 'frozen' || c.frozen !== null;
  const draining = c.drain !== null || c.mode === 'draining';
  const paused = c.paused === true || c.mode === 'paused';
  const joinsOpen = c.joinsEnabled !== false;
  const m = c.matcher;
  const flags = specFlags(c.flagValues);

  return (
    <Section id="lightning-controls" title="Operator Controls">
      <Row
        label="Paused"
        value={
          paused
            ? `Yes${c.pausedFrom ? `, From ${modePhrase(c.pausedFrom)}` : ''}`
            : c.paused === null
              ? 'Unknown'
              : 'No'
        }
        ink={paused ? 'gold' : 'silver'}
      />
      <Row
        label="Lightning Joins"
        value={c.joinsEnabled === null ? 'Unknown' : joinsOpen ? 'Open' : 'Closed'}
        ink={joinsOpen ? 'silver' : 'gold'}
      />
      <Row label="Lightning" value={c.lightningEnabled ? 'On' : 'Off'} />
      {frozen ? (
        <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--red`} role="status">
          Frozen. Every Control But Unfreeze Waits Until A Platform Administrator Lifts It.
        </p>
      ) : null}

      <span className={`${styles.recordMeta} ${styles.subhead} sc-ink--muted`}>Cluster</span>
      <div className={styles.words} role="group" aria-label="Cluster Controls">
        {paused ? (
          <ControlWord action="resume" onPick={pick} disabled={frozen} />
        ) : (
          <ControlWord action="pause" onPick={pick} disabled={frozen} />
        )}
        {joinsOpen ? (
          <ControlWord action="disable_joins" onPick={pick} disabled={frozen} />
        ) : (
          <ControlWord action="enable_joins" onPick={pick} disabled={frozen} />
        )}
        <ControlWord
          action="drain"
          label={draining ? 'Drain In Progress' : undefined}
          onPick={pick}
          disabled={frozen || draining}
        />
        {frozen ? (
          <ControlWord action="unfreeze" onPick={pick} />
        ) : (
          <ControlWord action="freeze" onPick={pick} />
        )}
      </div>

      <span className={`${styles.recordMeta} ${styles.subhead} sc-ink--muted`}>Lightning</span>
      <div className={styles.words} role="group" aria-label="Lightning Controls">
        {c.lightningEnabled ? (
          <ControlWord action="disable_lightning" onPick={pick} disabled={frozen || draining} />
        ) : (
          <ControlWord action="enable_lightning" onPick={pick} disabled={frozen} />
        )}
      </div>

      <span className={`${styles.recordMeta} ${styles.subhead} sc-ink--muted`}>
        Matcher Version
      </span>
      <Row label="Live" value={m?.version ?? 'Unknown'} ink="white" />
      <Row label="Roll Back Target" value={m?.previous ?? 'None'} />
      <Row label="Candidate" value={m?.shadowVersion ?? 'None'} />
      <Row
        label="Candidate Recording"
        value={m?.shadowDisabled === null || !m ? 'Unknown' : m.shadowDisabled ? 'Off' : 'On'}
        ink={m?.shadowDisabled ? 'gold' : 'silver'}
      />
      <Row label="Disabled" value={m && m.disabled.length ? m.disabled.join(', ') : 'None'} />
      <div className={styles.words} role="group" aria-label="Matcher Controls">
        <ControlWord
          action="set_matcher_version"
          label="Set Version"
          onPick={pick}
          disabled={frozen}
        />
        <ControlWord
          action="disable_matcher_version"
          label="Disable Version"
          onPick={pick}
          disabled={frozen}
        />
        <ControlWord
          action="enable_matcher_version"
          label="Enable Version"
          onPick={pick}
          disabled={frozen || !m || m.disabled.length === 0}
        />
        <ControlWord
          action="rollback_matcher_version"
          label="Roll Back"
          onPick={pick}
          disabled={frozen || !m?.previous}
        />
      </div>

      <span className={`${styles.recordMeta} ${styles.subhead} sc-ink--muted`}>Feature Flags</span>
      {flags.length === 0 ? (
        <p className={`sc-copy ${styles.empty} sc-ink--muted`}>No Feature Flags Reported</p>
      ) : (
        <ul className={styles.grid} aria-label="Feature Flags">
          {flags.map(({ flag, value }) => (
            <li className={styles.flagRow} key={flag} data-flag={flag}>
              <span className={`${styles.gridName} sc-ink--blue`}>{flagLabel(flag)}</span>
              <span className={`${styles.gridCell} sc-ink--${value ? 'green' : 'muted'}`}>
                {value === null ? 'Unknown' : value ? 'On' : 'Off'}
              </span>
              {flag === 'lightning_v1' ? (
                <span className={`${styles.gridCell} sc-ink--muted`}>Above</span>
              ) : !SWITCHABLE_FLAGS.has(flag) ? (
                <span className={`${styles.gridCell} sc-ink--muted`}>Always On</span>
              ) : (
                <button
                  type="button"
                  className={`${styles.word} ${styles.flagWord} sc-ink--white`}
                  onClick={() => setRequest({ action: 'set_flag', flag, value: !value })}
                  disabled={frozen || value === null}
                >
                  {value ? 'Turn Off' : 'Turn On'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {request ? (
        <ControlDialog
          cluster={c}
          request={request}
          onClose={() => setRequest(null)}
          onChanged={onChanged}
        />
      ) : null}
    </Section>
  );
}
