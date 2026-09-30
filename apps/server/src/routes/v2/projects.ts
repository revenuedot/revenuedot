import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { V2Error, body, paginate, scope, type V2Router } from "./common.js";
import { projectShape } from "./shapes.js";

const ProjectCreate = z.object({ name: z.string().trim().min(1).max(100) });

export function projectRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;

  // A secret key sees its own project; a dashboard user sees every project they are a member of.
  r.get("/v2/projects", scope("project_configuration:projects:read"), async (c) => {
    const p = c.get("principal");
    let ids: string[];
    if (p.kind === "key") ids = [p.projectId];
    else ids = (await db.select({ id: schema.memberships.projectId }).from(schema.memberships).where(eq(schema.memberships.userId, p.userId))).map((m) => m.id);
    const rows = ids.length ? await db.select().from(schema.projects).where(inArray(schema.projects.id, ids)) : [];
    return c.json(paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), projectShape));
  });

  // Creating projects needs a dashboard session: a secret key belongs to one project and could not use the new one.
  r.post("/v2/projects", scope("project_configuration:projects:read_write"), async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user") throw new V2Error(403, "authorization_error", "Secret API keys are scoped to one project and cannot create projects. Sign in to the dashboard to create one.");
    const b = await body(c, ProjectCreate);
    const id = newId("proj", 8);
    const [row] = await db.insert(schema.projects).values({ id, name: b.name, createdAt: deps.now() }).returning();
    await db.insert(schema.memberships).values({ userId: p.userId, projectId: id, role: "admin" });
    return c.json(projectShape(row!), 200);
  });
}
