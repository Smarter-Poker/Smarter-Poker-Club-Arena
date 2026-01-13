import React, { useEffect, useState } from 'react';
import { WalletService } from '../../services/WalletService';
import { CommissionService } from '../../services/CommissionService';
import { supabase } from '../../lib/supabase';

interface FinancialDashboardProps {
    clubId: string;
}

export const ClubFinancialDashboard: React.FC<FinancialDashboardProps> = ({ clubId }) => {
    const [diamondBalance, setDiamondBalance] = useState(0);
    const [mintAmount, setMintAmount] = useState(1000);
    const [loading, setLoading] = useState(false);

    // Commission State
    const [agentId, setAgentId] = useState('');
    const [commissionRate, setCommissionRate] = useState(0.5); // 50% default

    useEffect(() => {
        fetchDiamondBalance();
    }, [clubId]);

    const fetchDiamondBalance = async () => {
        // In a real app, this would be a reactive subscription
        const { data, error } = await supabase
            .from('club_diamond_wallets')
            .select('balance')
            .eq('club_id', clubId)
            .single();

        if (data) setDiamondBalance(data.balance);
    };

    const handleMint = async () => {
        setLoading(true);
        try {
            await WalletService.mintChips(clubId, mintAmount);
            alert(`Successfully minted ${mintAmount} chips!`);
            fetchDiamondBalance(); // Refresh
        } catch (error) {
            alert('Minting failed: ' + (error as Error).message);
        } finally {
            setLoading(false);
        }
    };

    const handleSetCommission = async () => {
        try {
            // TODO: Get actual current user ID from auth context
            await CommissionService.setRate(clubId, agentId, 'AGENT', commissionRate, 'current_user');
            alert('Commission Limit set successfully');
        } catch (error) {
            alert('Error: ' + (error as Error).message);
        }
    };

    // Cost Calculation based on 38 Diamonds / 100 Chips
    const diamondCost = Math.ceil((mintAmount / 100) * 38);

    return (
        <div className="p-6 bg-gray-900 text-white rounded-lg shadow-xl">
            <h1 className="text-2xl font-bold mb-6 text-yellow-400">🏦 Club Financial Command</h1>

            {/* DIAMOND WALLET SECTION */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <div className="bg-gray-800 p-6 rounded-lg border border-yellow-500/30">
                    <h2 className="text-gray-400 text-sm uppercase tracking-wide mb-2">💎 Diamond Vault</h2>
                    <div className="text-4xl font-mono text-blue-400">{diamondBalance.toLocaleString()} <span className="text-lg">D</span></div>
                    <div className="mt-2 text-xs text-gray-500">Peg: 1 Diamond = $0.01</div>
                </div>

                {/* MINTING CONSOLE */}
                <div className="bg-gray-800 p-6 rounded-lg border border-green-500/30">
                    <h2 className="text-gray-400 text-sm uppercase tracking-wide mb-4">🏭 Chip Minting Console</h2>

                    <div className="flex flex-col space-y-4">
                        <div>
                            <label className="block text-sm text-gray-400 mb-1">Chips to Mint</label>
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
                            className={`w-full py-2 rounded font-bold ${diamondBalance >= diamondCost
                                ? 'bg-green-600 hover:bg-green-500 text-white'
                                : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                                }`}
                        >
                            {loading ? 'Minting...' : '🔥 BURN DIAMONDS & MINT'}
                        </button>

                        <div className="text-xs text-green-400 text-center">
                            ⚡ 75% Cheaper than Industry Standard
                        </div>
                    </div>
                </div>
            </div>

            {/* COMMISSION SETTINGS */}
            <div className="bg-gray-800 p-6 rounded-lg border border-purple-500/30">
                <h2 className="text-gray-400 text-sm uppercase tracking-wide mb-4">📊 Commission Hierarchy</h2>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
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
                        <label className="block text-sm text-gray-400 mb-1">Commission Rate</label>
                        <div className="flex items-center space-x-2">
                            <input
                                type="range"
                                min="0" max="0.70" step="0.01"
                                value={commissionRate}
                                onChange={(e) => setCommissionRate(Number(e.target.value))}
                                className="w-full"
                            />
                            <span className="font-mono text-purple-400 w-16">{(commissionRate * 100).toFixed(0)}%</span>
                        </div>
                        <div className="text-xs text-red-500 mt-1">Max Cap: 70%</div>
                    </div>

                    <button
                        onClick={handleSetCommission}
                        className="w-full bg-purple-600 hover:bg-purple-500 text-white py-2 rounded font-bold"
                    >
                        SET RATE
                    </button>
                </div>
            </div>
        </div>
    );
};
