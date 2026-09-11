import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions } from "./log";

describe("loggerOptions", () => {
  it("prints the message and stack of an Error logged under the error key", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const log = pino(loggerOptions({ NODE_ENV: "test", LOG_LEVEL: "info" }), sink);
    log.error({ error: new Error("boom") }, "it failed");
    log.warn({ error: "already a string" }, "described");
    expect(lines).toHaveLength(2);
    const failed = JSON.parse(lines[0] ?? "{}") as {
      msg: string;
      error: { type: string; message: string; stack: string };
    };
    expect(failed.msg).toBe("it failed");
    expect(failed.error).toMatchObject({ type: "Error", message: "boom" });
    expect(failed.error.stack).toContain("Error: boom");
    const described = JSON.parse(lines[1] ?? "{}") as { error: string };
    expect(described.error).toBe("already a string");
  });
});
