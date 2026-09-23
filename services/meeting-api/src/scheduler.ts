export type Placement = { region: string; sfuId: string };
export type PlacementRequest = { meetingId: string; region: string; expectedSize: number };

/** Spec 3.1 Scheduler: picks region + SFU for a new session. */
export interface Scheduler {
  place(request: PlacementRequest): Promise<Placement>;
}

/** Single-region, single-SFU placement from config. Slice D replaces this with the registry. */
export class StaticScheduler implements Scheduler {
  constructor(private readonly cfg: Placement) {}

  async place(): Promise<Placement> {
    return { region: this.cfg.region, sfuId: this.cfg.sfuId };
  }
}
