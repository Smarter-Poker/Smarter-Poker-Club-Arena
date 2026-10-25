import { formatWalletChips } from '../utils/format';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FLASH POOL PAGE — Fast-Fold Poker Lobby
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Entry point for the Flash Pool (fast-fold) poker experience:
 * - Browse active flash pools by stakes
 * - Join a pool with configurable buy-in
 * - Live player count + tables running
 * - Connects to FlashPoolEngine for instant fold → reassign flow
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useIsMounted } from '../hooks/useIsMounted';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
// [MIGRATION] flashPoolEngine removed — server-authoritative (join via Supabase RPC)
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import PageBar from '../components/help/PageBar';
import { reportError } from '../utils/errorReporter';
import { resolvePageClubId } from '../utils/resolvePageClubId';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface PoolDisplay {
  poolId: string;
  stakes: string;
  smallBlind: number;
  bigBlind: number;
  activePlayers: number;
  tablesRunning: number;
  buyInMin: number;
  buyInMax: number;
  status: 'active' | 'waiting' | 'closed';
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function FlashPoolPage() {
  const navigate = useNavigate();
  /* Explicit, because `location.search` without this resolves to the GLOBAL
     `window.location` — which type-checks, reads correctly on first paint, and
     is not part of React's render cycle, so the dependency below would be
     lying about what it tracks. */
  const location = useLocation();
  const { user } = useAuthUser();
  const toast = useToast();
  useVisibilityRefresh(() => loadPools());

  const [loading, setLoading] = useState(true);
  const [pools, setPools] = useState<PoolDisplay[]>([]);
  const [joiningPool, setJoiningPool] = useState<string | null>(null);
  const [buyInAmounts, setBuyInAmounts] = useState<Record<string, number>>({});
  const [userBalance, setUserBalance] = useState<number | null>(null);
  const isMounted = useIsMounted();

  const loadingRef = useRef(false);

  // ── Load available pools ──
  const loadPools = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const { data, error } = await supabase
        .from('flash_pools')
        .select(
          'id, small_blind, big_blind, active_players, tables_running, buy_in_min, buy_in_max, status'
        )
        .in('status', ['active', 'waiting'])
        .order('big_blind', { ascending: true });

      if (error) throw error;

      const poolList: PoolDisplay[] = (data || []).map((row: any) => ({
        poolId: row.id,
        stakes: `${row.small_blind}/${row.big_blind}`,
        smallBlind: row.small_blind,
        bigBlind: row.big_blind,
        activePlayers: row.active_players || 0,
        tablesRunning: row.tables_running || 0,
        buyInMin: row.buy_in_min || row.big_blind * 40,
        buyInMax: row.buy_in_max || row.big_blind * 200,
        status: row.status || 'active',
      }));

      if (!isMounted.current) return;
      setPools(poolList);
    } catch (err) {
      reportError(err, 'FlashPoolPage.Failed_to_load_pools');
      if (!isMounted.current) return;
      toast.error('Failed to load pools');
      setPools([]);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPools();
  }, [loadPools]);

  /* ── THE BALANCE ON THIS PAGE BELONGS TO A CLUB ───────────────────────────
     `club_members.chip_balance` is PER CLUB. This read it with `.limit(1)`
     and no `.order()`, twice — once on mount and again on every
     BALANCE_UPDATED — so a player in more than one club saw an arbitrary
     club's chips, and the two copies could even disagree with each other
     after a refresh. On a page where those chips get spent, showing the wrong
     club's number is a money-facing bug, not a cosmetic one.

     Both copies are now one function that names the club first, through the
     same resolver every other global page uses: `?club=` if the URL carries
     it, else the club the player was last in. */
  const loadBalance = useCallback(async () => {
    if (!user?.id) return;
    try {
      const clubId = await resolvePageClubId({ search: location.search, userId: user.id });
      if (!clubId) {
        setUserBalance(0);
        return;
      }
      const { data, error } = await supabase
        .from('club_members')
        .select('chip_balance')
        .eq('user_id', user.id)
        .eq('club_id', clubId)
        .maybeSingle();
      if (error) throw error;
      setUserBalance(data?.chip_balance || 0);
    } catch (e) {
      reportError(e, 'FlashPoolPage.loadBalance');
      /* best effort */
    }
  }, [user?.id, location.search]);

  // ── Load user's chip balance ──
  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  // ── Bus listener: keep balance in sync when chips change on other pages ──
  useEffect(() => {
    if (!user?.id) return;
    const unsub = masterBus.subscribeDebounced('BALANCE_UPDATED', () => void loadBalance(), 500);
    return () => unsub();
  }, [user?.id, loadBalance]);

  // GAME_STATE_UPDATED listener removed 2026-08-28: nothing emits it on the
  // client bus, so this pool-stats patch never ran. The Supabase realtime
  // channel below is the live path that actually works.

  // ── Supabase real-time for live pool stats ──
  useEffect(() => {
    const channelKey = 'flash-pools-live';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'flash_pools' },
        (payload: any) => {
          const row = payload.new;
          if (!row) return;
          setPools((prev) =>
            prev.map((p) =>
              p.poolId === row.id
                ? {
                    ...p,
                    activePlayers: row.active_players ?? p.activePlayers,
                    tablesRunning: row.tables_running ?? p.tablesRunning,
                    status: row.status ?? p.status,
                  }
                : p
            )
          );
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'FlashPoolPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[FlashPoolPage] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, []);

  /* Dan's ruling (2026-10-16/17): fast-fold play is Lightning only. This page
     is parked, and the join it used to call took the buy-in without ever
     seating the player (no engine seat, no refund path). The server no longer
     lets a client call it (20261024232449_flash_pool_join_never_takes_chips),
     and the page never asks: a Join here can never move a chip. */
  const handleJoinPool = useCallback(
    (_pool: PoolDisplay) => {
      toast.error('Flash Pools Are Not Open. Fast-Fold Play Is In Lightning Games.');
    },
    [toast]
  );

  if (loading) return <PageSkeleton />;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #0a0a0a 100%)',
        color: '#e4e6eb',
        padding: '20px',
        paddingBottom: 'max(70px, env(safe-area-inset-bottom))',
        width: '100%',
        maxWidth: '100vw',
        boxSizing: 'border-box',
        overflowX: 'hidden',
      }}
    >
      {/* The gold title and its tagline went behind the "?" (Dan
          2026-10-17). Back stays: it is the page's one action. */}
      <PageBar
        title="Flash Pool"
        summary="Fast-Fold Poker. Fold Instantly, Get New Cards."
        steps={[
          {
            title: 'How It Works',
            body: 'Fold Instantly, Move To A New Table And Get New Cards. No Waiting For The Hand To Finish.',
          },
          {
            title: 'Pick A Pool',
            body: 'Each Pool Shows Its Stakes, Buy-In Range, Players And Tables. Enter A Buy-In And Tap Play.',
            target: '[data-flash-pools]',
          },
        ]}
      >
        <button
          onClick={() => navigate(-1)}
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: 'none',
            borderRadius: '12px',
            padding: '10px 14px',
            color: '#e4e6eb',
            cursor: 'pointer',
            fontSize: '16px',
          }}
        >
          ← Back
        </button>
      </PageBar>

      {/* Pool List */}
      <div data-flash-pools style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {pools.map((pool) => (
          <div
            key={pool.poolId}
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '16px',
              padding: '20px',
              transition: 'all 0.3s ease',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '12px',
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: '20px',
                    fontWeight: 700,
                    color: '#FFD700',
                  }}
                >
                  {pool.stakes}
                </div>
                <div style={{ fontSize: '12px', color: '#8b8fa3' }}>
                  Buy-In: {pool.buyInMin.toLocaleString()} - {pool.buyInMax.toLocaleString()}
                </div>
                {userBalance !== null && (
                  <div style={{ fontSize: '11px', color: '#60a5fa', marginTop: '2px' }}>
                    Your Balance: {formatWalletChips(userBalance)} Chips
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div
                  style={{
                    fontSize: '14px',
                    fontWeight: 600,
                    color: pool.activePlayers > 0 ? '#3FB950' : '#8b8fa3',
                    transition: 'color 0.3s ease',
                  }}
                >
                  <span style={{ display: 'inline-block', transition: 'transform 0.3s ease' }}>
                    {pool.activePlayers}
                  </span>{' '}
                  Players
                </div>
                <div style={{ fontSize: '12px', color: '#8b8fa3' }}>
                  {pool.tablesRunning} Tables
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="number"
                placeholder={`Buy-In (${pool.buyInMin})`}
                min={pool.buyInMin}
                max={pool.buyInMax}
                value={buyInAmounts[pool.poolId] || ''}
                onChange={(e) =>
                  setBuyInAmounts((prev) => ({
                    ...prev,
                    [pool.poolId]: e.target.value === '' ? 0 : Number(e.target.value),
                  }))
                }
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '10px',
                  padding: '10px 14px',
                  color: '#e4e6eb',
                  fontSize: '16px' /* under 16px makes iOS zoom the page on focus */,
                  outline: 'none',
                  minHeight: '44px',
                  boxSizing: 'border-box',
                }}
              />
              <button
                onClick={() => handleJoinPool(pool)}
                disabled={joiningPool === pool.poolId || pool.status === 'closed'}
                style={{
                  background:
                    joiningPool === pool.poolId
                      ? 'rgba(255,215,0,0.3)'
                      : 'linear-gradient(135deg, #FFD700, #FFA500)',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '10px 24px',
                  minHeight: '44px',
                  touchAction: 'manipulation',
                  color: '#000',
                  fontWeight: 700,
                  fontSize: '14px',
                  cursor: 'pointer',
                  opacity: joiningPool === pool.poolId ? 0.7 : 1,
                  transition: 'all 0.3s ease',
                }}
              >
                {joiningPool === pool.poolId ? '◷' : pool.status === 'closed' ? 'Closed' : 'Play'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {pools.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '60px 20px',
            color: '#8b8fa3',
          }}
        >
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>▲</div>
          <p>No Flash Pools Available Yet.</p>
          <p style={{ fontSize: '13px' }}>Check Back Soon!</p>
        </div>
      )}
    </div>
  );
}
