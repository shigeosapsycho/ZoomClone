import { describe, expect, it } from "vitest";
import { InMemoryEventBus, topicFor } from "./bus";

const sid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b11";
const pid = "2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12";

describe("InMemoryEventBus", () => {
  it("delivers envelopes asynchronously to subscribers of that type", async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe("participant.joined", (e) => {
      seen.push(`${e.type}:${e.payload.participant_id}:${e.key}`);
    });
    bus.subscribe("participant.left", () => {
      seen.push("wrong");
    });
    bus.publish("participant.joined", sid, {
      session_id: sid,
      participant_id: pid,
      user_id: null,
      display_name: "Ana",
      role: "attendee",
      joined_at: "2026-09-10T09:00:00.000Z",
    });
    expect(seen).toEqual([]);
    await bus.drain();
    expect(seen).toEqual([`participant.joined:${pid}:${sid}`]);
  });

  it("stamps id and ts and isolates handler failures", async () => {
    const errors: unknown[] = [];
    const bus = new InMemoryEventBus((err) => errors.push(err));
    let ok = 0;
    bus.subscribe("session.ended", () => {
      throw new Error("boom");
    });
    bus.subscribe("session.ended", async (e) => {
      expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(e.ts)).not.toBeNaN();
      ok++;
    });
    bus.publish("session.ended", sid, { session_id: sid, reason: "idle", peak_participants: 2 });
    await bus.drain();
    expect(ok).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("unsubscribe stops delivery", async () => {
    const bus = new InMemoryEventBus();
    let count = 0;
    const off = bus.subscribe("room.created", () => {
      count++;
    });
    bus.publish("room.created", sid, {
      session_id: sid,
      meeting_id: sid,
      home_sfu: "sfu-1",
      epoch: 1,
    });
    off();
    bus.publish("room.created", sid, {
      session_id: sid,
      meeting_id: sid,
      home_sfu: "sfu-1",
      epoch: 2,
    });
    await bus.drain();
    expect(count).toBe(1);
  });

  it("maps event types to spec 4.4 topics", () => {
    expect(topicFor("room.created")).toBe("meeting.lifecycle");
    expect(topicFor("session.ended")).toBe("meeting.lifecycle");
    expect(topicFor("host.action")).toBe("meeting.lifecycle");
    expect(topicFor("participant.joined")).toBe("participant.events");
    expect(topicFor("participant.updated")).toBe("participant.events");
  });
});
