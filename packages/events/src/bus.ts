import { randomUUID } from "node:crypto";
import type { Role } from "@zoomclone/protocol";

/** Typed payloads. Names mirror the spec 4.4 Kafka topics (see topicFor). */
export type EventMap = {
  "room.created": { session_id: string; home_sfu: string; epoch: number };
  "session.ended": { session_id: string; reason: string; peak_participants: number };
  "host.action": { session_id: string; actor_id: string; action: string; target_id?: string };
  "participant.joined": {
    session_id: string;
    participant_id: string;
    user_id: string | null;
    display_name: string;
    role: Role;
    joined_at: string;
  };
  "participant.left": {
    session_id: string;
    participant_id: string;
    left_at: string;
    reason: string;
  };
  "participant.updated": {
    session_id: string;
    participant_id: string;
    patch: Record<string, unknown>;
  };
};
export type EventType = keyof EventMap;

export type EventEnvelope<T extends EventType = EventType> = {
  id: string;
  type: T;
  /** Partition key: session_id, so one meeting's events stay ordered (spec 4.4). */
  key: string;
  ts: string;
  payload: EventMap[T];
};

export type EventHandler<T extends EventType> = (event: EventEnvelope<T>) => void | Promise<void>;

export interface EventBus {
  publish<T extends EventType>(type: T, key: string, payload: EventMap[T]): void;
  subscribe<T extends EventType>(type: T, handler: EventHandler<T>): () => void;
}

export type Topic = "meeting.lifecycle" | "participant.events";

export function topicFor(type: EventType): Topic {
  return type.startsWith("participant.") ? "participant.events" : "meeting.lifecycle";
}

/** Single-process bus. Handlers run on a microtask, never on the publisher's stack. */
export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<EventType, Set<EventHandler<EventType>>>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly onError: (error: unknown, event: EventEnvelope) => void = () => {},
  ) {}

  publish<T extends EventType>(type: T, key: string, payload: EventMap[T]): void {
    const event: EventEnvelope<T> = {
      id: randomUUID(),
      type,
      key,
      ts: new Date().toISOString(),
      payload,
    };
    for (const handler of this.handlers.get(type) ?? []) {
      const run: Promise<void> = Promise.resolve()
        .then(() => (handler as unknown as EventHandler<T>)(event))
        .catch((error: unknown) => this.onError(error, event))
        .finally(() => this.pending.delete(run));
      this.pending.add(run);
    }
  }

  subscribe<T extends EventType>(type: T, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as unknown as EventHandler<EventType>);
    return () => {
      set.delete(handler as unknown as EventHandler<EventType>);
    };
  }

  /** Test helper: resolves once every handler invocation so far has settled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }
}
