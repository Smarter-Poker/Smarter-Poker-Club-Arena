/** Logical clocks stop only for the exact weekly payout owners holding a table. */
export class WeeklyPauseClock {
  private tables = new Map<string, { startedAt: number; owners: Set<string> }>();

  hold(tableId: string, owner: string): void {
    if (!owner) throw new Error('Weekly payout pause requires an owner');
    let pause = this.tables.get(tableId);
    if (!pause) {
      pause = { startedAt: Date.now(), owners: new Set() };
      this.tables.set(tableId, pause);
    }
    pause.owners.add(owner);
  }

  release(tableId: string, owner: string): number | null {
    const pause = this.tables.get(tableId);
    if (!pause || !pause.owners.delete(owner) || pause.owners.size) return null;
    this.tables.delete(tableId);
    return Math.max(0, Date.now() - pause.startedAt);
  }

  has(tableId: string, owner?: string): boolean {
    const pause = this.tables.get(tableId);
    return owner === undefined ? !!pause : pause?.owners.has(owner) === true;
  }

  tableIds(): string[] {
    return [...this.tables.keys()];
  }

  /** Explicit engine retirement drops ownership without advancing gameplay. */
  retire(tableId: string): string[] {
    const owners = [...(this.tables.get(tableId)?.owners ?? [])];
    this.tables.delete(tableId);
    return owners;
  }

  now(tableId: string): number {
    return this.tables.get(tableId)?.startedAt ?? Date.now();
  }
}
