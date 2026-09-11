import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export type HarnessBundle = { html: string; js: string; css: string };

const clientDir = join(dirname(fileURLToPath(import.meta.url)), "client");

/**
 * Bundles the gallery client in memory (design doc: esbuild bundle served at /dev). One entry,
 * one CSS import, browser platform; the api base is injected into the page shell as config.
 */
export async function buildHarness(opts: { apiBase: string }): Promise<HarnessBundle> {
  const result = await build({
    entryPoints: [join(clientDir, "app.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: "inline",
    outdir: "/dev",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  let js = "";
  let css = "";
  for (const file of result.outputFiles) {
    if (file.path.endsWith(".js")) js = file.text;
    else if (file.path.endsWith(".css")) css = file.text;
  }
  const shell = await readFile(join(clientDir, "index.html"), "utf8");
  const html = shell.replace("__API_BASE__", JSON.stringify(opts.apiBase));
  return { html, js, css };
}
