import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { X, Play, Pause, Plus, SkipForward, SkipBack, Settings, Users, AlertTriangle, Clock } from 'lucide-react';

interface TournamentDirectorPanelProps {
  tournamentId: string;
  tournamentName: string;
  currentLevel: number;
  isRunning: boolean;
  onClose: () => void;
}

interface BlindLevel {
  id: number;
  small_blind: number;
  big_blind: number;
  ante: number;
  duration_minutes: number;
}

interface Player {
  id: string;
  name: string;
  chip_stack: number;
  status: string;
  table_number: number;
}

interface TournamentData {
  id: string;
  name: string;
  current_level: number;
  is_paused: boolean;
  small_blind: number;
  big_blind: number;
  ante: number;
  blind_structure: BlindLevel[];
}

const TournamentDirectorPanel: React.FC<TournamentDirectorPanelProps> = ({
  tournamentId,
  tournamentName,
  currentLevel,
  isRunning,
  onClose,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tournament, setTournament] = useState<TournamentData | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [activeTab, setActiveTab] = useState<'controls' | 'players'>('controls');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showRefund, setShowRefund] = useState(false);

  // Blind adjustment state
  const [adjustSmallBlind, setAdjustSmallBlind] = useState('');
  const [adjustBigBlind, setAdjustBigBlind] = useState('');
  const [adjustAnte, setAdjustAnte] = useState('');
  const [showAdjustForm, setShowAdjustForm] = useState(false);

  // Add time state
  const [addTimeMinutes, setAddTimeMinutes] = useState<1 | 2 | 5 | 10>(5);

  useEffect(() => {
    fetchTournamentData();
    fetchPlayers();

    // Subscribe to realtime updates
    const subscription = supabase
      .channel(`t-director-${tournamentId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, (payload) => {
        if (payload.new) {
          setTournament(payload.new as TournamentData);
        }
      })
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [tournamentId]);

  const fetchTournamentData = async () => {
    try {
      const { data, error: err } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', tournamentId)
        .single();

      if (err) throw err;
      setTournament(data as TournamentData);
      setError('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch tournament data';
      setError(message);
    }
  };

  const fetchPlayers = async () => {
    try {
      const { data, error: err } = await supabase
        .from('players')
        .select('*')
        .eq('tournament_id', tournamentId)
        .order('table_number', { ascending: true })
        .order('position', { ascending: true });

      if (err) throw err;
      setPlayers(data as Player[]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch players';
      setError(message);
    }
  };

  const showSuccessMessage = (message: string) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3000);
  };

  const broadcastEvent = async (eventType: string, eventData: Record<string, unknown>) => {
    try {
      await supabase.channel(`t-break-${tournamentId}`).send({
        type: 'broadcast',
        event: eventType,
        payload: eventData,
      });
    } catch (err) {
      console.error('Failed to broadcast event:', err);
    }
  };

  const handlePauseResume = async () => {
    if (!tournament) return;

    setLoading(true);
    try {
      const newPausedState = !tournament.is_paused;

      const { error: err } = await supabase
        .from('tournaments')
        .update({ is_paused: newPausedState })
        .eq('id', tournamentId);

      if (err) throw err;

      await broadcastEvent('tournament_pause', {
        is_paused: newPausedState,
        paused_at: newPausedState ? new Date().toISOString() : null,
      });

      showSuccessMessage(newPausedState ? 'Tournament paused' : 'Tournament resumed');
      fetchTournamentData();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update pause state';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddTime = async (minutes: number) => {
    setLoading(true);
    try {
      await broadcastEvent('add_time_to_level', {
        added_minutes: minutes,
        level: tournament?.current_level,
        added_at: new Date().toISOString(),
      });

      showSuccessMessage(`Added ${minutes} minute(s) to current level`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add time';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSkipToNextLevel = async () => {
    if (!tournament) return;

    setLoading(true);
    try {
      const nextLevel = tournament.current_level + 1;
      const blindStructure = tournament.blind_structure || [];

      if (nextLevel >= blindStructure.length) {
        setError('Already at final level');
        setLoading(false);
        return;
      }

      const nextBlindLevel = blindStructure[nextLevel];

      const { error: err } = await supabase
        .from('tournaments')
        .update({
          current_level: nextLevel,
          small_blind: nextBlindLevel.small_blind,
          big_blind: nextBlindLevel.big_blind,
          ante: nextBlindLevel.ante,
        })
        .eq('id', tournamentId);

      if (err) throw err;

      await broadcastEvent('level_advanced', {
        new_level: nextLevel,
        small_blind: nextBlindLevel.small_blind,
        big_blind: nextBlindLevel.big_blind,
        ante: nextBlindLevel.ante,
        advanced_at: new Date().toISOString(),
      });

      showSuccessMessage(`Advanced to level ${nextLevel}`);
      fetchTournamentData();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to advance level';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoBackOneLevel = async () => {
    if (!tournament || tournament.current_level === 0) {
      setError('Cannot go back from level 0');
      return;
    }

    setLoading(true);
    try {
      const prevLevel = tournament.current_level - 1;
      const blindStructure = tournament.blind_structure || [];
      const prevBlindLevel = blindStructure[prevLevel];

      const { error: err } = await supabase
        .from('tournaments')
        .update({
          current_level: prevLevel,
          small_blind: prevBlindLevel.small_blind,
          big_blind: prevBlindLevel.big_blind,
          ante: prevBlindLevel.ante,
        })
        .eq('id', tournamentId);

      if (err) throw err;

      await broadcastEvent('level_reverted', {
        new_level: prevLevel,
        small_blind: prevBlindLevel.small_blind,
        big_blind: prevBlindLevel.big_blind,
        ante: prevBlindLevel.ante,
        reverted_at: new Date().toISOString(),
      });

      showSuccessMessage(`Reverted to level ${prevLevel}`);
      fetchTournamentData();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to revert level';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleAdjustBlinds = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tournament) return;

    setLoading(true);
    try {
      const newSmallBlind = adjustSmallBlind ? Math.trunc(parseFloat(adjustSmallBlind) * 100) / 100 : tournament.small_blind;
      const newBigBlind = adjustBigBlind ? Math.trunc(parseFloat(adjustBigBlind) * 100) / 100 : tournament.big_blind;
      const newAnte = adjustAnte ? Math.trunc(parseFloat(adjustAnte) * 100) / 100 : tournament.ante;

      const { error: err } = await supabase
        .from('tournaments')
        .update({
          small_blind: newSmallBlind,
          big_blind: newBigBlind,
          ante: newAnte,
        })
        .eq('id', tournamentId);

      if (err) throw err;

      await broadcastEvent('blinds_adjusted', {
        small_blind: newSmallBlind,
        big_blind: newBigBlind,
        ante: newAnte,
        level: tournament.current_level,
        adjusted_at: new Date().toISOString(),
      });

      showSuccessMessage('Blinds adjusted successfully');
      setAdjustSmallBlind('');
      setAdjustBigBlind('');
      setAdjustAnte('');
      setShowAdjustForm(false);
      fetchTournamentData();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to adjust blinds';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleColorUp = async () => {
    setLoading(true);
    try {
      await broadcastEvent('color_up_triggered', {
        level: tournament?.current_level,
        triggered_at: new Date().toISOString(),
      });

      showSuccessMessage('Color up / Chip race initiated');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to trigger color up';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleForceBreak = async () => {
    setLoading(true);
    try {
      await broadcastEvent('tournament_break', {
        duration_minutes: 5,
        reason: 'Director forced break',
        forced_at: new Date().toISOString(),
      });

      showSuccessMessage('5-minute break initiated');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to force break';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleCancelTournament = async () => {
    setLoading(true);
    try {
      const { error: err } = await supabase
        .from('tournaments')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          apply_refunds: showRefund,
        })
        .eq('id', tournamentId);

      if (err) throw err;

      await broadcastEvent('tournament_cancelled', {
        apply_refunds: showRefund,
        cancelled_at: new Date().toISOString(),
      });

      showSuccessMessage('Tournament cancelled');
      setShowCancelConfirm(false);
      setTimeout(() => onClose(), 1500);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cancel tournament';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  if (!tournament) {
    return (
      <div className="fixed inset-0 z-50 bg-black bg-opacity-50 flex items-center justify-center">
        <div className="bg-gray-900 rounded-lg p-6 text-white">
          <p>Loading tournament data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-50 flex items-center justify-center p-4">
      <div className="bg-gray-950 rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white">{tournamentName}</h2>
            <p className="text-sm text-gray-400">Tournament Director Panel</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-300"
          >
            <X size={24} />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-800 px-6 flex gap-4 bg-gray-950">
          <button
            onClick={() => setActiveTab('controls')}
            className={`py-4 px-4 font-semibold border-b-2 transition-colors ${
              activeTab === 'controls'
                ? 'border-amber-500 text-amber-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <Clock size={18} />
              Controls
            </div>
          </button>
          <button
            onClick={() => setActiveTab('players')}
            className={`py-4 px-4 font-semibold border-b-2 transition-colors ${
              activeTab === 'players'
                ? 'border-amber-500 text-amber-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <Users size={18} />
              Players ({players.length})
            </div>
          </button>
        </div>

        {/* Messages */}
        {error && (
          <div className="mx-6 mt-4 p-4 bg-red-900 bg-opacity-30 border border-red-700 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}
        {success && (
          <div className="mx-6 mt-4 p-4 bg-green-900 bg-opacity-30 border border-green-700 rounded-lg text-green-300 text-sm">
            {success}
          </div>
        )}

        {/* Content */}
        <div className="p-6 space-y-6">
          {activeTab === 'controls' && (
            <>
              {/* Current Level Display */}
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-gray-400 text-xs uppercase tracking-wide">Level</p>
                    <p className="text-2xl font-bold text-amber-400">{tournament.current_level}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-xs uppercase tracking-wide">Small Blind</p>
                    <p className="text-2xl font-bold text-white">{Math.trunc(tournament.small_blind * 100) / 100}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-xs uppercase tracking-wide">Big Blind</p>
                    <p className="text-2xl font-bold text-white">{Math.trunc(tournament.big_blind * 100) / 100}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-xs uppercase tracking-wide">Ante</p>
                    <p className="text-2xl font-bold text-white">{Math.trunc(tournament.ante * 100) / 100}</p>
                  </div>
                </div>
              </div>

              {/* Pause/Resume */}
              <button
                onClick={handlePauseResume}
                disabled={loading}
                className={`w-full py-3 rounded-lg font-semibold flex items-center justify-center gap-2 transition-colors ${
                  tournament.is_paused
                    ? 'bg-green-900 hover:bg-green-800 text-green-100 disabled:opacity-50'
                    : 'bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50'
                }`}
              >
                {tournament.is_paused ? (
                  <>
                    <Play size={20} />
                    Resume Tournament
                  </>
                ) : (
                  <>
                    <Pause size={20} />
                    Pause Tournament
                  </>
                )}
              </button>

              {/* Add Time Buttons */}
              <div>
                <p className="text-gray-300 font-semibold mb-3 text-sm">Add Time to Current Level</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[1, 2, 5, 10].map((minutes) => (
                    <button
                      key={minutes}
                      onClick={() => handleAddTime(minutes)}
                      disabled={loading}
                      className="bg-amber-700 hover:bg-amber-600 text-white font-semibold py-2 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <Plus size={18} />
                      +{minutes}m
                    </button>
                  ))}
                </div>
              </div>

              {/* Level Navigation */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={handleSkipToNextLevel}
                  disabled={loading}
                  className="bg-amber-700 hover:bg-amber-600 text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <SkipForward size={18} />
                  Next Level
                </button>
                <button
                  onClick={handleGoBackOneLevel}
                  disabled={loading}
                  className="bg-amber-700 hover:bg-amber-600 text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <SkipBack size={18} />
                  Prev Level
                </button>
              </div>

              {/* Adjust Blinds */}
              <div>
                <button
                  onClick={() => setShowAdjustForm(!showAdjustForm)}
                  className="w-full bg-amber-700 hover:bg-amber-600 text-white font-semibold py-3 rounded-lg transition-colors flex items-center justify-center gap-2 mb-3"
                >
                  <Settings size={18} />
                  Adjust Blinds
                </button>
                {showAdjustForm && (
                  <form onSubmit={handleAdjustBlinds} className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
                    <div>
                      <label className="block text-gray-300 text-sm font-semibold mb-1">Small Blind</label>
                      <input
                        type="number"
                        step="0.01"
                        placeholder={tournament.small_blind.toString()}
                        value={adjustSmallBlind}
                        onChange={(e) => setAdjustSmallBlind(e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-300 text-sm font-semibold mb-1">Big Blind</label>
                      <input
                        type="number"
                        step="0.01"
                        placeholder={tournament.big_blind.toString()}
                        value={adjustBigBlind}
                        onChange={(e) => setAdjustBigBlind(e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-300 text-sm font-semibold mb-1">Ante</label>
                      <input
                        type="number"
                        step="0.01"
                        placeholder={tournament.ante.toString()}
                        value={adjustAnte}
                        onChange={(e) => setAdjustAnte(e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500"
                      />
                    </div>
                    <div className="flex gap-2 pt-2">
                      <button
                        type="submit"
                        disabled={loading}
                        className="flex-1 bg-green-700 hover:bg-green-600 text-white font-semibold py-2 rounded transition-colors disabled:opacity-50"
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowAdjustForm(false)}
                        className="flex-1 bg-gray-800 hover:bg-gray-700 text-white font-semibold py-2 rounded transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* Color Up / Chip Race */}
              <button
                onClick={handleColorUp}
                disabled={loading}
                className="w-full bg-amber-700 hover:bg-amber-600 text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50"
              >
                Color Up / Chip Race
              </button>

              {/* Force Break */}
              <button
                onClick={handleForceBreak}
                disabled={loading}
                className="w-full bg-amber-700 hover:bg-amber-600 text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50"
              >
                Force 5-Minute Break
              </button>

              {/* Cancel Tournament */}
              <div>
                <button
                  onClick={() => setShowCancelConfirm(!showCancelConfirm)}
                  className="w-full bg-red-900 hover:bg-red-800 text-red-100 font-semibold py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <AlertTriangle size={18} />
                  Cancel Tournament
                </button>
                {showCancelConfirm && (
                  <div className="mt-3 bg-red-900 bg-opacity-20 border border-red-700 rounded-lg p-4 space-y-3">
                    <p className="text-red-200 text-sm">Are you sure you want to cancel this tournament?</p>
                    <label className="flex items-center gap-2 text-red-200 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showRefund}
                        onChange={(e) => setShowRefund(e.target.checked)}
                        className="w-4 h-4 rounded"
                      />
                      Apply refunds to all players
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={handleCancelTournament}
                        disabled={loading}
                        className="flex-1 bg-red-700 hover:bg-red-600 text-white font-semibold py-2 rounded transition-colors disabled:opacity-50"
                      >
                        Confirm Cancel
                      </button>
                      <button
                        onClick={() => setShowCancelConfirm(false)}
                        className="flex-1 bg-gray-800 hover:bg-gray-700 text-white font-semibold py-2 rounded transition-colors"
                      >
                        Abort
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'players' && (
            <div className="space-y-3">
              {players.length === 0 ? (
                <p className="text-gray-400 text-center py-8">No players in tournament</p>
              ) : (
                players.map((player) => (
                  <div
                    key={player.id}
                    className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-between"
                  >
                    <div>
                      <p className="text-white font-semibold">{player.name}</p>
                      <p className="text-gray-400 text-sm">Table {player.table_number}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-amber-400 font-semibold">{Math.trunc(player.chip_stack * 100) / 100}</p>
                      <p className={`text-xs font-semibold ${
                        player.status === 'active' ? 'text-green-400' :
                        player.status === 'busted' ? 'text-red-400' :
                        'text-yellow-400'
                      }`}>
                        {player.status.toUpperCase()}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TournamentDirectorPanel;
