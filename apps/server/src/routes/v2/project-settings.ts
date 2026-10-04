import { and, desc, eq, ilike, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { BrandIn, brandOf } from "../../services/brand.js";
import { HISTORY_METRICS, monthlyHistories } from "../../services/metric-history.js";
import { DEFAULT_METRICS, LINE_MONTHS, VerifiedIn, forgetVerifiedHost, slugProblem, slugify, type VerifiedRow } from "../../services/verified.js";
import { cnameTarget, DOMAIN, txtName, txtValue, verifyDomain } from "../../services/web/domains.js";
import { CloudflareSaasError, deleteCustomHostname, ensureCustomHostname, getCustomHostname } from "../../services/cloudflare-saas.js";
import { hit } from "../../services/rate-limit.js";
import { newId } from "@revenuedot/core";
import { V2Error, body, listOf, notFound, pageParams, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { publicOrigin } from "./setup.js";

/**
 * Project settings tabs (prd/project-settings), RevenueDot extensions:
 *   GET    /v2/projects/{project_id}/brand                                        colour and gradient presets
 *   POST   /v2/projects/{project_id}/brand                                        replace them
 *   GET    /v2/projects/{project_id}/blocked_customers                            block list (?search=, paging)
 *   POST   /v2/projects/{project_id}/blocked_customers                            block an app user id
 *   GET    /v2/projects/{project_id}/blocked_customers/{app_user_id}              200 when blocked, 404 when not
 *   DELETE /v2/projects/{project_id}/blocked_customers/{app_user_id}              unblock
 *   GET    /v2/projects/{project_id}/verified_metrics                             Verified Metrics page settings
 *   POST   /v2/projects/{project_id}/verified_metrics                             update them (a published page is republished)
 *   GET    /v2/projects/{project_id}/verified_metrics/slug_availability?slug=     whether a slug is free
 *   POST   /v2/projects/{project_id}/verified_metrics/actions/publish
 *   POST   /v2/projects/{project_id}/verified_metrics/actions/unpublish
 *   GET    /v2/projects/{project_id}/verified_metrics/monthly_history             12 monthly points per metric (Line charts preview)
 *   PUT    /v2/projects/{project_id}/verified_metrics/domain                      set or clear the page's custom domain
 *   POST   /v2/projects/{project_id}/verified_metrics/domain/actions/verify       check its DNS (and its certificate on Cloud)
 */

const Block = z.object({ app_user_id: z.string().trim().min(1).max(100), note: z.string().trim().max(500).nullable().optional() });

export function projectSettingsRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";

  // ---- Brand ----------------------------------------------------------------------------------------------------------
  const brandOut = (raw: unknown) => ({ object: "brand" as const, ...brandOf(raw) });
  r.get(`${P}/brand`, scope("project_configuration:projects:read"), async (c) => {
    const [p] = await db.select({ brand: schema.projects.brand }).from(schema.projects).where(eq(schema.projects.id, c.get("projectId"))).limit(1);
    return c.json(brandOut(p?.brand));
  });
  r.post(`${P}/brand`, scope("project_configuration:projects:read_write"), async (c) => {
    const b = await body(c, BrandIn);
    const [cur] = await db.select({ brand: schema.projects.brand }).from(schema.projects).where(eq(schema.projects.id, c.get("projectId"))).limit(1);
    const prev = brandOf(cur?.brand);
    const merged = { color_presets: b.color_presets ?? prev.color_presets, gradient_presets: b.gradient_presets ?? prev.gradient_presets };
    // Keys are shared between the two lists (both become ui_config.app.colors), also when only one list is sent.
    const check = BrandIn.safeParse(merged);
    if (!check.success) {
      const i = check.error.issues[0]!;
      throw paramError(`${i.path.join(".")}: ${i.message}. Colour and gradient presets share one set of keys.`, String(i.path[0] ?? "gradient_presets"));
    }
    const next = brandOf(merged);
    await db.update(schema.projects).set({ brand: next }).where(eq(schema.projects.id, c.get("projectId")));
    return c.json(brandOut(next));
  });

  // ---- Blocked customers ----------------------------------------------------------------------------------------------
  const B = schema.blockedCustomers;
  const actorOf = (c: V2Context) => { const p = c.get("principal"); return p.kind === "user" ? p.userId : `key:${p.keyId}`; };
  const blockedOut = async (rows: (typeof B.$inferSelect)[], projectId: string) => {
    const userIds = [...new Set(rows.map((x) => x.blockedBy).filter((x): x is string => !!x && !x.startsWith("key:")))];
    const users = userIds.length ? await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
    // Whether the app user id belongs to a customer (the table links to it).
    const known = rows.length ? await db.select({ id: schema.customerAliases.appUserId }).from(schema.customerAliases)
      .where(and(eq(schema.customerAliases.projectId, projectId), inArray(schema.customerAliases.appUserId, rows.map((x) => x.appUserId)))) : [];
    const knownSet = new Set(known.map((k) => k.id));
    return rows.map((x) => ({
      object: "blocked_customer" as const, id: x.appUserId, app_user_id: x.appUserId, note: x.note ?? null, blocked_at: x.blockedAt.getTime(),
      blocked_by: x.blockedBy ? (x.blockedBy.startsWith("key:") ? { type: "api_key", id: x.blockedBy.slice(4), email: null } : { type: "user", id: x.blockedBy, email: users.find((u) => u.id === x.blockedBy)?.email ?? null }) : null,
      customer_exists: knownSet.has(x.appUserId),
    }));
  };

  r.get(`${P}/blocked_customers`, scope("customer_information:customers:read"), async (c) => {
    const projectId = c.get("projectId");
    const { limit, startingAfter } = pageParams(c);
    const conds = [eq(B.projectId, projectId)];
    const search = c.req.query("search")?.trim();
    if (search) conds.push(ilike(B.appUserId, `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`));
    if (startingAfter) {
      const [cur] = await db.select().from(B).where(and(eq(B.projectId, projectId), eq(B.appUserId, startingAfter))).limit(1);
      if (!cur) throw paramError("starting_after does not match a blocked customer.", "starting_after");
      conds.push(sql`(${B.blockedAt}, ${B.appUserId}) < (${cur.blockedAt.toISOString()}::timestamptz, ${cur.appUserId})`);
    }
    const rows = await db.select().from(B).where(and(...conds)).orderBy(desc(B.blockedAt), desc(B.appUserId)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json(listOf(c, await blockedOut(page, projectId), rows.length > limit ? page[page.length - 1]!.appUserId : null));
  });

  r.post(`${P}/blocked_customers`, scope("customer_information:customers:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, Block);
    const [existing] = await db.select().from(B).where(and(eq(B.projectId, projectId), eq(B.appUserId, b.app_user_id))).limit(1);
    if (existing) return c.json((await blockedOut([existing], projectId))[0]);
    const [row] = await db.insert(B).values({ projectId, appUserId: b.app_user_id, note: b.note ?? null, blockedBy: actorOf(c), blockedAt: deps.now() }).returning();
    return c.json((await blockedOut([row!], projectId))[0], 201);
  });

  const findBlocked = async (c: V2Context) => {
    const [row] = await db.select().from(B).where(and(eq(B.projectId, c.get("projectId")), eq(B.appUserId, c.req.param("app_user_id")!))).limit(1);
    if (!row) throw notFound("Blocked customer");
    return row;
  };
  r.get(`${P}/blocked_customers/:app_user_id`, scope("customer_information:customers:read"), async (c) => c.json((await blockedOut([await findBlocked(c)], c.get("projectId")))[0]));
  r.delete(`${P}/blocked_customers/:app_user_id`, scope("customer_information:customers:read_write"), async (c) => {
    const row = await findBlocked(c);
    await db.delete(B).where(and(eq(B.projectId, row.projectId), eq(B.appUserId, row.appUserId)));
    return c.json({ object: "blocked_customer", id: row.appUserId, app_user_id: row.appUserId, unblocked_at: deps.now().getTime() });
  });

  // ---- Verified Metrics -----------------------------------------------------------------------------------------------
  const V = schema.verifiedPages;
  const pageOf = async (c: V2Context): Promise<VerifiedRow | null> => {
    const [row] = await db.select().from(V).where(eq(V.projectId, c.get("projectId"))).limit(1);
    return row ?? null;
  };
  /** A page that was never saved: a free slug from the project name. */
  const draft = async (c: V2Context) => {
    const [p] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, c.get("projectId"))).limit(1);
    const name = p?.name ?? "My app";
    let base = slugify(name);
    if (slugProblem(base)) base = `app-${c.get("projectId").replace(/^proj/, "").toLowerCase()}`;
    let slug = base, n = 2;
    while (await slugTaken(slug, c.get("projectId"))) slug = `${base.slice(0, 36)}-${n++}`;
    return { slug, displayName: name.slice(0, 60) };
  };
  const slugTaken = async (slug: string, projectId: string) => {
    const [row] = await db.select({ p: V.projectId }).from(V).where(and(eq(V.slug, slug), ne(V.projectId, projectId))).limit(1);
    return !!row;
  };
  const pageOut = (c: V2Context, row: VerifiedRow | null, d?: { slug: string; displayName: string }) => {
    const origin = deps.apiUrl ?? publicOrigin(c);
    const slug = row?.slug ?? d!.slug;
    return {
      object: "verified_metrics" as const, status: row?.status ?? "never_published", slug, display_name: row?.displayName ?? d!.displayName,
      chart_type: row?.chartType ?? "number_sparkline", metrics: row?.metrics ?? DEFAULT_METRICS,
      show_icon: row?.showIcon ?? false, icon_asset_id: row?.iconAssetId ?? null,
      show_store_links: row?.showStoreLinks ?? false, app_store_url: row?.appStoreUrl ?? null, play_store_url: row?.playStoreUrl ?? null,
      url: `${origin}/verified/${slug}`, published_at: row?.publishedAt?.getTime() ?? null, updated_at: row?.updatedAt.getTime() ?? null,
      custom_domain: domainOut(c, row),
    };
  };

  /**
   * The custom domain (metrics.yourapp.com): proven like a web domain by a TXT record, served by a CNAME to the API host.
   * On Cloud the domain also needs a TLS certificate: from Cloudflare for SaaS when the server has a token for it,
   * otherwise RevenueDot adds it by hand after verification (docs/cloud.md).
   */
  const target = (c: V2Context) => cnameTarget(deps.customDomainTarget, deps.apiUrl ?? publicOrigin(c));
  const domainOut = (c: V2Context, row: VerifiedRow | null) => {
    if (!row?.customDomain) return null;
    const verified = row.domainStatus === "verified";
    const certificate = deps.cloudflareSaas
      ? { managed: "automatic" as const, status: row.domainSslStatus ?? (verified ? "pending" : null) }
      : deps.edition === "cloud" ? { managed: "manual" as const, status: null } : { managed: "self_hosted" as const, status: null };
    return {
      domain: row.customDomain, status: row.domainStatus, url: verified ? `https://${row.customDomain}` : null,
      verified_at: row.domainVerifiedAt?.getTime() ?? null, checked_at: row.domainCheckedAt?.getTime() ?? null, error: row.domainError,
      dns: [{ type: "CNAME", name: row.customDomain, value: target(c) }, { type: "TXT", name: txtName(row.customDomain), value: txtValue(row.domainToken ?? "") }],
      certificate: {
        ...certificate,
        note: certificate.managed === "manual" ? "RevenueDot adds the TLS certificate for your domain after it is verified, usually within one business day. Until then the page stays on its RevenueDot URL."
          : certificate.managed === "self_hosted" ? "Serve this server over HTTPS for the domain (your proxy or load balancer holds its certificate)." : null,
      },
    };
  };
  const DomainIn = z.object({ custom_domain: z.string().trim().toLowerCase().max(253).nullable() });
  const usedElsewhere = async (domain: string, projectId: string) => {
    const [page] = await db.select({ p: V.projectId }).from(V).where(and(eq(V.customDomain, domain), eq(V.domainStatus, "verified"), ne(V.projectId, projectId))).limit(1);
    const [web] = await db.select({ p: schema.webDomains.projectId }).from(schema.webDomains).where(and(eq(schema.webDomains.customDomain, domain), eq(schema.webDomains.status, "verified"))).limit(1);
    return page ? "This domain is used by another project's verified page." : web ? "This domain serves hosted web pages. Use another subdomain, such as metrics.yourapp.com." : null;
  };
  const dropHostname = async (row: VerifiedRow) => {
    if (!row.domainHostnameId || !deps.cloudflareSaas) return;
    try { await deleteCustomHostname(deps.fetch ?? fetch, deps.cloudflareSaas, row.domainHostnameId); } catch (e) { console.warn(`Removing the custom hostname ${row.customDomain} failed`, e); }
  };

  r.get(`${P}/verified_metrics`, scope("project_configuration:projects:read"), async (c) => {
    const row = await pageOf(c);
    return c.json(pageOut(c, row, row ? undefined : await draft(c)));
  });

  r.get(`${P}/verified_metrics/slug_availability`, scope("project_configuration:projects:read"), async (c) => {
    const slug = (c.req.query("slug") ?? "").trim().toLowerCase();
    const problem = slugProblem(slug);
    if (problem) return c.json({ object: "slug_availability", slug, available: false, reason: `The slug ${problem}.` });
    const taken = await slugTaken(slug, c.get("projectId"));
    return c.json({ object: "slug_availability", slug, available: !taken, reason: taken ? "Another project uses this slug." : null });
  });

  /** Validates and saves; `status` changes only through publish and unpublish. */
  const save = async (c: V2Context, input: z.infer<typeof VerifiedIn>, status?: "published" | "inactive") => {
    const projectId = c.get("projectId");
    const cur = await pageOf(c);
    const d = cur ? null : await draft(c);
    const slug = input.slug ?? cur?.slug ?? d!.slug;
    const problem = slugProblem(slug);
    if (problem) throw paramError(`slug ${problem}.`, "slug");
    if (await slugTaken(slug, projectId)) throw new V2Error(409, "resource_already_exists", "Another project uses this slug. Pick another one.", "slug");
    if (input.icon_asset_id) {
      const [a] = await db.select({ id: schema.mediaAssets.id }).from(schema.mediaAssets)
        .where(and(eq(schema.mediaAssets.projectId, projectId), eq(schema.mediaAssets.id, input.icon_asset_id), eq(schema.mediaAssets.kind, "image"))).limit(1);
      if (!a) throw paramError("icon_asset_id is not an image uploaded to this project.", "icon_asset_id");
    }
    const now = deps.now();
    const values = {
      slug, displayName: input.display_name ?? cur?.displayName ?? d!.displayName, chartType: input.chart_type ?? cur?.chartType ?? "number_sparkline",
      metrics: input.metrics ?? cur?.metrics ?? DEFAULT_METRICS, showIcon: input.show_icon ?? cur?.showIcon ?? false,
      iconAssetId: input.icon_asset_id !== undefined ? input.icon_asset_id : cur?.iconAssetId ?? null,
      showStoreLinks: input.show_store_links ?? cur?.showStoreLinks ?? false,
      appStoreUrl: input.app_store_url !== undefined ? input.app_store_url : cur?.appStoreUrl ?? null,
      playStoreUrl: input.play_store_url !== undefined ? input.play_store_url : cur?.playStoreUrl ?? null,
      status: status ?? cur?.status ?? "never_published",
      publishedAt: status === "published" ? now : cur?.publishedAt ?? null, updatedAt: now,
    };
    let row: VerifiedRow;
    try {
      [row] = cur
        ? await db.update(V).set(values).where(eq(V.projectId, projectId)).returning() as [VerifiedRow]
        : await db.insert(V).values({ projectId, ...values, createdAt: now }).returning() as [VerifiedRow];
    } catch (e) {
      // Two projects saving the same slug at once: the unique index decides.
      if (/verified_pages_slug|unique/i.test(String((e as { cause?: unknown })?.cause ?? e))) throw new V2Error(409, "resource_already_exists", "Another project uses this slug. Pick another one.", "slug");
      throw e;
    }
    return row;
  };

  r.post(`${P}/verified_metrics`, scope("project_configuration:projects:read_write"), async (c) => c.json(pageOut(c, await save(c, await body(c, VerifiedIn)))));
  r.post(`${P}/verified_metrics/actions/publish`, scope("project_configuration:projects:read_write"), async (c) => c.json(pageOut(c, await save(c, await body(c, VerifiedIn), "published"))));
  // The "Line charts" preview: the 12 monthly points the page would draw for each metric (production).
  r.get(`${P}/verified_metrics/monthly_history`, scope("project_configuration:projects:read"), async (c) => {
    const metrics = await monthlyHistories(db, c.get("projectId"), deps.now(), [...HISTORY_METRICS], LINE_MONTHS, "production");
    return c.json({ object: "verified_metrics_monthly_history", months: LINE_MONTHS, metrics });
  });

  r.put(`${P}/verified_metrics/domain`, scope("project_configuration:projects:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, DomainIn);
    const domain = b.custom_domain ? b.custom_domain.replace(/\.$/, "") : null;
    if (domain) {
      if (!DOMAIN.test(domain)) throw paramError("custom_domain must be a domain such as metrics.yourapp.com.", "custom_domain");
      const own = [deps.apiUrl, deps.publicUrl, deps.payUrl].filter(Boolean).map((u) => { try { return new URL(u!).hostname; } catch { return ""; } });
      if (own.includes(domain) || /(^|\.)revenuedot\.app$/.test(domain)) throw paramError("Use a domain you own, such as metrics.yourapp.com.", "custom_domain");
      const taken = await usedElsewhere(domain, projectId);
      if (taken) throw new V2Error(409, "resource_already_exists", taken, "custom_domain");
    }
    const cur = (await pageOf(c)) ?? await save(c, {});
    if ((cur.customDomain ?? null) === domain) return c.json(pageOut(c, cur));
    await dropHostname(cur);
    forgetVerifiedHost(cur.customDomain);
    const [row] = await db.update(V).set({
      customDomain: domain, domainToken: domain ? newId("", 24) : null, domainStatus: domain ? "pending" : "none", domainVerifiedAt: null,
      domainCheckedAt: null, domainError: null, domainHostnameId: null, domainSslStatus: null, updatedAt: deps.now(),
    }).where(eq(V.projectId, projectId)).returning();
    return c.json(pageOut(c, row!));
  });

  r.post(`${P}/verified_metrics/domain/actions/verify`, scope("project_configuration:projects:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const cur = await pageOf(c);
    if (!cur?.customDomain || !cur.domainToken) throw paramError("Set a custom domain first.", "custom_domain");
    const now = deps.now();
    if (!(await hit(db, `verified-domain-verify:${projectId}`, 6, 60_000, now))) throw new V2Error(429, "rate_limit_error", "Wait a minute before checking again.", undefined, true);
    const fetchFn = deps.fetch ?? fetch;
    const v = await verifyDomain(fetchFn, { customDomain: cur.customDomain, verificationToken: cur.domainToken }, target(c));
    const taken = v.ok ? await usedElsewhere(cur.customDomain, projectId) : null;
    const ok = v.ok && !taken;
    const set: Partial<typeof V.$inferInsert> = { domainStatus: ok ? "verified" : "failed", domainVerifiedAt: ok ? cur.domainVerifiedAt ?? now : null, domainCheckedAt: now, domainError: taken ?? v.error, updatedAt: now };
    // A domain that no longer proves itself loses its hostname, so its traffic stops reaching this server.
    if (!ok && cur.domainHostnameId) { await dropHostname(cur); Object.assign(set, { domainHostnameId: null, domainSslStatus: null }); }
    // The claim is saved before any certificate is requested: the unique index on verified domains decides a race, and
    // the losing project never touches the winner's hostname.
    let row: VerifiedRow | undefined;
    try {
      [row] = await db.update(V).set(set).where(eq(V.projectId, projectId)).returning();
    } catch (e) {
      if (!ok || !/unique|duplicate|23505/i.test(String((e as { cause?: unknown })?.cause ?? e))) throw e;
      [row] = await db.update(V).set({ ...set, domainStatus: "failed", domainVerifiedAt: null, domainHostnameId: null, domainSslStatus: null, domainError: "This domain is used by another project's verified page." }).where(eq(V.projectId, projectId)).returning();
    }
    // The certificate: Cloudflare for SaaS adds the hostname once DNS proves the domain, then reports its status.
    if (row?.domainStatus === "verified" && deps.cloudflareSaas) {
      const cfg = deps.cloudflareSaas;
      let cert: Partial<typeof V.$inferInsert>;
      try {
        let h;
        try {
          h = cur.domainHostnameId ? await getCustomHostname(fetchFn, cfg, cur.domainHostnameId) : await ensureCustomHostname(fetchFn, cfg, cur.customDomain);
        } catch (e) {
          // Removed in Cloudflare since: add it again.
          if (!(e instanceof CloudflareSaasError && e.status === 404)) throw e;
          h = await ensureCustomHostname(fetchFn, cfg, cur.customDomain);
        }
        cert = { domainHostnameId: h.id, domainSslStatus: h.sslStatus ?? h.status, domainError: h.error };
      } catch (e) {
        cert = { domainError: e instanceof CloudflareSaasError ? `The certificate could not be requested: ${e.message}` : "The certificate could not be requested. Try again in a minute." };
        if (!(e instanceof CloudflareSaasError)) console.warn("Cloudflare custom hostname failed", e);
      }
      [row] = await db.update(V).set(cert).where(eq(V.projectId, projectId)).returning();
    }
    forgetVerifiedHost(cur.customDomain);
    return c.json({ ...pageOut(c, row!), found: { cname: v.cname, txt: v.txt } });
  });

  r.post(`${P}/verified_metrics/actions/unpublish`, scope("project_configuration:projects:read_write"), async (c) => {
    const cur = await pageOf(c);
    if (!cur || cur.status !== "published") throw new V2Error(422, "unprocessable_entity_error", "The page is not published.");
    return c.json(pageOut(c, await save(c, {}, "inactive")));
  });
}

