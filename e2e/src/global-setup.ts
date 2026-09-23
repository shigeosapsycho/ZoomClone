import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { TONE_PATH } from "../playwright.config";
import { writeToneWav } from "./tone";

const ROOT = resolve(import.meta.dirname, "../..");

/** Infra must be up; migrations run against the docker database the services will use. */
export default function globalSetup(): void {
  writeToneWav(TONE_PATH);
  execSync("pnpm db:migrate", {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL },
  });
}

/** One database for the migration, the services and the api helper (E2E_DATABASE_URL overrides). */
export const DATABASE_URL =
  process.env["E2E_DATABASE_URL"] ?? "postgres://zoomclone:zoomclone@localhost:55432/zoomclone";
export const REDIS_URL = "redis://localhost:56379/0";
