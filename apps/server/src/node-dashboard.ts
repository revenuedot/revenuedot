/**
 * Self-host (entry.node.ts): one process serves the API and the built dashboard on one origin, like the dashboard host on
 * Cloud (entry.worker.ts). The API answers GET / with its name for API clients; a browser asking for a page there gets
 * the dashboard, whose home route opens the sign-in page or the signed-in person's project.
 */
export function withDashboardRoot<A extends unknown[]>(fetch: (req: Request, ...rest: A) => Response | Promise<Response>, html: string) {
  return (req: Request, ...rest: A): Response | Promise<Response> => {
    const page = (req.method === "GET" || req.method === "HEAD") && new URL(req.url).pathname === "/" && /text\/html/i.test(req.headers.get("accept") ?? "");
    if (!page) return fetch(req, ...rest);
    return new Response(req.method === "HEAD" ? null : html, { headers: { "content-type": "text/html; charset=UTF-8" } });
  };
}
