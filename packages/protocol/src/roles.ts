import { z } from "zod";

export const RoleSchema = z.enum(["host", "cohost", "attendee"]);
export type Role = z.infer<typeof RoleSchema>;

export const HOST_ROLES: ReadonlySet<Role> = new Set<Role>(["host", "cohost"]);
