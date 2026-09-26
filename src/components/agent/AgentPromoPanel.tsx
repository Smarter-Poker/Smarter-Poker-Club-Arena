/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AgentPromoPanel — Agent Promotional Chip Distribution Panel
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Ported from World Hub → Club Arena (March 2026)
 *
 *  Shown on the Cashier page for agents. Displays promo_balance
 *  and lets agents distribute promo chips to their downline players.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useVisibleRead } from '../../hooks/useVisibleRead';
import { supabase } from '../../lib/supabase';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { masterBus } from '../../core/MasterBus';
import { triggerHaptic } from '../../services/HapticService';
import { resolveAvatarDisplay } from '../../utils/avatarUtils';
import { checkSettlementLock } from '../../utils/settlementLock';
import { reportError } from '../../utils/errorReporter';
import { fetchAllRows } from '../../utils/fetchAllRows';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../../utils/playerDisplayName';

/** crypto.randomUUID is not in every embedded webview; fall back rather than throw. */
function newOpId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const FB = {
  bg: '#18191A',
  card: '#242526',
  text: '#E4E6EB',
  dim: '#B0B3B8',
  border: '#3E4042',
  gold: '#FFD700',
  success: '#31A24C',
  danger: '#FA383E',
  promo: '#9333ea',
};

interface DownlinePlayer {
  user_id: string;
  chip_balance?: number;
  promo_balance?: number;
  profiles?: { display_name?: string; username?: string; avatar_url?: string } | null;
}

type DownlineEvent = { kind: 'remove' } | { kind: 'balance'; value: number };

interface AgentPromoPanelProps {
  clubId: string;
  userId: string;
  role: string;
  onDistribute?: () => void;
}

