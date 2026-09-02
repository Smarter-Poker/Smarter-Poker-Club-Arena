import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
}

const ACTIVE_STATUSES = new Set(['running', 'active', 'waiting', 'registering', 'late_reg']);
const CLOSED_STATUSES = new Set(['closed', 'completed', 'cancelled', 'canceled', 'deleted']);
const CREATE_TARGETS = new Set<GameCreationTarget>(['table', 'event', 'spin', 'sng']);
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
  const [counts, setCounts] = useState({ total: 0, live: 0, scheduled: 0 });
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
      if (routeChanged) {
        loadedRouteRef.current = routeKey;
        setAllowed(null);
        setScopeId(null);
        setHosts([]);
        setHostClubId('');
        setGames([]);
        setCounts({ total: 0, live: 0, scheduled: 0 });
        setNextCursor(null);
        setHealth(null);
        setSurfaceDirty(false);
      }
      if (!silent || routeChanged) setLoading(true);
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

        const page = await gameManagementService.list(scope, resolvedScopeId);
        if (!isCurrent()) return;
        const tableRows = page.items.filter((row: any) => row.kind === 'table');
        const tournamentRows = page.items.filter((row: any) => row.kind === 'tournament');
        const tableIds = tableRows.map((row: any) => row.id);
        const tournamentIds = tournamentRows.map((row: any) => row.id);
        const [tableContracts, tournamentContracts, tableReceipts, tournamentReceipts] =
          await Promise.all([
            gameManagementService.getContracts('table', tableIds),
            gameManagementService.getContracts('tournament', tournamentIds),
            gameManagementService.getCommandReceipts('table', tableIds),
            gameManagementService.getCommandReceipts('tournament', tournamentIds),
          ]);
        if (!isCurrent()) return;
        const tableContractMap = new Map(
          tableContracts.map((contract) => [contract.gameId, contract])
        );
        const tournamentContractMap = new Map(
          tournamentContracts.map((contract) => [contract.gameId, contract])
        );
        const tableReceiptMap = new Map(tableReceipts.map((receipt) => [receipt.gameId, receipt]));
        const tournamentReceiptMap = new Map(
          tournamentReceipts.map((receipt) => [receipt.gameId, receipt])
        );
        const hostNames = Object.fromEntries(nextHosts.map((host) => [host.id, host.name]));
        const rows: ManagedGame[] = [
          ...tableRows.map((row: any) => ({
            id: row.id,
            kind: 'table' as const,
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
            contract: tableContractMap.get(row.id) || null,
            lastCommand: tableReceiptMap.get(row.id) || null,
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
            contract: tournamentContractMap.get(row.id) || null,
            lastCommand: tournamentReceiptMap.get(row.id) || null,
            pendingSchedule: row.pending_schedule
              ? {
                  scheduleId: row.pending_schedule.schedule_id,
                  executeAt: row.pending_schedule.execute_at,
                  status: row.pending_schedule.status,
                }
              : null,
          })),
        ];
        setGames(rows);
        setCounts(page.counts);
        setNextCursor(page.nextCursor);
        try {
          const nextHealth = await gameManagementService.getHealth(scope, resolvedScopeId);
          if (isCurrent()) setHealth(nextHealth);
        } catch (healthError) {
          reportError(healthError, 'GameManagementPage.health');
          if (isCurrent()) setHealth(null);
        }
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
    [clubId, scope, unionId, user?.id]
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
      const page = await gameManagementService.list(scope, scopeId, nextCursor);
      const tableRows = page.items.filter((row: any) => row.kind === 'table');
      const tournamentRows = page.items.filter((row: any) => row.kind === 'tournament');
      const [tableContracts, tournamentContracts, tableReceipts, tournamentReceipts] =
        await Promise.all([
          gameManagementService.getContracts(
            'table',
            tableRows.map((row: any) => row.id)
          ),
          gameManagementService.getContracts(
            'tournament',
            tournamentRows.map((row: any) => row.id)
          ),
          gameManagementService.getCommandReceipts(
            'table',
            tableRows.map((row: any) => row.id)
          ),
          gameManagementService.getCommandReceipts(
            'tournament',
            tournamentRows.map((row: any) => row.id)
          ),
        ]);
      const contractMap = new Map(
        [...tableContracts, ...tournamentContracts].map((contract) => [
          `${contract.gameId}`,
          contract,
        ])
      );
      const receiptMap = new Map(
        [...tableReceipts, ...tournamentReceipts].map((receipt) => [`${receipt.gameId}`, receipt])
      );
      const hostNames = Object.fromEntries(hosts.map((host) => [host.id, host.name]));
      const rows: ManagedGame[] = page.items.map((row: any) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        status: row.status,
        clubId: row.club_id,
        hostName: hostNames[row.club_id] || scopeName,
        variant: row.variant || (row.kind === 'table' ? 'NLH' : 'MTT'),
        players: row.players || 0,
        maxPlayers: row.max_players || 0,
        startTime: row.start_time,
        smallBlind: Number(row.small_blind || 0),
        bigBlind: Number(row.big_blind || 0),
        minBuyIn: Number(row.min_buy_in || 0),
        maxBuyIn: Number(row.max_buy_in || 0),
        buyIn: Number(row.buy_in || 0),
        contract: contractMap.get(row.id) || null,
        lastCommand: receiptMap.get(row.id) || null,
        pendingSchedule: row.pending_schedule
          ? {
              scheduleId: row.pending_schedule.schedule_id,
              executeAt: row.pending_schedule.execute_at,
              status: row.pending_schedule.status,
            }
          : null,
      }));
      setGames((current) => {
        const seen = new Set(current.map((game) => `${game.kind}:${game.id}`));
        return [...current, ...rows.filter((game) => !seen.has(`${game.kind}:${game.id}`))];
      });
      setCounts(page.counts);
      setNextCursor(page.nextCursor);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load more games.');
    } finally {
      setLoadingMore(false);
    }
  }, [hosts, loadingMore, nextCursor, scope, scopeId, scopeName, toast]);

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

  useMasterBusSubscriptions(
    [...GAME_REFRESH_EVENTS],
    () => {
      void load(true);
    },
    { debounce: 350 }
  );

  useMasterBusSubscriptions(
    ['GAME_MANAGEMENT_ACCESS_CHANGED'],
    () => {
      void load(true);
    },
    { debounce: 100 }
  );

  const realtimeStatus = useGameManagementRealtime({
    scope,
    scopeId: scopeId || '',
    enabled: allowed === true && Boolean(scopeId),
    onResync: () => void load(true),
  });

  const filteredGames = useMemo(
    () =>
      games.filter((game) => {
        const status = game.status.toLowerCase();
        if (view === 'running') return ACTIVE_STATUSES.has(status);
        if (view === 'closed') return CLOSED_STATUSES.has(status);
        if (view === 'scheduled')
          return (
            game.kind === 'tournament' &&
            !ACTIVE_STATUSES.has(status) &&
            !CLOSED_STATUSES.has(status)
          );
        return true;
      }),
    [games, view]
  );

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
            <span>{health?.commandsLast24h ?? 0} Commands / 24h</span>
            <span>{health?.rejectedLast24h ?? 0} Rejected</span>
            <span className={health?.integrityAlerts ? styles.healthAlert : undefined}>
              {health?.integrityAlerts ?? 0} Integrity Alerts
            </span>
            <span>{health?.scheduledPending ?? 0} Pending Schedules</span>
            <span className={health?.scheduledRejected24h ? styles.healthAlert : undefined}>
              {health?.scheduledRejected24h ?? 0} Schedule Rejects
            </span>
            <span title={`${health?.retentionDays ?? 30}-Day Realtime Retention`}>
              {health?.eventRows ?? 0} Realtime Events
            </span>
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
              const closed = CLOSED_STATUSES.has(game.status.toLowerCase());
              return (
                <article key={`${game.kind}-${game.id}`} className={styles.gameRow}>
                  <span
                    className={`${styles.statusRail} ${ACTIVE_STATUSES.has(game.status.toLowerCase()) ? styles.live : closed ? styles.closed : styles.scheduled}`}
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
