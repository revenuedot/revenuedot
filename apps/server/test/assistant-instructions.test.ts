import { describe, expect, it } from "vitest";
import { instructionsFor } from "../src/services/assistant/agent.js";
import { assistantScope } from "../src/services/assistant/access.js";

const ctxFor = (access: string, role: string) => ({
  project: { id: "proj1", name: "Focus" }, actor: { userId: "u1", email: "a@b.co", conversationId: "c1" }, userName: "Ana",
  scope: assistantScope(access, role),
}) as unknown as Parameters<typeof instructionsFor>[0];

describe("instructions about changing things", () => {
  it("a Viewer hears the real roles and who can make the change", () => {
    const t = instructionsFor(ctxFor("read_write", "viewer"), new Date("2026-10-01T00:00:00Z"));
    expect(t).toContain("role is Viewer");
    expect(t).toContain("Admin or Developer");
    expect(t).toContain("only an Admin can invite people or change roles");
    expect(t).toContain("there are no others");
  });
  it("a read-only project points the user at the dashboard page", () => {
    const t = instructionsFor(ctxFor("read_only", "admin"), new Date("2026-10-01T00:00:00Z"));
    expect(t).toContain("allows RevenueDot AI to read only");
    expect(t).toContain("Grant entitlement");
  });
  it("a writer is told every write needs approval", () => {
    expect(instructionsFor(ctxFor("read_write", "developer"), new Date("2026-10-01T00:00:00Z"))).toContain("approves or denies every write");
  });
});
