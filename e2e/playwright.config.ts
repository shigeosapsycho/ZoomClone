import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export const TONE_PATH = resolve(import.meta.dirname, ".cache/tone.wav");

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./src/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${TONE_PATH}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});
