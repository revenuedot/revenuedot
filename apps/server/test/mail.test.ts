// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the mail drivers (SMTP against an in-process SMTP server, log, Cloudflare binding) and the templates.
// Docs: https://revenuedot.app/docs/guides/self-hosting#email
import { afterEach, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "node:net";
import { smtpMailer } from "../src/mail/smtp.js";
import { cloudflareMailer, logMailer, parseAddress } from "../src/mail/index.js";
import { alertEmail, inviteEmail, passwordResetEmail, verifyEmail } from "../src/mail/templates.js";

let server: SMTPServer | undefined;
afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined; });

/** A throwaway SMTP catcher: accepts one account's login and keeps every message. */
async function catcher() {
  const got: { from: string; to: string[]; raw: string; user?: string }[] = [];
  server = new SMTPServer({
    secure: false, authOptional: false, disabledCommands: ["STARTTLS"],
    onAuth(auth, _s, cb) { if (auth.username === "mailer" && auth.password === "p@ss w0rd") cb(null, { user: auth.username }); else cb(new Error("Invalid username or password")); },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (d: Buffer) => { raw += d.toString("utf8"); });
      stream.on("end", () => { got.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw, user: session.user as string | undefined }); cb(); });
    },
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return { port: (server.server.address() as AddressInfo).port, got };
}

describe("SMTP driver", () => {
  it("logs in with the URL's credentials (URL-encoded) and delivers text and HTML with From and Reply-To", async () => {
    const { port, got } = await catcher();
    const m = smtpMailer(`smtp://mailer:${encodeURIComponent("p@ss w0rd")}@127.0.0.1:${port}`, "RevenueDot <no-reply@example.com>", { replyTo: "team@example.com" });
    expect(m.driver).toBe("smtp");
    const mail = passwordResetEmail({ base: "https://rd.example.com", url: "https://rd.example.com/reset-password?token=abc" });
    const r = await m.send({ to: "ana@example.com", ...mail });
    expect(r.id).toMatch(/@/);
    expect(got).toHaveLength(1);
    expect(got[0]!.user).toBe("mailer");
    expect(got[0]!.from).toBe("no-reply@example.com");
    expect(got[0]!.to).toEqual(["ana@example.com"]);
    const raw = got[0]!.raw.replace(/=\r?\n/g, "");
    expect(raw).toMatch(/^From: RevenueDot <no-reply@example.com>/m);
    expect(raw).toMatch(/^Reply-To: team@example.com/m);
    expect(raw).toMatch(/^Subject: Reset your RevenueDot password/m);
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("text/plain");
    expect(raw).toContain("text/html");
    expect(raw).toContain("reset-password?token=3Dabc"); // quoted-printable "="
  });

  it("rejects wrong credentials and bad URLs", async () => {
    const { port } = await catcher();
    await expect(smtpMailer(`smtp://mailer:wrong@127.0.0.1:${port}`, "x@example.com").send({ to: "a@example.com", subject: "s", text: "t", html: "<p>t</p>" })).rejects.toThrow(/Invalid username or password/);
    expect(() => smtpMailer("https://example.com", "x@example.com")).toThrow(/smtp:\/\//);
  });
});

describe("log and Cloudflare drivers", () => {
  it("the log driver prints the whole text, links included", async () => {
    const lines: string[] = [];
    await logMailer((s) => lines.push(s)).send({ to: "a@example.com", subject: "Join", text: "Accept invite: https://rd.example.com/invite?token=xyz", html: "" });
    expect(lines.join("\n")).toContain("https://rd.example.com/invite?token=xyz");
    expect(lines.join("\n")).toContain("REVENUEDOT_SMTP_URL");
  });

  it("the Cloudflare driver calls the send_email binding with the structured builder", async () => {
    const calls: unknown[] = [];
    const m = cloudflareMailer({ send: async (x) => { calls.push(x); return { messageId: "cf-1" }; } });
    expect(await m.send({ to: "a@example.com", subject: "S", text: "T", html: "<p>T</p>" })).toEqual({ id: "cf-1" });
    expect(calls).toEqual([{ to: "a@example.com", from: { email: "no-reply@mail.revenuedot.app", name: "RevenueDot" }, subject: "S", text: "T", html: "<p>T</p>", replyTo: "hello@revenuedot.app" }]);
    expect(parseAddress("a@b.co")).toEqual({ email: "a@b.co" });
  });
});

describe("templates", () => {
  const base = "https://rd.example.com";
  const all = [
    passwordResetEmail({ base, url: `${base}/reset-password?token=t` }),
    verifyEmail({ base, url: `${base}/verify-email?token=t` }),
    inviteEmail({ base, url: `${base}/invite?token=t`, projectName: "Scan <b>ner</b>", inviter: "Ana", role: "viewer", expiresInDays: 7 }),
    alertEmail({ base, state: "open", kind: "webhook", projectName: "Scanner", subjectName: "Backend", detail: "HTTP 500", url: `${base}/projects/p/integrations/webhooks/w` }),
    alertEmail({ base, state: "resolved", kind: "store_credentials", projectName: "Scanner", subjectName: "iOS", url: `${base}/projects/p/apps/a` }),
  ];
  it("have text and HTML, a settings link, no remote images, no tracking and no street address", () => {
    for (const m of all) {
      expect(m.subject.length).toBeGreaterThan(5);
      expect(m.text).toContain(`${base}/account`);
      expect(m.html).toContain(`${base}/account`);
      // One remote image is allowed: the fixed brand lockup. No per-recipient URL, no query string, no tracking pixel.
      const imgs = [...m.html.matchAll(/<img[^>]*>/gi)].map((x) => x[0]);
      expect(imgs).toHaveLength(1);
      expect(imgs[0]).toContain('src="https://revenuedot.app/brand/revenuedot-lockup-black@2x.png"');
      expect(imgs[0]).toContain('alt="RevenueDot"');
      expect(m.html).not.toMatch(/url\(|<script|pixel|\.gif|[?&]utm_|track/i);
      expect(m.html).toContain("#0A0A0A"); // the ink colour
      expect(m.html + m.text).not.toMatch(/Townsend|Street|Suite|Circo/i);
      const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]!);
      expect(hrefs.every((h) => h.startsWith(base))).toBe(true);
    }
  });
  it("escape names in HTML", () => {
    expect(all[2]!.html).toContain("Scan &lt;b&gt;ner&lt;/b&gt;");
    expect(all[2]!.html).not.toContain("<b>ner</b>");
  });
});
