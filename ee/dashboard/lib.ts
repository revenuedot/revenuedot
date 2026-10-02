// RevenueDot Enterprise (ee/LICENSE). Types and helpers shared by the organization pages. Spec: prd/enterprise/PRD.md §11.
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api, ApiError, type List } from "../../apps/dashboard/src/lib/api";

export interface Org {
  object: string; id: string; name: string; your_role: "owner" | "admin" | "member"; region: string; region_name: string; selectable_regions: string[]; region_enforced: boolean; cloud: boolean;
  audit_retention_days: number | null; sso_enforced: boolean; seats: { purchased: number | null; used: number }; billing_email: string | null;
  member_count: number; project_count: number; features: string[]; created_at: number;
}
export interface Overview extends Org { sso: { connections: number; enabled: number; verified_domains: string[] }; scim: { active_tokens: number } }
export interface Member { user_id: string; email: string; name: string | null; role: "owner" | "admin" | "member"; source: string; active: boolean; sso_groups: string[]; last_sso_at: number | null; password_sign_in: boolean; created_at: number }
export interface OrgProject { id: string; name: string; region: string; region_name: string; member_count: number; your_role: string | null; added_at: number }
export interface ProjectMember { user_id: string; email: string; name: string | null; role: string; role_name: string; source: string }
export interface CustomRole { id: string; name: string; description: string | null; scopes: string[]; project_id: string | null; member_count: number; updated_at: number }
export interface ScopeGroup { group: string; scopes: { scope: string; label: string }[] }
export interface Mapping { id: string; group: string; project_id: string; project_name: string | null; role: string; role_name: string; created_at: number }
export interface Enterprise { mode: "licensed" | "development" | "invalid"; features: string[]; licensee?: string | null; expires_at?: number | null; message?: string | null }
export interface OrgLog { id: string; action: string; actor: { type: string; id: string | null; email: string | null }; target: { type: string; id: string | null }; data: Record<string, unknown>; occurred_at: number }

export const base = (orgId: string) => `/v2/organizations/${encodeURIComponent(orgId)}`;
export const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong. Try again.");
export const useOrgId = () => useParams().orgId ?? "";
export const isAdmin = (o?: Pick<Org, "your_role"> | null) => o?.your_role === "owner" || o?.your_role === "admin";

export const useOrg = (orgId: string) => useQuery({ queryKey: ["org", orgId], queryFn: () => api<Overview>(`${base(orgId)}/overview`), enabled: !!orgId, retry: false });
export const useEnterprise = () => useQuery({ queryKey: ["enterprise"], queryFn: () => api<Enterprise>("/v2/enterprise"), retry: false });
export const useOrgProjects = (orgId: string) => useQuery({ queryKey: ["org-projects", orgId], queryFn: async () => (await api<List<OrgProject>>(`${base(orgId)}/projects`)).items, enabled: !!orgId });
export const useRoles = (orgId: string, enabled = true) => useQuery({ queryKey: ["org-roles", orgId], queryFn: async () => (await api<List<CustomRole>>(`${base(orgId)}/roles`)).items, enabled: !!orgId && enabled, retry: false });

export const BUILTIN = [
  { value: "admin", label: "Admin", text: "Everything, including members, secret API keys and deleting the project." },
  { value: "developer", label: "Developer", text: "Apps, catalog, customers and integrations; no secret API keys or members." },
  { value: "viewer", label: "Viewer", text: "Sees everything, changes nothing." },
];
export const ORG_ROLE_TEXT: Record<string, string> = {
  owner: "Everything, including retention, seats, billing and deleting the organization.",
  admin: "Members, projects, roles, single sign-on, SCIM and exports. Admin of every organization project.",
  member: "Sees the organization and the projects they were given.",
};
export const SOURCE_LABEL: Record<string, string> = { manual: "Added by hand", sso: "Single sign-on", scim: "SCIM", project: "From a project", idp: "Identity provider", org: "Organization role" };
/** "sso_sign_in_failed" → "SSO sign-in failed". */
export const label = (action: string) => action.replace(/_/g, " ").replace(/\bsso\b/g, "SSO").replace(/\bscim\b/g, "SCIM").replace(/\bsign in\b/g, "sign-in").replace(/^./, (c) => c.toUpperCase());

/** Roles a project member can get: the built-in ones, then the organization's custom roles that apply to this project. */
export function roleOptions(roles: CustomRole[] | undefined, projectId: string) {
  return [...BUILTIN.map((b) => ({ value: b.value, label: b.label })), ...(roles ?? []).filter((r) => !r.project_id || r.project_id === projectId).map((r) => ({ value: r.id, label: r.name }))];
}
