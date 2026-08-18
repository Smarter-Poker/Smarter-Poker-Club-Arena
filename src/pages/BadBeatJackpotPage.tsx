/**
 *  BAD BEAT JACKPOT PAGE — Live Jackpot Updates
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import ClubBottomNav from '../components/club/ClubBottomNav';
import './BadBeatJackpotPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubUUID } from '../utils/clubIdResolver';
import PageSkeleton from '../components/common/PageSkeleton';
import { formatDate } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import BBJService from '../services/BBJService';
import { confirmDialog } from '../components/common/confirmDialog';
import BBJAdminAnalytics from '../components/bbj/BBJAdminAnalytics';
import BBJRulesPanel from '../components/bbj/BBJRulesPanel';

interface JackpotInfo {
  id: string;
  club_id: string;
  pool_amount?: number; // Legacy — not in schema, kept for backward compat
  main_balance: number;
  backup_balance: number;
  promo_balance: number;
  total_contributed: number;
  last_hit_at?: string;
  last_hit_amount?: number;
}

interface JackpotHistory {
  id: string;
  awarded_at: string;
  total_payout: number;
  winner_hand: string;
  loser_hand: string;
  winner_display_name?: string;
  loser_display_name?: string;
}

export default function BadBeatJackpotPage() {
  const navigate = useNavigate();
  useVisibilityRefresh(() => loadJackpotData());
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();

  const [jackpot, setJackpot] = useState<JackpotInfo | null>(null);
  const [history, setHistory] = useState<JackpotHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [justUpdated, setJustUpdated] = useState(false);
  const [visibleHistoryRows, setVisibleHistoryRows] = useState(new Set<number>());
  const [playerContribution, setPlayerContribution] = useState(0);
  // 2026-08-18: real hand count + own-contribution facts, from the ledger.
  const [poolFacts, setPoolFacts] = useState<{ hands: number; chips: number } | null>(null);
  const [myHands, setMyHands] = useState(0);
  const [canManagePromo, setCanManagePromo] = useState(false);
  const [promoAmount, setPromoAmount] = useState('');
  const [distributingPromo, setDistributingPromo] = useState(false);

  // Only the pool's club/union owner sees the promo-rain control (the RPC also
  // enforces this server-side).
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!clubId || !user?.id) {
        setCanManagePromo(false);
        return;
      }
      try {
        const resolvedId = await resolveClubUUID(clubId);
        const { data: clubRow } = await supabase
          .from('clubs')
          .select('owner_id, union_id')
          .eq('id', resolvedId)
          .maybeSingle();
        if (!alive) return;
        let owner = clubRow?.owner_id === user.id;
        if (!owner && clubRow?.union_id) {
          const { data: unionRow } = await supabase
            .from('unions')
            .select('owner_id')
            .eq('id', clubRow.union_id)
            .maybeSingle();
          owner = unionRow?.owner_id === user.id;
        }
        if (alive) setCanManagePromo(owner);
      } catch (e) {
        reportError(e, 'BadBeatJackpotPage.ownerCheck');
      }
    })();
    return () => {
      alive = false;
    };
  }, [clubId, user?.id]);

  const runPromoRain = async () => {
    if (!jackpot?.id || distributingPromo) return;
    const amount = Number(promoAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid amount to distribute.');
      return;
    }
    if (amount > (jackpot.promo_balance || 0)) {
      toast.error('Amount exceeds the promo pool balance.');
      return;
    }
    if (
      !(await confirmDialog({
        title: 'Distribute promo pool',
        message: `Rain ${amount.toLocaleString()} chips from the promo pool, split evenly among all currently-active players? This can't be undone.`,
        confirmText: 'Rain it',
        variant: 'default',
      }))
    )
      return;
    setDistributingPromo(true);
    try {
      const count = await BBJService.executePromoRain(jackpot.id, amount, 'Promo rain');
      toast.success(`Rained ${amount.toLocaleString()} chips to ${count} active player(s)!`);
      setPromoAmount('');
      loadJackpotData();
    } catch (e: any) {
      toast.error(e?.message || 'Promo rain failed');
    } finally {
      setDistributingPromo(false);
    }
  };
  const prevAmountRef = useRef<number>(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (clubId) {
      let isMounted = true;
      loadJackpotData(() => isMounted);

      const channelKey = 'jackpot-live';

      const setupRealtime = async () => {
        const resolvedId = await resolveClubUUID(clubId);
        if (!isMounted) return;

        // RAKE-AUDIT 2026-07-24: resolve the ACTUAL pool (union-level when the
        // club is in a union — that is where the server banks contributions).
        // The old `club_id=eq.` filter never fired for union clubs.
        const { data: clubRow } = await supabase
          .from('clubs')
          .select('union_id')
          .eq('id', resolvedId)
          .maybeSingle();
        let poolIdQuery = supabase.from('bbj_pools').select('id');
        poolIdQuery = clubRow?.union_id
          ? poolIdQuery.eq('union_id', clubRow.union_id)
          : poolIdQuery.eq('club_id', resolvedId);
        const { data: poolRow } = await poolIdQuery.maybeSingle();
        if (!isMounted) return;
        const poolFilter = poolRow?.id ? `id=eq.${poolRow.id}` : `club_id=eq.${resolvedId}`;
        const winnersFilter = poolRow?.id ? `pool_id=eq.${poolRow.id}` : `club_id=eq.${resolvedId}`;

        const channel = masterBus.getOrCreateChannel(channelKey);
        channel
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'bbj_pools',
              filter: poolFilter,
            },
            (payload) => {
              if (!isMounted) return;
              const newData = payload.new as JackpotInfo;
              if ((newData.main_balance || 0) > prevAmountRef.current) {
                setJustUpdated(true);
                if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
                flashTimerRef.current = setTimeout(() => {
                  setJustUpdated(false);
                  flashTimerRef.current = null;
                }, 2000);
              }
              prevAmountRef.current = newData.main_balance || 0;
              setJackpot(newData);
            }
          )
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'bbj_winners',
              filter: winnersFilter,
            },
            (payload) => {
              if (!isMounted) return;
              toast.success(' BAD BEAT JACKPOT HIT!');
              loadJackpotData(() => isMounted);
            }
          )
          .subscribe((status: string, err?: Error) => {
            if (status === 'CHANNEL_ERROR') {
              if (err)
                reportError(err?.message || err, 'BadBeatJackpotPage._Realtime_channel_error');
            }
            if (status === 'TIMED_OUT') {
              console.warn('[BadBeatJackpotPage] ⏱️ Realtime channel timed out');
            }
          });
      };

      setupRealtime().catch((e) => console.warn('[BadBeatJackpotPage] Realtime setup failed:', e));

      return () => {
        isMounted = false;
        masterBus.removeRegisteredChannel(channelKey);
        if (flashTimerRef.current) {
          clearTimeout(flashTimerRef.current);
          flashTimerRef.current = null;
        }
      };
    }
  }, [clubId]);

  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setJustUpdated(false);
    setPlayerContribution(0);
    setVisibleHistoryRows(new Set());
    loadingRef.current = false;
  }, [clubId]);

  const loadJackpotData = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (!clubId) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (!getIsMounted || getIsMounted()) setLoading(true);
      try {
        const resolvedId = await resolveClubUUID(clubId);

        // RAKE-AUDIT 2026-07-24: read the pool where the server actually banks
        // the money — union-level pool when the club belongs to a union, else
        // the club-level pool. Union clubs previously showed a stale/empty
        // club pool while the real jackpot accumulated in the union pool.
        const { data: clubUnionRow } = await supabase
          .from('clubs')
          .select('union_id')
          .eq('id', resolvedId)
          .maybeSingle();
        let jackpotQuery = supabase
          .from('bbj_pools')
          .select(
            'id, club_id, main_balance, backup_balance, promo_balance, total_contributed, last_hit_at, last_hit_amount'
          );
        jackpotQuery = clubUnionRow?.union_id
          ? jackpotQuery.eq('union_id', clubUnionRow.union_id)
          : jackpotQuery.eq('club_id', resolvedId);
        const { data: jackpotData } = await jackpotQuery.maybeSingle();

        if (getIsMounted && !getIsMounted()) return;
        if (jackpotData) {
          setJackpot(jackpotData);
          prevAmountRef.current = jackpotData.main_balance || 0;
        }

        // RAKE-AUDIT 2026-07-24: winners history keyed to the resolved pool so
        // union-club players see union-pool hits.
        let historyQuery = supabase
          .from('bbj_winners')
          .select(
            'id, awarded_at, total_payout, winner_hand, loser_hand, winner_display_name, loser_display_name'
          );
        historyQuery = jackpotData?.id
          ? historyQuery.eq('pool_id', jackpotData.id)
          : historyQuery.eq('club_id', resolvedId);
        const { data: historyData } = await historyQuery
          .order('awarded_at', { ascending: false })
          .limit(10);

        if (getIsMounted && !getIsMounted()) return;
        if (historyData) {
          setHistory(historyData);
        }

        // 2026-08-18: pool facts from the LEDGER (the pool counters have
        // drifted: 161,442 counter vs 261,316 actual rows).
        if (jackpotData?.id) {
          const { data: factRows } = await supabase.rpc('fn_bbj_pool_facts', {
            p_pool_id: jackpotData.id,
          });
          if (getIsMounted && !getIsMounted()) return;
          const f = Array.isArray(factRows) ? factRows[0] : factRows;
          if (f) {
            setPoolFacts({
              hands: Number(f.hands_contributed) || 0,
              chips: Number(f.total_contributed) || 0,
            });
          }
        }

        // "Your contribution" used to read bbj_contributions.player_id, which
        // is NULL on all 550,782 rows — the card always computed 0 and never
        // rendered, after pulling up to 10,000 rows to find that out. The BBJ
        // fee comes out of the POT, so a player's honest share is
        // fee x (their pot contribution / pot size) — which is what this RPC
        // returns, for the calling user only.
        if (user?.id && jackpotData?.id) {
          const { data: mineRows } = await supabase.rpc('fn_bbj_my_contribution', {
            p_pool_id: jackpotData.id,
            p_days: 90,
          });
          if (getIsMounted && !getIsMounted()) return;
          const mine = Array.isArray(mineRows) ? mineRows[0] : mineRows;
          if (mine) {
            setPlayerContribution(Number(mine.attributed_chips) || 0);
            setMyHands(Number(mine.hands_contributed) || 0);
          }
        }
      } catch (error) {
        reportError(error, 'BadBeatJackpotPage.Failed_to_load_jackpot');
        if (!getIsMounted || getIsMounted()) toast.error('Failed to load jackpot data.');
      } finally {
        loadingRef.current = false;
        if (!getIsMounted || getIsMounted()) setLoading(false);
      }
    },
    [clubId]
  );

  // Bus listener: reload jackpot data when a hand completes (BBJ contribution may have been added)
  useEffect(() => {
    if (!clubId) return;
    const unsubHand = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => {
        loadJackpotData();
      },
      2000
    );
    return unsubHand;
  }, [clubId, loadJackpotData]);

  // Stagger history rows
  useEffect(() => {
    setVisibleHistoryRows(new Set());
    const timers = history.map((_, i) =>
      setTimeout(() => setVisibleHistoryRows((prev) => new Set([...prev, i])), i * 50)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [history.length]);

  if (loading) {
    return (
      <div className="bbj-page">
        <div className="loading-state">
          <PageSkeleton variant="stats" />
        </div>
        {clubId && <ClubBottomNav clubId={clubId} />}
      </div>
    );
  }

  return (
    <div className="bbj-page">
      {/* Current Jackpot — Main Balance */}
      <div className={`jackpot-display ${justUpdated ? 'just-updated' : ''}`}>
        <div className="jackpot-glow" />
        <span className="jackpot-label">Main Jackpot</span>
        <span className="jackpot-amount">{(jackpot?.main_balance || 0).toLocaleString()}</span>
      </div>

      {/* 100K Pivot Law Threshold Alert */}
      {/* RAKE-AUDIT 2026-07-24: alert fired at 50k (50% of pivot) while the
          progress math used 100k — aligned to the actual 100k pivot approach
          zone (>=80%) so the banner matches the allocation switchover. */}
      {(jackpot?.main_balance || 0) >= 80000 && (
        <div
          style={{
            margin: '0 1rem 0.75rem',
            padding: '12px 16px',
            background:
              'linear-gradient(135deg, rgba(255,215,0,0.08) 0%, rgba(255,165,0,0.06) 100%)',
            border: '1px solid rgba(255,215,0,0.25)',
            borderRadius: '12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <span
              style={{
                fontSize: '0.75rem',
                color: '#FFD700',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              🎯 100K Pivot Alert
            </span>
            <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>
              Pool at {(((jackpot?.main_balance || 0) / 100000) * 100).toFixed(1)}% of pivot
              threshold
            </div>
          </div>
          <div
            style={{
              width: '80px',
              height: '6px',
              background: 'rgba(255,255,255,0.06)',
              borderRadius: '3px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, ((jackpot?.main_balance || 0) / 100000) * 100)}%`,
                background: 'linear-gradient(90deg, #FFD700, #FF6B00)',
                borderRadius: '3px',
                transition: 'width 1s ease',
              }}
            />
          </div>
        </div>
      )}

      {/* Triple-Bank Breakdown */}
      <div className="jackpot-info" style={{ marginBottom: '0.5rem' }}>
        <div
          className="info-card"
          style={{
            border: '1px solid rgba(0, 122, 255, 0.3)',
            background: 'rgba(0, 122, 255, 0.08)',
          }}
        >
          <span className="info-label">🏦 Backup Pool</span>
          <span className="info-value" style={{ color: '#007aff' }}>
            {(jackpot?.backup_balance || 0).toLocaleString()} chips
          </span>
        </div>
        <div
          className="info-card"
          style={{
            border: '1px solid rgba(175, 82, 222, 0.3)',
            background: 'rgba(175, 82, 222, 0.08)',
          }}
        >
          <span className="info-label">🎁 Promo Pool</span>
          <span className="info-value" style={{ color: '#af52de' }}>
            {(jackpot?.promo_balance || 0).toLocaleString()} chips
          </span>
        </div>
      </div>

      {/* Admin-only jackpot health panel (server-gated; renders nothing for
          non-admins). 2026-08-18 */}
      <BBJAdminAnalytics poolId={jackpot?.id || null} />

      {/* Owner-only: distribute the promo pool to active players */}
      {canManagePromo && (jackpot?.promo_balance || 0) > 0 && (
        <div
          style={{
            margin: '4px 0 16px',
            padding: '14px 16px',
            borderRadius: '12px',
            border: '1px solid rgba(175,82,222,0.3)',
            background: 'rgba(175,82,222,0.06)',
          }}
        >
          <div
            style={{
              fontSize: '13px',
              fontWeight: 700,
              color: '#af52de',
              marginBottom: '8px',
            }}
          >
            Distribute Promo Pool
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
            Rain promo chips to everyone currently seated. Split evenly.
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={jackpot?.promo_balance || 0}
              value={promoAmount}
              onChange={(e) => setPromoAmount(e.target.value)}
              placeholder="Amount"
              aria-label="Promo rain amount"
              style={{
                flex: '1 1 120px',
                minWidth: 0,
                padding: '10px 12px',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.04)',
                color: '#fff',
                fontSize: '14px',
              }}
            />
            <button
              onClick={() => setPromoAmount(String(jackpot?.promo_balance || 0))}
              style={{
                padding: '10px 12px',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.04)',
                color: 'rgba(255,255,255,0.7)',
                fontSize: '13px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Max
            </button>
            <button
              onClick={runPromoRain}
              disabled={distributingPromo}
              style={{
                padding: '10px 18px',
                borderRadius: '10px',
                border: 'none',
                background: 'linear-gradient(135deg,#af52de,#8e44ad)',
                color: '#fff',
                fontSize: '13px',
                fontWeight: 800,
                cursor: distributingPromo ? 'wait' : 'pointer',
                opacity: distributingPromo ? 0.6 : 1,
              }}
            >
              {distributingPromo ? 'Raining…' : '🎁 Rain to Active Players'}
            </button>
          </div>
        </div>
      )}

      {/* Info Cards.
          2026-08-18: "Qualifying Hand: Quad 2s or better beaten" was wrong for
          every game we spread — the per-variant truth now lives in the rules
          panel below. "Hands Dealt" showed total_contributed, which is a CHIP
          AMOUNT, not a hand count; both facts now come from the ledger. */}
      <div className="jackpot-info">
        <div className="info-card">
          <span className="info-label">Hands Contributed</span>
          <span className="info-value">{(poolFacts?.hands || 0).toLocaleString()}</span>
        </div>
        <div className="info-card">
          <span className="info-label">Total Collected</span>
          <span className="info-value">{(poolFacts?.chips || 0).toLocaleString()} chips</span>
        </div>
        {playerContribution > 0 && (
          <div
            className="info-card"
            style={{
              border: '1px solid rgba(52, 199, 89, 0.3)',
              background: 'rgba(52, 199, 89, 0.08)',
            }}
          >
            <span className="info-label">Your Contribution (90d)</span>
            <span className="info-value" style={{ color: '#34c759' }}>
              {playerContribution.toLocaleString(undefined, { maximumFractionDigits: 2 })} chips
            </span>
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)', marginTop: '2px' }}>
              across {myHands.toLocaleString()} hands
            </span>
          </div>
        )}
      </div>

      {/* What qualifies / what it pays — per variant and per stakes tier */}
      <BBJRulesPanel poolAmount={jackpot?.main_balance || 0} />

      {/* Payout Structure */}
      <div className="payout-structure">
        <h3>Payout Structure</h3>
        <p
          style={{
            margin: '0 0 10px',
            fontSize: '12px',
            color: 'rgba(255,255,255,0.6)',
            lineHeight: 1.5,
          }}
        >
          Applied to the stakes-tiered share of the pool shown above &mdash; not the whole pool.
        </p>
        <div className="payout-bars">
          <div className="payout-bar">
            <span className="payout-label">Loser (Bad Beat)</span>
            <div className="bar-fill" style={{ width: '50%' }} />
            <span className="payout-percent">50%</span>
          </div>
          <div className="payout-bar">
            <span className="payout-label">Winner</span>
            <div className="bar-fill" style={{ width: '25%' }} />
            <span className="payout-percent">25%</span>
          </div>
          <div className="payout-bar">
            <span className="payout-label">Table Share</span>
            <div className="bar-fill" style={{ width: '25%' }} />
            <span className="payout-percent">25%</span>
          </div>
        </div>
      </div>

      {/* History */}
      <div className="jackpot-history">
        <h3>Recent Hits</h3>
        {history.length === 0 ? (
          <div className="empty-state">
            <p>No jackpot hits yet. Will you be the first?</p>
          </div>
        ) : (
          <div className="history-list">
            {history.map((hit, index) => (
              <div
                key={hit.id}
                className="history-row"
                style={{
                  opacity: visibleHistoryRows.has(index) ? 1 : 0,
                  transform: visibleHistoryRows.has(index) ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <div className="hit-info">
                  <span className="hit-date">{formatDate(hit.awarded_at)}</span>
                  {/* 2026-08-18: names were selected but never shown — a hit
                      list without people reads like test data. */}
                  {(hit.loser_display_name || hit.winner_display_name) && (
                    <span className="hit-players">
                      {hit.loser_display_name || 'Player'}
                      {hit.winner_display_name ? ` vs ${hit.winner_display_name}` : ''}
                    </span>
                  )}
                  <span className="hit-hands">
                    {hit.loser_hand} beat by {hit.winner_hand}
                  </span>
                </div>
                <div className="hit-amount">{hit.total_payout.toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom Navigation */}
      {clubId && <ClubBottomNav clubId={clubId} />}
    </div>
  );
}
