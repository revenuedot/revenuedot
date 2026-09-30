import type { APIRoute } from "astro";
import { SITE } from "../../site";

// RFC 9116. Renew Expires before it passes.
export const GET: APIRoute = () =>
  new Response(
    [
      `Contact: mailto:${SITE.email.security}`,
      `Contact: ${SITE.github}/security/advisories/new`,
      "Expires: 2027-09-30T00:00:00.000Z",
      "Preferred-Languages: en",
      `Canonical: ${SITE.url}/.well-known/security.txt`,
      `Policy: ${SITE.url}/security`,
      "",
    ].join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
