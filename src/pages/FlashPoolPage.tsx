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
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { flashPoolEngine, type FlashPoolConfig } from '../engine/FlashPoolEngine';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';

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
      console.error('[FlashPoolPage] Failed to load pools:', err);
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

  // ── Load user's chip balance ──
  useEffect(() => {
    if (!user?.id) return;
    const loadBalance = async () => {
      try {
        const { data } = await supabase
          .from('club_members')
          .select('chip_balance')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle();
        if (data) setUserBalance(data.chip_balance || 0);
      } catch {
        /* best effort */
      }
    };
    loadBalance();
  }, [user?.id]);

  // ── Bus listener: keep balance in sync when chips change on other pages ──
  useEffect(() => {
    if (!user?.id) return;
    const unsub = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      async () => {
        try {
          const { data } = await supabase
            .from('club_members')
            .select('chip_balance')
            .eq('user_id', user.id)
            .limit(1)
            .maybeSingle();
          if (data) setUserBalance(data.chip_balance || 0);
        } catch {
          /* best effort */
        }
      },
      500
    );
    return () => unsub();
  }, [user?.id]);

  // ── Bus listener for pool updates (debounced) ──
  useEffect(() => {
    const unsub = masterBus.subscribeDebounced(
      'GAME_STATE_UPDATED',
      (event) => {
        const data = event.payload;
        if (!data) return;
        setPools((prev) =>
          prev.map((p) =>
            p.poolId === data.poolId
              ? {
                  ...p,
                  activePlayers: data.activePlayers ?? p.activePlayers,
                  tablesRunning: data.tablesRunning ?? p.tablesRunning,
                }
              : p
          )
        );
      },
      500
    );
    return () => unsub();
  }, []);

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
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, []);

  const handleJoinPool = useCallback(
    async (pool: PoolDisplay) => {
      if (!user?.id) {
        toast.error('Please sign in to play');
        return;
      }
      const enteredAmount = buyInAmounts[pool.poolId] || 0;
      const buyIn = enteredAmount || pool.buyInMin;
      // Validate buy-in is within the pool's allowed range
      if (buyIn < pool.buyInMin || buyIn > pool.buyInMax) {
        toast.error(
          `Buy-in must be between ${pool.buyInMin.toLocaleString()} and ${pool.buyInMax.toLocaleString()}`
        );
        return;
      }
      setJoiningPool(pool.poolId);
      try {
        const joined = flashPoolEngine.joinPool(pool.poolId, user.id, buyIn);
        if (!joined) {
          toast.error('Unable to join pool — you may already be in this pool');
          return;
        }
        toast.success(`Joining ${pool.stakes} flash pool...`);
        masterBus.emit('FLASH_POOL_JOINED', {
          poolId: pool.poolId,
          userId: user.id,
          buyIn,
        });
      } catch (err) {
        console.error('[FlashPoolPage] Join failed:', err);
        toast.error('Failed to join pool');
      } finally {
        setJoiningPool(null);
      }
    },
    [user, buyInAmounts, toast]
  );

  if (loading) return <PageSkeleton />;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #0a0a0a 100%)',
        color: '#e4e6eb',
        padding: '20px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '24px',
        }}
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
        <div>
          <h1
            style={{
              fontSize: '24px',
              fontWeight: 700,
              margin: 0,
              background: 'linear-gradient(135deg, #FFD700, #FFA500)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            ⚡ Flash Pool
          </h1>
          <p style={{ color: '#8b8fa3', margin: '4px 0 0', fontSize: '13px' }}>
            Fast-fold poker — fold instantly, get new cards
          </p>
        </div>
      </div>

      {/* How It Works */}
      <div
        style={{
          background: 'rgba(255,215,0,0.06)',
          border: '1px solid rgba(255,215,0,0.15)',
          borderRadius: '16px',
          padding: '16px',
          marginBottom: '24px',
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '12px',
          textAlign: 'center',
        }}
      >
        <div>
          <div style={{ fontSize: '28px', marginBottom: '4px' }}>⚡</div>
          <div style={{ fontSize: '12px', color: '#8b8fa3' }}>Fold Instantly</div>
        </div>
        <div>
          <div style={{ fontSize: '28px', marginBottom: '4px' }}>🔄</div>
          <div style={{ fontSize: '12px', color: '#8b8fa3' }}>New Table</div>
        </div>
        <div>
          <div style={{ fontSize: '28px', marginBottom: '4px' }}>🃏</div>
          <div style={{ fontSize: '12px', color: '#8b8fa3' }}>New Cards</div>
        </div>
      </div>

      {/* Pool List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
                  Buy-in: {pool.buyInMin.toLocaleString()} – {pool.buyInMax.toLocaleString()}
                </div>
                {userBalance !== null && (
                  <div style={{ fontSize: '11px', color: '#60a5fa', marginTop: '2px' }}>
                    💰 Your balance: {userBalance.toLocaleString()} chips
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
                  players
                </div>
                <div style={{ fontSize: '12px', color: '#8b8fa3' }}>
                  {pool.tablesRunning} tables
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="number"
                placeholder={`Buy-in (${pool.buyInMin})`}
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
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '10px',
                  padding: '10px 14px',
                  color: '#e4e6eb',
                  fontSize: '14px',
                  outline: 'none',
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
                  color: '#000',
                  fontWeight: 700,
                  fontSize: '14px',
                  cursor: 'pointer',
                  opacity: joiningPool === pool.poolId ? 0.7 : 1,
                  transition: 'all 0.3s ease',
                }}
              >
                {joiningPool === pool.poolId
                  ? '⏳'
                  : pool.status === 'closed'
                    ? '🔒 Closed'
                    : '⚡ Play'}
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
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>⚡</div>
          <p>No flash pools available yet.</p>
          <p style={{ fontSize: '13px' }}>Check back soon!</p>
        </div>
      )}
    </div>
  );
}
