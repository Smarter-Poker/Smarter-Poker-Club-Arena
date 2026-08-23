import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUserStore } from '../stores/useUserStore';
import { tournamentService } from '../services/TournamentService';
import { supabase } from '../lib/supabase';
import { fmtChips } from '../utils/format';
import confirmDialog from '../components/common/confirmDialog';
import { useToast } from '../components/common/Toast';
import { reportError } from '../utils/errorReporter';

export interface RegisterTournamentParams {
  id: string;
  name: string;
  buy_in_amount: number;
  buy_in_fee?: number;
}

export function useTournamentRegistration() {
  const [isRegistering, setIsRegistering] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const currentUserId = useUserStore((s: any) => s.user?.id);
  const username = useUserStore((s: any) => s.user?.username) || 'Player';

  const register = useCallback(
    async (t: RegisterTournamentParams, onSuccess?: () => void) => {
      if (!currentUserId) {
        toast.error('Sign In To Register');
        return;
      }
      if (isRegistering) return;

      const totalCost = t.buy_in_amount + (t.buy_in_fee || 0);
      const confirmed = await confirmDialog({
        title: 'Confirm Buy In',
        message: `Register for ${t.name}? This will debit ${fmtChips(totalCost)} from your wallet.`,
        confirmText: 'Confirm Buy In',
      });
      if (!confirmed) return;

      setIsRegistering(true);
      try {
        await tournamentService.registerPlayer(t.id, currentUserId, username);
        toast.success(`You Are Registered For ${t.name}`);

        if (onSuccess) {
          onSuccess();
        }

        // Check if the server assigned a table (late reg)
        const { data: tp } = await supabase
          .from('tournament_players')
          .select('table_id')
          .eq('tournament_id', t.id)
          .eq('user_id', currentUserId)
          .maybeSingle();

        if (tp?.table_id) {
          navigate(`/table/${tp.table_id}`);
        } else {
          // Find active tournament table to spectate
          const { data: tbls } = await supabase
            .from('tables')
            .select('id, status')
            .eq('tournament_id', t.id)
            .neq('status', 'closed')
            .limit(1);
          if (tbls && tbls.length > 0 && tbls[0].id) {
            navigate(`/table/${tbls[0].id}`);
          }
        }
      } catch (e) {
        reportError(e, 'useTournamentRegistration.register', { tournamentId: t.id });
        toast.error(e instanceof Error ? e.message : 'Registration Failed, Please Try Again');
      } finally {
        setIsRegistering(false);
      }
    },
    [currentUserId, username, isRegistering, navigate, toast]
  );

  return { register, isRegistering };
}
