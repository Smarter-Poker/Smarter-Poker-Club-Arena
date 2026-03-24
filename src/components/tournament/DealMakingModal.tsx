import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

interface DealMakingModalProps {
  tournamentId: string;
  prizePool: number;
  payoutStructure: Array<{ place: number; percentage: number }>;
  players: Array<{ userId: string; username: string; chips: number }>;
  onClose: () => void;
  onDealAccepted: () => void;
}

interface DealProposal {
  type: 'icm' | 'chip_chop' | 'equal' | 'custom';
  amounts: Record<string, number>;
  description: string;
}

interface PlayerAllocation {
  userId: string;
  username: string;
  chips: number;
  icmAmount: number;
  chipChopAmount: number;
  equalAmount: number;
}

// ICM Calculator using Malmuth-Harville approximation for 5+ players
const calculateICM = (
  chipCounts: number[],
  prizePool: number,
  payouts: number[]
): number[] => {
  const numPlayers = chipCounts.length;

  // For small player counts, use exact ICM
  if (numPlayers <= 4) {
    return calculateExactICM(chipCounts, payouts);
  }

  // For 5+ players, use Malmuth-Harville approximation
  return calculateMalmuthHarville(chipCounts, payouts);
};

const calculateExactICM = (chipCounts: number[], payouts: number[]): number[] => {
  const numPlayers = chipCounts.length;
  const equity = new Array(numPlayers).fill(0);

  if (numPlayers === 1) {
    return [payouts[0]];
  }

  const totalChips = chipCounts.reduce((a, b) => a + b, 0);

  // Recursive ICM calculation
  const calculateEquity = (
    chips: number[],
    payoutList: number[],
    playerIdx: number
  ): number => {
    const remaining = chips.length;

    if (remaining === 1) {
      return payoutList.reduce((a, b) => a + b, 0);
    }

    if (remaining === 0) {
      return 0;
    }

    const total = chips.reduce((a, b) => a + b, 0);
    const probability = chips[playerIdx] / total;

    const finishValue = payoutList[payoutList.length - 1];

    const newChips = chips.filter((_, i) => i !== playerIdx);
    const newPayouts = payoutList.slice(0, payoutList.length - 1);

    const continuationValue = calculateEquity(newChips, newPayouts, playerIdx < chips.length - 1 ? playerIdx : playerIdx - 1);

    return probability * finishValue + (1 - probability) * continuationValue;
  };

  // Simplified iterative approach for exact ICM
  for (let i = 0; i < numPlayers; i++) {
    const chipsArray = chipCounts.slice();
    const payoutArray = payouts.slice();

    let currentEquity = 0;
    const tempChips = chipsArray.slice();
    const tempPayouts = payoutArray.slice();

    for (let place = 0; place < numPlayers; place++) {
      const total = tempChips.reduce((a, b) => a + b, 0);
      const probability = tempChips[i] / total;
      const payout = tempPayouts[place];

      currentEquity += probability * payout;

      // Remove this player for next iteration
      if (place < numPlayers - 1) {
        tempChips.splice(i, 1);
        tempPayouts.splice(place, 1);

        // Adjust index if player was removed
        if (i >= tempChips.length && tempChips.length > 0) {
          // Continue with recursion is handled differently
          break;
        }
      }
    }

    equity[i] = currentEquity;
  }

  return equity;
};

const calculateMalmuthHarville = (chipCounts: number[], payouts: number[]): number[] => {
  const numPlayers = chipCounts.length;
  const equity = new Array(numPlayers).fill(0);
  const totalChips = chipCounts.reduce((a, b) => a + b, 0);

  for (let i = 0; i < numPlayers; i++) {
    let playerEquity = 0;

    for (let place = 0; place < numPlayers; place++) {
      let probability = chipCounts[i] / totalChips;

      // Adjust probability for eliminations before this place
      let remainingChips = totalChips;
      let tempChips = chipCounts.slice();

      for (let eliminatedPlace = 0; eliminatedPlace < place; eliminatedPlace++) {
        let maxChips = -1;
        let maxIdx = -1;

        for (let j = 0; j < tempChips.length; j++) {
          if (tempChips[j] > maxChips) {
            maxChips = tempChips[j];
            maxIdx = j;
          }
        }

        if (maxIdx === i) {
          probability = 0;
          break;
        }

        remainingChips -= maxChips;
        tempChips.splice(maxIdx, 1);
        if (maxIdx < i) {
          i -= 1;
        }
      }

      if (probability > 0 && payouts[place] !== undefined) {
        playerEquity += probability * payouts[place];
      }
    }

    equity[i] = playerEquity;
  }

  return equity;
};

