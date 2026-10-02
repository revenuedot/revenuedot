import { Route } from "react-router-dom";
import { Overview } from "./pages/Overview";
import { Customers } from "./pages/Customers";
import { CustomerDetail } from "./pages/CustomerDetail";
import { OfferingsPage } from "./pages/catalog/Offerings";
import { OfferingEditor } from "./pages/catalog/OfferingEditor";
import { OfferingDetail } from "./pages/catalog/OfferingDetail";
import { ProductDetail, ProductsPage } from "./pages/catalog/Products";
import { EntitlementDetail, EntitlementsPage } from "./pages/catalog/Entitlements";
import { NewProject } from "./pages/setup/NewProject";
import { Apps } from "./pages/setup/Apps";
import { AppConfig } from "./pages/setup/AppConfig";
import { ApiKeys } from "./pages/setup/ApiKeys";
import { Integrations } from "./pages/setup/Integrations";
import { WebhookDetail, WebhookEdit, WebhookList, WebhookNew } from "./pages/setup/Webhooks";
import { ExportDetail, ExportNew, ExportsList } from "./pages/setup/Exports";
import { PartnerIntegrationPage } from "./pages/setup/PartnerIntegration";
import { ProjectSettingsPage } from "./pages/setup/ProjectSettings";
import { VirtualCurrenciesPage } from "./pages/catalog/VirtualCurrencies";
import { CustomerCenterPage } from "./pages/lifecycle/CustomerCenter";
import { RefundControlPage } from "./pages/lifecycle/RefundControl";
import { RetentionPage } from "./pages/lifecycle/Retention";
import { SupportPage } from "./pages/lifecycle/Support";
import { WinbackEditor, WinbackListPage } from "./pages/lifecycle/Winback";
import { PaymentRecoveryPage } from "./pages/lifecycle/PaymentRecovery";
import { PaywallsPage } from "./pages/paywalls/Paywalls";
import { PaywallEditor } from "./pages/paywalls/Editor";
import { GalleryPage } from "./pages/paywalls/Gallery";
import { TargetingPage } from "./pages/targeting/Targeting";
import { ExperimentsPage } from "./pages/experiments/Experiments";
import { ExperimentDetail } from "./pages/experiments/ExperimentDetail";
import { ExperimentFormPage } from "./pages/experiments/ExperimentForm";
import { ChartsPage } from "./pages/charts/Charts";
import { AdsOverviewPage } from "./pages/ads/AdsOverview";
import { RewardsPage } from "./pages/ads/Rewards";
import { AdMobPage } from "./pages/ads/AdMobPage";
import { ZendeskPage } from "./pages/setup/SupportApps";
import { WebPage } from "./pages/web/Web";
import { FunnelsPage } from "./pages/web/Funnels";
import { FunnelBuilderPage } from "./pages/web/FunnelBuilder";
import { WebDiscountsPage } from "./pages/web/WebDiscounts";
import { AuthPage as AppAuthPage } from "./pages/auth/AuthPage";
import { lazy, Suspense } from "react";

// RevenueDot AI pulls in the AI SDK, the Agents client and Streamdown; it loads only when opened.
const AssistantPage = lazy(() => import("./pages/ai/Assistant").then((m) => ({ default: m.AssistantPage })));
const Assistant = () => <Suspense fallback={null}><AssistantPage /></Suspense>;

