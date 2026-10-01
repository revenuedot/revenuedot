/**
 * Paths the API owns on RevenueDot Cloud's dashboard host (app.revenuedot.app); everything else there is the dashboard.
 * `oauth` is here because MCP clients (ChatGPT, Claude) send people to /oauth/authorize on the dashboard host, where their
 * session cookie lives. Without it the consent page is replaced by the dashboard.
 */
export const API_PATH = /^\/(v1|v2|auth|oauth|rcbilling|\.well-known|pay)(\/|$)/;
