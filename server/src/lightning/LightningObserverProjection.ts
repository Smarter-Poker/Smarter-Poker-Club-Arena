import type { TableStateHub } from '../transport/TableStateHub.js';

interface PublicHost {
  readonly clusterId: string;
}

/** Public physical rooms follow one complete virtual hand, never a player's room. */
export class LightningObserverProjection {
  private readonly active = new Set<PublicHost>();
  private readonly states = new Map<PublicHost, Record<string, unknown>>();
  private readonly selected = new Map<string, PublicHost>();

  constructor(
    private readonly hub: TableStateHub,
    private readonly anchors: (clusterId: string) => string[]
  ) {}

  started(host: PublicHost): void {
    this.active.add(host);
    for (const table of this.anchors(host.clusterId)) {
      const current = this.selected.get(table);
      if (current && this.active.has(current)) continue;
      this.selected.set(table, host);
      this.hub.claimPublicProjection(table, host, () =>
        this.anchors(host.clusterId).includes(table)
      );
    }
  }

  state(host: PublicHost, state: Record<string, unknown>): void {
    this.started(host);
    this.states.set(host, state);
    for (const table of this.anchors(host.clusterId)) {
      const selected = this.selected.get(table);
      if (selected && this.active.has(selected) && selected !== host) continue;
      this.show(table, host, state);
    }
  }

  event(host: PublicHost, event: Record<string, unknown>): void {
    for (const table of this.anchors(host.clusterId)) {
      if (this.selected.get(table) !== host) continue;
      this.hub.emitEvent(table, { ...event, table_id: table }, host);
    }
  }

  finished(host: PublicHost): void {
    this.active.delete(host);
    this.states.delete(host);
    const next = [...this.states].find(([candidate]) => candidate.clusterId === host.clusterId);
    for (const table of this.anchors(host.clusterId)) {
      if (this.selected.get(table) !== host) continue;
      // Keep the terminal public frame while waiting, instead of resurrecting
      // the cash anchor's pre-conversion hand. The next hand takes ownership.
      if (next) this.show(table, next[0], next[1]);
    }
  }

  private show(table: string, host: PublicHost, state: Record<string, unknown>): void {
    this.selected.set(table, host);
    this.hub.claimPublicProjection(table, host, () => this.anchors(host.clusterId).includes(table));
    this.hub.publish(table, { ...state, table_id: table, lightning_observer: true }, host);
  }
}