export default function AgentPromoPanel({
  clubId,
  userId,
  role,
  onDistribute,
}: AgentPromoPanelProps) {
  const [promoBalance, setPromoBalance] = useState<number | null>(null);
  const [downline, setDownline] = useState<DownlinePlayer[]>([]);
  const downlineRef = useRef<DownlinePlayer[]>([]);
  const downlineEventsRef = useRef(new Map<string, DownlineEvent>());
  const [loading, setLoading] = useState(true);
  const [balanceError, setBalanceError] = useState(false);
  const [downlineError, setDownlineError] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [distributing, setDistributing] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const isMounted = useIsMounted();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Rate limit: 10s between distributions
  const lastDistributeRef = useRef(0);
  const DISTRIBUTE_RATE_LIMIT_MS = 10_000;

  /**
   * The idempotency key for the CURRENT attempt. Held across a failure so a
   * retry after a lost response replays the original send instead of paying
   * twice; cleared on success and whenever the inputs change, because a
   * changed amount or target is a genuinely new intent.
   */
  const opIdRef = useRef<string | null>(null);
  useEffect(() => {
    opIdRef.current = null;
  }, [amount, selectedPlayer, clubId]);

  const isAgent = ['agent', 'sub_agent', 'super_agent'].includes(role);

  const showToast = (msg: string, type = 'success') => {
    if (!isMounted.current) return;
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      if (isMounted.current) setToast(null);
    }, 3000);
  };

  const readScope = `${clubId}:${userId}:${role}`;
  const scopeRef = useRef(readScope);
  scopeRef.current = readScope;
  const refreshBalance = useVisibleRead({
    scopeKey: readScope,
    enabled: Boolean(clubId && userId && isAgent),
    read: async (signal) => {
      const { data: agent, error } = await supabase
        .from('agents')
        .select('id, promo_wallet_balance')
        .eq('club_id', clubId)
        .eq('user_id', userId)
        .abortSignal(signal)
        .maybeSingle();
      const value = agent?.promo_wallet_balance;
      if (
        error ||
        !agent ||
        value === null ||
        value === undefined ||
        String(value).trim() === '' ||
        !Number.isFinite(Number(value))
      )
        throw error || new Error('Promo Balance Is Unavailable');
      return Number(value);
    },
    onData: (value) => {
      setPromoBalance(value);
      setBalanceError(false);
    },
    onError: (error) => {
      reportError(error, 'AgentPromoPanel.Balance');
      setBalanceError(true);
    },
    onReset: () => {
      setPromoBalance(null);
      setBalanceError(false);
    },
  });
  const refreshDownline = useVisibleRead({
    scopeKey: readScope,
    enabled: Boolean(clubId && userId && isAgent),
    intervalMs: 60_000,
    read: async (signal) => {
      // Events arriving after this snapshot starts must survive its delayed
      // response. This map belongs to one read, never another account's read.
      const events = new Map<string, DownlineEvent>();
      downlineEventsRef.current = events;
      const players = await fetchAllRows<{ user_id: string; chip_balance: number }>(
        (from, to) =>
          supabase
            .from('club_members')
            .select('user_id, chip_balance')
            .eq('club_id', clubId)
            .eq('agent_id', userId)
            .eq('role', 'player')
            .order('user_id', { ascending: true })
            .range(from, to)
            .abortSignal(signal),
        { label: 'AgentPromoPanel.players' }
      );
      const playerProfileMap: Record<string, any> = {};
      // Bounded ID lists avoid an oversized URL for a large downline.
      for (let start = 0; start < players.length; start += 100) {
        signal.throwIfAborted();
        const { data: profiles, error } = await supabase
          .from('profiles')
          .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
          .in(
            'id',
            players.slice(start, start + 100).map((player) => player.user_id)
          )
          .abortSignal(signal);
        if (error) throw error;
        for (const profile of profiles || []) playerProfileMap[profile.id] = profile;
      }
      return {
        players: players.map((player) => ({
          ...player,
          profiles: playerProfileMap[player.user_id] || null,
        })),
        events,
      };
    },
    onData: ({ players, events }) => {
      const current = players
        .flatMap((player) => {
          const event = events.get(player.user_id);
          if (event?.kind === 'remove') return [];
          return [
            {
              ...player,
              chip_balance: event?.kind === 'balance' ? event.value : player.chip_balance,
            },
          ];
        })
        .sort((a, b) => b.chip_balance - a.chip_balance);
      downlineRef.current = current;
      setDownline(current);
      setDownlineError(false);
      setLoading(false);
    },
    onError: (error) => {
      reportError(error, 'AgentPromoPanel.Downline');
      setDownlineError(true);
      setLoading(false);
    },
    onReset: () => {
      downlineRef.current = [];
      downlineEventsRef.current = new Map();
      setDownline([]);
      setDownlineError(false);
      setLoading(true);
      setSelectedPlayer(null);
      setAmount('');
      setDistributing(false);
      setToast(null);
    },
  });
  const loadData = () => {
    refreshBalance();
    refreshDownline();
  };
  useMasterBusSubscription('DATA_MUTATED', (payload) => {
    const relevant = ['promo_distributed', 'promo_granted', 'chips_distributed', 'chips_minted'];
    if (relevant.includes(String(payload?.action || ''))) loadData();
  });
  useEffect(() => {
    if (!clubId || !userId || !isAgent) return;
    let active = true;
    const scope = readScope;
    const channelKey = `agent-promo-${clubId}-${userId}`;
    masterBus
      .getOrCreateChannel(channelKey)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'club_members', filter: `agent_id=eq.${userId}` },
        (payload) => {
          if (!active || scopeRef.current !== scope) return;
          if (!['INSERT', 'UPDATE', 'DELETE'].includes(payload.eventType)) return;
          const deleted = payload.eventType === 'DELETE';
          const row = deleted ? payload.old : payload.new;
          // Default replica identity is (club_id,user_id). DELETE filtering
          // and old non-key fields cannot establish membership in this list.
          if (row?.club_id !== clubId || typeof row.user_id !== 'string') return;
          const known = downlineRef.current.find((player) => player.user_id === row.user_id);
          const membershipKnown =
            (typeof row.agent_id === 'string' || row.agent_id === null) &&
            typeof row.role === 'string';
          if (deleted || (membershipKnown && (row.agent_id !== userId || row.role !== 'player'))) {
            downlineEventsRef.current.set(row.user_id, { kind: 'remove' });
            if (known) {
              const remaining = downlineRef.current.filter(
                (player) => player.user_id !== row.user_id
              );
              downlineRef.current = remaining;
              setDownline(remaining);
              setSelectedPlayer((selected) => (selected === row.user_id ? null : selected));
            }
            return;
          }
          const value = row.chip_balance;
          if (
            !known ||
            !membershipKnown ||
            !['number', 'string'].includes(typeof value) ||
            String(value).trim() === '' ||
            !Number.isFinite(Number(value))
          ) {
            refreshDownline();
            return;
          }
          const balance = Number(value);
          // Heartbeats and unrelated membership fields do not reload all
          // players and profiles. The delivered new row already has the chips.
          downlineEventsRef.current.set(row.user_id, { kind: 'balance', value: balance });
          if (known.chip_balance === balance) return;
          const players = downlineRef.current
            .map((player) =>
              player.user_id === row.user_id ? { ...player, chip_balance: balance } : player
            )
            .sort((a, b) => (b.chip_balance ?? 0) - (a.chip_balance ?? 0));
          downlineRef.current = players;
          setDownline(players);
        }
      )
      .subscribe((status: string, error?: Error) => {
        if (!active || scopeRef.current !== scope) return;
        if (status === 'SUBSCRIBED') refreshDownline();
        if (status === 'CHANNEL_ERROR' && error) reportError(error, 'AgentPromoPanel.Channel');
      });
    return () => {
      active = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, userId, isAgent, readScope, refreshDownline]);

  const handleDistribute = async () => {
    if (!selectedPlayer || !amount || promoBalance === null || balanceError || downlineError)
      return;
    const scope = readScope;
    const current = () => isMounted.current && scopeRef.current === scope;
    const amt = Math.floor(Number(amount));
    if (!amt || !Number.isFinite(amt) || amt <= 0) {
      showToast('Enter a positive amount', 'error');
      return;
    }
    if (amt > promoBalance) {
      showToast('Insufficient promo balance', 'error');
      return;
    }

    setDistributing(true);
    triggerHaptic('medium');

    // RATE LIMIT — 10s between distributions
    const now = Date.now();
    const elapsed = now - lastDistributeRef.current;
    if (elapsed < DISTRIBUTE_RATE_LIMIT_MS) {
      const waitSec = Math.ceil((DISTRIBUTE_RATE_LIMIT_MS - elapsed) / 1000);
      showToast(`Please wait ${waitSec}s before distributing again`, 'error');
      setDistributing(false);
      return;
    }

    // SETTLEMENT FREEZE CHECK — block during active settlements
    try {
      const lockResult = await checkSettlementLock(clubId);
      if (!current()) return;
      if (lockResult.locked) {
        showToast('Settlement in progress - distributions frozen', 'error');
        if (isMounted.current) setDistributing(false);
        return;
      }
    } catch (e) {
      reportError(e, 'AgentPromoPanel');
      // Fail-open: allow distribution if settlement check fails
    }

    if (!current()) return;
    try {
      /**
       * THE POOL THIS PANEL DISPLAYS IS NOW THE POOL IT SPENDS (audit
       * 2026-08-27). The header above shows agents.promo_wallet_balance -
       * the float the Club Bank Cashier funds - but the old path went
       * through the distribute-promo World Hub route, whose RPC
       * (transfer_promo_agent_to_player) debits club_members.promo_balance:
       * a column that is zero for every member in production and that
       * nothing ever funds. Every distribution therefore died with
       * "insufficient agent promo balance" while the panel showed a funded
       * float - zero ledger rows of that type have EVER been written.
       *
       * fn_promo_wallet_send is the canonical promo money path (Dan
       * 2026-08-24: to a player wallet it is just as good as cash). It
       * debits the displayed float, enforces the recursive downline edge,
       * refuses self-sends and sub-cent amounts, and writes one ledger row
       * under an op_id - held in a ref across a failed attempt so a retry
       * after a lost response replays instead of paying twice, and minted
       * fresh once the send lands or the inputs change.
       */
      if (!opIdRef.current) opIdRef.current = newOpId();
      const { data, error } = await supabase.rpc('fn_promo_wallet_send', {
        p_club_id: clubId,
        p_to_user_id: selectedPlayer,
        p_amount: amt,
        p_destination: 'player_wallet',
        p_reason: 'Promo Distribution From The Agent Panel',
        p_op_id: opIdRef.current,
      });
      if (!current()) return;
      if (error) throw error;
      const res = (Array.isArray(data) ? data[0] : data) as {
        success?: boolean;
        error?: string;
      } | null;
      if (!res?.success) throw new Error(res?.error || 'Distribution failed');
      opIdRef.current = null;

      showToast(`${amt.toLocaleString()} promo chips sent`);
      masterBus.emit('DATA_MUTATED', { table: 'agents', action: 'promo_distributed' });
      masterBus.emit('BALANCE_UPDATED', { source: 'promo_distributed', userId: selectedPlayer });
      if (isMounted.current) {
        setAmount('');
        setSelectedPlayer(null);
        loadData();
        onDistribute?.();
        lastDistributeRef.current = Date.now();
      }
    } catch (e: unknown) {
      if (!current()) return;
      const msg = e instanceof Error ? e.message : 'Distribution failed';
      showToast(msg, 'error');
    } finally {
      if (current()) setDistributing(false);
    }
  };

  if (!isAgent) return null;
  const PRESETS = [100, 500, 1000, 2500];

  return (
    <div
      style={{
        background: FB.card,
        borderRadius: 12,
        padding: 16,
        border: `1px solid ${FB.border}`,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: FB.text }}>◈ Promo Wallet</div>
          <div style={{ fontSize: 11, color: FB.dim }}>
            Distribute Promotional Chips To Your Players
          </div>
        </div>
        <div
          style={{
            background: `${FB.promo}20`,
            border: `1px solid ${FB.promo}60`,
            borderRadius: 8,
            padding: '4px 12px',
          }}
        >
          <div style={{ fontSize: 10, color: FB.promo, fontWeight: 600 }}>PROMO BALANCE</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: FB.promo }}>
            {balanceError
              ? 'Unavailable'
              : promoBalance === null
                ? 'Loading...'
                : promoBalance.toLocaleString()}
          </div>
        </div>
      </div>

      {toast && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            marginBottom: 10,
            background: toast.type === 'error' ? '#dc262620' : '#31A24C20',
            color: toast.type === 'error' ? FB.danger : FB.success,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {toast.msg}
        </div>
      )}

      {balanceError || downlineError ? (
        <div role="alert">
          Promo Data Could Not Be Refreshed. <button onClick={loadData}>Try Again</button>
        </div>
      ) : loading || promoBalance === null ? (
        <div style={{ padding: '12px 0' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 0',
                animation: `animationsShimmerFade 1.4s ease-in-out ${i * 0.1}s infinite`,
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background:
                    'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                  backgroundSize: '200px 100%',
                  animation: 'animationsShimmerSlide 1.4s ease-in-out infinite',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    width: `${50 + i * 10}%`,
                    height: 12,
                    borderRadius: 4,
                    background:
                      'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                    backgroundSize: '200px 100%',
                    animation: 'animationsShimmerSlide 1.4s ease-in-out infinite',
                    marginBottom: 5,
                  }}
                />
                <div
                  style={{
                    width: '40%',
                    height: 10,
                    borderRadius: 4,
                    background:
                      'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                    backgroundSize: '200px 100%',
                    animation: 'animationsShimmerSlide 1.4s ease-in-out infinite',
                  }}
                />
              </div>
            </div>
          ))}
          <style>{`
            @keyframes shimmerSlide { 0% { background-position: -200px 0; } 100% { background-position: 200px 0; } }
            @keyframes shimmerFade { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
          `}</style>
        </div>
      ) : promoBalance <= 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '16px 12px',
            background: `${FB.promo}08`,
            borderRadius: 8,
            border: `1px solid ${FB.border}`,
          }}
        >
          <div style={{ fontSize: 24, marginBottom: 6 }}>◈</div>
          <div style={{ fontSize: 13, color: FB.dim, fontWeight: 600 }}>
            No Promo Chips Available
          </div>
          <div style={{ fontSize: 11, color: FB.dim, marginTop: 4 }}>
            Ask Your Club Owner To Grant Promo Chips From The Admin Panel.
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 10 }}>
            <label
              style={{
                fontSize: 11,
                color: FB.dim,
                fontWeight: 600,
                marginBottom: 4,
                display: 'block',
              }}
            >
              Select Player ({downline.length} In Your Downline)
            </label>
            {downline.length === 0 ? (
              <div style={{ fontSize: 12, color: FB.dim, padding: '8px 0' }}>
                No Players Assigned To You Yet.
              </div>
            ) : (
              <select
                value={selectedPlayer || ''}
                onChange={(e) => setSelectedPlayer(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: FB.bg,
                  color: FB.text,
                  border: `1px solid ${FB.border}`,
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <option value="">Choose A Player...</option>
                {downline.map((p) => (
                  <option key={p.user_id} value={p.user_id}>
                    {p.profiles ? playerDisplayName(p.profiles) : p.user_id.slice(0, 8)}
                    {' - '}Chips:{' '}
                    {p.chip_balance !== undefined && p.chip_balance !== null
                      ? p.chip_balance.toLocaleString()
                      : '...'}
                  </option>
                ))}
              </select>
            )}
          </div>

          {selectedPlayer && (
            <>
              <div style={{ marginBottom: 8 }}>
                <label
                  style={{
                    fontSize: 11,
                    color: FB.dim,
                    fontWeight: 600,
                    marginBottom: 4,
                    display: 'block',
                  }}
                >
                  Amount
                </label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Enter Promo Chip Amount"
                  min="1"
                  max={promoBalance}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    background: FB.bg,
                    color: FB.text,
                    border: `1px solid ${FB.border}`,
                    borderRadius: 8,
                    fontSize: 15,
                    fontWeight: 700,
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                {PRESETS.filter((p) => p <= promoBalance).map((p) => (
                  <button
                    key={p}
                    onClick={() => setAmount(String(p))}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 6,
                      background: amount === String(p) ? FB.promo : FB.bg,
                      color: amount === String(p) ? '#fff' : FB.dim,
                      border: `1px solid ${FB.border}`,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    {p.toLocaleString()}
                  </button>
                ))}
                <button
                  onClick={() => setAmount(String(promoBalance))}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    background: amount === String(promoBalance) ? FB.promo : FB.bg,
                    color: amount === String(promoBalance) ? '#fff' : FB.dim,
                    border: `1px solid ${FB.border}`,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  ALL
                </button>
              </div>
              <button
                onClick={handleDistribute}
                disabled={distributing || !amount || Math.floor(Number(amount)) <= 0}
                style={{
                  width: '100%',
                  padding: '12px 0',
                  background: distributing
                    ? FB.dim
                    : `linear-gradient(135deg, ${FB.promo}, #7c3aed)`,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 10,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: distributing ? 'not-allowed' : 'pointer',
                  opacity: distributing ? 0.7 : 1,
                  boxShadow: `0 4px 16px ${FB.promo}40`,
                }}
              >
                {distributing
                  ? 'Sending...'
                  : `Send ${amount && Math.floor(Number(amount)) > 0 ? Math.floor(Number(amount)).toLocaleString() : '0'} Promo Chips`}
              </button>
            </>
          )}

          {downline.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: FB.dim, marginBottom: 6 }}>
                Your Players
              </div>
              {downline.slice(0, 10).map((p) => {
                const name = p.profiles ? playerDisplayName(p.profiles) : p.user_id.slice(0, 8);
                return (
                  <div
                    key={p.user_id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 0',
                      borderBottom: `1px solid ${FB.border}20`,
                    }}
                  >
                    <img
                      src={resolveAvatarDisplay(p.profiles?.avatar_url, p.user_id)}
                      alt=""
                      loading="lazy"
                      style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: FB.text,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {name}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 11, color: FB.text, fontWeight: 700 }}>
                        {p.chip_balance !== undefined && p.chip_balance !== null
                          ? p.chip_balance.toLocaleString()
                          : '...'}
                      </div>
                    </div>
                  </div>
                );
              })}
              {downline.length > 10 && (
                <div style={{ fontSize: 11, color: FB.dim, textAlign: 'center', padding: 6 }}>
                  +{downline.length - 10} More Players
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div
        style={{
          marginTop: 12,
          padding: '8px 10px',
          borderRadius: 6,
          background: 'rgba(147,51,234,0.06)',
          border: `1px solid ${FB.promo}20`,
          fontSize: 10,
          color: FB.dim,
          lineHeight: 1.5,
        }}
      >
        ⓘ Promo Chips Are Non-Transferable Between Agents. They Can Only Be Distributed To Your
        Assigned Players. Promo Chips Do Not Count As Settlement Debt.
      </div>
    </div>
  );
}
