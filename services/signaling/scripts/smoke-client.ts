// A minimal client for the running services (pnpm dev): one HTTP request to the meeting API, then
// a WebSocket session with signaling, which in turn calls the SFU over gRPC. It prints every
// message it sends and receives; run the services with LOG_LEVEL=debug to see their side.
//
//   pnpm smoke
//
// Needs AUTH_DEV_ISSUER=true on the meeting API (the default in .env.example).

const API = process.env["API_URL"] ?? "http://localhost:8080";
const HOST_SUB = "11111111-1111-4111-8111-111111111111";

function show(direction: string, what: string, body: unknown): void {
  const text = JSON.stringify(body);
  console.log(`${direction} ${what} ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`);
}

/** Tokens are bearer credentials; print their presence, not their value. */
function maskTokens(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  return Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, k.endsWith("token") ? "<jwt>" : v]),
  );
}

async function http<T>(method: string, path: string, body: unknown, token?: string): Promise<T> {
  show("client -> meeting-api", `${method} ${path}`, body);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  show("meeting-api -> client", `${res.status}`, maskTokens(json));
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return json;
}

async function main(): Promise<void> {
  const { access_token: token } = await http<{ access_token: string }>("POST", "/dev/oidc/token", {
    sub: HOST_SUB,
    name: "Smoke host",
  });
  const meeting = await http<{ code: string }>("POST", "/v1/meetings", { title: "smoke" }, token);
  const join = await http<{ signaling_url: string; signaling_token: string }>(
    "POST",
    "/v1/join",
    { code: meeting.code, display_name: "Smoke host" },
    token,
  );

  const ws = new WebSocket(join.signaling_url);
  const send = (frame: { type: string; id?: string; payload: unknown }) => {
    show("client -> signaling", frame.type, frame.type === "hello" ? { token: "<jwt>" } : frame);
    ws.send(JSON.stringify(frame));
  };
  const received: Array<{ type: string; id?: string; seq?: number; payload: unknown }> = [];
  const waitFor = (pred: (f: (typeof received)[number]) => boolean, ms = 10_000) =>
    new Promise<(typeof received)[number]>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("timed out waiting for a frame")), ms);
      const check = () => {
        const hit = received.find(pred);
        if (hit) {
          clearTimeout(deadline);
          resolve(hit);
        } else setTimeout(check, 20);
      };
      check();
    });
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as (typeof received)[number];
    received.push(frame);
    const summary =
      frame.type === "welcome"
        ? {
            ...(frame.payload as { seq: number; state: string; epoch: number }),
            roster: "<roster>",
            tracks: "<tracks>",
            room_meta: "<meta>",
            media: "<transport params>",
          }
        : frame;
    show("signaling -> client", frame.type, summary);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
  });

  send({ type: "hello", id: "1", payload: { token: join.signaling_token } });
  await waitFor((f) => f.type === "welcome");
  send({ type: "chat", id: "2", payload: { body: "hello from the smoke client" } });
  await waitFor((f) => f.type === "ack" && f.id === "2");
  send({ type: "host.end", id: "3", payload: {} });
  await new Promise<void>((resolve) =>
    ws.addEventListener("close", (event) => {
      console.log(`signaling closed the socket: ${event.code} ${event.reason}`);
      resolve();
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
