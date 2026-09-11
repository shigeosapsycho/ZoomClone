import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { devIssuerRoutes } from "./auth/dev-issuer";
import { registerAuthHook } from "./auth/hooks";
import { authRoutes } from "./auth/routes";
import type { AppDeps } from "./deps";
import { errorHandler, notFoundHandler } from "./error-handler";
import { joinRoutes } from "./join/routes";
import { meetingRoutes } from "./meetings/routes";

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export type App = FastifyInstance;

export async function buildApp(deps: AppDeps): Promise<App> {
  const app = Fastify({
    logger:
      deps.env.NODE_ENV === "test"
        ? false
        : deps.env.NODE_ENV === "development"
          ? { level: deps.env.LOG_LEVEL, transport: { target: "pino-pretty" } }
          : { level: deps.env.LOG_LEVEL },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.decorate("deps", deps);

  registerAuthHook(app, deps.userVerifier);
  await app.register(authRoutes);
  if (deps.env.AUTH_DEV_ISSUER) {
    await app.register(devIssuerRoutes, {
      keys: deps.keys,
      issuerUrl: deps.env.DEV_ISSUER_URL,
      audience: deps.env.OIDC_AUDIENCE,
      defaultOrgId: deps.env.DEFAULT_ORG_ID,
    });
  }
  await app.register(meetingRoutes, { prefix: "/v1" });
  await app.register(joinRoutes, { prefix: "/v1" });

  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/healthz", async () => ({ ok: true }));
  r.get("/metrics", async (_req, reply) => {
    reply.header("content-type", deps.metrics.registry.contentType);
    return deps.metrics.registry.metrics();
  });

  return app;
}
