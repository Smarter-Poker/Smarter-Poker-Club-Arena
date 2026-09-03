import React, { useEffect, useState, useRef } from 'react';
// Basename-aware navigation. This app mounts under
// basename="/hub/club-arena"; a plain <a href="/..."> ignores that and
// lands on smarter.poker/... which 404s. See the Financial Tools links below.
import { useNavigate } from 'react-router-dom';
import { useIsMounted } from '../../hooks/useIsMounted';
import { WalletService } from '../../services/WalletService';
import { CommissionService } from '../../services/CommissionService';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { useVisibilityRefresh } from '../../hooks/useVisibilityRefresh';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts';
import { reportError } from '../../utils/errorReporter';
import { clubGamesOrFilter } from '../../utils/unionScope';

interface FinancialDashboardProps {
  clubId: string;
}

// Helper to initialize blank 7-day data
const getEmptyRevenueData = () => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const data = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    data.push({
      day: days[d.getDay()],
      fullDate: d.toLocaleDateString(),
      revenue: 0,
      rake: 0,
    });
  }
  return data;
};

/**
 * WHAT THE CLUB'S RAKE ACTUALLY SPLIT INTO, over the same seven days as the
 * bar chart beside it.
 *
 * 2026-09-01 (phase 7 audit): this was a hardcoded constant - Club 50, Agents
 * 30, Players 20 - drawn as a pie and labelled "Commission Split" on a club
 * owner's financials page. It was not a default, an estimate or a target; it
 * was three numbers that had never been measured, rendered next to real ones.
 * ClubFinancialsPage carries a note about the same page fabricating "rakeback
 * as rake * 0.1 and agent commissions as rake * 0.05, labelled as if they were
 * real"; this is the last of that family.
 *
 * The three sources, all live:
 *   rake      rake_records (the ledger the bar chart already reads)
 *   agents    fn_club_commission_accrued - the definer aggregate over
 *             agent_commissions, staff-only, added in phase 7
 *   players   chip_transactions of type 'rakeback'
 * The club's own share is what is left, floored at zero.
 */
const EMPTY_SPLIT = [
  { name: 'Club', value: 0, color: '#1877f2' },
  { name: 'Agents', value: 0, color: '#f7931a' },
  { name: 'Players', value: 0, color: '#2ecc71' },
];

