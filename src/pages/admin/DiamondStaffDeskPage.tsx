/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND STAFF DESK (Diamond Phase 10, line 4)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Add staff-only game configuration, incident review and audited
 * adjustments." Item 8 of the build list in
 * docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md: one platform-staff route,
 * linked from the Financial Admin Hub, over doors that were all built first.
 *
 *   Games        open, edit, configure and close Diamond cash tables; cancel
 *                events and remove a player (fn_poker_diamond_*). Creating an
 *                event stays a door for now: its configuration (blinds,
 *                payouts) is a form of its own.
 *   Incidents    the Diamond incident board, one row's trail and review, and
 *                a whole rule family closed in one act (fn_ca_diamond_incident_*).
 *   Books        the health report as the hourly watch last read it, the
 *                trial balance and the register against supply.
 *   Adjustments  the queue with its receipts; propose, approve, reject and
 *                settle (fn_ca_diamond_adjustment_*).
 *
 * The arena's own paths render the safe shell for everybody, so the desk
 * lives outside them, as /financial-incidents does. PlatformStaffGuard closes
 * the route; every door asks fn_is_platform_admin() again and every act is on
 * the record there (admin_audit_log, the incident trail, the register). A
 * refusal is printed as the door named it, never guessed.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { confirmDialog } from '../../components/common/confirmDialog';
import DiamondIncidentReviewService, {
  incidentRefusalCopy,
  isRefusal,
  type DiamondIncident,
  type ReviewAnswer,
  type IncidentFamilyCount,
  type IncidentSeverity,
  type IncidentStatusFilter,
} from '../../services/DiamondIncidentReviewService';
import {
  approveDiamondAdjustment,
  proposeDiamondAdjustment,
  rejectDiamondAdjustment,
  settleDiamondAdjustment,
  type DiamondAdjustmentAnswer,
  type DiamondAdjustmentRefusal,
} from '../../services/DiamondAdjustmentService';
import {
  DIAMOND_CASH_GAMES,
  cancelDiamondEvent,
  closeDiamondTable,
  editDiamondTable,
  listDiamondEntries,
  listDiamondEvents,
  listDiamondTables,
  openDiamondTable,
  readAdjustmentQueue,
  readDiamondBooks,
  readHealthReading,
  refusalWords,
  removeDiamondEntry,
  setDiamondBombPot,
  setDiamondRunItTwice,
  setDiamondStraddle,
  titleWords,
  type DiamondTable,
  type QueuedAdjustment,
  type TableStakes,
} from '../../services/DiamondStaffDeskService';
import '../AdminDashboardPage.css';

type Note = { ok: boolean; text: string } | null;

const GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
  gap: 8,
  margin: '8px 0',
} as const;
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;
const LIST = { display: 'grid', gap: 8, marginBottom: 16 } as const;
const RED = { background: 'rgba(239,68,68,0.15)', color: '#f87171' };
const CLOSED = ['closed', 'completed', 'cancelled', 'finished', 'deleted'];

const words = (e: unknown) => (e instanceof Error ? e.message : refusalWords(String(e)));
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'Not Set');
const num = (n: unknown) =>
  n === null || n === undefined || n === '' ? 'Unknown' : Number(n).toLocaleString();
const game = (v: string) => v.replace('_', ' ').toUpperCase();
const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const whole = (f: FormData, k: string) => (field(f, k) === '' ? null : Number(field(f, k)));

/** One read: its answer, or why it could not be read. */
function useRead<T>(read: () => Promise<T>) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    read().then(
      (data) => setState({ data, loading: false }),
      (e) => setState({ error: words(e), loading: false })
    );
  }, [read]);
  useEffect(load, [load]);
  return { ...state, load };
}

