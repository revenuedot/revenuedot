import { skip, type PartnerDef } from "./common.js";

/**
 * Connections that send no lifecycle events, so they have their own dashboard page instead of the event form:
 * - Google AdMob: OAuth with a Google Cloud OAuth client, then the account's ad units are loaded for the Ads Overview
 *   (apps/server/src/services/ads/admob.ts, prd/ads/PRD.md). The fields are the project's own OAuth client, used when the
 *   server has none (REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID and _SECRET).
 * - Intercom inbox app: Intercom's Canvas Kit calls `POST /v1/support/intercom/{project_id}/canvas`, signed with the
 *   Intercom app's client secret (`X-Body-Signature`, HMAC-SHA256 of the body), and gets the contact's subscription
 *   summary as Canvas Kit components (apps/server/src/routes/support-apps.ts).
 * - Apple Search Ads: attribution needs no setup (the AdServices token is resolved with Apple and stored as
 *   `$appleAdsCampaignId` …). The optional API user credentials load campaign and ad group names for the campaign
 *   report (apps/server/src/services/ads/apple-ads.ts).
 * - Zendesk ticket sidebar app: a Zendesk app (manifest in `integrations/zendesk-app/`) that calls
 *   `GET /v2/projects/{project_id}/support_summaries?email=` with a secret key stored as a secure app setting.
 */

const none = async () => skip("This connection sends no events.");

export const CONNECTION_PARTNERS: PartnerDef[] = [
  {
    spec: {
      kind: "admob", name: "Google AdMob", category: "ads", text: "Load your AdMob ad units so the Ads Overview shows their names and formats.",
      environment: "both", eventNames: false, docs: "https://revenuedot.app/docs/guides/ads#admob", api: "documented", connection: true,
      fields: [
        { key: "client_id", label: "Google OAuth client ID", type: "text", placeholder: "1234-abc.apps.googleusercontent.com", hint: "Only when the server has no Google OAuth client. Create a Web application client in Google Cloud with the redirect URI shown on this page." },
        { key: "client_secret", label: "Google OAuth client secret", type: "secret" },
      ],
    },
    events: [], build: none,
  },
  {
    spec: {
      kind: "apple_search_ads", name: "Apple Search Ads", category: "attribution", text: "Match purchases to Apple Search Ads campaigns: attribution from the AdServices token, campaign names and revenue by campaign.",
      environment: "both", eventNames: false, docs: "https://revenuedot.app/docs/guides/integrations#apple-search-ads", api: "documented", connection: true,
      fields: [
        { key: "org_id", label: "Organization ID", type: "text", placeholder: "1234567", hint: "Optional: only for campaign names. Apple Search Ads › Account settings." },
        { key: "client_id", label: "Client ID", type: "text", placeholder: "SEARCHADS.…", hint: "From the API user's API tab after you upload the public key." },
        { key: "team_id", label: "Team ID", type: "text", placeholder: "SEARCHADS.…" },
        { key: "key_id", label: "Key ID", type: "text" },
        { key: "private_key", label: "Private key (PEM)", type: "secret", hint: "The P-256 key you generated (private-key.pem). Sealed at rest." },
      ],
    },
    events: [], build: none,
  },
  {
    spec: {
      kind: "intercom_inbox", name: "Intercom inbox", category: "support", text: "Subscription status, plan, renewal date and total spent next to each conversation in Intercom.",
      environment: "both", eventNames: false, docs: "https://revenuedot.app/docs/guides/support-integrations#intercom", api: "documented", connection: true,
      fields: [
        { key: "client_secret", label: "Intercom app client secret", type: "secret", required: true, hint: "From your Intercom app in the Developer Hub, under Basic information. RevenueDot checks each request's signature with it." },
      ],
    },
    events: [], build: none,
  },
  {
    spec: {
      kind: "zendesk", name: "Zendesk", category: "support", text: "A ticket sidebar app with the requester's entitlements, subscriptions, refunds and open tickets.",
      environment: "both", eventNames: false, docs: "https://revenuedot.app/docs/guides/support-integrations#zendesk", api: "documented", connection: true,
      fields: [],
    },
    events: [], build: none,
  },
];