const DealMakingModal: React.FC<DealMakingModalProps> = ({
  tournamentId,
  prizePool,
  payoutStructure,
  players,
  onClose,
  onDealAccepted,
}) => {
  const [selectedDealType, setSelectedDealType] = useState<'icm' | 'chip_chop' | 'equal' | 'custom'>('icm');
  const [customAmounts, setCustomAmounts] = useState<Record<string, number>>({});
  const [proposingDeal, setProposingDeal] = useState(false);
  const [dealProposalId, setDealProposalId] = useState<string | null>(null);
  const [playerAcceptances, setPlayerAcceptances] = useState<Record<string, boolean>>({});
  const [dealStatus, setDealStatus] = useState<'idle' | 'proposed' | 'accepted' | 'declined'>('idle');

  // Calculate payouts from structure
  const payouts = payoutStructure.map(p => Math.trunc((prizePool * p.percentage) * 100) / 100);

  // Calculate chip counts and ICM
  const chipCounts = players.map(p => p.chips);
  const icmAmounts = calculateICM(chipCounts, prizePool, payouts);

  // Build allocations
  const allocations: PlayerAllocation[] = players.map((player, idx) => {
    const totalChips = chipCounts.reduce((a, b) => a + b, 0);
    const chipChopAmount = Math.trunc((prizePool * (player.chips / totalChips)) * 100) / 100;
    const equalAmount = Math.trunc((prizePool / players.length) * 100) / 100;

    return {
      userId: player.userId,
      username: player.username,
      chips: player.chips,
      icmAmount: Math.trunc(icmAmounts[idx] * 100) / 100,
      chipChopAmount,
      equalAmount,
    };
  });

  // Initialize custom amounts
  useEffect(() => {
    if (selectedDealType === 'custom' && Object.keys(customAmounts).length === 0) {
      const initial: Record<string, number> = {};
      allocations.forEach(a => {
        initial[a.userId] = a.icmAmount;
      });
      setCustomAmounts(initial);
    }
  }, [selectedDealType]);

  const getDealAmounts = (): Record<string, number> => {
    const amounts: Record<string, number> = {};

    allocations.forEach(allocation => {
      if (selectedDealType === 'icm') {
        amounts[allocation.userId] = allocation.icmAmount;
      } else if (selectedDealType === 'chip_chop') {
        amounts[allocation.userId] = allocation.chipChopAmount;
      } else if (selectedDealType === 'equal') {
        amounts[allocation.userId] = allocation.equalAmount;
      } else if (selectedDealType === 'custom') {
        amounts[allocation.userId] = customAmounts[allocation.userId] || 0;
      }
    });

    return amounts;
  };

  const handleProposeDeal = async () => {
    setProposingDeal(true);

    try {
      const amounts = getDealAmounts();

      const { data, error } = await supabase
        .from('tournament_deals')
        .insert({
          tournament_id: tournamentId,
          deal_type: selectedDealType,
          proposed_amounts: amounts,
          status: 'pending',
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;

      setDealProposalId(data.id);
      setDealStatus('proposed');

      // Initialize acceptances
      const initialAcceptances: Record<string, boolean> = {};
      players.forEach(p => {
        initialAcceptances[p.userId] = false;
      });
      setPlayerAcceptances(initialAcceptances);
    } catch (err) {
      console.error('Failed to propose deal:', err);
      alert('Failed to propose deal');
    } finally {
      setProposingDeal(false);
    }
  };

  const handleAcceptDeal = async (userId: string) => {
    if (!dealProposalId) return;

    try {
      const { error } = await supabase
        .from('tournament_player_deal_votes')
        .insert({
          deal_id: dealProposalId,
          player_id: userId,
          accepted: true,
          voted_at: new Date().toISOString(),
        });

      if (error) throw error;

      const newAcceptances = { ...playerAcceptances, [userId]: true };
      setPlayerAcceptances(newAcceptances);

      // Check if all players accepted
      const allAccepted = players.every(p => newAcceptances[p.userId]);

      if (allAccepted) {
        // Update tournament status and end tournament
        const amounts = getDealAmounts();

        const { error: updateError } = await supabase
          .from('tournaments')
          .update({
            status: 'completed',
            deal_id: dealProposalId,
            final_payouts: amounts,
          })
          .eq('id', tournamentId);

        if (updateError) throw updateError;

        // Update player final buyins/payouts
        for (const player of players) {
          await supabase
            .from('tournament_players')
            .update({
              final_payout: amounts[player.userId],
              deal_accepted: true,
            })
            .eq('user_id', player.userId)
            .eq('tournament_id', tournamentId);
        }

        setDealStatus('accepted');
        setTimeout(() => {
          onDealAccepted();
        }, 1500);
      }
    } catch (err) {
      console.error('Failed to accept deal:', err);
      alert('Failed to accept deal');
    }
  };

  const handleDeclineDeal = async (userId: string) => {
    if (!dealProposalId) return;

    try {
      await supabase
        .from('tournament_player_deal_votes')
        .insert({
          deal_id: dealProposalId,
          player_id: userId,
          accepted: false,
          voted_at: new Date().toISOString(),
        });

      setDealStatus('declined');
      setTimeout(() => {
        setDealProposalId(null);
        setPlayerAcceptances({});
        setDealStatus('idle');
      }, 2000);
    } catch (err) {
      console.error('Failed to decline deal:', err);
    }
  };

  const currentAmounts = getDealAmounts();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg shadow-2xl max-w-4xl w-full max-h-96 overflow-y-auto border border-green-700">
        {/* Header */}
        <div className="bg-gradient-to-r from-green-900 to-green-800 px-6 py-4 border-b border-green-700">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-bold text-white">Tournament Deal</h2>
            <button
              onClick={onClose}
              className="text-gray-300 hover:text-white transition"
            >
              ✕
            </button>
          </div>
          <p className="text-green-100 text-sm mt-1">
            Prize pool remaining: {Math.trunc(prizePool * 100) / 100} chips
          </p>
        </div>

        <div className="p-6">
          {/* Player Status */}
          <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
            {allocations.map(player => (
              <div
                key={player.userId}
                className="bg-gray-800 rounded p-3 border border-gray-700"
              >
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-white font-semibold">{player.username}</p>
                    <p className="text-green-400 text-sm">
                      {Math.trunc(player.chips * 100) / 100} chips
                    </p>
                  </div>
                  {dealProposalId && (
                    <div className="text-right">
                      {playerAcceptances[player.userId] !== undefined && (
                        <span
                          className={`text-sm font-semibold ${
                            playerAcceptances[player.userId]
                              ? 'text-green-400'
                              : 'text-red-400'
                          }`}
                        >
                          {playerAcceptances[player.userId] ? '✓ Accepted' : '✗ Declined'}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Deal Selection (only if not proposed) */}
          {dealStatus === 'idle' && !dealProposalId && (
            <>
              <div className="mb-6">
                <h3 className="text-white font-semibold mb-3">Deal Type</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {(['icm', 'chip_chop', 'equal', 'custom'] as const).map(type => (
                    <button
                      key={type}
                      onClick={() => setSelectedDealType(type)}
                      className={`py-2 px-3 rounded text-sm font-semibold transition ${
                        selectedDealType === type
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                      }`}
                    >
                      {type === 'icm' && 'ICM Chop'}
                      {type === 'chip_chop' && 'Chip Chop'}
                      {type === 'equal' && 'Equal Split'}
                      {type === 'custom' && 'Custom'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Deal Breakdown */}
              <div className="mb-6 bg-gray-800 rounded-lg p-4 border border-gray-700">
                <h3 className="text-white font-semibold mb-4">Proposed Payouts</h3>
                <div className="space-y-2">
                  {allocations.map(player => (
                    <div key={player.userId} className="flex justify-between items-center">
                      <span className="text-gray-300">{player.username}</span>
                      <div className="flex gap-4">
                        {selectedDealType === 'custom' ? (
                          <input
                            type="number"
                            value={customAmounts[player.userId] || ''}
                            onChange={e => {
                              const value = parseFloat(e.target.value) || 0;
                              setCustomAmounts({
                                ...customAmounts,
                                [player.userId]: Math.trunc(value * 100) / 100,
                              });
                            }}
                            className="bg-gray-700 text-white px-2 py-1 rounded w-24 text-right text-sm"
                            placeholder="0.00"
                          />
                        ) : (
                          <span className="text-green-400 font-semibold">
                            {Math.trunc(currentAmounts[player.userId] * 100) / 100}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 pt-4 border-t border-gray-700 flex justify-between">
                  <span className="text-white font-semibold">Total</span>
                  <span className="text-green-400 font-bold">
                    {Math.trunc(
                      Object.values(currentAmounts).reduce((a, b) => a + b, 0) * 100
                    ) / 100}
                  </span>
                </div>
              </div>

              {/* Comparison Table */}
              <div className="mb-6 overflow-x-auto">
                <h3 className="text-white font-semibold mb-3">All Options</h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-800 border-b border-gray-700">
                      <th className="text-left px-3 py-2 text-gray-300">Player</th>
                      <th className="text-right px-3 py-2 text-gray-300">ICM</th>
                      <th className="text-right px-3 py-2 text-gray-300">Chip Chop</th>
                      <th className="text-right px-3 py-2 text-gray-300">Equal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocations.map(player => (
                      <tr key={player.userId} className="border-b border-gray-700 hover:bg-gray-800">
                        <td className="px-3 py-2 text-gray-300">{player.username}</td>
                        <td className="text-right px-3 py-2 text-green-400">
                          {Math.trunc(player.icmAmount * 100) / 100}
                        </td>
                        <td className="text-right px-3 py-2 text-green-400">
                          {Math.trunc(player.chipChopAmount * 100) / 100}
                        </td>
                        <td className="text-right px-3 py-2 text-green-400">
                          {Math.trunc(player.equalAmount * 100) / 100}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Propose Button */}
              <div className="flex gap-3">
                <button
                  onClick={handleProposeDeal}
                  disabled={proposingDeal}
                  className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white font-bold py-2 px-4 rounded transition"
                >
                  {proposingDeal ? 'Proposing...' : 'Propose Deal'}
                </button>
                <button
                  onClick={onClose}
                  className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded transition"
                >
                  Cancel
                </button>
              </div>
            </>
          )}

          {/* Deal Voting */}
          {dealProposalId && dealStatus === 'proposed' && (
            <div>
              <div className="mb-6 bg-blue-900 border border-blue-700 rounded p-4">
                <p className="text-blue-100">
                  Deal proposed. Waiting for all players to accept...
                </p>
              </div>

              <div className="space-y-3">
                {players.map(player => (
                  <div
                    key={player.userId}
                    className="bg-gray-800 rounded p-4 border border-gray-700 flex justify-between items-center"
                  >
                    <div>
                      <p className="text-white font-semibold">{player.username}</p>
                      <p className="text-green-400 text-sm">
                        {Math.trunc(currentAmounts[player.userId] * 100) / 100} chips
                      </p>
                    </div>
                    {playerAcceptances[player.userId] !== undefined ? (
                      <span
                        className={`font-semibold ${
                          playerAcceptances[player.userId]
                            ? 'text-green-400'
                            : 'text-red-400'
                        }`}
                      >
                        {playerAcceptances[player.userId] ? '✓' : '✗'}
                      </span>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleAcceptDeal(player.userId)}
                          className="bg-green-600 hover:bg-green-700 text-white font-bold py-1 px-4 rounded text-sm transition"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => handleDeclineDeal(player.userId)}
                          className="bg-red-600 hover:bg-red-700 text-white font-bold py-1 px-4 rounded text-sm transition"
                        >
                          Decline
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Success State */}
          {dealStatus === 'accepted' && (
            <div className="text-center py-8">
              <p className="text-green-400 font-bold text-lg mb-2">✓ Deal Accepted!</p>
              <p className="text-gray-300">Tournament ending with agreed payouts...</p>
            </div>
          )}

          {/* Declined State */}
          {dealStatus === 'declined' && (
            <div className="text-center py-8">
              <p className="text-red-400 font-bold text-lg mb-2">✗ Deal Declined</p>
              <p className="text-gray-300">Play continues to the end...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DealMakingModal;
