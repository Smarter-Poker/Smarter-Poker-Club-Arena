import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { CreditService } from '../../services/CreditService';

interface AgentPortalProps {
    agentId: string;
}

export const AgentFinancialPortal: React.FC<AgentPortalProps> = ({ agentId }) => {
    const [wallet, setWallet] = useState({
        agentBal: 0,
        playerBal: 0,
        promoBal: 0,
        creditLimit: 0,
        debt: 0
    });

    useEffect(() => {
        fetchWalletData();
    }, [agentId]);

    const fetchWalletData = async () => {
        const { data, error } = await supabase
            .from('agents')
            .select('agent_wallet_balance, player_wallet_balance, promo_wallet_balance, credit_limit')
            .eq('id', agentId)
            .single();

        if (error) {
            console.error("Error loading agent wallet", error);
            return;
        }

        // Calculate Sunday Debt
        const calculatedDebt = await CreditService.calculateDebt(agentId);

        setWallet({
            agentBal: data.agent_wallet_balance,
            playerBal: data.player_wallet_balance,
            promoBal: data.promo_wallet_balance,
            creditLimit: data.credit_limit,
            debt: calculatedDebt.debtOwed
        });
    };

    const handleTransferToPlayer = async () => {
        // Call WalletService.agentSelfTransfer
        const amount = Number(prompt("Amount to transfer to Player Wallet?"));
        if (!amount) return;

        // Logic tied to WalletService (imported in real impl)
        // await WalletService.agentSelfTransfer(agentId, amount);
        alert("Transfer simulated: " + amount);
        fetchWalletData();
    };

    return (
        <div className="p-6 bg-slate-900 text-white rounded-lg shadow-xl  border border-blue-900">
            <h1 className="text-2xl font-bold mb-6 text-blue-400">👔 Agent Command Center</h1>

            {/* TRIPLE WALLET GRID */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">

                {/* WALLET 1: BUSINESS (AGENT) */}
                <div className="bg-slate-800 p-4 rounded border-t-4 border-blue-500">
                    <h2 className="text-xs uppercase text-blue-300 font-bold tracking-wider mb-2">Details / Business Wallet</h2>
                    <div className="text-3xl font-mono text-white mb-1">{wallet.agentBal.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">Commissions & Settlements</div>
                </div>

                {/* WALLET 2: PLAY (PLAYER) */}
                <div className="bg-slate-800 p-4 rounded border-t-4 border-green-500">
                    <h2 className="text-xs uppercase text-green-300 font-bold tracking-wider mb-2">Table / Play Wallet</h2>
                    <div className="text-3xl font-mono text-white mb-1">{wallet.playerBal.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">For playing at tables</div>
                    <button
                        onClick={handleTransferToPlayer}
                        className="mt-2 w-full py-1 text-xs bg-green-900 hover:bg-green-800 text-green-200 rounded"
                    >
                        LOAD FROM BIZ ➔
                    </button>
                </div>

                {/* WALLET 3: PROMO */}
                <div className="bg-slate-800 p-4 rounded border-t-4 border-pink-500">
                    <h2 className="text-xs uppercase text-pink-300 font-bold tracking-wider mb-2">Promo / Marketing</h2>
                    <div className="text-3xl font-mono text-white mb-1">{wallet.promoBal.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">Non-cashable giveaways</div>
                </div>
            </div>

            {/* CREDIT LINE STATUS */}
            <div className="bg-slate-800 p-6 rounded border border-gray-700">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-lg">💳 Credit Line Status</h3>
                    <span className="text-sm font-mono text-gray-400">Limit: {wallet.creditLimit.toLocaleString()}</span>
                </div>

                {/* Debt Progress Bar */}
                <div className="w-full bg-gray-900 rounded-full h-4 mb-2 overflow-hidden">
                    <div
                        className="bg-red-500 h-4 transition-all duration-500"
                        style={{ width: `${Math.min(((wallet.creditLimit - wallet.agentBal) / wallet.creditLimit) * 100, 100)}%` }}
                    />
                </div>

                <div className="flex justify-between items-end">
                    <div>
                        <div className="text-xs text-gray-500 uppercase">Current Usage</div>
                        <div className="text-xl font-mono text-red-400">{(wallet.creditLimit - wallet.agentBal).toLocaleString()}</div>
                    </div>

                    <div className="text-right">
                        <div className="text-xs text-gray-500 uppercase">Available Credit</div>
                        <div className="text-xl font-mono text-green-400">{(wallet.agentBal).toLocaleString()}</div>
                        {/* Note: Simplified view. Real available credit = Limit - (Limit - Balance) = Balance */}
                    </div>
                </div>

                {wallet.debt > 0 && (
                    <div className="mt-4 p-3 bg-red-900/30 border border-red-500/50 rounded flex justify-between items-center">
                        <div>
                            <span className="block text-red-500 font-bold">⚠️ SUNDAY INVOICE DUE</span>
                            <span className="text-sm text-gray-300">You must settle {wallet.debt.toLocaleString()} chips.</span>
                        </div>
                        <button className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-bold rounded">
                            SETTLE NOW
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
