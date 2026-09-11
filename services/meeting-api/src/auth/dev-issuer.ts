import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { SignJWT } from "jose";
import { z } from "zod";
import type { SigningKeys } from "@zoomclone/tokens";

const DevTokenRequestSchema = z.object({
  sub: z.uuid().optional(),
  org_id: z.uuid().optional(),
  name: z.string().min(1).max(80).optional(),
});

const DevTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  sub: z.string(),
  org_id: z.string(),
});

export type DevIssuerOptions = {
  keys: SigningKeys;
  issuerUrl: string;
  audience: string;
  defaultOrgId: string;
};

/** Local OIDC stand-in. Mints user bearers with the meeting-api signing key. env.ts refuses it in production. */
export const devIssuerRoutes: FastifyPluginAsync<DevIssuerOptions> = async (app, opts) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/dev/oidc/jwks.json", async () => ({ keys: [opts.keys.publicJwk] }));
  r.post(
    "/dev/oidc/token",
    { schema: { body: DevTokenRequestSchema, response: { 200: DevTokenResponseSchema } } },
    async (req) => {
      const sub = req.body.sub ?? randomUUID();
      const orgId = req.body.org_id ?? opts.defaultOrgId;
      const accessToken = await new SignJWT({ org_id: orgId, name: req.body.name ?? "Dev User" })
        .setProtectedHeader({ alg: "ES256", kid: opts.keys.kid })
        .setIssuer(opts.issuerUrl)
        .setAudience(opts.audience)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(opts.keys.privateKey);
      return {
        access_token: accessToken,
        token_type: "Bearer" as const,
        expires_in: 3600,
        sub,
        org_id: orgId,
      };
    },
  );
};
