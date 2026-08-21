import React, { useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { dailyChallengeService } from '../../services/DailyChallengeService';

export function ChallengeToastListener() {
  const { user } = useAuthUser();
  const toast = useToast();
  // Keep track of processed completed ids so we don't double-toast
  // on reconnects or duplicate payloads
  const processedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel(`challenges-toast-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'user_daily_challenges',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const oldRecord = payload.old;
          const newRecord = payload.new;

          // If the old record had completed=false and the new one has completed=true
          if (oldRecord.completed === false && newRecord.completed === true) {
            if (processedRef.current.has(newRecord.id)) return;
            processedRef.current.add(newRecord.id);

            // Resolve the challenge metadata
            const challenge = dailyChallengeService.findInPools(newRecord.challenge_id);
            if (challenge) {
              toast.success(`🏆 Challenge Complete: ${challenge.name}! Check Hub to claim.`);
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, toast]);

  return null;
}