/** One act at a time: busy while it runs, then what it answered. */
function useAct(after?: () => void) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const act = async (run: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ ok: true, text: await run() });
      after?.();
    } catch (e) {
      setNote({ ok: false, text: words(e) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, act };
}

function Banner({ note }: { note: Note }) {
  if (!note) return null;
  return <div className={note.ok ? 'admin-success-banner' : 'admin-error-banner'}>{note.text}</div>;
}

function Loaded<T>({
  read,
  children,
}: {
  read: { data?: T; error?: string; loading: boolean; load: () => void };
  children: (data: T) => ReactNode;
}) {
  if (read.error)
    return (
      <div className="admin-error-banner" style={ROW}>
        <span>Could Not Be Read: {read.error}</span>
        <button
          type="button"
          className="admin-btn admin-btn-ghost admin-btn-sm"
          onClick={read.load}
        >
          Retry
        </button>
      </div>
    );
  if (read.data === undefined) return <div className="admin-skeleton" style={{ height: 60 }} />;
  return <>{children(read.data)}</>;
}

function Badge({ text, tone }: { text: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const cls = tone === 'ok' ? ' admin-badge-green' : tone === 'warn' ? ' admin-badge-yellow' : '';
  return (
    <span className={`admin-badge${cls}`} style={tone === 'bad' ? RED : undefined}>
      {titleWords(text)}
    </span>
  );
}

const tone = (s: string): 'ok' | 'warn' | 'bad' | undefined =>
  s === 'ok' || s === 'resolved' || s === 'settled'
    ? 'ok'
    : s === 'critical' || s === 'unknown' || s === 'rejected'
      ? 'bad'
      : s === 'info'
        ? undefined
        : 'warn';

function Num({ label, name, value }: { label: string; name: string; value?: number | null }) {
  return (
    <label className="admin-label">
      {label}
      <input
        className="admin-input"
        name={name}
        type="number"
        step={1}
        defaultValue={value ?? undefined}
      />
    </label>
  );
}

function StakeFields({ t }: { t?: DiamondTable }) {
  return (
    <div style={GRID}>
      <label className="admin-label">
        Name
        <input className="admin-input" name="name" maxLength={60} defaultValue={t?.name} />
      </label>
      <Num label="Small Blind" name="sb" value={t?.small_blind} />
      <Num label="Big Blind" name="bb" value={t?.big_blind} />
      <Num label="Minimum Buy-In" name="min" value={t?.min_buy_in} />
      <Num label="Maximum Buy-In" name="max" value={t?.max_buy_in} />
      <Num label="Seats" name="seats" value={t?.max_players ?? 6} />
    </div>
  );
}

const stakesOf = (f: FormData): TableStakes => ({
  name: field(f, 'name') || null,
  smallBlind: whole(f, 'sb'),
  bigBlind: whole(f, 'bb'),
  minBuyIn: whole(f, 'min'),
  maxBuyIn: whole(f, 'max'),
  maxPlayers: whole(f, 'seats'),
});

const submit =
  (handle: (f: FormData, action: string) => void) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const button = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    handle(new FormData(e.currentTarget), button?.value ?? '');
  };

/* ── Games ─────────────────────────────────────────────────────────────── */

function TableFeatures({
  t,
  act,
  busy,
}: {
  t: DiamondTable;
  act: ReturnType<typeof useAct>['act'];
  busy: boolean;
}) {
  const straddle = !t.straddle_enabled ? 'off' : t.auto_utg_straddle ? 'auto' : 'on';
  return (
    <form
      onSubmit={submit((f) =>
        act(async () => {
          const s = field(f, 'straddle');
          if (s !== straddle) await setDiamondStraddle(t.id, s !== 'off', s === 'auto');
          const rit = f.get('rit') === 'on';
          if (rit !== !!t.run_it_twice) await setDiamondRunItTwice(t.id, rit);
          const bomb = f.get('bomb') === 'on';
          const ante = whole(f, 'ante') ?? 2;
          const boards = whole(f, 'boards') ?? 1;
          if (
            bomb !== !!t.bomb_pot_enabled ||
            (bomb && (ante !== t.bomb_pot_ante_multiplier || boards !== t.bomb_pot_board_count))
          )
            await setDiamondBombPot(t.id, bomb, ante, boards);
          return `${t.name}: Features Saved`;
        })
      )}
    >
      <div style={GRID}>
        <label className="admin-label">
          Straddle
          <select className="admin-input" name="straddle" defaultValue={straddle}>
            <option value="off">Off</option>
            <option value="on">Voluntary</option>
            <option value="auto">Automatic Under The Gun</option>
          </select>
        </label>
        <label className="admin-label">
          <input type="checkbox" name="rit" defaultChecked={!!t.run_it_twice} /> Run It Twice
        </label>
        <label className="admin-label">
          <input type="checkbox" name="bomb" defaultChecked={!!t.bomb_pot_enabled} /> Bomb Pots
        </label>
        <Num
          label="Bomb Pot Ante (Big Blinds)"
          name="ante"
          value={t.bomb_pot_ante_multiplier ?? 2}
        />
        <Num label="Bomb Pot Boards (1 To 3)" name="boards" value={t.bomb_pot_board_count ?? 1} />
      </div>
      <button className="admin-btn admin-btn-primary admin-btn-sm" disabled={busy}>
        Save Features
      </button>
    </form>
  );
}

function Tables() {
  const tables = useRead(listDiamondTables);
  const { busy, note, act } = useAct(tables.load);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section>
      <h2 className="admin-section-title">Cash Tables</h2>
      <Banner note={note} />
      <form
        className="admin-card"
        style={{ marginBottom: 12 }}
        onSubmit={submit((f) =>
          act(async () => {
            await openDiamondTable(stakesOf(f), field(f, 'game'));
            return 'Table Opened';
          })
        )}
      >
        <h3 className="admin-card-subtitle">Open A Table</h3>
        <StakeFields />
        <label className="admin-label">
          Game
          <select className="admin-input" name="game" defaultValue="nlh">
            {DIAMOND_CASH_GAMES.map((g) => (
              <option key={g} value={g}>
                {game(g)}
              </option>
            ))}
          </select>
        </label>
        <button className="admin-btn admin-btn-primary" disabled={busy}>
          Open Table
        </button>
      </form>
      <Loaded read={tables}>
        {(list) =>
          list.length === 0 ? (
            <div className="admin-empty-state">No Diamond Cash Tables</div>
          ) : (
            <div style={LIST}>
              {list.map((t) => {
                const open = !CLOSED.includes(t.status);
                const features = [
                  t.straddle_enabled && (t.auto_utg_straddle ? 'Auto Straddle' : 'Straddle'),
                  t.run_it_twice && 'Run It Twice',
                  t.bomb_pot_enabled && `Bomb Pots ${t.bomb_pot_ante_multiplier}x`,
                ].filter(Boolean);
                return (
                  <div key={t.id} className="admin-panel-soft">
                    <div style={ROW}>
                      <strong>{t.name}</strong>
                      <Badge text={t.status} tone={open ? 'ok' : undefined} />
                    </div>
                    <div className="admin-text-secondary">
                      {game(t.game_variant)} · {num(t.small_blind)}/{num(t.big_blind)} · Buy-In{' '}
                      {num(t.min_buy_in)} To {num(t.max_buy_in)} · {t.current_players ?? 0}/
                      {t.max_players} Seated{features.length ? ` · ${features.join(', ')}` : ''}
                    </div>
                    {open && (
                      <div style={{ ...ROW, marginTop: 6 }}>
                        <button
                          type="button"
                          className="admin-btn admin-btn-ghost admin-btn-sm"
                          onClick={() => setEditing(editing === t.id ? null : t.id)}
                        >
                          {editing === t.id ? 'Done' : 'Edit'}
                        </button>
                        <button
                          type="button"
                          className="admin-btn admin-btn-danger admin-btn-sm"
                          disabled={busy}
                          onClick={async () => {
                            if (
                              await confirmDialog({
                                title: 'Close Table',
                                message: `Close ${t.name}? A Table Where A Seat Holds Diamonds Is Refused.`,
                                confirmText: 'Close Table',
                                variant: 'danger',
                              })
                            )
                              act(async () => {
                                await closeDiamondTable(t.id);
                                return `${t.name}: Closed`;
                              });
                          }}
                        >
                          Close
                        </button>
                      </div>
                    )}
                    {open && editing === t.id && (
                      <div style={{ marginTop: 8 }}>
                        <form
                          onSubmit={submit((f) =>
                            act(async () => {
                              await editDiamondTable(t.id, stakesOf(f));
                              return `${t.name}: Stakes Saved`;
                            })
                          )}
                        >
                          <StakeFields t={t} />
                          <button
                            className="admin-btn admin-btn-primary admin-btn-sm"
                            disabled={busy}
                          >
                            Save Stakes (Empty Table Only)
                          </button>
                        </form>
                        <TableFeatures t={t} act={act} busy={busy} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        }
      </Loaded>
    </section>
  );
}

function Entries({ eventId, name }: { eventId: string; name: string }) {
  const entries = useRead(useCallback(() => listDiamondEntries(eventId), [eventId]));
  const { busy, note, act } = useAct(entries.load);
  return (
    <div style={{ marginTop: 8 }}>
      <Banner note={note} />
      <Loaded read={entries}>
        {(list) =>
          list.length === 0 ? (
            <div className="admin-text-secondary">Nobody Is Entered</div>
          ) : (
            list.map((p) => (
              <div key={p.user_id} style={ROW}>
                <span>{p.username || p.user_id}</span>
                <Badge text={p.status || 'unknown'} />
                <button
                  type="button"
                  className="admin-btn admin-btn-danger admin-btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: 'Remove Player',
                        message: `Remove ${p.username || 'This Player'} From ${name}? Their Entry Goes Home.`,
                        confirmText: 'Remove',
                        variant: 'danger',
                      })
                    )
                      act(async () => {
                        const r = await removeDiamondEntry(eventId, p.user_id);
                        return `Removed; ${num(r.refunded_diamonds ?? 0)} Diamonds Returned`;
                      });
                  }}
                >
                  Remove
                </button>
              </div>
            ))
          )
        }
      </Loaded>
    </div>
  );
}

function Events() {
  const events = useRead(listDiamondEvents);
  const { busy, note, act } = useAct(events.load);
  const [shown, setShown] = useState<string | null>(null);
  return (
    <section>
      <h2 className="admin-section-title">Events</h2>
      <Banner note={note} />
      <Loaded read={events}>
        {(list) =>
          list.length === 0 ? (
            <div className="admin-empty-state">No Diamond Events</div>
          ) : (
            <div style={LIST}>
              {list.map((e) => (
                <div key={e.id} className="admin-panel-soft">
                  <div style={ROW}>
                    <strong>{e.name}</strong>
                    <Badge text={e.status} />
                  </div>
                  <div className="admin-text-secondary">
                    {titleWords(e.tournament_type || 'event')} · Buy-In {num(e.buy_in_amount)} ·{' '}
                    {e.current_players ?? 0}/{e.max_players ?? 'Open'} Entered · Starts{' '}
                    {when(e.start_time)}
                  </div>
                  <div style={{ ...ROW, marginTop: 6 }}>
                    <button
                      type="button"
                      className="admin-btn admin-btn-ghost admin-btn-sm"
                      onClick={() => setShown(shown === e.id ? null : e.id)}
                    >
                      {shown === e.id ? 'Hide Entries' : 'Entries'}
                    </button>
                    {!CLOSED.includes(e.status) && (
                      <button
                        type="button"
                        className="admin-btn admin-btn-danger admin-btn-sm"
                        disabled={busy}
                        onClick={async () => {
                          if (
                            await confirmDialog({
                              title: 'Cancel Event',
                              message: `Cancel ${e.name}? Every Entry Goes Home.`,
                              confirmText: 'Cancel Event',
                              variant: 'danger',
                            })
                          )
                            act(async () => {
                              const r = await cancelDiamondEvent(e.id);
                              return `${e.name}: Cancelled; ${num(r.refunded_count ?? 0)} Entries Returned`;
                            });
                        }}
                      >
                        Cancel Event
                      </button>
                    )}
                  </div>
                  {shown === e.id && <Entries eventId={e.id} name={e.name} />}
                </div>
              ))}
            </div>
          )
        }
      </Loaded>
    </section>
  );
}

/* ── Incidents ─────────────────────────────────────────────────────────── */

async function answer<T>(p: Promise<ReviewAnswer<T>>): Promise<T> {
  const a = await p;
  if (isRefusal(a)) throw new Error(incidentRefusalCopy(a.error));
  return a;
}

function Review({ incident, after }: { incident: DiamondIncident; after: () => void }) {
  const trail = useRead(
    useCallback(() => answer(DiamondIncidentReviewService.trail(incident.id)), [incident.id])
  );
  const { busy, note, act } = useAct(() => {
    trail.load();
    after();
  });
  const S = DiamondIncidentReviewService;
  return (
    <div style={{ marginTop: 8 }}>
      <pre
        className="admin-mono"
        style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}
      >
        {JSON.stringify(incident.detail, null, 1)}
      </pre>
      <Loaded read={trail}>
        {(t) => (
          <div className="admin-text-secondary">
            {t.events.length === 0
              ? 'No Person Has Reviewed This Incident'
              : t.events.map((ev) => (
                  <div key={ev.id}>
                    {when(ev.at)} · {titleWords(ev.kind)} By {ev.actor_label || ev.actor}
                    {typeof ev.detail.note === 'string' ? `: ${ev.detail.note}` : ''}
                  </div>
                ))}
          </div>
        )}
      </Loaded>
      <Banner note={note} />
      <form
        onSubmit={submit((f, action) =>
          act(async () => {
            const text = field(f, 'note');
            const id = incident.id;
            if (action === 'acknowledge') await answer(S.acknowledge(id, text || null));
            else if (action === 'comment') await answer(S.comment(id, text));
            else if (action === 'resolve') await answer(S.resolve(id, text));
            else await answer(S.reopen(id, text));
            return `Incident ${id}: ${titleWords(action)} Recorded`;
          })
        )}
      >
        <textarea
          className="admin-input admin-textarea"
          name="note"
          rows={2}
          placeholder="Note Or Reason (10 Characters Or More To Resolve Or Reopen)"
        />
        <div style={ROW}>
          {incident.status === 'open' && (
            <button
              className="admin-btn admin-btn-ghost admin-btn-sm"
              value="acknowledge"
              disabled={busy}
            >
              Acknowledge
            </button>
          )}
          <button
            className="admin-btn admin-btn-ghost admin-btn-sm"
            value="comment"
            disabled={busy}
          >
            Comment
          </button>
          {incident.status === 'resolved' ? (
            <button
              className="admin-btn admin-btn-danger admin-btn-sm"
              value="reopen"
              disabled={busy}
            >
              Reopen
            </button>
          ) : (
            <button
              className="admin-btn admin-btn-success admin-btn-sm"
              value="resolve"
              disabled={busy}
            >
              Resolve
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function FamilyClose({ family, after }: { family: IncidentFamilyCount; after: () => void }) {
  const { busy, note, act } = useAct(after);
  return (
    <form
      className="admin-panel-soft"
      onSubmit={submit((f) =>
        act(async () => {
          const severity = (field(f, 'severity') || null) as IncidentSeverity | null;
          const before = field(f, 'before');
          const reason = field(f, 'reason');
          const label = `${family.family}${severity ? ` ${titleWords(severity)}` : ''}`;
          if (
            !(await confirmDialog({
              title: 'Close A Rule Family',
              message: `Resolve Every Open ${label} Row Filed Before ${before ? when(before) : 'Now'} With This One Reason?`,
              confirmText: 'Resolve Them',
              variant: 'danger',
            }))
          )
            return 'Nothing Was Closed';
          const r = await answer(
            DiamondIncidentReviewService.resolveFamily(
              family.family,
              severity,
              before ? new Date(before).toISOString() : null,
              reason
            )
          );
          return `${label}: ${num(r.resolved)} Resolved, ${num(r.skipped_reopened)} Reopened Rows Left For A Person`;
        })
      )}
    >
      <Banner note={note} />
      <div style={GRID}>
        <label className="admin-label">
          Severity
          <select className="admin-input" name="severity" defaultValue="">
            <option value="">All</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label className="admin-label">
          Filed Before (Empty Is Now)
          <input className="admin-input" name="before" type="datetime-local" />
        </label>
      </div>
      <textarea
        className="admin-input admin-textarea"
        name="reason"
        rows={2}
        required
        minLength={10}
        placeholder="The One Reason For Every Row (10 Characters Or More)"
      />
      <button className="admin-btn admin-btn-danger admin-btn-sm" disabled={busy}>
        Close {family.family} Family
      </button>
    </form>
  );
}

function Incidents() {
  const [filter, setFilter] = useState<{
    status: IncidentStatusFilter;
    rule: string | null;
    severity: IncidentSeverity | null;
  }>({ status: 'unresolved', rule: null, severity: null });
  const [rows, setRows] = useState<DiamondIncident[]>([]);
  const [families, setFamilies] = useState<IncidentFamilyCount[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  const load = useCallback(
    async (beforeId: number | null) => {
      try {
        const b = await answer(DiamondIncidentReviewService.board({ ...filter, beforeId }));
        setRows((r) => (beforeId ? [...r, ...b.incidents] : b.incidents));
        setFamilies(b.families);
        setNext(b.next_before_id);
        setError(null);
        setLoaded(true);
      } catch (e) {
        setError(words(e));
      }
    },
    [filter]
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  const reload = () => void load(null);

  return (
    <section>
      <h2 className="admin-section-title">Open Diamond Incidents By Family</h2>
      {error && <div className="admin-error-banner">Could Not Be Read: {error}</div>}
      <div style={LIST}>
        {!loaded && !error && <div className="admin-skeleton" style={{ height: 60 }} />}
        {loaded && families.length === 0 && (
          <div className="admin-empty-state">Nothing Is Open</div>
        )}
        {families.map((f) => (
          <div key={f.family} className="admin-panel-soft">
            <div style={ROW}>
              <strong>{f.family}</strong>
              <span>
                {num(f.open)} Open: {num(f.critical)} Critical, {num(f.warning)} Warning,{' '}
                {num(f.info)} Info; {num(f.older_than_7_days)} Older Than A Week
              </span>
              <button
                type="button"
                className="admin-btn admin-btn-ghost admin-btn-sm"
                onClick={() => setFilter({ ...filter, rule: f.family })}
              >
                Show
              </button>
              <button
                type="button"
                className="admin-btn admin-btn-ghost admin-btn-sm"
                onClick={() => setClosing(closing === f.family ? null : f.family)}
              >
                {closing === f.family ? 'Keep Open' : 'Close Family'}
              </button>
            </div>
            {closing === f.family && <FamilyClose family={f} after={reload} />}
          </div>
        ))}
      </div>
      <div style={GRID}>
        <label className="admin-label">
          Status
          <select
            className="admin-input"
            value={filter.status}
            onChange={(e) =>
              setFilter({ ...filter, status: e.target.value as IncidentStatusFilter })
            }
          >
            {['unresolved', 'open', 'acknowledged', 'resolved', 'all'].map((s) => (
              <option key={s} value={s}>
                {titleWords(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-label">
          Severity
          <select
            className="admin-input"
            value={filter.severity ?? ''}
            onChange={(e) =>
              setFilter({
                ...filter,
                severity: (e.target.value || null) as IncidentSeverity | null,
              })
            }
          >
            <option value="">All</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        {filter.rule && (
          <button
            type="button"
            className="admin-btn admin-btn-ghost admin-btn-sm"
            onClick={() => setFilter({ ...filter, rule: null })}
          >
            Showing {filter.rule}: Show Every Family
          </button>
        )}
      </div>
      <div style={LIST}>
        {loaded && rows.length === 0 && !error && (
          <div className="admin-empty-state">No Incidents Match</div>
        )}
        {rows.map((i) => (
          <div key={i.id} className="admin-panel-soft">
            <div style={ROW}>
              <span className="admin-mono">{i.id}</span>
              <strong>{i.rule}</strong>
              <Badge text={i.severity} tone={tone(i.severity)} />
              <Badge text={i.status} tone={i.status === 'resolved' ? 'ok' : undefined} />
              <button
                type="button"
                className="admin-btn admin-btn-ghost admin-btn-sm"
                onClick={() => setOpen(open === i.id ? null : i.id)}
              >
                {open === i.id ? 'Hide' : 'Review'}
              </button>
            </div>
            <div className="admin-text-secondary">
              {when(i.occurred_at)}
              {i.amount !== null ? ` · Amount ${num(i.amount)}` : ''}
              {i.resolution ? ` · ${i.resolution}` : ''}
            </div>
            {open === i.id && <Review incident={i} after={reload} />}
          </div>
        ))}
        {next !== null && (
          <button
            type="button"
            className="admin-btn admin-btn-ghost"
            onClick={() => void load(next)}
          >
            Load More
          </button>
        )}
      </div>
    </section>
  );
}

/* ── Health And Books ──────────────────────────────────────────────────── */

function Books() {
  const health = useRead(readHealthReading);
  const books = useRead(readDiamondBooks);
  return (
    <section>
      <h2 className="admin-section-title">Health</h2>
      <Loaded read={health}>
        {(h) =>
          !h.read_at ? (
            <div className="admin-empty-state">
              The Hourly Watch Has Not Kept A Reading Yet. It Reads The Report At 35 Minutes Past
              Each Hour.
            </div>
          ) : (
            <div style={LIST}>
              <div className="admin-text-secondary">
                As The Hourly Watch Read It At {when(h.read_at)}
              </div>
              {h.areas.map((a) => (
                <div key={a.area} className="admin-panel-soft">
                  <div style={ROW}>
                    <strong>{titleWords(a.area)}</strong>
                    <Badge text={a.status} tone={tone(a.status)} />
                  </div>
                  <div className="admin-text-secondary">{a.detail}</div>
                </div>
              ))}
            </div>
          )
        }
      </Loaded>
      <h2 className="admin-section-title">Register Against Supply</h2>
      <Loaded read={books}>
        {(b) => (
          <>
            {b.register ? (
              <div className="admin-stats-grid">
                {(
                  [
                    ['Register', b.register.register_net],
                    ['Held In All', b.register.meter_total],
                    ['Players', b.register.player_diamonds],
                    ['House', b.register.house_diamonds],
                    ['Difference', b.register.difference],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="admin-stat-card">
                    <div className="admin-stat-label">{label}</div>
                    <div
                      className="admin-stat-value"
                      style={label === 'Difference' && Number(value) !== 0 ? RED : undefined}
                    >
                      {num(value)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="admin-empty-state">The Register Could Not Be Read</div>
            )}
            <h2 className="admin-section-title">Trial Balance</h2>
            <div className="admin-table-scroll">
              <table className="admin-data-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Now</th>
                    <th>Change</th>
                    <th>Journal</th>
                    <th>Register</th>
                    <th>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {b.trial_balance.map((r) => (
                    <tr key={r.account} title={r.note ?? undefined}>
                      <td>{titleWords(r.account)}</td>
                      <td>{num(r.balance_now)}</td>
                      <td>{num(r.balance_delta)}</td>
                      <td>{num(r.journal_net)}</td>
                      <td>{num(r.mint_net)}</td>
                      <td
                        style={
                          r.difference !== null && Number(r.difference) !== 0 ? RED : undefined
                        }
                      >
                        {r.difference === null ? 'Not Compared' : num(r.difference)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Loaded>
    </section>
  );
}

/* ── Adjustments ───────────────────────────────────────────────────────── */

async function adjusted<T>(p: Promise<DiamondAdjustmentAnswer<T>>): Promise<T> {
  const a = await p;
  const refused = a as DiamondAdjustmentRefusal;
  if (refused.ok === false) throw new Error(refusalWords(refused.refusedReason));
  return a as T;
}

function Adjustment({
  a,
  act,
  busy,
}: {
  a: QueuedAdjustment;
  act: ReturnType<typeof useAct>['act'];
  busy: boolean;
}) {
  const target =
    a.target_kind === 'diamond_house' ? 'The Diamond House' : a.target_label || a.target_id;
  return (
    <div className="admin-panel-soft">
      <div style={ROW}>
        <strong>
          {a.amount > 0 ? '+' : ''}
          {num(a.amount)} Diamonds To {target}
        </strong>
        <Badge text={a.status} tone={tone(a.status)} />
      </div>
      <div className="admin-text-secondary">
        {a.reason} · Proposed By {a.proposed_by_label || a.proposed_by} {when(a.proposed_at)}
        {a.approved_at ? ` · Approved By ${a.approved_by_label || a.approved_by}` : ''}
        {a.rejected_at ? ` · Rejected By ${a.rejected_by_label || a.rejected_by}` : ''}
        {a.decision_note ? ` · ${a.decision_note}` : ''}
        {a.receipt
          ? ` · Settled By ${a.receipt.settled_by_label || a.receipt.settled_by} ${when(a.receipt.settled_at)} From ${titleWords(a.receipt.source)}, Supply Moved ${num(a.receipt.supply_moved)}`
          : ''}
      </div>
      {(a.status === 'proposed' || a.status === 'approved') && (
        <form
          style={{ ...ROW, marginTop: 6 }}
          onSubmit={submit((f, action) =>
            act(async () => {
              if (action === 'settle') {
                if (
                  !(await confirmDialog({
                    title: 'Settle Adjustment',
                    message: `Move ${num(a.amount)} Diamonds For ${target} Now?`,
                    confirmText: 'Settle',
                  }))
                )
                  return 'Nothing Was Settled';
                const r = await adjusted(settleDiamondAdjustment(a.id));
                return r.replayed ? 'Already Settled; Nothing Moved Again' : 'Settled';
              }
              const note = field(f, 'note') || null;
              if (action === 'approve') await adjusted(approveDiamondAdjustment(a.id, note));
              else await adjusted(rejectDiamondAdjustment(a.id, note));
              return action === 'approve' ? 'Approved' : 'Rejected';
            })
          )}
        >
          {a.status === 'proposed' ? (
            <>
              <input
                className="admin-input"
                name="note"
                placeholder="Note (Optional)"
                style={{ flex: 1 }}
              />
              <button
                className="admin-btn admin-btn-success admin-btn-sm"
                value="approve"
                disabled={busy}
              >
                Approve
              </button>
              <button
                className="admin-btn admin-btn-danger admin-btn-sm"
                value="reject"
                disabled={busy}
              >
                Reject
              </button>
            </>
          ) : (
            <button
              className="admin-btn admin-btn-primary admin-btn-sm"
              value="settle"
              disabled={busy}
            >
              Settle
            </button>
          )}
        </form>
      )}
    </div>
  );
}

function Adjustments() {
  const queue = useRead(readAdjustmentQueue);
  const { busy, note, act } = useAct(queue.load);
  return (
    <section>
      <h2 className="admin-section-title">Diamond Adjustments</h2>
      <Banner note={note} />
      <Loaded read={queue}>
        {(q) => (
          <>
            <div className={q.correction_source ? 'admin-panel-soft' : 'admin-error-banner'}>
              {q.correction_source
                ? `Corrections Are Paid By ${titleWords(q.correction_source.source)}, Authorized By ${q.correction_source.authorized_by} ${when(q.correction_source.authorized_at)}`
                : 'Settling Is Refused Until What Pays For A Diamond Correction Is Authorized. Proposing, Approving And Rejecting Work Now.'}
            </div>
            <div className="admin-text-secondary" style={{ margin: '8px 0' }}>
              {(['proposed', 'approved', 'rejected', 'settled'] as const)
                .map((s) => `${titleWords(s)} ${num(q.counts[s] ?? 0)}`)
                .join(' · ')}
            </div>
            <form
              className="admin-card"
              style={{ marginBottom: 12 }}
              onSubmit={submit((f) =>
                act(async () => {
                  const house = field(f, 'target') === 'diamond_house';
                  await adjusted(
                    proposeDiamondAdjustment({
                      targetKind: house ? 'diamond_house' : 'diamond_wallet',
                      targetId: house ? null : field(f, 'player') || null,
                      amount: Number(field(f, 'amount')),
                      reason: field(f, 'reason'),
                    })
                  );
                  return 'Proposed. A Different Staff Member Approves It.';
                })
              )}
            >
              <h3 className="admin-card-subtitle">Propose An Adjustment</h3>
              <div style={GRID}>
                <label className="admin-label">
                  Target
                  <select className="admin-input" name="target" defaultValue="diamond_wallet">
                    <option value="diamond_wallet">A Player Wallet</option>
                    <option value="diamond_house">The Diamond House</option>
                  </select>
                </label>
                <label className="admin-label">
                  Player ID (Wallet Only)
                  <input className="admin-input" name="player" />
                </label>
                <Num label="Diamonds (Minus To Take)" name="amount" />
              </div>
              <textarea
                className="admin-input admin-textarea"
                name="reason"
                rows={2}
                required
                minLength={20}
                placeholder="Reason (20 Characters Or More)"
              />
              <button className="admin-btn admin-btn-primary" disabled={busy}>
                Propose
              </button>
            </form>
            <div style={LIST}>
              {q.adjustments.length === 0 && (
                <div className="admin-empty-state">No Diamond Adjustments Yet</div>
              )}
              {q.adjustments.map((a) => (
                <Adjustment key={a.id} a={a} act={act} busy={busy} />
              ))}
            </div>
          </>
        )}
      </Loaded>
    </section>
  );
}

/* ── The Desk ──────────────────────────────────────────────────────────── */

const TABS = [
  ['games', 'Games'],
  ['incidents', 'Incidents'],
  ['books', 'Health And Books'],
  ['adjustments', 'Adjustments'],
] as const;

export default function DiamondStaffDeskPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('games');
  return (
    <div className="admin-page">
      <div className="admin-container">
        <div className="admin-page-header">
          <div>
            <h1 className="admin-page-title">Diamond Staff Desk</h1>
            <p className="admin-text-secondary">
              Diamond Games, Incidents, Books And Adjustments. Every Act Is Recorded Under Your
              Name.
            </p>
          </div>
        </div>
        <div className="admin-tabs" role="tablist">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`admin-tab${tab === key ? ' active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="admin-tab-content">
          {tab === 'games' && (
            <>
              <Tables />
              <Events />
            </>
          )}
          {tab === 'incidents' && <Incidents />}
          {tab === 'books' && <Books />}
          {tab === 'adjustments' && <Adjustments />}
        </div>
      </div>
    </div>
  );
}
