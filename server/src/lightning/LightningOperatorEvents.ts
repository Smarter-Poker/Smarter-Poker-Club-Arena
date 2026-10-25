import { parseLightningTopUpReceipt, type LightningTopUpReceipt } from './LightningTopUp.js';
/** Database transaction events reach operators through the engine channel.
 * Raw ledger payloads never leave the service; club membership and each read
 * door retain their existing authorization. No polling supplies updates. */
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../services/supabase.js';
import { channelHub } from '../hub/ChannelHub.js';
import { tableStateHub } from '../transport/TableStateHub.js';
import { alwaysOnRegistry } from '../observability/engineInstruments.js';
import { reportError } from '../services/errorReporter.js';

const subscription = alwaysOnRegistry.gauge(
  'poker_lightning_operator_subscription',
  'Lightning operator event subscription is active'
);

export class LightningOperatorEvents {
  private channel: RealtimeChannel | null = null;
  private generation = 0;
  private clubs = new Map<string, string>();
  constructor(
    private db: SupabaseClient = supabase,
    private send = (clubId: string, event: Record<string, unknown>) =>
      channelHub.broadcastToClub(clubId, { type: 'CLUB_EVENT', clubId, event }),
    private topUp = (receipt: LightningTopUpReceipt) => {
      tableStateHub.emitEvent(receipt.pool_session_id, {
        type: 'lightning_top_up_completed',
        ...receipt,
      });
    }
  ) {}
  start(): void {
    if (this.channel) return;
    const generation = ++this.generation;
    this.channel = this.db
      .channel('engine-lightning-operator-events')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'cash_cluster_events' },
        (row) => {
          void this.publish(row.new, generation);
        }
      )
      .subscribe((status) => {
        if (generation !== this.generation) return;
        if (status === 'SUBSCRIBED') {
          subscription.set(1);
          for (const clubId of new Set(this.clubs.values()))
            this.send(clubId, { type: 'lightning_operator_resync' });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          subscription.set(0);
          reportError(new Error(status), 'LightningOperatorEvents.subscription');
        }
      });
  }
  async stop(): Promise<void> {
    ++this.generation;
    subscription.set(0);
    const channel = this.channel;
    this.channel = null;
    this.clubs.clear();
    if (channel) await this.db.removeChannel(channel);
  }
  async publish(row: Record<string, unknown>, generation = this.generation): Promise<void> {
    if (row.kind === 'lightning_top_up_completed') {
      try {
        const receipt = parseLightningTopUpReceipt(row.payload);
        if (receipt.status === 'pending') throw new Error('Nonterminal Lightning Top Up Event');
        if (generation === this.generation) this.topUp(receipt);
      } catch (error) {
        reportError(error, 'LightningOperatorEvents.top_up');
      }
      return;
    }
    const clusterId = row.game_id;
    if (typeof clusterId !== 'string' || typeof row.kind !== 'string') return;
    try {
      let clubId = this.clubs.get(clusterId);
      if (!clubId) {
        const { data, error } = await this.db
          .from('cash_games')
          .select('club_id')
          .eq('id', clusterId)
          .maybeSingle();
        if (error) throw error;
        if (typeof data?.club_id !== 'string') return;
        clubId = data.club_id;
        if (generation !== this.generation) return;
        // The live fleet is bounded, and removed clusters cannot accumulate forever.
        if (this.clubs.size >= 10_000) this.clubs.delete(this.clubs.keys().next().value!);
        this.clubs.set(clusterId, clubId);
      }
      if (generation !== this.generation) return;
      this.send(clubId, {
        type: 'lightning_operator_changed',
        clusterId,
        kind: row.kind,
        eventId: row.id,
        timestamp: row.at,
      });
    } catch (error) {
      reportError(error, 'LightningOperatorEvents.publish');
    }
  }
}
