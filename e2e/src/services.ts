import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as http2 from "node:http2";
import { resolve } from "node:path";
import { DATABASE_URL, REDIS_URL } from "./global-setup";

const ROOT = resolve(import.meta.dirname, "../..");
export const API_URL = "http://localhost:8080";
export const SIGNALING_URL = "http://localhost:8081";
const SFU_URL = "http://localhost:9090";

const SHARED_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "warn",
  DATABASE_URL,
  REDIS_URL,
  TOKEN_ISSUER: "meeting-api",
};

const SERVICE_ENV: Record<ServiceName, Record<string, string>> = {
  "meeting-api": {
    ...SHARED_ENV,
    MEETING_API_PORT: "8080",
    AUTH_DEV_ISSUER: "true",
    SIGNALING_PUBLIC_URL: "ws://localhost:8081",
    CORS_ORIGINS: SIGNALING_URL,
    JOIN_RATE_LIMIT: "1000",
    JOIN_RATE_LIMIT_PER_CODE: "6",
    STUN_URLS: "",
  },
  sfu: {
    ...SHARED_ENV,
    SFU_GRPC_PORT: "9090",
    SFU_WORKERS: "1",
    SFU_MEDIA_PORT_BASE: "43000",
    SFU_ANNOUNCED_IP: "127.0.0.1",
    MEDIASOUP_LOG_LEVEL: "error",
  },
  signaling: {
    ...SHARED_ENV,
    SIGNALING_PORT: "8081",
    MEETING_API_JWKS_URL: `${API_URL}/.well-known/jwks.json`,
    MEETING_API_PUBLIC_URL: API_URL,
    SFU_ENDPOINTS: `sfu-local-1=${SFU_URL}`,
    DEV_HARNESS: "true",
    // Grace outlasts the reconnect backoff a client goes through while the process restarts.
    DISCONNECT_GRACE_MS: "10000",
    ROOM_IDLE_TIMEOUT_MS: "3000",
    HEARTBEAT_MS: "500",
    OWNER_LEASE_MS: "2000",
  },
};

export type ServiceName = "meeting-api" | "sfu" | "signaling";

type Running = { name: ServiceName; child: ChildProcess };

/** Spawns the three services as plain node processes (tsx via --import) and waits for /healthz. */
export class ServiceManager {
  private readonly running = new Map<ServiceName, Running>();

  constructor() {
    // A runner that dies (a killed worker, an uncaught error) never reaches stopAll: give every
    // child tree a synchronous best-effort kill on the way out. The exit hook cannot await.
    process.once("exit", () => {
      for (const { child } of this.running.values()) killTreeSync(child);
    });
  }

  async startAll(): Promise<void> {
    for (const name of ["meeting-api", "sfu", "signaling"] as const) await this.start(name);
  }

  async start(name: ServiceName): Promise<void> {
    if (this.running.has(name)) return;
    const cwd = resolve(ROOT, "services", name);
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd,
      env: { ...minimalEnv(), ...SERVICE_ENV[name] },
      stdio: ["ignore", "inherit", "inherit"],
    });
    this.running.set(name, { name, child });
    // The health poll races the child's exit: a crash on boot fails at once, not after 30 s.
    let onExit = (): void => undefined;
    const exited = new Promise<never>((_, reject) => {
      onExit = () =>
        reject(
          new Error(
            `${name} exited with code ${child.exitCode ?? child.signalCode} before becoming healthy`,
          ),
        );
      child.once("exit", onExit);
    });
    try {
      await Promise.race([
        waitFor(() => this.healthy(name), 30_000, `${name} did not become healthy`),
        exited,
      ]);
    } finally {
      child.off("exit", onExit);
    }
  }

  async stop(name: ServiceName): Promise<void> {
    const running = this.running.get(name);
    if (!running) return;
    this.running.delete(name);
    await killTree(running.child);
  }

  async stopAll(): Promise<void> {
    for (const name of [...this.running.keys()].reverse()) await this.stop(name);
  }

  /** Scenario 7: the room controller dies and a fresh process rehydrates the room from Redis. */
  async restartSignaling(): Promise<void> {
    await this.stop("signaling");
    await this.start("signaling");
  }

  private async healthy(name: ServiceName): Promise<boolean> {
    try {
      if (name === "sfu") return await h2Healthy(SFU_URL);
      const url = name === "meeting-api" ? `${API_URL}/healthz` : `${SIGNALING_URL}/healthz`;
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  }
}

function minimalEnv(): Record<string, string> {
  const keep = [
    "PATH",
    "Path",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "COMSPEC",
    "PATHEXT",
  ];
  const out: Record<string, string> = {};
  for (const key of keep) if (process.env[key]) out[key] = process.env[key]!;
  return out;
}

function h2Healthy(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const session = http2.connect(baseUrl);
    // A listener that never speaks HTTP/2 would otherwise hang the poll for good.
    const giveUp = setTimeout(() => {
      resolve(false);
      session.destroy();
    }, 2_000);
    const settle = (healthy: boolean) => {
      clearTimeout(giveUp);
      resolve(healthy);
    };
    session.on("error", () => settle(false));
    const req = session.request({ ":path": "/healthz" });
    req.on("response", (headers) => {
      settle(headers[":status"] === 200);
      req.close();
      session.close();
    });
    req.on("error", () => settle(false));
    req.end();
  });
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function killTree(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32" && child.pid) {
    // taskkill fails when the pid is already gone (the process died between the check and the
    // call); the exit event decides either way. A live child it could not kill gets kill().
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      try {
        if (!exited(child)) child.kill("SIGKILL");
      } catch {
        // kill() of a process that is already gone: the exit event settles it.
      }
    }
  } else {
    child.kill("SIGTERM");
    const escalate = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => clearTimeout(escalate));
  }
  await gone;
}

/** For the process exit hook, which cannot wait: the whole tree on Windows, else SIGKILL. */
function killTreeSync(child: ChildProcess): void {
  if (exited(child)) return;
  try {
    if (process.platform === "win32" && child.pid) {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // best effort: the child may already be gone
  }
}

export async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} within ${timeoutMs} ms`);
}

/** Refuses to run when one of the fixed ports is already taken by something else. */
export async function assertPortsFree(): Promise<void> {
  const probes = [
    ["meeting-api", `${API_URL}/healthz`, () => fetch(`${API_URL}/healthz`).then(() => true)],
    [
      "signaling",
      `${SIGNALING_URL}/healthz`,
      () => fetch(`${SIGNALING_URL}/healthz`).then(() => true),
    ],
    ["sfu", `${SFU_URL}/healthz`, () => h2Healthy(SFU_URL)],
  ] as const;
  for (const [name, url, probe] of probes) {
    const busy = await probe().catch(() => false);
    if (busy)
      throw new Error(`${name} port is already in use (${url}); stop the running service first`);
  }
}
