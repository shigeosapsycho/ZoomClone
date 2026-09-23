import { describe, expect, it } from "vitest";
import { EventQueue, MAX_QUEUED_EVENTS } from "./events";

async function collect<T>(iter: AsyncIterable<T>, max: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

describe("EventQueue", () => {
  it("yields pushed items in order and returns after end()", async () => {
    const q = new EventQueue<number>();
    q.push(1);
    q.push(2);
    const drained = collect(q.drain(), 10);
    q.push(3);
    q.end();
    expect(await drained).toEqual([1, 2, 3]);
    expect(q.ended).toBe(true);
  });

  it("wakes a waiting consumer when an item arrives later", async () => {
    const q = new EventQueue<string>();
    const first = (async () => {
      for await (const item of q.drain()) return item;
      return "none";
    })();
    await new Promise((r) => setTimeout(r, 20));
    q.push("late");
    expect(await first).toBe("late");
  });

  it("ignores pushes after end and stops on abort", async () => {
    const q = new EventQueue<number>();
    const controller = new AbortController();
    const drained = collect(q.drain(controller.signal), 10);
    q.push(1);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    q.push(2);
    expect(await drained).toEqual([1]);
    expect(q.ended).toBe(true);
  });

  it("drops the backlog and ends when a subscriber falls more than maxSize behind", async () => {
    let overflows = 0;
    const q = new EventQueue<number>({ maxSize: 3, onOverflow: () => overflows++ });
    for (let i = 0; i < 4; i++) q.push(i);
    expect(overflows).toBe(1);
    expect(q.ended).toBe(true);
    q.push(99);
    expect(overflows).toBe(1);
    expect(await collect(q.drain(), 10)).toEqual([]);
  });

  it("defaults the cap to MAX_QUEUED_EVENTS", () => {
    const q = new EventQueue<number>();
    for (let i = 0; i < MAX_QUEUED_EVENTS; i++) q.push(i);
    expect(q.ended).toBe(false);
    q.push(MAX_QUEUED_EVENTS);
    expect(q.ended).toBe(true);
  });
});