/** Project routes. URL paths mirror RevenueCat's dashboard so bookmarks and muscle memory carry over. */
export const routes = [
  <Route key="overview" path="/projects/:projectId/overview" element={<Overview />} />,
  <Route key="ai" path="/projects/:projectId/ai" element={<Assistant />} />,
  <Route key="ai-conversation" path="/projects/:projectId/ai/:conversationId" element={<Assistant />} />,
  <Route key="charts" path="/projects/:projectId/charts" element={<ChartsPage />} />,
  <Route key="chart" path="/projects/:projectId/charts/:chartName" element={<ChartsPage />} />,
  <Route key="customers" path="/projects/:projectId/customers" element={<Customers />} />,
  <Route key="customer" path="/projects/:projectId/customers/:appUserId" element={<CustomerDetail />} />,
  <Route key="catalog-offerings" path="/projects/:projectId/product-catalog/offerings" element={<OfferingsPage />} />,
  <Route key="catalog-offering-new" path="/projects/:projectId/product-catalog/offerings/new" element={<OfferingEditor />} />,
  <Route key="catalog-offering" path="/projects/:projectId/product-catalog/offerings/:offeringId" element={<OfferingDetail />} />,
  <Route key="catalog-offering-edit" path="/projects/:projectId/product-catalog/offerings/:offeringId/edit" element={<OfferingEditor />} />,
  <Route key="catalog-products" path="/projects/:projectId/product-catalog/products" element={<ProductsPage />} />,
  <Route key="catalog-product" path="/projects/:projectId/product-catalog/products/:productId" element={<ProductDetail />} />,
  <Route key="catalog-entitlements" path="/projects/:projectId/product-catalog/entitlements" element={<EntitlementsPage />} />,
  <Route key="catalog-entitlement" path="/projects/:projectId/product-catalog/entitlements/:entitlementId" element={<EntitlementDetail />} />,
  <Route key="catalog-currencies" path="/projects/:projectId/product-catalog/virtual-currencies" element={<VirtualCurrenciesPage />} />,
  <Route key="customer-center" path="/projects/:projectId/lifecycle/customer-center" element={<CustomerCenterPage />} />,
  <Route key="support" path="/projects/:projectId/lifecycle/support" element={<SupportPage />} />,
  <Route key="retention" path="/projects/:projectId/lifecycle/retention" element={<RetentionPage />} />,
  <Route key="refund-control" path="/projects/:projectId/lifecycle/refund-control" element={<RefundControlPage />} />,
  <Route key="payment-recovery" path="/projects/:projectId/lifecycle/payment-recovery" element={<PaymentRecoveryPage />} />,
  <Route key="winback" path="/projects/:projectId/lifecycle/winback" element={<WinbackListPage />} />,
  <Route key="winback-new" path="/projects/:projectId/lifecycle/winback/new" element={<WinbackEditor />} />,
  <Route key="winback-campaign" path="/projects/:projectId/lifecycle/winback/:campaignId" element={<WinbackEditor />} />,
  <Route key="paywalls" path="/projects/:projectId/paywalls" element={<PaywallsPage />} />,
  <Route key="paywall-templates" path="/projects/:projectId/paywalls/templates" element={<GalleryPage />} />,
  <Route key="paywall" path="/projects/:projectId/paywalls/:paywallId" element={<PaywallEditor />} />,
  <Route key="ads" path="/projects/:projectId/ads" element={<AdsOverviewPage />} />,
  <Route key="ads-rewards" path="/projects/:projectId/ads/rewards" element={<RewardsPage />} />,
  <Route key="targeting" path="/projects/:projectId/targeting" element={<TargetingPage />} />,
  <Route key="experiments" path="/projects/:projectId/experiments" element={<ExperimentsPage />} />,
  <Route key="experiment-new" path="/projects/:projectId/experiments/new" element={<ExperimentFormPage />} />,
  <Route key="experiment" path="/projects/:projectId/experiments/:experimentId" element={<ExperimentDetail />} />,
  <Route key="experiment-edit" path="/projects/:projectId/experiments/:experimentId/edit" element={<ExperimentFormPage />} />,
  <Route key="web" path="/projects/:projectId/web" element={<WebPage />} />,
  <Route key="funnels" path="/projects/:projectId/funnels" element={<FunnelsPage />} />,
  <Route key="funnel" path="/projects/:projectId/funnels/:funnelId" element={<FunnelBuilderPage />} />,
  <Route key="web-discounts" path="/projects/:projectId/web-discounts" element={<WebDiscountsPage />} />,
  <Route key="auth" path="/projects/:projectId/auth" element={<AppAuthPage />} />,
  <Route key="project-new" path="/projects/new" element={<NewProject />} />,
  <Route key="apps" path="/projects/:projectId/apps" element={<Apps />} />,
  <Route key="app" path="/projects/:projectId/apps/:appId" element={<AppConfig />} />,
  <Route key="api-keys" path="/projects/:projectId/api-keys" element={<ApiKeys />} />,
  <Route key="integrations" path="/projects/:projectId/integrations" element={<Integrations />} />,
  <Route key="webhooks" path="/projects/:projectId/integrations/webhooks" element={<WebhookList />} />,
  <Route key="webhook-new" path="/projects/:projectId/integrations/webhooks/new" element={<WebhookNew />} />,
  <Route key="webhook" path="/projects/:projectId/integrations/webhooks/:webhookId" element={<WebhookDetail />} />,
  <Route key="webhook-edit" path="/projects/:projectId/integrations/webhooks/:webhookId/edit" element={<WebhookEdit />} />,
  <Route key="exports" path="/projects/:projectId/integrations/exports" element={<ExportsList />} />,
  <Route key="export-new" path="/projects/:projectId/integrations/exports/new" element={<ExportNew />} />,
  <Route key="export" path="/projects/:projectId/integrations/exports/:exportId" element={<ExportDetail />} />,
  <Route key="integration-admob" path="/projects/:projectId/integrations/admob" element={<AdMobPage />} />,
  <Route key="integration-zendesk" path="/projects/:projectId/integrations/zendesk" element={<ZendeskPage />} />,
  <Route key="integration" path="/projects/:projectId/integrations/:type" element={<PartnerIntegrationPage />} />,
  <Route key="settings" path="/projects/:projectId/settings" element={<ProjectSettingsPage />} />,
  <Route key="settings-tab" path="/projects/:projectId/settings/:tab" element={<ProjectSettingsPage />} />,
];
