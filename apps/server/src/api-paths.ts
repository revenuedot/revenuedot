/**
 * Paths the API owns on RevenueDot Cloud's dashboard host (app.revenuedot.app); everything else there is the dashboard.
 * `oauth` is here because MCP clients (ChatGPT, Claude) send people to /oauth/authorize on the dashboard host, where their
 * session cookie lives. Without it the consent page is replaced by the dashboard. `share` serves public share cards
 * (the first-sale card) and `agents` is RevenueDot AI's Durable Object WebSocket on Cloud (prd/ai-assistant/PRD.md).
 * `verified` serves the public Verified Metrics pages (prd/project-settings §4) on both hosts. `sso` (single sign-on: SAML
 * assertion consumer and OpenID Connect callbacks, which set the session cookie) and `scim` (SCIM 2.0 provisioning) are
 * enterprise routes (extensions.ts); without the extension they answer 404 like any unknown API path.
 */
export const API_PATH = /^\/(v1|v2|auth|oauth|rcbilling|\.well-known|pay|share|agents|verified|sso|scim)(\/|$)/;
