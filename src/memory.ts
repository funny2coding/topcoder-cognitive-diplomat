export interface MemoryEvent {
  type: string;
  at_ms: number;
  data: unknown;
}

export class RequestMemory {
  private readonly startedAt = Date.now();
  private readonly events: MemoryEvent[] = [];

  add(type: string, data: unknown): void {
    this.events.push({
      type,
      at_ms: Date.now() - this.startedAt,
      data
    });
  }

  snapshot(): MemoryEvent[] {
    return [...this.events];
  }
}
