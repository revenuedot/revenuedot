import { lazy, Suspense, type ComponentType } from "react";
import { Navigate } from "react-router-dom";

/**
 * Extension point: the only place the dashboard reaches the paid `ee/` folder (LICENSING.md, ee/README.md). The module is
 * found at build time with a glob, so a build without `ee/` still works (the glob is empty), and it is loaded lazily,
 * only when a page under /organizations is opened; links to those pages appear only when the server reports an
 * enterprise licence (`enterprise` in GET /auth/me). This file is licensed under AGPL-3.0 with the rest of the dashboard.
 */
const modules = import.meta.glob<{ default: ComponentType }>("../../../ee/dashboard/index.tsx");
const load = Object.values(modules)[0];
const Enterprise = load ? lazy(load) : null;

export const enterpriseAvailable = !!Enterprise;

export function EnterpriseRoutes() {
  if (!Enterprise) return <Navigate to="/" replace />;
  return <Suspense fallback={null}><Enterprise /></Suspense>;
}
