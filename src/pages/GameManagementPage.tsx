import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import CreateTournamentModal from '../components/club/CreateTournamentModal';
import GameCreationActions, {
  type GameCreationTarget,
} from '../components/club/GameCreationActions';
import TickerManagementPanel from '../components/club/TickerManagementPanel';
import ClubMessageManagementPanel from '../components/club/ClubMessageManagementPanel';
import { useToast } from '../components/common/Toast';
import { confirmDialog } from '../components/common/confirmDialog';
import { useAuthUser } from '../hooks/useAuthUser';
import { useMasterBusSubscriptions } from '../hooks/useMasterBusSubscription';
import { useCoalescedRefresh } from '../hooks/useCoalescedRefresh';
import { useGameManagementRealtime } from '../hooks/useGameManagementRealtime';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useDialogEscape } from '../hooks/useDialogEscape';
import { supabase } from '../lib/supabase';
import { fetchGameCreationAccess } from '../services/GameAccessService';
import {
  gameManagementService,
  type ManagedGameCommandReceipt,
  type ManagedGameContractSummary,
  type ManagedGameContractVersion,
  type ManagedGameKind,
  type ManagedGamePatch,
  type ManagedGameListCursor,
  type GameManagementHealth,
} from '../services/GameManagementService';
import { unionService } from '../services/UnionService';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { mergeById } from '../utils/mergeById';
import { reportError } from '../utils/errorReporter';
import CreateTablePage from './CreateTablePage';
import styles from './GameManagementPage.module.css';

type Scope = 'club' | 'union';
type View = 'all' | 'running' | 'scheduled' | 'closed';
type ManagementSurface = 'games' | 'ticker' | 'messages';

interface HostClub {
  id: string;
  name: string;
}

interface ManagedGame {
  id: string;
  kind: ManagedGameKind;
  name: string;
  status: string;
  clubId: string;
  hostName: string;
  variant: string;
  players: number;
  maxPlayers: number;
  startTime: string | null;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  buyIn: number;
  contract: ManagedGameContractSummary | null;
  lastCommand: ManagedGameCommandReceipt | null;
  pendingSchedule: { scheduleId: string; executeAt: string; status: string } | null;
  /**
   * 0 live, 1 scheduled, 2 closed - decided by fn_list_managed_games and never
   * re-derived here. The board used to compute "scheduled" a second time in
   * this file, as "a tournament that is neither active nor closed", and got
   * the same wrong answer the SQL did: every tournament is REGISTERING, which
   * both lists counted as active, so the Scheduled tab could never match a
   * single row. One definition, on the server, is why that cannot recur.
   */
  bucket: number;
}

/** Mirrors fn_list_managed_games. Read the bucket; never recompute it. */
const BUCKET_LIVE = 0;
const BUCKET_SCHEDULED = 1;
const BUCKET_CLOSED = 2;
/**
 * Which bucket each tab asks the server for. `all` asks for every bucket.
 *
 * These used to be applied here, with games.filter(...), over the ONE page of
 * 100 rows that happened to be loaded - which stopped working the moment the
 * list became bucket-ordered, because then page 1 is entirely live games and
 * the Scheduled and Closed tabs had nothing local to find. A tab is a query.
 */
/**
 * One place that turns a server row into a board row.
 *
 * There were two copies of this object literal and a targeted refresh would
 * have made a third. A board row that means slightly different things
 * depending on which code path produced it is the bug this whole page has been
 * paying for all day.
 */
function toManagedGame(row: any, hostNames: Record<string, string>, fallbackName: string) {
  return {
    id: row.id,
    kind: row.kind,
    bucket: Number(row.bucket ?? 0),
    name: row.name,
    status: row.status,
    clubId: row.club_id,
    hostName: hostNames[row.club_id] || fallbackName,
    variant: row.variant || (row.kind === 'table' ? 'NLH' : 'MTT'),
    players: row.players || 0,
    maxPlayers: row.max_players || 0,
    startTime: row.start_time ?? null,
    smallBlind: Number(row.small_blind || 0),
    bigBlind: Number(row.big_blind || 0),
    minBuyIn: Number(row.min_buy_in || 0),
    maxBuyIn: Number(row.max_buy_in || 0),
    buyIn: Number(row.buy_in || 0),
    contract: row.contract || null,
    lastCommand: row.lastCommand || null,
    pendingSchedule: row.pending_schedule
      ? {
          scheduleId: row.pending_schedule.schedule_id,
          executeAt: row.pending_schedule.execute_at,
          status: row.pending_schedule.status,
        }
      : null,
  };
}

/**
 * Above this many distinct games changed at once, one full board read is
 * cheaper than N targeted ones. The feed reaches 421 table updates in a
 * minute, so the busy case must NOT turn into a request storm of its own.
 */
const TARGETED_REFRESH_MAX = 8;

const VIEW_BUCKET: Record<View, number | null> = {
  all: null,
  running: BUCKET_LIVE,
  scheduled: BUCKET_SCHEDULED,
  closed: BUCKET_CLOSED,
};
const CREATE_TARGETS = new Set<GameCreationTarget>(['table', 'event', 'spin', 'sng']);
/** A refresh keeps the identity of every row it did not change. */
const mergeManagedGames = (current: ManagedGame[], next: ManagedGame[]): ManagedGame[] =>
  mergeById(current, next, (row) => row.id);

const GAME_REFRESH_EVENTS = [
  'TABLE_CREATED',
  'TABLE_UPDATED',
  'TABLE_CLOSED',
  'TOURNAMENT_UPDATED',
  'TOURNAMENT_REGISTERED',
  'TOURNAMENT_CANCELLED',
] as const;

