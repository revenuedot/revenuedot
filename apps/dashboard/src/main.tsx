import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import "./styles/index.css";
import { AuthPage } from "./pages/Auth";
import { AccountPage, ConfirmEmailPage, ForgotPasswordPage, InvitePage, ResetPasswordPage, VerifyEmailPage } from "./pages/AccountPages";
import { AccountGeneralPage } from "./pages/account/General";
import { AccountSecurityPage } from "./pages/account/Security";
import { AccountNotificationsPage } from "./pages/account/Notifications";
import { AccountDateRegionPage, AccountInterfacePage } from "./pages/account/Appearance";
import { PrefsProvider } from "./components/Prefs";
import { loadCachedPrefs } from "./lib/prefs";
import { Soon } from "./pages/Soon";
import { StripeConnectCallback } from "./pages/setup/StripeConnect";
import { BillingPage } from "./pages/Billing";
import { ReceiveProject } from "./pages/ReceiveProject";
import { routes } from "./routes";
import { useMe } from "./components/Shell";
import { ToastProvider } from "./components/ui";
import { api, ApiError } from "./lib/api";
import { initAnalytics } from "./lib/analytics";
import { EnterpriseRoutes } from "./extensions";

initAnalytics();
// The theme, tint, currency and week start of the last visit, before the first paint (lib/prefs.ts).
loadCachedPrefs();
// A 402 (Cloud's go-live gate, components/PlanRequired.tsx) answers the same until Pro starts: no retries.
const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status === 402) && n < 3 } } });

function Home() {
  // Ask /auth/config first: /auth/me answers 401 when signed out, which the browser logs as an error.
  const config = useQuery({ queryKey: ["auth-config"], queryFn: () => api<{ signed_in?: boolean }>("/auth/config"), retry: false });
  const me = useMe(config.data?.signed_in === true);
  if (config.isLoading) return null;
  if (!config.data?.signed_in) return <Navigate to="/login" replace />;
  if (me.isLoading) return null;
  if (me.isError || !me.data) return <Navigate to="/login" replace />;
  return <Navigate to={me.data.projects[0] ? `/projects/${me.data.projects[0].id}/overview` : "/projects/new"} replace />;
}

/**
 * Signed-in pages. A signed-out visitor (an old bookmark, a link in an email) goes to sign in and comes back here,
 * before any page asks the API for data it would refuse with 401, which the browser logs as console errors.
 */
function RequireAuth() {
  const loc = useLocation();
  const qc = useQueryClient();
  const known = qc.getQueryData(["me"]) !== undefined;
  const config = useQuery({ queryKey: ["auth-gate"], queryFn: () => api<{ signed_in?: boolean }>("/auth/config"), retry: false, enabled: !known, staleTime: 0, gcTime: 0 });
  if (known || config.isError) return <Outlet />;
  if (config.isPending) return null;
  if (!config.data?.signed_in) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Outlet />;
}

const SOON: [string, string, string][] = [
  ["benchmarks", "Benchmarks", "How your conversion and retention compare with apps like yours."],
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider><BrowserRouter><PrefsProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path="/confirm-email" element={<ConfirmEmailPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/account" element={<AccountPage />} />
            <Route path="/account/general" element={<AccountGeneralPage />} />
            <Route path="/connect/stripe" element={<StripeConnectCallback />} />
            <Route path="/account/billing" element={<BillingPage />} />
            <Route path="/account/security" element={<AccountSecurityPage />} />
            <Route path="/account/notifications" element={<AccountNotificationsPage />} />
            <Route path="/account/interface" element={<AccountInterfacePage />} />
            <Route path="/account/date-and-region" element={<AccountDateRegionPage />} />
            <Route path="/projects/receive" element={<ReceiveProject />} />
            {routes}
            <Route path="/organizations/*" element={<EnterpriseRoutes />} />
            {SOON.map(([p, t, w]) => <Route key={p} path={`/projects/:projectId/${p}`} element={<Soon title={t} what={w} />} />)}
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </PrefsProvider></BrowserRouter></ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
