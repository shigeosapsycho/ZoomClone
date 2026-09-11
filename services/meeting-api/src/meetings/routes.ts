import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateMeetingRequestSchema,
  EndMeetingResponseSchema,
  IdParamsSchema,
  MeetingResponseSchema,
  UpdateMeetingRequestSchema,
} from "@zoomclone/protocol";
import { requireUser } from "../auth/hooks";
import { toMeetingResponse } from "./mapper";

/** Spec 5.1 meeting routes. Registered with prefix /v1. */
export const meetingRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const meetings = app.deps.meetings;

  r.post(
    "/meetings",
    { schema: { body: CreateMeetingRequestSchema, response: { 201: MeetingResponseSchema } } },
    async (req, reply) => {
      const row = await meetings.create(requireUser(req), req.body);
      return reply.status(201).send(toMeetingResponse(row));
    },
  );

  r.get(
    "/meetings/:id",
    { schema: { params: IdParamsSchema, response: { 200: MeetingResponseSchema } } },
    async (req) => toMeetingResponse(await meetings.get(requireUser(req), req.params.id)),
  );

  r.patch(
    "/meetings/:id",
    {
      schema: {
        params: IdParamsSchema,
        body: UpdateMeetingRequestSchema,
        response: { 200: MeetingResponseSchema },
      },
    },
    async (req) =>
      toMeetingResponse(await meetings.update(requireUser(req), req.params.id, req.body)),
  );

  r.delete("/meetings/:id", { schema: { params: IdParamsSchema } }, async (req, reply) => {
    await meetings.cancel(requireUser(req), req.params.id);
    return reply.status(204).send();
  });

  // find-my-way needs a regex-constrained param to put a literal colon right after a parameter:
  // a bare ":id::end" reads as one param literally named "id::end" that swallows the ":end"
  // value too, since only "." "-" "(" "/" or end of string end a parametric name. "(^[^:/]+)"
  // ends the "id" param there, so the "::" that follows is then read as an escaped literal
  // colon, matching /v1/meetings/<uuid>:end with a clean req.params.id.
  r.post(
    "/meetings/:id(^[^:/]+)::end",
    { schema: { params: IdParamsSchema, response: { 200: EndMeetingResponseSchema } } },
    async (req) => {
      const { sessionId } = await meetings.end(requireUser(req), req.params.id);
      return { session_id: sessionId };
    },
  );
};
