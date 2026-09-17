import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { CreditService } from '../../services/CreditService';
import { WalletService } from '../../services/WalletService';
import { useToast } from '../common/Toast';
import { FinancialChart } from '../charts/FinancialChart';
import { masterBus } from '../../core/MasterBus';
import { reportError } from '../../utils/errorReporter';
import { useVisibilityRefresh } from '../../hooks/useVisibilityRefresh';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useIsMounted } from '../../hooks/useIsMounted';

interface AgentPortalProps {
  agentId: string;
}

interface ChartData {
  name: string;
  rake: number;
  commissions: number;
}

export const AgentFinancialPortal: React.FC<AgentPortalProps> = ({ agentId }) => {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuthUser();
  const [walletOwnerId, setWalletOwnerId] = useState<string | null>(null);
  const renderScope = JSON.stringify([agentId, user?.id]);
  const agentScope = useRef(renderScope);
  agentScope.current = renderScope;
  const walletRequest = useRef(0);
  const commissionRequest = useRef(0);
  const [loadedWalletScope, setLoadedWalletScope] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const [wallet, setWallet] = useState({
    agentBal: 0,
    playerBal: 0,
    promoBal: 0,
    creditLimit: 0,
    debt: 0,
  });
  const [commissionData, setCommissionData] = useState<ChartData[]>([]);
  const [isTransferring, setIsTransferring] = useState(false);
  const transferInFlight = useRef(false);
  const [agentClubId, setAgentClubId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const walletReady = loadedWalletScope === renderScope && !!agentClubId;

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  useEffect(() => {
    setCommissionData([]);
    fetchWalletData();
    fetchCommissionHistory();
  }, [agentId, user?.id]);

  // Hook to handle visibility state changes (prevents zombie subscriptions)
  useVisibilityRefresh(() => {
    fetchWalletData();
    fetchCommissionHistory();
  });

  // Live-sync: refresh wallet data when balances change anywhere in the app
  useEffect(() => {
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        fetchWalletData();
      },
      500
    );
    return () => {
      unsubBalance();
    };
  }, [agentId, user?.id]);

  const fetchCommissionHistory = async () => {
    const scope = renderScope;
    if (!isMounted.current || scope !== agentScope.current) return;
    const request = ++commissionRequest.current;
    const isCurrent = () =>
      isMounted.current && scope === agentScope.current && request === commissionRequest.current;
    // Fetch last 7 days of commission data
    const days: string[] = [];
    for (let i = 6; i >= 0; i--) {
      days.push(
        new Date(Date.now() - i * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', {
          weekday: 'short',
        })
      );
    }
    try {
      // Canonical commission data lives in agent_commissions, keyed by the
      // agent's user_id (= auth.uid) with `amount` = commission earned. agentId
      // here is the agents.id PK, so resolve to user_id first. (There is no
      // commission_ledger table.)
      const { data: agentRow, error: agentError } = await supabase
        .from('agents')
        .select('user_id, club_id')
        .eq('id', agentId)
        .maybeSingle();
      if (!isCurrent()) return;
      if (agentError) throw agentError;
      if (!agentRow?.user_id || !agentRow.club_id) {
        setCommissionData(days.map((d) => ({ name: d, rake: 0, commissions: 0 })));
        return;
      }

      const { data, error } = await supabase
        .from('agent_commissions')
        .select('amount, created_at')
        .eq('user_id', agentRow.user_id)
        .eq('club_id', agentRow.club_id)
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: true })
        .limit(5000);

      if (!isCurrent()) return;
      if (error) throw error;

      if (data && data.length > 0) {
        // Group by day
        const grouped: Record<string, number> = {};
        data.forEach((d: any) => {
          const day = new Date(d.created_at).toLocaleDateString('en-US', { weekday: 'short' });
          grouped[day] = (grouped[day] || 0) + (Number(d.amount) || 0);
        });
        setCommissionData(days.map((d) => ({ name: d, rake: 0, commissions: grouped[d] || 0 })));
      } else {
        // No commission data yet — show zeros
        setCommissionData(
          days.map((d) => ({
            name: d,
            rake: 0,
            commissions: 0,
          }))
        );
      }
    } catch (err) {
      reportError(err, 'AgentFinancialPortal.Failed_to_load_commission_history');
    }
  };

  const fetchWalletData = async () => {
    const scope = renderScope;
    if (!isMounted.current || scope !== agentScope.current) return;
    const request = ++walletRequest.current;
    const isCurrent = () =>
      isMounted.current && scope === agentScope.current && request === walletRequest.current;
    setAgentClubId(null);
    setLoadedWalletScope(null);
    try {
      const { data, error } = await supabase
        .from('agents')
        .select('user_id, club_id, agent_wallet_balance, promo_wallet_balance, credit_limit')
        .eq('id', agentId)
        .maybeSingle();

      if (error || !data) {
        reportError(error, 'AgentFinancialPortal.Error_loading_agent_wallet');
        return;
      }

      const { data: member, error: memberError } = await supabase
        .from('club_members')
        .select('chip_balance')
        .eq('club_id', data.club_id)
        .eq('user_id', data.user_id)
        .maybeSingle();
      if (memberError || !member) throw memberError || new Error('Player Wallet Not Found');
      if (!isCurrent()) return;

      // Calculate Sunday Debt
      const calculatedDebt = await CreditService.calculateDebt(agentId);

      if (!isCurrent()) return;
      setLoadedWalletScope(scope);
      setAgentClubId(data.club_id);
      setWalletOwnerId(data.user_id);
      setWallet({
        agentBal: data.agent_wallet_balance || 0,
        playerBal: Number(member.chip_balance) || 0,
        promoBal: data.promo_wallet_balance || 0,
        creditLimit: data.credit_limit || 0,
        debt: calculatedDebt.debtOwed,
      });
    } catch (err) {
      reportError(err, 'AgentFinancialPortal.fetchWalletData_error');
    }
  };

  const handleTransferToPlayer = async () => {
    const scope = renderScope;
    const isCurrent = () => isMounted.current && scope === agentScope.current;
    if (transferInFlight.current || !walletReady || !isCurrent() || walletOwnerId !== user?.id)
      return;
    const amountStr = prompt('Amount To Transfer To Player Wallet?');
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return;

    transferInFlight.current = true;
    setIsTransferring(true);
    try {
      const success = await WalletService.agentSelfTransfer(agentClubId!, amount);
      if (!isCurrent()) return;
      if (success) {
        await fetchWalletData(); // Refresh wallet data
      } else {
        toast.error('Transfer failed. Please check your balance.');
      }
    } catch (err) {
      reportError(err, 'AgentFinancialPortal.Transfer_error');
      if (isCurrent()) toast.error('Transfer failed: ' + (err as Error).message);
    } finally {
      transferInFlight.current = false;
      if (isMounted.current) setIsTransferring(false);
    }
  };

  return (
    <div
      className="p-6 bg-slate-900 text-white rounded-lg shadow-xl  border border-blue-900"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <h1 className="text-2xl font-bold mb-6 text-blue-400">Agent Command Center</h1>

      {/* TRIPLE WALLET GRID */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {/* WALLET 1: BUSINESS (AGENT) */}
        <div className="bg-slate-800 p-4 rounded border-t-4 border-blue-500">
          <h2 className="text-xs uppercase text-blue-300 font-bold tracking-wider mb-2">
            Details / Business Wallet
          </h2>
          <div className="text-3xl font-mono text-white mb-1">
            {wallet.agentBal.toLocaleString()}
          </div>
          <div className="text-xs text-gray-500">Commissions & Settlements</div>
        </div>

        {/* WALLET 2: PLAY (PLAYER) */}
        <div className="bg-slate-800 p-4 rounded border-t-4 border-green-500">
          <h2 className="text-xs uppercase text-green-300 font-bold tracking-wider mb-2">
            Table / Play Wallet
          </h2>
          <div className="text-3xl font-mono text-white mb-1">
            {wallet.playerBal.toLocaleString()}
          </div>
          <div className="text-xs text-gray-500">For Playing At Tables</div>
          <button
            onClick={handleTransferToPlayer}
            disabled={isTransferring || !walletReady || walletOwnerId !== user?.id}
            className="mt-2 w-full py-1 text-xs bg-green-900 hover:bg-green-800 text-green-200 rounded"
          >
            LOAD FROM BIZ ➔
          </button>
        </div>

        {/* WALLET 3: PROMO */}
        <div className="bg-slate-800 p-4 rounded border-t-4 border-pink-500">
          <h2 className="text-xs uppercase text-pink-300 font-bold tracking-wider mb-2">
            Promo / Marketing
          </h2>
          <div className="text-3xl font-mono text-white mb-1">
            {wallet.promoBal.toLocaleString()}
          </div>
          <div className="text-xs text-gray-500">Non-Cashable Giveaways</div>
        </div>
      </div>

      {/* CREDIT LINE STATUS */}
      <div className="bg-slate-800 p-6 rounded border border-gray-700">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-lg">Credit Line Status</h3>
          <span className="text-sm font-mono text-gray-400">
            Limit: {wallet.creditLimit.toLocaleString()}
          </span>
        </div>

        {/* Debt Progress Bar */}
        <div className="w-full bg-gray-900 rounded-full h-4 mb-2 overflow-hidden">
          <div
            className="bg-red-500 h-4 transition-all duration-500"
            style={{
              width: `${wallet.creditLimit > 0 ? Math.max(0, Math.min(((wallet.creditLimit - wallet.agentBal) / wallet.creditLimit) * 100, 100)) : 0}%`,
            }}
          />
        </div>

        <div className="flex justify-between items-end">
          <div>
            <div className="text-xs text-gray-500 uppercase">Current Usage</div>
            <div className="text-xl font-mono text-red-400">
              {(wallet.creditLimit - wallet.agentBal).toLocaleString()}
            </div>
          </div>

          <div className="text-right">
            <div className="text-xs text-gray-500 uppercase">Available Credit</div>
            <div className="text-xl font-mono text-green-400">
              {wallet.agentBal.toLocaleString()}
            </div>
            {/* Note: Simplified view. Real available credit = Limit - (Limit - Balance) = Balance */}
          </div>
        </div>

        {wallet.debt > 0 && (
          <div className="mt-4 p-3 bg-red-900/30 border border-red-500/50 rounded flex justify-between items-center">
            <div>
              <span className="block text-red-500 font-bold"> SUNDAY INVOICE DUE</span>
              <span className="text-sm text-gray-300">
                You Must Settle {wallet.debt.toLocaleString()} Chips.
              </span>
            </div>
            <button
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-bold rounded"
              onClick={() => {
                // Navigate to settlement page — construct club URL from agent data
                navigate('/wallet');
              }}
            >
              SETTLE NOW
            </button>
          </div>
        )}
      </div>

      {/* COMMISSION TRENDS CHART */}
      <div className="bg-slate-800 p-6 rounded border border-gray-700 mt-6">
        <h3 className="font-bold text-lg mb-4"> Commission Trends (7 Days)</h3>
        {/* This chart has commission data and no rake data - it fed rake: 0 for
            every day, and the chart drew that as a flat "Rake" line at zero,
            which reads as a week with no rake. The agent's downline rake lives
            in fn_agent_downline_rake (the Downline Rake panel); until this
            chart is given it, it shows only what it actually has. */}
        <FinancialChart
          data={commissionData}
          height={200}
          showRake={false}
          showRakeback={false}
          showCommissions={true}
        />
      </div>
    </div>
  );
};
