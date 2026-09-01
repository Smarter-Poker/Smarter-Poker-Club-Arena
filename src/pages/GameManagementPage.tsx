import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { supabase } from '../lib/supabase';
import { fetchGameCreationAccess } from '../services/GameAccessService';
import {
  gameManagementService,
  type ManagedGameKind,
  type ManagedGamePatch,
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

function EditGameDialog({
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
  const [name, setName] = useState(game.name);
  const [smallBlind, setSmallBlind] = useState(String(game.smallBlind || 1));
  const [bigBlind, setBigBlind] = useState(String(game.bigBlind || 2));
  const [minBuyIn, setMinBuyIn] = useState(String(game.minBuyIn || 40));
  const [maxBuyIn, setMaxBuyIn] = useState(String(game.maxBuyIn || 200));
  const [maxPlayers, setMaxPlayers] = useState(String(game.maxPlayers || 9));
  const [startTime, setStartTime] = useState(
    game.startTime ? new Date(game.startTime).toISOString().slice(0, 16) : ''
  );

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.currentTarget === e.target) onClose();
      }}
    >
      <form
        className={styles.dialog}
        aria-labelledby="edit-game-title"
        onSubmit={(e) => {
          e.preventDefault();
          const patch: ManagedGamePatch = { name: name.trim(), maxPlayers: Number(maxPlayers) };
          if (game.kind === 'table') {
            patch.smallBlind = Number(smallBlind);
            patch.bigBlind = Number(bigBlind);
            patch.minBuyIn = Number(minBuyIn);
            patch.maxBuyIn = Number(maxBuyIn);
          } else if (startTime) {
            patch.startTime = new Date(startTime).toISOString();
          }
          onSave(patch);
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
            max="1000000"
            value={maxPlayers}
            onChange={(e) => setMaxPlayers(e.target.value)}
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
        <p>Live Games Can Be Renamed, But Structural Changes Are Locked Once Players Are Active.</p>
        <div className={styles.dialogActions}>
          <button type="button" onClick={onClose} disabled={busy}>
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>('all');
  const [surface, setSurface] = useState<ManagementSurface>('games');
  const [editing, setEditing] = useState<ManagedGame | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const managementPath =
    scope === 'union' ? `/unions/${unionId}/table-management` : `/clubs/${clubId}/table-management`;

  const clearCreate = () => setSearchParams({}, { replace: true });

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
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
        // A member club is operated from its union console, even for a union
        // owner who technically has authority over the underlying rows.
        const standaloneAccess = access.allowed && !access.unionId;
        setAllowed(standaloneAccess);
        if (!standaloneAccess) {
          setScopeId(resolvedScopeId);
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
        setAllowed(canManage);
        if (!canManage) {
          setScopeId(unionId);
          setLoading(false);
          return;
        }
        const [unionResult, hostResult] = await Promise.all([
          supabase.from('unions').select('id,name').eq('id', unionId).maybeSingle(),
          supabase.from('union_clubs').select('club_id, clubs(name)').eq('union_id', unionId),
        ]);
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

      const tableQuery = supabase
        .from('tables')
        .select(
          'id,club_id,name,status,game_variant,current_players,max_players,small_blind,big_blind,min_buy_in,max_buy_in,created_at,is_deleted'
        )
        .is('tournament_id', null)
        .eq('is_deleted', false);
      const tournamentQuery = supabase
        .from('tournaments')
        .select(
          'id,club_id,name,status,game_type,variant,current_players,max_players,start_time,buy_in_amount,created_at'
        );
      if (scope === 'union') {
        tableQuery.eq('union_id', resolvedScopeId);
        tournamentQuery.eq('union_id', resolvedScopeId);
      } else {
        tableQuery.eq('club_id', resolvedScopeId).is('union_id', null);
        tournamentQuery.eq('club_id', resolvedScopeId).is('union_id', null);
      }
      const [tableResult, tournamentResult] = await Promise.all([
        tableQuery.order('created_at', { ascending: false }).limit(500),
        tournamentQuery.order('start_time', { ascending: true }).limit(500),
      ]);
      if (tableResult.error) throw tableResult.error;
      if (tournamentResult.error) throw tournamentResult.error;
      const hostNames = Object.fromEntries(nextHosts.map((host) => [host.id, host.name]));
      const rows: ManagedGame[] = [
        ...(tableResult.data || []).map((row: any) => ({
          id: row.id,
          kind: 'table' as const,
          name: row.name,
          status: row.status,
          clubId: row.club_id,
          hostName: hostNames[row.club_id] || resolvedScopeName,
          variant: row.game_variant || 'NLH',
          players: row.current_players || 0,
          maxPlayers: row.max_players || 0,
          startTime: null,
          smallBlind: Number(row.small_blind || 0),
          bigBlind: Number(row.big_blind || 0),
          minBuyIn: Number(row.min_buy_in || 0),
          maxBuyIn: Number(row.max_buy_in || 0),
          buyIn: 0,
        })),
        ...(tournamentResult.data || []).map((row: any) => ({
          id: row.id,
          kind: 'tournament' as const,
          name: row.name,
          status: row.status,
          clubId: row.club_id,
          hostName: hostNames[row.club_id] || resolvedScopeName,
          variant: row.game_type || row.variant || 'MTT',
          players: row.current_players || 0,
          maxPlayers: row.max_players || 0,
          startTime: row.start_time,
          smallBlind: 0,
          bigBlind: 0,
          minBuyIn: 0,
          maxBuyIn: 0,
          buyIn: Number(row.buy_in_amount || 0),
        })),
      ];
      setGames(rows);
    } catch (error) {
      reportError(error, 'GameManagementPage.load');
      setLoadError(error instanceof Error ? error.message : 'Could not load games.');
    } finally {
      setLoading(false);
    }
  }, [clubId, scope, unionId, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useMasterBusSubscriptions(
    [...GAME_REFRESH_EVENTS],
    () => {
      void load();
    },
    { debounce: 350 }
  );

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

  const liveCount = games.filter((game) => ACTIVE_STATUSES.has(game.status.toLowerCase())).length;
  const scheduledCount = games.filter(
    (game) =>
      game.kind === 'tournament' &&
      !ACTIVE_STATUSES.has(game.status.toLowerCase()) &&
      !CLOSED_STATUSES.has(game.status.toLowerCase())
  ).length;

  const tournamentFormat =
    requestedCreate === 'spin' ? 'spin' : requestedCreate === 'sng' ? 'sng' : 'mtt_freezeout';
  const tournamentModalOpen =
    requestedCreate === 'event' || requestedCreate === 'spin' || requestedCreate === 'sng';

  const closeGame = async (game: ManagedGame) => {
    if (game.players > 0) {
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
      await gameManagementService.close(game.kind, game.id);
      toast.success(
        game.kind === 'table' ? 'Empty table closed.' : 'Unregistered tournament cancelled.'
      );
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not close the game.');
    } finally {
      setBusyId(null);
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
            <span>
              <strong>{liveCount}</strong> Live
            </span>
            <span>
              <strong>{scheduledCount}</strong> Scheduled
            </span>
            <span>
              <strong>{games.length}</strong> Total
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
            onClick={() => setSurface(key)}
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
          <select value={hostClubId} onChange={(e) => setHostClubId(e.target.value)}>
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
                      onClick={() => {
                        if (game.kind === 'tournament' && game.players > 0) {
                          toast.error(
                            'This tournament cannot be modified after a player has registered.'
                          );
                          return;
                        }
                        setEditing(game);
                      }}
                      disabled={busyId === game.id}
                      title={
                        game.kind === 'tournament' && game.players > 0
                          ? 'Locked After The First Registration'
                          : 'Edit Game'
                      }
                    >
                      Edit
                    </button>
                    {game.kind === 'table' && !closed && <Link to={`/table/${game.id}`}>Open</Link>}
                    {!closed && (
                      <button
                        className={styles.danger}
                        onClick={() => void closeGame(game)}
                        disabled={busyId === game.id}
                        title={
                          game.players > 0
                            ? game.kind === 'table'
                              ? 'Players Must Leave Before This Table Can Close'
                              : 'A Registered Tournament Cannot Be Cancelled'
                            : 'Close Game'
                        }
                      >
                        {busyId === game.id ? 'Closing…' : 'Close'}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        ))}

      {surface === 'ticker' && allowed && scopeId && (
        <TickerManagementPanel scope={scope} scopeId={scopeId} />
      )}

      {surface === 'messages' && allowed && hostClubId && (
        <ClubMessageManagementPanel
          clubId={hostClubId}
          clubName={hosts.find((host) => host.id === hostClubId)?.name || scopeName}
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
              await gameManagementService.update(editing.kind, editing.id, patch);
              toast.success('Game updated.');
              setEditing(null);
              await load();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Could not update the game.');
            } finally {
              setBusyId(null);
            }
          }}
        />
      )}
    </main>
  );
}
