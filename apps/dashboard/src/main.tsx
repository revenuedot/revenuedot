import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import "./styles/index.css";
import { AuthPage } from "./pages/Auth";
import { AccountPage, ForgotPasswordPage, InvitePage, ResetPasswordPage, VerifyEmailPage } from "./pages/AccountPages";
import { Soon } from "./pages/Soon";
import { routes } from "./routes";
import { useMe } from "./components/Shell";
import { ToastProvider } from "./components/ui";
import { api } from "./lib/api";

try { const t = localStorage.getItem("rd-theme"); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false } } });

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
      <ToastProvider><BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route element={<RequireAuth />}>
            <Route path="/account" element={<AccountPage />} />
            {routes}
            {SOON.map(([p, t, w]) => <Route key={p} path={`/projects/:projectId/${p}`} element={<Soon title={t} what={w} />} />)}
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter></ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
