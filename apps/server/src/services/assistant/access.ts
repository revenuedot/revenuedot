import { allows, type Principal } from "../../routes/v2/common.js";
import { isWriteTool, type ToolDefinition } from "./tools.js";

/**
 * What RevenueDot AI may do for one person in one project (prd/ai-assistant/PRD.md §2): the project's AI setting, then
 * the collaborator's role. Decided again on every turn, so a changed setting or role applies to the next question.
 */
export type AiAccess = "read_write" | "read_only" | "disabled";
export const AI_ACCESS: AiAccess[] = ["read_write", "read_only", "disabled"];

export interface AssistantScope {
  access: AiAccess;
  role: string;
  canRead: boolean;
  canWrite: boolean;
  /** Why writing (or everything) is off, in words the UI shows. */
  reason: string | null;
}

export function assistantScope(access: string, role: string): AssistantScope {
  const a = (AI_ACCESS as string[]).includes(access) ? (access as AiAccess) : "read_write";
  if (a === "disabled") return { access: a, role, canRead: false, canWrite: false, reason: "An admin turned RevenueDot AI off for this project." };
  if (a === "read_only") return { access: a, role, canRead: true, canWrite: false, reason: "This project allows RevenueDot AI to read only." };
  if (role === "viewer") return { access: a, role, canRead: true, canWrite: false, reason: "Your role (Viewer) can read only." };
  // A custom role (from an enterprise extension) reads with RevenueDot AI; the API still checks each read against its scopes.
  if (role !== "admin" && role !== "developer") return { access: a, role, canRead: true, canWrite: false, reason: "Your role can read only with RevenueDot AI." };
  return { access: a, role, canRead: true, canWrite: true, reason: null };
}

/** The tools this person may be offered: reads when the project allows the assistant, writes only with read_write and a role that has every scope. */
export function allowedTools(all: ToolDefinition[], s: AssistantScope): ToolDefinition[] {
  if (!s.canRead) return [];
  const p: Principal = { kind: "user", userId: "", role: s.role === "admin" || s.role === "developer" ? s.role : "viewer" };
  return all.filter((t) => (isWriteTool(t) ? s.canWrite : true) && t.scopes.every((x) => allows(p, x)));
}
