import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "@zoomclone/protocol";
import type { AuthUser, UserVerifier } from "./user-verifier";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function bearerFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

/** Verifies any bearer on any request. A bad token is 401 everywhere; no token is allowed (guest routes decide). */
export function registerAuthHook(app: FastifyInstance, verifier: UserVerifier): void {
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    const token = bearerFrom(req);
    req.user = token ? await verifier.verify(token) : null;
  });
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new ApiError("UNAUTHORIZED", "bearer token required");
  return req.user;
}
