import { describe, expect, it } from "vitest";
import { createTestInfra, silentLog, startTestSignaling } from "../../test/helpers";
import { FakeSfu } from "../../test/fake-sfu";
import { buildHarness } from "./build";

describe("dev harness bundle", () => {
  it("bundles the client for the browser and injects the api base", async () => {
    const bundle = await buildHarness({ apiBase: "http://api.test:8080" });
    expect(bundle.html).toContain('<script type="module" src="/dev/app.js">');
    expect(bundle.html).toContain('href="/dev/app.css"');
    expect(bundle.html).toContain("http://api.test:8080");
    expect(bundle.js.length).toBeGreaterThan(1000);
    // mediasoup-client brings CommonJS dependencies, so esbuild's `__commonJS` wrapper (whose
    // inner function is named `__require`) is expected; a bare `require(` or a `__require("x")`
    // call would mean a module the browser cannot load (the node:crypto import Task 1 removed).
    expect(bundle.js).not.toMatch(/(?<![\w$])require\(/);
    expect(bundle.js).not.toContain('__require("');
    expect(bundle.css).toContain("--desk");
  }, 30_000);

  it("serves the page, the script and the stylesheet under /dev when enabled", async () => {
    const infra = await createTestInfra();
    const sfu = new FakeSfu();
    await sfu.start();
    const harness = await buildHarness({ apiBase: "http://127.0.0.1:1" });
    const signaling = await startTestSignaling(infra, sfu.baseUrl, { harness });
    try {
      expect((await fetch(`${signaling.httpUrl}/dev/`)).headers.get("content-type")).toContain(
        "text/html",
      );
      expect(await (await fetch(`${signaling.httpUrl}/dev/app.js`)).text()).toBe(harness.js);
      expect((await fetch(`${signaling.httpUrl}/dev/app.css`)).status).toBe(200);
      expect((await fetch(`${signaling.httpUrl}/dev/nope`)).status).toBe(404);
    } finally {
      await signaling.close();
      await sfu.stop();
      await infra.close();
    }
  }, 30_000);
});
