/**
 * Guards for URLs that customers configure and the server then calls (Slack webhook URLs, a self-hosted PostHog, S3
 * endpoints). Without them a project member could point an integration at the server's own network and read the
 * answer back in the delivery log.
 *
 * Always refused: non-http(s) schemes, credentials in the URL, link-local and cloud metadata addresses
 * (169.254.0.0/16, fe80::/10, metadata.google.internal ...) and unspecified or multicast addresses.
 * `strict` (RevenueDot Cloud) also refuses plain http, localhost, private and loopback networks and internal names.
 * Self-hosted servers may call their own network (a self-hosted PostHog, MinIO), so `strict` is off there.
 *
 * Host names are checked as written; WHATWG URL parsing already turns numeric forms such as http://2130706433/ into
 * dotted IPv4, so those are caught too. DNS answers are not checked (Workers cannot reach private addresses anyway).
 */

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "metadata.goog", "instance-data", "instance-data.ec2.internal"]);

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** "never" for addresses no integration may call, "private" for ones only a self-hosted server may call, else null. */
function classifyV4(ip: number[]): "never" | "private" | null {
  const a = ip[0]!, b = ip[1]!;
  if (a === 0 || a >= 224) return "never";
  if (a === 169 && b === 254) return "never";
  if (ip.join(".") === "100.100.100.200") return "never"; // Alibaba Cloud metadata
  if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
  return null;
}

function classifyV6(host: string): "never" | "private" | null {
  const h = host.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) { const v4 = ipv4(mapped[1]!); return v4 ? classifyV4(v4) : "never"; }
  // WHATWG URL serialises ::ffff:a.b.c.d as ::ffff:xxxx:yyyy.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
    return classifyV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  if (h === "::" || h.startsWith("ff")) return "never";
  if (/^fe[89ab]/.test(h) || h.startsWith("fd00:ec2::")) return "never";
  if (h === "::1" || /^f[cd]/.test(h)) return "private";
  return null;
}

/** Why the server must not call this URL, or null when it may. */
export function outboundUrlProblem(raw: string, strict: boolean): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "is not a valid URL"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "must be an https URL";
  if (strict && u.protocol !== "https:") return "must be an https URL";
  if (u.username || u.password) return "must not contain a user name or password";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "has no host";
  const bracketed = host.startsWith("[") ? host.slice(1, -1) : null;
  const kind = bracketed !== null ? classifyV6(bracketed) : ipv4(host) ? classifyV4(ipv4(host)!) : null;
  if (kind === "never" || METADATA_HOSTS.has(host)) return "points at an address the server must not call";
  if (strict) {
    if (kind === "private") return "points at a private network address";
    if (host === "localhost" || /\.(localhost|local|internal|lan|home|intranet|corp)$/.test(host) || (!host.includes(".") && bracketed === null)) {
      return "points at a private network address";
    }
  }
  return null;
}