export const ClubFinancialDashboard: React.FC<FinancialDashboardProps> = ({ clubId }) => {
  const isMounted = useIsMounted();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const [diamondBalance, setDiamondBalance] = useState(0);
  const [mintAmount, setMintAmount] = useState(1000);
  const [loading, setLoading] = useState(false);
  const [revenueData, setRevenueData] = useState(getEmptyRevenueData());
  const [split, setSplit] = useState(EMPTY_SPLIT);
  const [activeTableCount, setActiveTableCount] = useState(0);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  // Commission State
  const [agentId, setAgentId] = useState('');
  const [commissionRate, setCommissionRate] = useState(0.5);
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  const kpiCards = [
    { label: 'Diamond Vault', value: diamondBalance.toLocaleString(), color: 'blue' },
    {
      label: 'Weekly Revenue',
      value: revenueData.reduce((sum, d) => sum + d.revenue, 0).toLocaleString(),
      color: 'green',
    },
    {
      label: 'Weekly Rake',
      value: revenueData.reduce((sum, d) => sum + d.rake, 0).toLocaleString(),
      color: 'orange',
    },
    { label: 'Active Tables', value: activeTableCount.toLocaleString(), color: 'purple' },
  ];

  useEffect(() => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = kpiCards.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  }, []);

  useEffect(() => {
    fetchDiamondBalance();
    fetchRevenueData();
    fetchActiveTableCount();

    // Refresh periodically
    const interval = setInterval(() => {
      fetchDiamondBalance();
      fetchRevenueData();
      fetchActiveTableCount();
    }, 30000);

    const channelKey = `club_wallet:${clubId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'club_diamond_wallets',
          filter: `club_id=eq.${clubId}`,
        },
        (payload) => {
          if (payload.new && 'balance' in payload.new) {
            setDiamondBalance((payload.new as { balance: number }).balance);
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err)
            reportError(err?.message || err, 'ClubFinancialDashboard._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[ClubFinancialDashboard] Realtime channel timed out');
        }
      });

    return () => {
      clearInterval(interval);
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

  // Hook to handle visibility state changes (prevents zombie subscriptions)
  useVisibilityRefresh(() => {
    fetchDiamondBalance();
    fetchRevenueData();
    fetchActiveTableCount();
  });

  const fetchDiamondBalance = async () => {
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { data, error } = await supabase
        .from('club_diamond_wallets')
        .select('balance')
        .eq('club_id', resolvedId)
        .maybeSingle();

      if (error) {
        reportError(error, 'ClubFinancialDashboard.Failed_to_load_diamond_balance');
        return;
      }
      if (data) setDiamondBalance(data.balance);
    } catch (err) {
      reportError(err, 'ClubFinancialDashboard.fetchDiamondBalance_error');
    }
  };

  const fetchRevenueData = async () => {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 6);
      startDate.setHours(0, 0, 0, 0);

      const resolvedId = await resolveClubUUID(clubId);
      // 2026-08-19: this read rake_history, whose last write was 2026-05-01 —
      // so this revenue widget has been drawing a flat zero line for three and
      // a half months. The comment it carried ("so this widget agrees with the
      // summary cards on ClubFinancialsPage") was accurate and was exactly the
      // problem: both agreed, and both were wrong. rake_records is the live
      // ledger, and ClubFinancialsPage now reads it too.
      const { data: records, error } = await supabase
        .from('rake_records')
        .select('rake_amount, created_at')
        .eq('club_id', resolvedId)
        .gte('created_at', startDate.toISOString())
        .limit(10000);

      if (error) throw error;

      const newData = getEmptyRevenueData();

      (records || []).forEach((record: any) => {
        const dateKey = new Date(record.created_at).toLocaleDateString();
        const daySlot = newData.find((d) => d.fullDate === dateKey);

        if (daySlot) {
          daySlot.rake += Number(record.rake_amount || 0);
          // In this context, club revenue is derived from rake
          daySlot.revenue += Number(record.rake_amount || 0);
        }
      });

      setRevenueData(newData);

      // The split, from the same window and the same ledgers.
      const totalRake = (records || []).reduce(
        (sum: number, r: any) => sum + Number(r.rake_amount || 0),
        0
      );

      const { data: agentShare, error: agentErr } = await supabase.rpc(
        'fn_club_commission_accrued',
        { p_club_id: resolvedId, p_since: startDate.toISOString() }
      );
      if (agentErr) reportError(agentErr, 'ClubFinancialDashboard.commission_accrued');

      const { data: rakebackRows, error: rakebackErr } = await supabase
        .from('chip_transactions')
        .select('amount')
        .eq('club_id', resolvedId)
        .eq('transaction_type', 'rakeback')
        .gte('created_at', startDate.toISOString())
        .limit(5000);
      if (rakebackErr) reportError(rakebackErr, 'ClubFinancialDashboard.rakeback_paid');

      const agents = Number(agentShare ?? 0) || 0;
      const players = (rakebackRows || []).reduce(
        (sum: number, r: any) => sum + Number(r.amount || 0),
        0
      );
      const club = Math.max(totalRake - agents - players, 0);

      // THE WHOLE IS THE RAKE, and that choice matters. Commission books to the
      // PLAYER's club (credit_agent_commission_from_rake resolves the player's
      // club, per union law) while rake_records books to the TABLE's club - so
      // for a club whose members play at a host club's tables, this window can
      // hold commission and no rake at all. Measured 2026-09-01: SHARK CLUB's
      // last rake_records row is 2026-08-20 while its agents accrued 309,991.51
      // in the following week, all of it at another club's tables.
      //
      // Dividing by (club + agents + players) there would draw "Agents 100%",
      // which is not a split of anything. Dividing by the rake this club
      // actually recorded shows zero, which is what this ledger knows - and it
      // agrees with the Daily Rake chart beside it, which is already flat for
      // the same reason.
      setSplit(
        totalRake <= 0
          ? EMPTY_SPLIT
          : [
              { name: 'Club', value: Math.round((club / totalRake) * 100), color: '#1877f2' },
              { name: 'Agents', value: Math.round((agents / totalRake) * 100), color: '#f7931a' },
              { name: 'Players', value: Math.round((players / totalRake) * 100), color: '#2ecc71' },
            ]
      );
    } catch (error) {
      reportError(error, 'ClubFinancialDashboard.Failed_to_load_revenue_data');
    }
  };

  const handleMint = async () => {
    setLoading(true);
    try {
      await WalletService.mintChips(clubId, mintAmount);
      if (isMounted.current) toast.success(`Successfully minted ${mintAmount} chips!`);
      fetchDiamondBalance();
    } catch (error) {
      if (isMounted.current) toast.error('Minting failed: ' + (error as Error).message);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const handleSetCommission = async () => {
    if (!user?.id) {
      toast.error('You must be logged in to set commission rates');
      return;
    }
    try {
      await CommissionService.setRate(clubId, agentId, 'AGENT', commissionRate, user.id);
      if (isMounted.current) toast.success('Commission Limit set successfully');
    } catch (error) {
      if (isMounted.current) toast.error('Error: ' + (error as Error).message);
    }
  };

  const fetchActiveTableCount = async () => {
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { count, error } = await supabase
        .from('tables')
        .select('id', { count: 'exact', head: true })
        // P2-1: union-aware — count the union's active tables too
        .or(await clubGamesOrFilter(resolvedId))
        .eq('status', 'active');
      if (!error && count !== null) setActiveTableCount(count);
    } catch (e) {
      reportError(e, 'ClubFinancialDashboard.fetchActiveTableCount');
      // Non-critical — keep existing count
    }
  };

  const diamondCost = Math.ceil((mintAmount / 100) * 38);
  const totalWeeklyRevenue = revenueData.reduce((sum, d) => sum + d.revenue, 0);
  const totalWeeklyRake = revenueData.reduce((sum, d) => sum + d.rake, 0);

  return (
    <div className="p-6 bg-gray-900 text-white rounded-lg shadow-xl space-y-6">
      <h1 className="text-2xl font-bold text-yellow-400">Club Financial Command</h1>

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div
          className="bg-gray-800 p-4 rounded-lg border border-blue-500/30"
          style={{
            opacity: visibleItems.has(0) ? 1 : 0,
            transform: visibleItems.has(0) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <div className="text-gray-400 text-xs uppercase">Diamond Vault</div>
          <div className="text-2xl font-mono text-blue-400">{diamondBalance.toLocaleString()}</div>
        </div>
        <div
          className="bg-gray-800 p-4 rounded-lg border border-green-500/30"
          style={{
            opacity: visibleItems.has(1) ? 1 : 0,
            transform: visibleItems.has(1) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <div className="text-gray-400 text-xs uppercase">Weekly Revenue</div>
          <div className="text-2xl font-mono text-green-400">
            {totalWeeklyRevenue.toLocaleString()}
          </div>
        </div>
        <div
          className="bg-gray-800 p-4 rounded-lg border border-orange-500/30"
          style={{
            opacity: visibleItems.has(2) ? 1 : 0,
            transform: visibleItems.has(2) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <div className="text-gray-400 text-xs uppercase">Weekly Rake</div>
          <div className="text-2xl font-mono text-orange-400">
            {totalWeeklyRake.toLocaleString()}
          </div>
        </div>
        <div
          className="bg-gray-800 p-4 rounded-lg border border-purple-500/30"
          style={{
            opacity: visibleItems.has(3) ? 1 : 0,
            transform: visibleItems.has(3) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <div className="text-gray-400 text-xs uppercase">Active Tables</div>
          <div className="text-2xl font-mono text-purple-400">
            {activeTableCount.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Revenue Chart */}
      <div className="bg-gray-800 p-6 rounded-lg border border-gray-700">
        <h2 className="text-gray-400 text-sm uppercase tracking-wide mb-4">Weekly Revenue Trend</h2>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={revenueData}>
            <defs>
              <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#1877f2" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#1877f2" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="day" stroke="#6b7280" />
            <YAxis stroke="#6b7280" />
            <Tooltip
              contentStyle={{
                background: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '8px',
              }}
              labelStyle={{ color: '#9ca3af' }}
            />
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="#1877f2"
              fillOpacity={1}
              fill="url(#colorRevenue)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Commission Distribution & Rake Chart */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Pie Chart */}
        <div className="bg-gray-800 p-6 rounded-lg border border-gray-700">
          <h2 className="text-gray-400 text-sm uppercase tracking-wide mb-4">Commission Split</h2>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={split}
                cx="50%"
                cy="50%"
                innerRadius={40}
                outerRadius={70}
                paddingAngle={5}
                dataKey="value"
              >
                {split.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex justify-center gap-4 mt-2">
            {split.map((item) => (
              <div key={item.name} className="flex items-center gap-1 text-xs">
                <span style={{ background: item.color }} className="w-3 h-3 rounded-full"></span>
                <span className="text-gray-400">
                  {item.name} {item.value}%
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Bar Chart */}
        <div className="bg-gray-800 p-6 rounded-lg border border-gray-700">
          <h2 className="text-gray-400 text-sm uppercase tracking-wide mb-4">Daily Rake</h2>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={revenueData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="day" stroke="#6b7280" />
              <YAxis stroke="#6b7280" />
              <Tooltip
                contentStyle={{
                  background: '#1f2937',
                  border: '1px solid #374151',
                  borderRadius: '8px',
                }}
              />
              <Bar dataKey="rake" fill="#f7931a" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Minting Console */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-gray-800 p-6 rounded-lg border border-green-500/30">
          <h2 className="text-gray-400 text-sm uppercase tracking-wide mb-4">
            Chip Minting Console
          </h2>
          <div className="flex flex-col space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Chips To Mint</label>
              <input
                type="number"
                value={mintAmount}
                onChange={(e) => setMintAmount(Number(e.target.value))}
                className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
              />
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-400">Cost (38 D / 100 Chips):</span>
              <span className="text-red-400 font-bold">-{diamondCost} Diamonds</span>
            </div>
            <button
              onClick={handleMint}
              disabled={loading || diamondBalance < diamondCost}
              className={`w-full py-2 rounded font-bold ${
                diamondBalance >= diamondCost
                  ? 'bg-green-600 hover:bg-green-500 text-white'
                  : 'bg-gray-600 text-gray-400 cursor-not-allowed'
              }`}
            >
              {loading ? 'Minting...' : 'MINT CHIPS'}
            </button>
          </div>
        </div>

        {/* Commission Settings */}
        <div className="bg-gray-800 p-6 rounded-lg border border-purple-500/30">
          <h2 className="text-gray-400 text-sm uppercase tracking-wide mb-4">
            ⚙ Commission Settings
          </h2>
          <div className="flex flex-col space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Agent ID</label>
              <input
                type="text"
                placeholder="UUID"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-white"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Rate: {(commissionRate * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min="0"
                max="0.70"
                step="0.01"
                value={commissionRate}
                onChange={(e) => setCommissionRate(Number(e.target.value))}
                className="w-full"
              />
            </div>
            <button
              onClick={handleSetCommission}
              className="w-full bg-purple-600 hover:bg-purple-500 text-white py-2 rounded font-bold"
            >
              SET RATE
            </button>
          </div>
        </div>

        {/* Financial Tools Quick Navigation */}
        <div
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '12px',
            padding: '16px',
            gridColumn: '1 / -1',
          }}
        >
          <h2
            style={{
              color: '#8899aa',
              fontSize: '0.75rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: '12px',
            }}
          >
            Financial Tools
          </h2>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => navigate('/financial-alerts')}
              style={{
                padding: '8px 14px',
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: '8px',
                color: '#ef4444',
                fontSize: '0.8rem',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Financial Alerts
            </button>
            <button
              type="button"
              onClick={() => clubId && navigate(`/clubs/${clubId}/disputes`)}
              style={{
                padding: '8px 14px',
                background: 'rgba(245,158,11,0.1)',
                border: '1px solid rgba(245,158,11,0.3)',
                borderRadius: '8px',
                color: '#f59e0b',
                fontSize: '0.8rem',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              ⚠ Disputes
            </button>
            <button
              type="button"
              onClick={() => navigate('/financial-health')}
              style={{
                padding: '8px 14px',
                background: 'rgba(16,185,129,0.1)',
                border: '1px solid rgba(16,185,129,0.3)',
                borderRadius: '8px',
                color: '#10b981',
                fontSize: '0.8rem',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              System Health
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
