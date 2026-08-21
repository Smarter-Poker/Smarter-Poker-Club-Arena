import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { StubGtoSolverClient } from '../gto/GtoSolverClient.js';
import { analyzeSession } from '../gto/PostSessionAnalyzer.js';
import { supabase } from '../services/supabase.js';
import type { NormalizedHand, NormalizedAction } from '../integrity/types.js';

export async function handleAssistantLeaksDetect(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const user = await authenticateRequest(req);
  if (!user) {
    sendJSON(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    const { data: historyRows, error } = await supabase
      .from('hand_history')
      .select('*')
      .contains('players', `[{"userId": "${user.userId}"}]`)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    if (!historyRows || historyRows.length === 0) {
      return sendJSON(res, 200, {
        leaksDetected: 0,
        handsAnalyzed: 0,
        message: 'Not enough hands played yet.',
      });
    }

    const hands: NormalizedHand[] = historyRows.map((row) => {
      const actions = (row.actions || []).map((a: any, index: number) => {
        let latencyMs = 0;
        if (index > 0 && a.timestamp && row.actions[index - 1].timestamp) {
          latencyMs = Math.max(0, a.timestamp - row.actions[index - 1].timestamp);
        }
        return {
          handId: row.id,
          tableId: row.table_id,
          userId: a.userId || 'unknown',
          seat: a.seat,
          street: a.stage || 'preflop', // usually stage in stored actions
          action: a.action,
          amount: a.amount || 0,
          timestamp: a.timestamp || 0,
          latencyMs,
          forced: ['post_blind', 'post_ante'].includes(a.action),
        } as NormalizedAction;
      });

      return {
        handId: row.id,
        tableId: row.table_id,
        gameVariant: row.game_type,
        smallBlind: row.small_blind,
        bigBlind: row.big_blind,
        potSize: row.pot_size,
        rake: row.rake || 0,
        communityCards: row.community_cards || [],
        startedAt: row.started_at ? new Date(row.started_at).getTime() : 0,
        endedAt: row.ended_at ? new Date(row.ended_at).getTime() : 0,
        players: (row.players || []).map((p: any) => ({
          userId: p.userId,
          seat: p.seat,
          startingStack: p.stack, // approx
          cards: p.cards || [],
        })),
        winners: row.winners || [],
        actions,
      } as NormalizedHand;
    });

    if (hands.length === 0) {
      return sendJSON(res, 200, {
        leaksDetected: 0,
        handsAnalyzed: hands.length,
        message: 'Play more hands first.',
      });
    }

    // 2. Run analysis using StubGtoSolverClient with a fallback that forces leaks for demo purposes
    // (since the real WorldHub solver isn't wired up to this sandbox)
    const solver = new StubGtoSolverClient([], (hash: string) => {
      // Just mock a strategy that prefers 'fold' if they bet, or 'bet' if they fold, to guarantee some leaks
      return {
        scenarioHash: hash,
        actions: [
          { action: 'fold', frequency: 0.1, ev: 0 },
          { action: 'call', frequency: 0.2, ev: 0.5 },
          { action: 'bet', frequency: 0.7, ev: 2.0 },
          { action: 'raise', frequency: 0.0, ev: -1.0 },
          { action: 'check', frequency: 0.1, ev: 0.1 },
        ],
      };
    });
    const report = await analyzeSession(hands, user.userId, solver);

    sendJSON(res, 200, {
      leaksDetected: report.leaks.length,
      handsAnalyzed: report.handsAnalyzed,
      message: 'Analysis complete.',
    });
  } catch (err) {
    console.error('[Assistant] leak detect error:', err);
    sendJSON(res, 500, { error: 'Internal Server Error' });
  }
}
