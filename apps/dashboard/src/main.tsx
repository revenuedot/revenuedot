import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/app.css";
import { AuthPage } from "./pages/Auth";
import { Soon } from "./pages/Soon";
import { routes } from "./routes";
import { useMe } from "./components/Shell";

try { const t = localStorage.getItem("rd-theme"); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false } } });

function Home() {
  const me = useMe();
  if (me.isLoading) return null;
  if (me.isError || !me.data) return <Navigate to="/login" replace />;
  return <Navigate to={me.data.projects[0] ? `/projects/${me.data.projects[0].id}/overview` : "/projects/new"} replace />;
}

const SOON: [string, string, string][] = [
  ["charts", "Charts", "42 revenue and subscription charts with RevenueCat's definitions."],
  ["benchmarks", "Benchmarks", "How your conversion and retention compare with apps like yours."],
  ["product-catalog/virtual-currencies", "In-app currencies", "Coins and credits that customers earn and spend."],
  ["web-discounts", "Web discounts", "Discounts applied at web checkout."],
  ["paywalls", "Paywalls", "Design paywalls once and change them without an app release."],
  ["targeting", "Targeting", "Show different offerings to different customers."],
  ["experiments", "Experiments", "A/B test prices and offerings."],
  ["funnels", "Funnels", "Web-to-app funnels and purchase links."],
  ["ads", "Ads", "Ad revenue next to subscription revenue."],
  ["ads/rewards", "Rewards", "Rewarded ads that grant currency or access."],
  ["lifecycle/customer-center", "Customer Center", "Self-service subscription management inside your app."],
  ["lifecycle/support", "Support", "Customer support from purchase data."],
  ["lifecycle/retention", "Retention", "Offers that save cancelling customers."],
  ["lifecycle/refund-control", "Refund control", "Policies for Apple refund requests and Google chargebacks."],
  ["lifecycle/winback", "Win-back", "Bring back churned subscribers."],
  ["web", "Web", "Sell subscriptions on the web with Stripe."],
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          {routes}
          {SOON.map(([p, t, w]) => <Route key={p} path={`/projects/:projectId/${p}`} element={<Soon title={t} what={w} />} />)}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
