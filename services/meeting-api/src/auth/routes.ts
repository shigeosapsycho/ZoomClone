import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { MeResponseSchema } from "@zoomclone/protocol";
import { jwks } from "@zoomclone/tokens";
import { requireUser } from "./hooks";

export const authRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/.well-known/jwks.json", async () => jwks(app.deps.keys));
  r.get("/v1/me", { schema: { response: { 200: MeResponseSchema } } }, async (req) => {
    const user = requireUser(req);
    return { id: user.id, org_id: user.orgId, name: user.name };
  });
};
