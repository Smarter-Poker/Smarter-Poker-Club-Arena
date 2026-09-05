/**
 *  BAD BEAT JACKPOT PAGE — Live Jackpot Updates
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import './BadBeatJackpotPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubUUID } from '../utils/clubIdResolver';
import PageSkeleton from '../components/common/PageSkeleton';
import { reportError } from '../utils/errorReporter';
import BBJService from '../services/BBJService';
import { confirmDialog } from '../components/common/confirmDialog';
import BBJAdminAnalytics from '../components/bbj/BBJAdminAnalytics';
import { BBJRecentHits } from '../components/bbj/BBJRecentHits';
import { BBJHandDetail } from '../components/bbj/BBJHandDetail';
import BBJRulesPanel from '../components/bbj/BBJRulesPanel';
import { ArenaJackpotDisplay } from '../components/club-buttons';
import { playerDisplayName } from '../utils/playerDisplayName';

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

export default function BadBeatJackpotPage() {
  useVisibilityRefresh(() => loadJackpotData());
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();

  const [jackpot, setJackpot] = useState<JackpotInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [openHandPayoutId, setOpenHandPayoutId] = useState<string | null>(null);
  const [justUpdated, setJustUpdated] = useState(false);
  /** True when the last read threw. Distinct from "this club has no pool". */
  const [loadFailed, setLoadFailed] = useState(false);
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
        title: 'Distribute Promo Pool',
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

  /**
   * THE REALTIME HANDLER MUST CALL THE CURRENT LOADER, NOT THE ONE IT CLOSED OVER.
   *
   * `loadJackpotData` is a useCallback over [clubId, user?.id, toast], and the
   * effect below is keyed on [clubId] alone - deliberately, because adding the
   * callback would tear down and re-subscribe the realtime channel every time
   * auth resolved. The cost of that shortcut was a stale closure: on first
   * mount `user` is null, so the captured loader skips the
   * `fn_bbj_my_contribution` branch, and the "BAD BEAT JACKPOT HIT!" handler
   * kept invoking THAT version forever. A player who was paid never saw their
   * contribution figure appear, no matter how many hands or hits went by.
   *
   * A ref updated on every render is the fix that keeps both properties: one
   * subscription per club, always the newest loader.
   */
  const loadRef = useRef<(getIsMounted?: () => boolean) => void>(() => {});

  useEffect(() => {
    if (!clubId) {
      // Nothing will ever call the loader, so nothing will ever clear the
      // initial `loading: true` - the page sat on a skeleton for good.
      setLoading(false);
      return;
    }
    {
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
            () => {
              if (!isMounted) return;
              toast.success('Bad Beat Jackpot Hit');
              loadRef.current(() => isMounted);
            }
          )
          .subscribe((status: string, err?: Error) => {
            if (status === 'CHANNEL_ERROR') {
              if (err)
                reportError(err?.message || err, 'BadBeatJackpotPage._Realtime_channel_error');
            }
            if (status === 'TIMED_OUT') {
              console.warn('[BadBeatJackpotPage] Realtime channel timed out');
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

  /**
   * RESET PER-CLUB STATE WHEN NAVIGATING BETWEEN CLUBS.
   *
   * This cleared three things and left four behind: `jackpot`, `poolFacts`,
   * `myHands` and `loadFailed`. The load below only assigns `if (jackpotData)`,
   * so moving from a club WITH a pool to one WITHOUT left the previous club's
   * main/backup/promo balances and hand counts on screen, presented as this
   * club's - and the honest "No Jackpot Pool For This Club Yet" branch could
   * never be reached. Showing one club's money under another club's name is
   * the worst failure this page has.
   */
  useEffect(() => {
    setJustUpdated(false);
    setPlayerContribution(0);
    setJackpot(null);
    setPoolFacts(null);
    setMyHands(0);
    setLoadFailed(false);
    prevAmountRef.current = 0;
    loadingRef.current = false;
  }, [clubId]);

  const loadJackpotData = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (!clubId) {
        setLoading(false);
        return;
      }
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

        /**
         * The two reads below do not depend on each other and were awaited one
         * after the other, so the page paid two full round trips in series on
         * every load and every HAND_COMPLETED bus tick. They are the same two
         * calls, issued together.
         *
         * 2026-08-18: pool facts come from the LEDGER, because the pool
         * counters have drifted (161,442 counter vs 261,316 actual rows).
         *
         * "Your contribution" used to read bbj_contributions.player_id, which
         * is NULL on all 550,782 rows — the card always computed 0 and never
         * rendered, after pulling up to 10,000 rows to find that out. The BBJ
         * fee comes out of the POT, so a player's honest share is
         * fee x (their pot contribution / pot size), which is what the RPC
         * returns, for the calling user only.
         */
        const wantsMine = Boolean(user?.id && jackpotData?.id);
        const [factsRes, mineRes] = await Promise.all([
          jackpotData?.id
            ? supabase.rpc('fn_bbj_pool_facts', { p_pool_id: jackpotData.id })
            : Promise.resolve({ data: null }),
          wantsMine
            ? supabase.rpc('fn_bbj_my_contribution', { p_pool_id: jackpotData!.id, p_days: 90 })
            : Promise.resolve({ data: null }),
        ]);
        if (getIsMounted && !getIsMounted()) return;

        {
          const factRows = factsRes.data;
          const f = Array.isArray(factRows) ? factRows[0] : factRows;
          if (f) {
            setPoolFacts({
              hands: Number(f.hands_contributed) || 0,
              chips: Number(f.total_contributed) || 0,
            });
          }
        }

        if (wantsMine) {
          const mineRows = mineRes.data;
          const mine = Array.isArray(mineRows) ? mineRows[0] : mineRows;
          if (mine) {
            setPlayerContribution(Number(mine.attributed_chips) || 0);
            setMyHands(Number(mine.hands_contributed) || 0);
          }
        }
        if (!getIsMounted || getIsMounted()) setLoadFailed(false);
      } catch (error) {
        reportError(error, 'BadBeatJackpotPage.Failed_to_load_jackpot');
        if (!getIsMounted || getIsMounted()) {
          setLoadFailed(true);
          toast.error('Failed to load jackpot data.');
        }
      } finally {
        loadingRef.current = false;
        if (!getIsMounted || getIsMounted()) setLoading(false);
      }
    },
    // `user?.id` is READ in this body (the fn_bbj_my_contribution block), and
    // it was not a dependency. On first mount `user` is typically still null,
    // so that block was skipped - and because the callback was never recreated
    // when auth resolved, every later caller kept invoking the stale version.
    // "Your Contribution (90D)" therefore never appeared until the club id
    // itself changed. `toast` is captured for the same reason.
    [clubId, user?.id, toast]
  );

  // Keep the realtime handler pointed at the newest loader. See loadRef above.
  loadRef.current = loadJackpotData;

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

  if (loading) {
    return (
      <div className="bbj-page">
        <div className="loading-state">
          <PageSkeleton variant="stats" />
        </div>
      </div>
    );
  }

  /**
   * NO POOL, OR THE READ FAILED.
   *
   * This used to fall straight through to the full jackpot screen built
   * entirely out of zeros - "Main Jackpot 0", "0 Chips", a rules panel priced
   * off a zero pool, an empty winners list - with a transient toast as the only
   * signal that anything was wrong. A player cannot tell that from a club whose
   * jackpot genuinely sits at zero. Say which it is, and give them a way to try
   * again, because there was none anywhere on this page.
   */
  if (loadFailed || !jackpot) {
    return (
      <div className="bbj-page">
        <div className="bbj-page__empty">
          <h2 className="bbj-page__empty-title">
            {loadFailed ? 'Could Not Load The Jackpot' : 'No Jackpot Pool For This Club Yet'}
          </h2>
          <p className="bbj-page__empty-body">
            {loadFailed
              ? 'The Jackpot Could Not Be Read Just Now. Nothing Is Lost - Try Again.'
              : 'A Pool Starts Building As Soon As Hands Are Dealt With The Jackpot Drop Enabled.'}
          </p>
          {loadFailed && (
            <button type="button" className="bbj-page__retry" onClick={() => loadJackpotData()}>
              Try Again
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bbj-page">
      {/* Current Jackpot — Main Balance */}
      <div className="bbj-clubbuttons-hero-wrap">
        <ArenaJackpotDisplay
          className="bbj-clubbuttons-hero"
          badge="BBJ"
          eyebrow="Bad Beat Jackpot"
          value={(jackpot?.main_balance || 0).toLocaleString()}
          valueLabel={`Bad Beat Jackpot ${(jackpot?.main_balance || 0).toLocaleString()} Chips`}
          label="Main Jackpot"
          dataState={justUpdated ? 'updating' : 'loaded'}
        />
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
              'linear-gradient(135deg, rgba(213, 218, 226,0.08) 0%, rgba(186, 193, 203,0.06) 100%)',
            border: '1px solid rgba(213, 218, 226,0.25)',
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
                color: '#d5dae2',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              100K Pivot Alert
            </span>
            <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>
              Pool At {(((jackpot?.main_balance || 0) / 100000) * 100).toFixed(1)}% Of Pivot
              Threshold
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
                background: 'linear-gradient(90deg, #d5dae2, #8f97a3)',
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
          className="bad-beat-jackpot-page__info-card"
          style={{
            border: '1px solid rgba(0, 122, 255, 0.3)',
            background: 'rgba(0, 122, 255, 0.08)',
          }}
        >
          <span className="info-label">Backup Pool</span>
          <span className="info-value" style={{ color: '#007aff' }}>
            {(jackpot?.backup_balance || 0).toLocaleString()} Chips
          </span>
        </div>
        <div
          className="bad-beat-jackpot-page__info-card"
          style={{
            border: '1px solid rgba(175, 82, 222, 0.3)',
            background: 'rgba(175, 82, 222, 0.08)',
          }}
        >
          <span className="info-label">Promo Pool</span>
          <span className="info-value" style={{ color: '#af52de' }}>
            {(jackpot?.promo_balance || 0).toLocaleString()} Chips
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
            Rain Promo Chips To Everyone Currently Seated. Split Evenly.
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
              aria-label="Promo Rain Amount"
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
                minHeight: '44px',
                touchAction: 'manipulation',
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
                minHeight: '44px',
                touchAction: 'manipulation',
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
              {distributingPromo ? 'Raining…' : 'Rain To Active Players'}
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
        <div className="bad-beat-jackpot-page__info-card">
          <span className="info-label">Hands Contributed</span>
          <span className="info-value">{(poolFacts?.hands || 0).toLocaleString()}</span>
        </div>
        <div className="bad-beat-jackpot-page__info-card">
          <span className="info-label">Total Collected</span>
          <span className="info-value">{(poolFacts?.chips || 0).toLocaleString()} Chips</span>
        </div>
        {playerContribution > 0 && (
          <div
            className="bad-beat-jackpot-page__info-card"
            style={{
              border: '1px solid rgba(52, 199, 89, 0.3)',
              background: 'rgba(52, 199, 89, 0.08)',
            }}
          >
            <span className="info-label">Your Contribution (90D)</span>
            <span className="info-value" style={{ color: '#34c759' }}>
              {playerContribution.toLocaleString(undefined, { maximumFractionDigits: 2 })} Chips
            </span>
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)', marginTop: '2px' }}>
              Across {myHands.toLocaleString()} Hands
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
          Applied To The Stakes-Tiered Share Of The Pool Shown Above - Not The Whole Pool.
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
      <div className="jackpot-history" style={{ padding: '0 0.5rem' }}>
        {openHandPayoutId ? (
          <div style={{ marginTop: '1rem' }}>
            <BBJHandDetail
              payoutId={openHandPayoutId}
              onBack={() => setOpenHandPayoutId(null)}
              currentUserName={user ? playerDisplayName(user) : null}
              currentUserId={user?.id}
            />
          </div>
        ) : (
          <BBJRecentHits
            poolId={jackpot?.id || null}
            limit={10}
            poolAmount={jackpot?.main_balance || 0}
            currentUserId={user?.id}
            currentUserName={user ? playerDisplayName(user) : null}
            onOpenHand={setOpenHandPayoutId}
          />
        )}
      </div>

      {/* Bottom Navigation */}
    </div>
  );
}
