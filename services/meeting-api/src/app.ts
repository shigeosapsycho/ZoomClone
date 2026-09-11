import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { AppDeps } from "./deps";
import { errorHandler, notFoundHandler } from "./error-handler";

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export type App = FastifyInstance;

export async function buildApp(deps: AppDeps): Promise<App> {
  const app = Fastify({
    logger: deps.env.NODE_ENV === "test" ? false : { level: deps.env.LOG_LEVEL },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.decorate("deps", deps);

  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/healthz", async () => ({ ok: true }));
  r.get("/metrics", async (_req, reply) => {
    reply.header("content-type", deps.metrics.registry.contentType);
    return deps.metrics.registry.metrics();
  });

  return app;
}