function formatTime(value: string | null): string {
  if (!value) return 'Starts when ready';
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The tooltip on the events-per-hour tile. `lastEventAt` is read from the
 * health RPC and, until now, was fetched on every load and never shown - so an
 * operator watching a rate could not tell a genuinely quiet floor from a feed
 * that stopped an hour ago. Both read zero; only the timestamp separates them.
 */
function formatEventClock(lastEventAt: string | null): string {
  if (!lastEventAt) return 'No Realtime Event Recorded Yet';
  return `Last Realtime Event ${formatTime(lastEventAt)}`;
}

function toLocalDateTimeInput(value: Date): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ScheduleCloseDialog({
  game,
  busy,
  onClose,
  onSchedule,
}: {
  game: ManagedGame;
  busy: boolean;
  onClose: () => void;
  onSchedule: (executeAt: string) => void;
}) {
  const dialogRef = useFocusTrap<HTMLFormElement>(true);
  const minimum = toLocalDateTimeInput(new Date(Date.now() + 2 * 60_000));
  const [executeAt, setExecuteAt] = useState(
    toLocalDateTimeInput(new Date(Date.now() + 60 * 60_000))
  );
  useDialogEscape(true, onClose, busy);
  return (
    <div className={styles.dialogBackdrop} role="presentation">
      <form
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-close-title"
        onSubmit={(event) => {
          event.preventDefault();
          onSchedule(new Date(executeAt).toISOString());
        }}
      >
        <span className={styles.eyebrow}>Governed Lifecycle</span>
        <h2 id="schedule-close-title">Schedule Close</h2>
        <p>
          {game.name} Will Close Only If Its Contract Is Unchanged And No Players Are Seated Or
          Registered When The Command Runs.
        </p>
        <label>
          Execute At
          <input
            type="datetime-local"
            min={minimum}
            value={executeAt}
            onChange={(event) => setExecuteAt(event.target.value)}
            required
          />
        </label>
        <div className={styles.dialogActions}>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={styles.primary} disabled={busy || !executeAt}>
            {busy ? 'Scheduling…' : 'Schedule Close'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function EditGameDialog({
  game,
  busy,
  onClose,
  onSave,
}: {
  game: ManagedGame;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: ManagedGamePatch) => void;
}) {
  const dialogRef = useFocusTrap<HTMLFormElement>(true);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [name, setName] = useState(game.name);
  const [smallBlind, setSmallBlind] = useState(String(game.smallBlind || 1));
  const [bigBlind, setBigBlind] = useState(String(game.bigBlind || 2));
  const [minBuyIn, setMinBuyIn] = useState(String(game.minBuyIn || 40));
  const [maxBuyIn, setMaxBuyIn] = useState(String(game.maxBuyIn || 200));
  const [maxPlayers, setMaxPlayers] = useState(String(game.maxPlayers || 9));
  const [startTime, setStartTime] = useState(
    game.startTime ? new Date(game.startTime).toISOString().slice(0, 16) : ''
  );
  const tableStructureLocked =
    game.kind === 'table' &&
    (Boolean(game.contract?.contractLocked) ||
      ['running', 'active'].includes(game.status.toLowerCase()));

  const dirty =
    name !== game.name ||
    (!tableStructureLocked && maxPlayers !== String(game.maxPlayers || 9)) ||
    (game.kind === 'table' &&
      !tableStructureLocked &&
      (smallBlind !== String(game.smallBlind || 1) ||
        bigBlind !== String(game.bigBlind || 2) ||
        minBuyIn !== String(game.minBuyIn || 40) ||
        maxBuyIn !== String(game.maxBuyIn || 200))) ||
    (game.kind === 'tournament' &&
      startTime !== (game.startTime ? new Date(game.startTime).toISOString().slice(0, 16) : ''));

  const requestClose = useCallback(() => {
    if (busy) return;
    if (!dirty) {
      onClose();
      return;
    }
    void confirmDialog({
      message: 'Discard the unsaved game changes?',
      variant: 'danger',
    }).then((confirmed) => {
      if (confirmed) onClose();
    });
  }, [busy, dirty, onClose]);

  useDialogEscape(true, requestClose, busy);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const buildPatch = (): ManagedGamePatch | null => {
    const trimmedName = name.replace(/\s+/g, ' ').trim();
    const seats = Number(maxPlayers);
    if (!trimmedName) {
      setValidationError('Enter a game name.');
      return null;
    }
    if (!tableStructureLocked && (!Number.isInteger(seats) || seats < 2)) {
      setValidationError('Maximum players must be a whole number of at least two.');
      return null;
    }
    const patch: ManagedGamePatch = { name: trimmedName };
    if (!tableStructureLocked) patch.maxPlayers = seats;
    if (game.kind === 'table' && !tableStructureLocked) {
      const small = Number(smallBlind);
      const big = Number(bigBlind);
      const minimum = Number(minBuyIn);
      const maximum = Number(maxBuyIn);
      if (![small, big, minimum, maximum].every(Number.isFinite) || small <= 0) {
        setValidationError('Enter positive numeric blinds and buy-in limits.');
        return null;
      }
      if (big < small) {
        setValidationError('The big blind cannot be lower than the small blind.');
        return null;
      }
      if (maximum < minimum) {
        setValidationError('The maximum buy-in cannot be lower than the minimum buy-in.');
        return null;
      }
      if (seats > 10) {
        setValidationError('Cash tables support a maximum of ten seats.');
        return null;
      }
      patch.smallBlind = small;
      patch.bigBlind = big;
      patch.minBuyIn = minimum;
      patch.maxBuyIn = maximum;
    } else if (startTime) {
      const timestamp = new Date(startTime);
      if (!Number.isFinite(timestamp.getTime())) {
        setValidationError('Enter a valid tournament start time.');
        return null;
      }
      patch.startTime = timestamp.toISOString();
    }
    setValidationError(null);
    return patch;
  };

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.currentTarget === e.target) requestClose();
      }}
    >
      <form
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-game-title"
        aria-describedby="edit-game-description"
        onSubmit={(e) => {
          e.preventDefault();
          const patch = buildPatch();
          if (patch) onSave(patch);
        }}
      >
        <span className={styles.eyebrow}>Safe Pre-Game Changes</span>
        <h2 id="edit-game-title">Edit {game.kind === 'table' ? 'Table' : 'Tournament'}</h2>
        <label>
          Game Name
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Maximum Players
          <input
            type="number"
            min="2"
            max={game.kind === 'table' ? '10' : '1000000'}
            value={maxPlayers}
            onChange={(e) => setMaxPlayers(e.target.value)}
            disabled={tableStructureLocked}
            required
          />
        </label>
        {game.kind === 'table' ? (
          <div className={styles.fieldGrid}>
            <label>
              Small Blind
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={smallBlind}
                onChange={(e) => setSmallBlind(e.target.value)}
                disabled={tableStructureLocked}
                required
              />
            </label>
            <label>
              Big Blind
              <input
                type="number"
                min="0.02"
                step="0.01"
                value={bigBlind}
                onChange={(e) => setBigBlind(e.target.value)}
                disabled={tableStructureLocked}
                required
              />
            </label>
            <label>
              Minimum Buy-In
              <input
                type="number"
                min="1"
                step="1"
                value={minBuyIn}
                onChange={(e) => setMinBuyIn(e.target.value)}
                disabled={tableStructureLocked}
                required
              />
            </label>
            <label>
              Maximum Buy-In
              <input
                type="number"
                min="1"
                step="1"
                value={maxBuyIn}
                onChange={(e) => setMaxBuyIn(e.target.value)}
                disabled={tableStructureLocked}
                required
              />
            </label>
          </div>
        ) : (
          <label>
            Start Time
            <input
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </label>
        )}
        <p id="edit-game-description">
          {tableStructureLocked
            ? 'This Live Table Can Be Renamed. Its Blinds, Buy-In, And Seats Are Locked.'
            : 'Structural Changes Lock As Soon As Players Become Active.'}
        </p>
        {validationError && (
          <p className={styles.dialogError} role="alert">
            {validationError}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button type="button" onClick={requestClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={styles.primary} disabled={busy}>
            {busy ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ContractHistoryDialog({
  game,
  versions,
  loading,
  onClose,
}: {
  game: ManagedGame;
  versions: ManagedGameContractVersion[];
  loading: boolean;
  onClose: () => void;
}) {
  const dialogRef = useFocusTrap(true);
  useDialogEscape(true, onClose);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`${styles.dialog} ${styles.contractDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contract-title"
      >
        <span className={styles.eyebrow}>Published Contract History</span>
        <h2 id="contract-title">{game.name}</h2>
        <p>
          Every Revision Is Hashed And Append-Only. Registered Tournament Contracts Cannot Be
          Rewritten.
        </p>
        {game.kind === 'tournament' && game.contract && (
          <div className={styles.readinessGrid} aria-label="Tournament Guarantee Readiness">
            <span>
              <small>Readiness</small>
              <strong>{game.contract.readiness.state.replace(/_/g, ' ')}</strong>
            </span>
            <span>
              <small>Guarantee</small>
              <strong>{game.contract.readiness.guaranteedPrize}</strong>
            </span>
            <span>
              <small>Overlay Required</small>
              <strong>{game.contract.readiness.overlayRequired}</strong>
            </span>
            <span>
              <small>{game.contract.readiness.bankType || 'Funding'} Bank</small>
              <strong>{game.contract.readiness.bankBalance}</strong>
            </span>
            <span>
              <small>Other Live Promises</small>
              <strong>{game.contract.readiness.otherLiveExposure}</strong>
            </span>
            <span>
              <small>Short By</small>
              <strong>{game.contract.readiness.shortBy}</strong>
            </span>
          </div>
        )}
        {loading ? (
          <div className={styles.contractLoading} role="status" aria-live="polite">
            Loading Contract History…
          </div>
        ) : versions.length === 0 ? (
          <div className={styles.contractLoading} role="status">
            No Published Contract Revisions Were Returned.
          </div>
        ) : (
          <div className={styles.contractVersions}>
            {versions.map((version) => (
              <details key={version.version} open={version.version === versions[0]?.version}>
                <summary>
                  <strong>Version {version.version}</strong>
                  <span>{new Date(version.publishedAt).toLocaleString()}</span>
                  <code>{version.contractHash.slice(0, 12)}</code>
                </summary>
                <div className={styles.contractMeta}>
                  <span>{version.changeReason.replace(/_/g, ' ')}</span>
                  <span>SHA-256 {version.contractHash}</span>
                </div>
                <pre>{JSON.stringify(version.contract, null, 2)}</pre>
              </details>
            ))}
          </div>
        )}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.primary} onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}

export default function GameManagementPage({ scope }: { scope: Scope }) {
  const { clubId, unionId } = useParams<{ clubId: string; unionId: string }>();
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const createParam = searchParams.get('create');
  const requestedCreate = CREATE_TARGETS.has(createParam as GameCreationTarget)
    ? (createParam as GameCreationTarget)
    : null;
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [scopeName, setScopeName] = useState(scope === 'union' ? 'Union' : 'Club');
  const [hosts, setHosts] = useState<HostClub[]>([]);
  const [hostClubId, setHostClubId] = useState('');
  const [games, setGames] = useState<ManagedGame[]>([]);
  const [counts, setCounts] = useState({
    total: 0,
    live: 0,
    scheduled: 0,
    closed: 0,
    closedWithinHorizon: 0,
    closedHorizonDays: 7,
  });
  const [nextCursor, setNextCursor] = useState<ManagedGameListCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>('all');
  const [surface, setSurface] = useState<ManagementSurface>('games');
  const [surfaceDirty, setSurfaceDirty] = useState(false);
  const [editing, setEditing] = useState<ManagedGame | null>(null);
  const [scheduling, setScheduling] = useState<ManagedGame | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [contractGame, setContractGame] = useState<ManagedGame | null>(null);
  const [contractVersions, setContractVersions] = useState<ManagedGameContractVersion[]>([]);
  const [contractLoading, setContractLoading] = useState(false);
  const [health, setHealth] = useState<GameManagementHealth | null>(null);
  const loadEpochRef = useRef(0);
  const loadedRouteRef = useRef('');
  const loadedViewRef = useRef<View>('all');
  /** Latest rows, so the refresh below never closes over a stale board. */
  const gamesRef = useRef<ManagedGame[]>([]);
  /** Games named by events since the last flush, deduplicated. */
  const changedRef = useRef<Set<string>>(new Set());
  /**
   * An event arrived that did NOT name a game. Not every refresh event is
   * obliged to carry an id, and a targeted refresh cannot act on one that
   * does not - so it forces the full reload rather than quietly doing nothing,
   * which would drop a real change on the floor.
   */
  const sawUnnamedRef = useRef(false);
  // One load at a time, with at most one queued behind it, and a stable handle
  // so the queued one can be started from inside load's own `finally`.
  const loadInFlightRef = useRef(false);
  const rerunRef = useRef(false);
  // The queued load inherits the LOUDEST request that was folded into it. A
  // silent refresh coalesced behind another silent refresh stays silent, but
  // an operator arriving - a route change, a Try Again - must still get the
  // spinner it would have got had nothing been in flight. Losing this is how
  // coalescing turns one bug into a quieter one.
  const rerunSilentRef = useRef(true);
  const mountedRef = useRef(true);
  const loadRef = useRef<(silent?: boolean) => void>(() => {});

  const managementPath =
    scope === 'union' ? `/unions/${unionId}/table-management` : `/clubs/${clubId}/table-management`;

  const clearCreate = () => setSearchParams({}, { replace: true });

  /**
   * @param silent A background refresh - realtime, the master bus, or a command
   *   that just succeeded - rather than an operator arriving. It must never put
   *   an already-rendered board back behind the loading state.
   */
  const load = useCallback(
    async (silent = false) => {
      if (!user?.id) return;
      // Coalesce instead of stacking. Every management event for this scope
      // arrives here as a refresh, and the feed is not quiet: Deep Stack Society
      // alone wrote ~19,900 game_management_events in one hour (5.5 a second),
      // because every running tournament emits one on each row update. A full
      // load is five sequential round trips and was measured at ~11 seconds
      // against production, so refreshes were starting every 2-4 seconds and
      // running five deep. Each one re-asserted setLoading(true) on entry, while
      // the epoch guard let only a load still current at the END clear the flag
      // or publish its rows - and with a newer load always in flight, none ever
      // was. The page sat on "Loading Live Game Controls..." indefinitely with
      // every counter reading 0, while the header, which is set before the first
      // long await, read correctly. That combination is the signature of this
      // bug; if you see it again, look here first.
      if (loadInFlightRef.current) {
        rerunRef.current = true;
        if (!silent) rerunSilentRef.current = false;
        return;
      }
      loadInFlightRef.current = true;
      const requestId = ++loadEpochRef.current;
      const isCurrent = () => loadEpochRef.current === requestId;
      const routeKey = `${scope}:${scope === 'union' ? unionId || '' : clubId || ''}`;
      // A different club or union than the one on screen. The reset below empties
      // the board, so this can never be served silently: without the spinner the
      // operator reads the empty board as "this club has no games".
      const routeChanged = loadedRouteRef.current !== routeKey;
      // Switching tabs asks a different question of the server, so the rows on
      // screen belong to the previous answer. Clear them and show the spinner
      // rather than leaving the old tab's games under the new tab's heading.
      const viewChanged = loadedViewRef.current !== view;
      if (viewChanged) {
        loadedViewRef.current = view;
        setGames([]);
        setNextCursor(null);
      }
      if (routeChanged) {
        loadedRouteRef.current = routeKey;
        setAllowed(null);
        setScopeId(null);
        setHosts([]);
        setHostClubId('');
        setGames([]);
        setCounts({
          total: 0,
          live: 0,
          scheduled: 0,
          closed: 0,
          closedWithinHorizon: 0,
          closedHorizonDays: 7,
        });
        setNextCursor(null);
        setHealth(null);
        setSurfaceDirty(false);
      }
      if (!silent || routeChanged || viewChanged) setLoading(true);
      setLoadError(null);
      try {
        let resolvedScopeId: string;
        let resolvedScopeName: string;
        let nextHosts: HostClub[];
        if (scope === 'club') {
          resolvedScopeId = await resolveClubUUID(clubId || '');
          const [access, clubResult] = await Promise.all([
            fetchGameCreationAccess(resolvedScopeId),
            supabase.from('clubs').select('id,name').eq('id', resolvedScopeId).maybeSingle(),
          ]);
          if (!isCurrent()) return;
          // A member club is operated from its union console, even for a union
          // owner who technically has authority over the underlying rows.
          const standaloneAccess = access.allowed && !access.unionId;
          setAllowed(standaloneAccess);
          if (!standaloneAccess) {
            setScopeId(resolvedScopeId);
            setHosts([]);
            setGames([]);
            setHealth(null);
            setSurfaceDirty(false);
            setLoading(false);
            return;
          }
          if (clubResult.error || !clubResult.data)
            throw clubResult.error || new Error('Club not found');
          resolvedScopeName = clubResult.data.name;
          setScopeName(resolvedScopeName);
          nextHosts = [{ id: resolvedScopeId, name: clubResult.data.name }];
        } else {
          if (!unionId) throw new Error('Union not found');
          resolvedScopeId = unionId;
          const canManage = await unionService.isUnionAdmin(unionId, user.id);
          if (!isCurrent()) return;
          setAllowed(canManage);
          if (!canManage) {
            setScopeId(unionId);
            setHosts([]);
            setGames([]);
            setHealth(null);
            setSurfaceDirty(false);
            setLoading(false);
            return;
          }
          const [unionResult, hostResult] = await Promise.all([
            supabase.from('unions').select('id,name').eq('id', unionId).maybeSingle(),
            supabase.from('union_clubs').select('club_id, clubs(name)').eq('union_id', unionId),
          ]);
          if (!isCurrent()) return;
          if (unionResult.error || !unionResult.data)
            throw unionResult.error || new Error('Union not found');
          if (hostResult.error) throw hostResult.error;
          resolvedScopeName = unionResult.data.name;
          setScopeName(resolvedScopeName);
          nextHosts = (hostResult.data || []).map((row: any) => ({
            id: row.club_id,
            name: row.clubs?.name || 'Union Club',
          }));
        }

        setScopeId(resolvedScopeId);
        setHosts(nextHosts);
        setHostClubId((current) =>
          nextHosts.some((host) => host.id === current) ? current : nextHosts[0]?.id || ''
        );

        // ONE wave. The board row now arrives whole - fn_list_managed_games
        // folds in each game's published contract and latest command receipt -
        // so the four dependent calls that used to sit here are gone, and the
        // health read has no reason to wait for any of it.
        const [page, healthResult] = await Promise.all([
          gameManagementService.list(scope, resolvedScopeId, null, VIEW_BUCKET[view]),
          gameManagementService
            .getHealth(scope, resolvedScopeId)
            .catch((healthError): GameManagementHealth | null => {
              // Health is telemetry beside the board, never a reason to fail it.
              reportError(healthError, 'GameManagementPage.health');
              return null;
            }),
        ]);
        if (!isCurrent()) return;
        const tableRows = page.items.filter((row: any) => row.kind === 'table');
        const tournamentRows = page.items.filter((row: any) => row.kind === 'tournament');
        const hostNames = Object.fromEntries(nextHosts.map((host) => [host.id, host.name]));
        const rows: ManagedGame[] = [
          ...tableRows.map((row: any) => ({
            id: row.id,
            kind: 'table' as const,
            bucket: Number(row.bucket ?? 0),
            name: row.name,
            status: row.status,
            clubId: row.club_id,
            hostName: hostNames[row.club_id] || resolvedScopeName,
            variant: row.variant || 'NLH',
            players: row.players || 0,
            maxPlayers: row.max_players || 0,
            startTime: null,
            smallBlind: Number(row.small_blind || 0),
            bigBlind: Number(row.big_blind || 0),
            minBuyIn: Number(row.min_buy_in || 0),
            maxBuyIn: Number(row.max_buy_in || 0),
            buyIn: 0,
            contract: row.contract || null,
            lastCommand: row.lastCommand || null,
            pendingSchedule: row.pending_schedule
              ? {
                  scheduleId: row.pending_schedule.schedule_id,
                  executeAt: row.pending_schedule.execute_at,
                  status: row.pending_schedule.status,
                }
              : null,
          })),
          ...tournamentRows.map((row: any) => ({
            id: row.id,
            kind: 'tournament' as const,
            bucket: Number(row.bucket ?? 0),
            name: row.name,
            status: row.status,
            clubId: row.club_id,
            hostName: hostNames[row.club_id] || resolvedScopeName,
            variant: row.variant || 'MTT',
            players: row.players || 0,
            maxPlayers: row.max_players || 0,
            startTime: row.start_time,
            smallBlind: 0,
            bigBlind: 0,
            minBuyIn: 0,
            maxBuyIn: 0,
            buyIn: Number(row.buy_in || 0),
            contract: row.contract || null,
            lastCommand: row.lastCommand || null,
            pendingSchedule: row.pending_schedule
              ? {
                  scheduleId: row.pending_schedule.schedule_id,
                  executeAt: row.pending_schedule.execute_at,
                  status: row.pending_schedule.status,
                }
              : null,
          })),
        ];
        /* MERGE BY ID, NEVER REPLACE. `setGames(rows)` handed React a brand
           new object for every row on every refresh, so the whole list
           remounted: rows flashed, an open row menu closed, and the scroll
           position jumped. A row whose fields are unchanged now keeps its
           previous identity and its DOM is left alone, which is what makes a
           background refresh invisible instead of a glitch. */
        setGames((current) => mergeManagedGames(current, rows));
        // Null counts mean unchanged, not zero: a paged read does not recount
        // the scope, and reading null as 0 would blank the header.
        if (page.counts) setCounts(page.counts);
        setNextCursor(page.nextCursor);
        setHealth(healthResult);
      } catch (error) {
        if (!isCurrent()) return;
        reportError(error, 'GameManagementPage.load');
        setLoadError(error instanceof Error ? error.message : 'Could not load games.');
      } finally {
        loadInFlightRef.current = false;
        // Unconditional. The in-flight guard means the load that reaches this
        // line is the only one running, so it is always the one that raised the
        // flag. Gating this on isCurrent() is exactly what starved it before.
        setLoading(false);
        if (rerunRef.current && mountedRef.current) {
          rerunRef.current = false;
          const rerunSilent = rerunSilentRef.current;
          rerunSilentRef.current = true;
          // A refresh arrived mid-flight. Serve it once, at the volume it asked
          // for. Deferred so this load's own state updates commit first.
          setTimeout(() => {
            if (mountedRef.current) loadRef.current(rerunSilent);
          }, 0);
        } else {
          rerunRef.current = false;
          rerunSilentRef.current = true;
        }
      }
    },
    [clubId, scope, unionId, user?.id, view]
  );
  loadRef.current = load;

  // Unmounting retires every load still in flight. Bumping the epoch is what
  // makes isCurrent() false for them, so a request that resolves after the
  // operator has left publishes nothing and starts no follow-on work.
  useEffect(() => {
    // Re-armed on mount, not just initialised at declaration: StrictMode mounts,
    // unmounts and remounts, and a flag only ever set to false would leave the
    // remounted page unable to serve a coalesced refresh for the rest of its life.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadEpochRef.current += 1;
    };
  }, []);

  const loadMore = useCallback(async () => {
    if (!scopeId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await gameManagementService.list(scope, scopeId, nextCursor, VIEW_BUCKET[view]);
      // Same as the first page: the rows already carry their contract and
      // their last command, so Load More is one request, not five.
      const hostNames = Object.fromEntries(hosts.map((host) => [host.id, host.name]));
      const rows: ManagedGame[] = page.items.map((row: any) =>
        toManagedGame(row, hostNames, scopeName)
      );
      setGames((current) => {
        const seen = new Set(current.map((game) => `${game.kind}:${game.id}`));
        return [...current, ...rows.filter((game) => !seen.has(`${game.kind}:${game.id}`))];
      });
      // Null on a paged read means unchanged, not zero.
      if (page.counts) setCounts(page.counts);
      setNextCursor(page.nextCursor);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load more games.');
    } finally {
      setLoadingMore(false);
    }
  }, [hosts, loadingMore, nextCursor, scope, scopeId, scopeName, toast, view]);

  useEffect(() => {
    void load();
  }, [load]);

  // BrowserRouter links do not fire beforeunload. Protect drafts when an
  // operator leaves through the hamburger menu or any other in-app link.
  useEffect(() => {
    if (!surfaceDirty) return;
    const onClickCapture = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as HTMLElement | null)?.closest?.(
        'a[href]'
      ) as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return;
      let destination: URL;
      try {
        destination = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (
        destination.origin !== window.location.origin ||
        (destination.pathname === window.location.pathname &&
          destination.search === window.location.search)
      )
        return;
      if (!window.confirm('Leave Table Management And Discard Your Unsaved Changes?')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('click', onClickCapture, true);
    return () => document.removeEventListener('click', onClickCapture, true);
  }, [surfaceDirty]);

  /* A BACKGROUND REFRESH IS NOT A LIVE VIDEO FEED (Dan 2026-09-02): "CLUBS
     SHOULD NOT BE RANDOMLY REFRESHING ON THEIR OWN, IT FEELS LIKE A BUG OR
     GLITCH ... ITS ALSO HAPPENING INSIDE OF THE TABLE MANAGEMENT PAGE."

     The event feed this page listens to is not an occasional signal - every
     running game writes a game_management_events row on each update, measured
     2026-09-02 at 2,108 rows in ten minutes for ONE club, 3.5 a second. On a
     350 ms debounce that is a full reload starting the moment the previous one
     lands, forever, in every open tab.

     This uses the shared useCoalescedRefresh rather than its own timer. #2728
     wrote that hook, used it in ClubHomePage, and then hand-rolled the same
     rate limit, the same visibility gate and the same pending flag here - so
     the behaviour existed twice, and only the copy in the hook had tests.
     Deleting the copy also gains refreshNow(), which is the piece the inline
     version never had and which the two callers below actually need.

     A game whose state matters to the second is watched from the table, not
     from a management list. */
  const { request: requestBoardRefresh, refreshNow: refreshBoardNow } = useCoalescedRefresh(
    () => void loadRef.current(true),
    { minIntervalMs: 20_000 }
  );

  /**
   * Read back the games that changed, not the whole board.
   *
   * Every management event used to become a full reload. The feed is not
   * gentle - 421 table updates in one measured minute - and what actually
   * moved was usually one row's player count. fn_list_managed_games can now
   * return a single enriched row, skipping both whole-scope scans: 2 ms
   * against production versus 21 ms for the full page, and one row on the
   * wire instead of a hundred.
   *
   * It falls back to requestBoardRefresh - which is coalesced, rate
   * limited and skipped while the tab is hidden - whenever a splice would be a
   * lie:
   *   - a changed game is not on the board (created, or on another page)
   *   - the row is gone from this scope (null)
   *   - the row changed BUCKET, so it belongs under a different tab now
   *   - more games changed at once than a full read is worth
   * The bucket case matters twice over: the counters are per-bucket totals, so
   * a row that stays in its bucket cannot move any of them, and one that
   * leaves it moves two. That is precisely why the counters can be left alone
   * on the fast path and must be recomputed on the slow one.
   */
  const refreshChangedGames = useCallback(async () => {
    const ids = Array.from(changedRef.current);
    const unnamed = sawUnnamedRef.current;
    changedRef.current.clear();
    sawUnnamedRef.current = false;
    if (!scopeId || unnamed) {
      requestBoardRefresh();
      return;
    }
    // Nothing was named and nothing was unnamed: there is nothing to refresh.
    // Reloading here would turn a spurious wake into a full board read.
    if (ids.length === 0) return;
    const known = ids
      .map((id) => gamesRef.current.find((game) => game.id === id))
      .filter((game): game is ManagedGame => Boolean(game));
    if (known.length !== ids.length || known.length > TARGETED_REFRESH_MAX) {
      requestBoardRefresh();
      return;
    }
    try {
      const hostNames = Object.fromEntries(hosts.map((host) => [host.id, host.name]));
      const fresh = await Promise.all(
        known.map((game) => gameManagementService.getGame(scope, scopeId, game.kind, game.id))
      );
      const mapped = fresh.map((row) => (row ? toManagedGame(row, hostNames, scopeName) : null));
      const splicable = mapped.every((row, index) => row && row.bucket === known[index].bucket);
      if (!splicable) {
        requestBoardRefresh();
        return;
      }
      const byId = new Map(mapped.map((row) => [row!.id, row as ManagedGame]));
      setGames((current) => current.map((game) => byId.get(game.id) ?? game));
    } catch (error) {
      // A targeted read that fails is not a reason to show stale rows.
      reportError(error, 'GameManagementPage.refreshChangedGames');
      requestBoardRefresh();
    }
  }, [hosts, requestBoardRefresh, scope, scopeId, scopeName]);

  // Accumulate every event. The decider below is debounced, and a debounced
  // subscription only ever sees the LAST payload of a burst - which would
  // refresh one game and silently miss the other four hundred.
  useMasterBusSubscriptions([...GAME_REFRESH_EVENTS], (payload: unknown) => {
    const id =
      (payload as { tableId?: string; tournamentId?: string } | null)?.tableId ??
      (payload as { tableId?: string; tournamentId?: string } | null)?.tournamentId;
    if (id) changedRef.current.add(String(id));
    else sawUnnamedRef.current = true;
  });

  useMasterBusSubscriptions(
    [...GAME_REFRESH_EVENTS],
    () => {
      void refreshChangedGames();
    },
    { debounce: 350 }
  );

  /* These two must not wait, and must not leave a scheduled refresh behind.
     refreshNow() is load(true) plus cancelling any pending timer - which is
     the difference that matters: calling load() directly left the coalescer's
     timer armed, so a redundant second reload fired up to 20 seconds later
     having just been superseded.

     An access change alters what the operator is allowed to see. onResync
     fires when the realtime channel has just (re)subscribed and is saying "I
     may have missed something", which is precisely the moment a rate limit
     must not add delay. */
  useMasterBusSubscriptions(
    ['GAME_MANAGEMENT_ACCESS_CHANGED'],
    () => {
      refreshBoardNow();
    },
    { debounce: 100 }
  );

  const realtimeStatus = useGameManagementRealtime({
    scope,
    scopeId: scopeId || '',
    enabled: allowed === true && Boolean(scopeId),
    onResync: () => refreshBoardNow(),
  });

  // The server returned exactly this tab's bucket, so there is nothing left to
  // filter. Kept as a named value because the render reads it in several places.
  useEffect(() => {
    gamesRef.current = games;
  }, [games]);

  const filteredGames = games;

  const liveCount = counts.live;
  const scheduledCount = counts.scheduled;

  const tournamentFormat =
    requestedCreate === 'spin' ? 'spin' : requestedCreate === 'sng' ? 'sng' : 'mtt_freezeout';
  const tournamentModalOpen =
    requestedCreate === 'event' || requestedCreate === 'spin' || requestedCreate === 'sng';

  const changeSurface = async (nextSurface: ManagementSurface) => {
    if (nextSurface === surface) return;
    if (
      surfaceDirty &&
      !(await confirmDialog({
        message: 'Discard the unsaved changes on this management section?',
        variant: 'danger',
      }))
    )
      return;
    setSurfaceDirty(false);
    setSurface(nextSurface);
  };

  const changeHostClub = async (nextClubId: string) => {
    if (nextClubId === hostClubId) return;
    if (
      surfaceDirty &&
      !(await confirmDialog({
        message: 'Discard the unsaved club-message changes before changing host clubs?',
        variant: 'danger',
      }))
    )
      return;
    setSurfaceDirty(false);
    setHostClubId(nextClubId);
  };

  const closeGame = async (game: ManagedGame) => {
    if (game.players > 0 || game.contract?.contractLocked) {
      toast.error(
        game.kind === 'table'
          ? 'This table cannot be closed while players are seated. Ask every player to leave first.'
          : 'This tournament cannot be cancelled after a player has registered.'
      );
      return;
    }
    const confirmed = await confirmDialog({
      message:
        game.kind === 'table'
          ? `Close ${game.name}? Only an empty table can be closed.`
          : `Cancel ${game.name}? This is allowed only before the first registration.`,
      variant: 'danger',
    });
    if (!confirmed) return;
    setBusyId(game.id);
    try {
      await gameManagementService.close(game.kind, game.id, game.contract?.version);
      toast.success(
        game.kind === 'table' ? 'Empty table closed.' : 'Unregistered tournament cancelled.'
      );
      await load(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not close the game.');
    } finally {
      setBusyId(null);
    }
  };

  const openContractHistory = async (game: ManagedGame) => {
    setContractGame(game);
    setContractVersions([]);
    setContractLoading(true);
    try {
      setContractVersions(await gameManagementService.getContractHistory(game.kind, game.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load contract history.');
      setContractGame(null);
    } finally {
      setContractLoading(false);
    }
  };

  if (allowed === null) {
    return (
      <main className={styles.page}>
        <section className={styles.empty}>Verifying Game-Management Access…</section>
      </main>
    );
  }

  if (allowed === false) {
    return (
      <main className={styles.page}>
        <section className={styles.denied}>
          <span>Management Locked</span>
          <h1>
            {scope === 'club'
              ? 'This Club Is Managed By Its Union'
              : 'Union Owner Or Admin Required'}
          </h1>
          <p>
            {scope === 'club'
              ? 'When A Club Joins A Union, Its Staff Can No Longer Create, Change, Close, Or View Management Controls For Games. Use The Union Console Instead.'
              : 'Only The Union Owner And Union Admins Can Manage Union Games.'}
          </p>
          <button onClick={() => navigate(scope === 'club' ? `/clubs/${clubId}` : '/unions')}>
            Return
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.commandHeader}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>
            {scope === 'union' ? 'Union Command' : 'Standalone Club Command'}
          </span>
          <h1>Table Management</h1>
          <p>{scopeName} · One Governed Command Surface For Games, Ticker, And Club Messages.</p>
          <span className={styles.safetyLine}>Live Contract · Occupied Games Stay Locked</span>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.countRail}>
            <span
              className={realtimeStatus === 'live' ? styles.healthGood : styles.healthWarn}
              role="status"
              aria-live="polite"
            >
              <strong>{realtimeStatus === 'live' ? 'Live' : 'Recovering'}</strong> Realtime
            </span>
            <span>
              <strong>{liveCount}</strong> Live
            </span>
            <span>
              <strong>{scheduledCount}</strong> Scheduled
            </span>
            <span>
              <strong>{counts.total}</strong> Total
            </span>
          </div>
          <div className={styles.healthRail} aria-label="Management Health">
            {/*
              A health read that FAILED must not render as zeros. `?? 0` used to
              paint "0 Integrity Alerts" whether the answer was zero or whether
              nobody could be asked - and the operator has no way to tell those
              apart. Health is telemetry, so a failed read still never blocks the
              board; it just says so instead of impersonating an all-clear.
            */}
            {health === null ? (
              <span className={styles.healthAlert}>Management Health Unavailable</span>
            ) : (
              <>
                <span>{health.commandsLast24h} Commands / 24h</span>
                <span>{health.rejectedLast24h} Rejected</span>
                <span className={health.integrityAlerts ? styles.healthAlert : undefined}>
                  {health.integrityAlerts} Integrity Alerts
                </span>
                <span>{health.scheduledPending} Pending Schedules</span>
                <span className={health.scheduledRejected24h ? styles.healthAlert : undefined}>
                  {health.scheduledRejected24h} Schedule Rejects
                </span>
                <span title={formatEventClock(health.lastEventAt)}>
                  {health.eventsLastHour} Events / Hour
                </span>
                <span title={`${health.retentionDays}-Day Realtime Retention`}>
                  {health.eventRows} Realtime Events
                </span>
              </>
            )}
          </div>
          <GameCreationActions managementPath={managementPath} />
        </div>
      </header>

      <nav className={styles.surfaceNav} aria-label="Management Sections">
        {(
          [
            ['games', 'Game Board', 'Running & Scheduled'],
            ['ticker', 'Ticker Management', 'Live Message Rail'],
            ['messages', 'Club Messages', 'Identity & Announcements'],
          ] as Array<[ManagementSurface, string, string]>
        ).map(([key, label, detail], index) => (
          <button
            key={key}
            type="button"
            className={surface === key ? styles.surfaceActive : ''}
            aria-current={surface === key ? 'page' : undefined}
            onClick={() => void changeSurface(key)}
            title={
              surfaceDirty && surface !== key ? 'Unsaved Changes Will Need Confirmation' : undefined
            }
          >
            <span>0{index + 1}</span>
            <strong>{label}</strong>
            <small>{detail}</small>
          </button>
        ))}
      </nav>

      {scope === 'union' && hosts.length > 0 && (
        <label className={styles.hostPicker}>
          Host Club
          <select value={hostClubId} onChange={(e) => void changeHostClub(e.target.value)}>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {surface === 'games' && requestedCreate === 'table' && hostClubId && (
        <section className={styles.creatorDeck} aria-label="Create Table">
          <CreateTablePage clubIdOverride={hostClubId} onBack={clearCreate} />
        </section>
      )}
      {scope === 'union' && hosts.length === 0 && !loading && (
        <section className={styles.empty}>Add A Club To This Union Before Creating Games.</section>
      )}

      {surface === 'games' && (
        <nav className={styles.filters} aria-label="Game Status">
          {(['all', 'running', 'scheduled', 'closed'] as View[]).map((item) => (
            <button
              key={item}
              type="button"
              className={view === item ? styles.active : ''}
              onClick={() => setView(item)}
            >
              {item}
            </button>
          ))}
          {requestedCreate && (
            <button className={styles.dismissCreator} onClick={clearCreate}>
              Close Creator
            </button>
          )}
        </nav>
      )}

      {surface === 'games' &&
        (loadError ? (
          <section className={styles.empty}>
            <p>{loadError}</p>
            <button onClick={() => void load()}>Try Again</button>
          </section>
        ) : loading ? (
          <section className={styles.empty}>Loading Live Game Controls…</section>
        ) : filteredGames.length === 0 ? (
          <section className={styles.empty}>
            <h2>No Games In This View</h2>
            <p>Use The Controls Above To Add The First One.</p>
          </section>
        ) : (
          <section className={styles.gameList} aria-label="Managed Games">
            {filteredGames.map((game) => {
              const closed = game.bucket === BUCKET_CLOSED;
              return (
                <article key={`${game.kind}-${game.id}`} className={styles.gameRow}>
                  <span
                    className={`${styles.statusRail} ${game.bucket === BUCKET_LIVE ? styles.live : closed ? styles.closed : styles.scheduled}`}
                    aria-hidden="true"
                  />
                  <div className={styles.gameIdentity}>
                    <span>
                      {game.kind === 'table' ? 'Cash Table' : 'Tournament'} · {game.hostName}
                    </span>
                    <h2>{game.name}</h2>
                    <p>
                      {game.variant.toUpperCase()} ·{' '}
                      {game.kind === 'table'
                        ? `${game.smallBlind}/${game.bigBlind} · Buy-In ${game.minBuyIn}-${game.maxBuyIn}`
                        : `${game.buyIn} Buy-In · ${formatTime(game.startTime)}`}
                    </p>
                    {game.contract && (
                      <div className={styles.contractRail}>
                        <span>Contract V{game.contract.version}</span>
                        <span>{game.contract.contractHash.slice(0, 8)}</span>
                        {game.contract.contractLocked && (
                          <span className={styles.locked}>Locked</span>
                        )}
                        {game.kind === 'tournament' && (
                          <span
                            className={
                              game.contract.readiness.canStart ? styles.ready : styles.blocked
                            }
                            title={
                              game.contract.readiness.state === 'funding_blocked'
                                ? `Guarantee Short By ${game.contract.readiness.shortBy} Chips`
                                : 'Published Contract Readiness'
                            }
                          >
                            {game.contract.readiness.state === 'funding_blocked'
                              ? `Funding Short ${game.contract.readiness.shortBy}`
                              : game.contract.readiness.state.replace(/_/g, ' ')}
                          </span>
                        )}
                      </div>
                    )}
                    {game.lastCommand && (
                      <div
                        className={`${styles.commandReceipt} ${
                          game.lastCommand.status === 'rejected' ||
                          game.lastCommand.reconciliationState === 'version_drift'
                            ? styles.commandRejected
                            : ''
                        }`}
                        title={`Command ${game.lastCommand.commandId}`}
                      >
                        <span>
                          {game.lastCommand.status === 'succeeded'
                            ? 'Confirmed'
                            : game.lastCommand.status}{' '}
                          {game.lastCommand.action}
                        </span>
                        <code>{game.lastCommand.commandId.slice(0, 8)}</code>
                        <span>
                          V{game.lastCommand.versionBefore} → V{game.lastCommand.versionAfter}
                        </span>
                        {game.lastCommand.reconciliationState === 'version_drift' && (
                          <span>Revision Check Failed</span>
                        )}
                      </div>
                    )}
                    {game.pendingSchedule && (
                      <div className={styles.scheduleRail}>
                        <span>Close Scheduled</span>
                        <strong>{formatTime(game.pendingSchedule.executeAt)}</strong>
                        <button
                          type="button"
                          disabled={busyId === game.id}
                          onClick={async () => {
                            setBusyId(game.id);
                            try {
                              await gameManagementService.cancelSchedule(
                                game.pendingSchedule!.scheduleId
                              );
                              toast.success('Scheduled close cancelled.');
                              await load(true);
                            } catch (error) {
                              toast.error(
                                error instanceof Error
                                  ? error.message
                                  : 'Could not cancel this schedule.'
                              );
                            } finally {
                              setBusyId(null);
                            }
                          }}
                        >
                          Cancel Schedule
                        </button>
                      </div>
                    )}
                  </div>
                  <div className={styles.gameNumbers}>
                    <strong>
                      {game.players}/{game.maxPlayers || '∞'}
                    </strong>
                    <span>Players</span>
                  </div>
                  <span className={styles.status}>{game.status.replace(/_/g, ' ')}</span>
                  <div className={styles.rowActions}>
                    <button
                      onClick={() => void openContractHistory(game)}
                      disabled={busyId === game.id}
                      title="View Published Contract History"
                    >
                      Contract
                    </button>
                    {/*
                      Open, Pause, Schedule and Close are all gated on !closed
                      and Edit was not, so a finished game could be renamed and
                      re-limited from the board. Nothing downstream refuses it:
                      fn_update_managed_game never looks at the status for a
                      table. A closed game is history, so it is read-only here.
                    */}
                    {!closed && (
                      <button
                        onClick={() => {
                          if (game.kind === 'tournament' && game.contract?.contractLocked) {
                            toast.error(
                              'This tournament cannot be modified after a player has registered.'
                            );
                            return;
                          }
                          setEditing(game);
                        }}
                        disabled={busyId === game.id}
                        title={
                          game.kind === 'tournament' && game.contract?.contractLocked
                            ? 'Locked After The First Registration'
                            : 'Edit Game'
                        }
                        aria-disabled={
                          game.kind === 'tournament' && game.contract?.contractLocked
                            ? true
                            : undefined
                        }
                      >
                        Edit
                      </button>
                    )}
                    {game.kind === 'table' && !closed && <Link to={`/table/${game.id}`}>Open</Link>}
                    {game.kind === 'table' && !closed && (
                      <button
                        type="button"
                        disabled={busyId === game.id}
                        onClick={async () => {
                          const paused = game.status.toLowerCase() === 'paused';
                          setBusyId(game.id);
                          try {
                            if (paused) await gameManagementService.resume(game.id);
                            else await gameManagementService.pause(game.id);
                            toast.success(
                              paused ? 'Table resumed.' : 'Table will pause after this hand.'
                            );
                            await load(true);
                          } catch (error) {
                            toast.error(
                              error instanceof Error
                                ? error.message
                                : `Could not ${paused ? 'resume' : 'pause'} this table.`
                            );
                          } finally {
                            setBusyId(null);
                          }
                        }}
                        title={
                          game.status.toLowerCase() === 'paused'
                            ? 'Resume Dealing'
                            : 'Pause Safely After The Current Hand'
                        }
                      >
                        {game.status.toLowerCase() === 'paused' ? 'Resume' : 'Pause'}
                      </button>
                    )}
                    {!closed && !game.pendingSchedule && (
                      <button
                        onClick={() => {
                          if (game.players > 0 || game.contract?.contractLocked) {
                            toast.error(
                              game.kind === 'table'
                                ? 'Players must leave before a close can be scheduled.'
                                : 'A registered tournament cannot be scheduled for cancellation.'
                            );
                            return;
                          }
                          setScheduling(game);
                        }}
                        disabled={busyId === game.id || !game.contract}
                        aria-disabled={
                          game.players > 0 || game.contract?.contractLocked ? true : undefined
                        }
                        title={
                          game.players > 0 || game.contract?.contractLocked
                            ? 'Occupied Or Registered Games Stay Locked'
                            : 'Schedule A Guarded Future Close'
                        }
                      >
                        Schedule
                      </button>
                    )}
                    {!closed && (
                      <button
                        className={styles.danger}
                        onClick={() => void closeGame(game)}
                        disabled={busyId === game.id}
                        title={
                          game.players > 0 || game.contract?.contractLocked
                            ? game.kind === 'table'
                              ? 'Players Must Leave Before This Table Can Close'
                              : 'A Registered Tournament Cannot Be Cancelled'
                            : 'Close Game'
                        }
                        aria-disabled={
                          game.players > 0 || game.contract?.contractLocked ? true : undefined
                        }
                      >
                        {busyId === game.id ? 'Closing…' : 'Close'}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
            {nextCursor && (
              <button
                type="button"
                className={styles.loadMore}
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading More…' : `Load More · ${games.length} Of ${counts.total}`}
              </button>
            )}
          </section>
        ))}

      {surface === 'ticker' && allowed && scopeId && (
        <TickerManagementPanel scope={scope} scopeId={scopeId} onDirtyChange={setSurfaceDirty} />
      )}

      {surface === 'messages' && allowed && hostClubId && (
        <ClubMessageManagementPanel
          clubId={hostClubId}
          clubName={hosts.find((host) => host.id === hostClubId)?.name || scopeName}
          onDirtyChange={setSurfaceDirty}
        />
      )}

      {tournamentModalOpen && hostClubId && (
        <CreateTournamentModal
          clubId={hostClubId}
          unionId={scope === 'union' ? scopeId || undefined : undefined}
          initialFormat={tournamentFormat}
          onClose={clearCreate}
          onSuccess={() => {
            clearCreate();
            void load();
          }}
        />
      )}
      {editing && (
        <EditGameDialog
          game={editing}
          busy={busyId === editing.id}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            setBusyId(editing.id);
            try {
              await gameManagementService.update(
                editing.kind,
                editing.id,
                patch,
                editing.contract?.version
              );
              toast.success('Game updated.');
              setEditing(null);
              await load(true);
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Could not update the game.');
            } finally {
              setBusyId(null);
            }
          }}
        />
      )}

      {scheduling && (
        <ScheduleCloseDialog
          game={scheduling}
          busy={busyId === scheduling.id}
          onClose={() => setScheduling(null)}
          onSchedule={async (executeAt) => {
            if (!scheduling.contract) return;
            setBusyId(scheduling.id);
            try {
              await gameManagementService.scheduleClose(
                scheduling.kind,
                scheduling.id,
                scheduling.contract.version,
                executeAt
              );
              toast.success('Guarded close scheduled.');
              setScheduling(null);
              await load(true);
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : 'Could not schedule this command.'
              );
            } finally {
              setBusyId(null);
            }
          }}
        />
      )}

      {contractGame && (
        <ContractHistoryDialog
          game={contractGame}
          versions={contractVersions}
          loading={contractLoading}
          onClose={() => setContractGame(null)}
        />
      )}
    </main>
  );
}
