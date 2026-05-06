/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📊 SUBSCRIPTION HEALTH MONITOR
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tracks active realtime subscriptions and warns about potential memory leaks.
 * Prevents excessive concurrent subscriptions and monitors subscription lifecycle.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Keep in sync with RealtimeChannelService.MAX_CONCURRENT_SUBSCRIPTIONS (25)
import { reportError } from './errorReporter';

const SUBSCRIPTION_WARN_THRESHOLD = 20;
const SUBSCRIPTION_MAX = 25;

interface SubscriptionRecord {
  id: string;
  channel: string;
  createdAt: number;
}

class SubscriptionMonitor {
  private subscriptions = new Map<string, SubscriptionRecord>();
  private warnedChannels = new Set<string>();

  /**
   * Register a new subscription
   */
  register(id: string, channel: string): void {
    this.subscriptions.set(id, {
      id,
      channel,
      createdAt: Date.now(),
    });

    // Warn if approaching limit
    if (this.subscriptions.size >= SUBSCRIPTION_WARN_THRESHOLD) {
      const channels = this.getGroupedByChannel();
      const report = Object.entries(channels)
        .map(([ch, count]) => `${ch}: ${count}`)
        .join(', ');

      if (!this.warnedChannels.has(report)) {
        console.warn(
          `[SubscriptionMonitor] ${this.subscriptions.size}/${SUBSCRIPTION_MAX} subscriptions active. ` +
            `Approaching limit. Channels: ${report}`
        );
        this.warnedChannels.add(report);
      }
    }

    // Log if at max
    if (this.subscriptions.size >= SUBSCRIPTION_MAX) {
      reportError(
        new Error(
          `[SubscriptionMonitor] Max subscriptions (${SUBSCRIPTION_MAX}) reached! ` +
            `Current: ${this.subscriptions.size}. This may cause memory leaks.`
        ),
        'subscriptionMonitor.SubscriptionMonitor_Max_subscriptions_SU'
      );
    }
  }

  /**
   * Unregister a subscription
   */
  unregister(id: string): void {
    this.subscriptions.delete(id);
    this.warnedChannels.clear(); // Reset warnings on cleanup
  }

  /**
   * Get total subscription count
   */
  getCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Get subscriptions grouped by channel
   */
  private getGroupedByChannel(): Record<string, number> {
    const grouped: Record<string, number> = {};
    this.subscriptions.forEach((sub) => {
      grouped[sub.channel] = (grouped[sub.channel] || 0) + 1;
    });
    return grouped;
  }

  /**
   * Get detailed subscription list for debugging
   */
  getDetails(): Array<{ id: string; channel: string; ageMs: number }> {
    const now = Date.now();
    return Array.from(this.subscriptions.values()).map((sub) => ({
      id: sub.id,
      channel: sub.channel,
      ageMs: now - sub.createdAt,
    }));
  }

  /**
   * Check if subscription exists
   */
  has(id: string): boolean {
    return this.subscriptions.has(id);
  }

  /**
   * Clean up all subscriptions
   */
  cleanup(): void {
    this.subscriptions.clear();
    this.warnedChannels.clear();
  }

  /**
   * Get diagnostics summary
   */
  getDiagnostics(): {
    totalSubscriptions: number;
    maxSubscriptions: number;
    warnThreshold: number;
    byChannel: Record<string, number>;
    isAtCapacity: boolean;
  } {
    return {
      totalSubscriptions: this.subscriptions.size,
      maxSubscriptions: SUBSCRIPTION_MAX,
      warnThreshold: SUBSCRIPTION_WARN_THRESHOLD,
      byChannel: this.getGroupedByChannel(),
      isAtCapacity: this.subscriptions.size >= SUBSCRIPTION_MAX,
    };
  }
}

// Singleton instance
export const subscriptionMonitor = new SubscriptionMonitor();

export { SubscriptionMonitor };
export default subscriptionMonitor;
