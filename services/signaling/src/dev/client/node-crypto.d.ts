// The client tsconfig intentionally omits Node's ambient types (types: []) so browser globals
// like WebSocket resolve to the DOM lib, not Node's undici types (see signaling.ts). But
// @zoomclone/protocol's barrel (index.ts) re-exports meeting-code.ts, which imports node:crypto's
// randomInt; nothing under src/dev/client calls it, so this minimal ambient declaration is enough
// to satisfy the type checker here without pulling in the rest of @types/node. It does not help
// esbuild bundle signaling.ts for the browser (that needs meeting-code.ts to drop the node:crypto
// dependency); see task-1-report.md for that finding, relevant once app.ts imports signaling.ts.
declare module "node:crypto" {
  export function randomInt(min: number, max: number): number;
}
