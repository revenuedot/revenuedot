// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: environment clean-up that must run before any other module of the Node server is loaded.
// docker-compose.yml passes every optional setting as `${VAR:-}`, so an unset OPENAI_BASE_URL arrives as an empty string.
// The AI SDK creates its default providers when it is imported and rejects an empty base URL, which stopped the server
// from starting. An empty *_BASE_URL means "not set", so it is removed here.
// Docs: https://revenuedot.app/docs/self-hosting

export function dropEmptyBaseUrls(env: Record<string, string | undefined>): string[] {
  const dropped = Object.keys(env).filter((k) => k.endsWith("_BASE_URL") && env[k]!.trim() === "");
  for (const k of dropped) delete env[k];
  return dropped;
}

dropEmptyBaseUrls(process.env);
