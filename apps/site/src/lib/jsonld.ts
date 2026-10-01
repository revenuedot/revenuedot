import { SITE, type Crumb, type Faq } from "../site";
import { PLANS } from "./pricing";

const ORG_ID = `${SITE.url}/#organization`;
const APP_ID = `${SITE.url}/#software`;

export function organization() {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: SITE.name,
    url: SITE.url,
    logo: { "@type": "ImageObject", url: `${SITE.url}/android-chrome-512.png`, width: 512, height: 512 },
    sameAs: [SITE.org, SITE.github],
    contactPoint: [
      { "@type": "ContactPoint", contactType: "customer support", email: SITE.email.hello },
      { "@type": "ContactPoint", contactType: "security", email: SITE.email.security },
    ],
  };
}

export function website() {
  return { "@type": "WebSite", "@id": `${SITE.url}/#website`, name: SITE.name, url: SITE.url, publisher: { "@id": ORG_ID } };
}

/** The product, with the plans that exist today as offers. Paid cloud plans are "coming", so they are left out. */
export function softwareApplication() {
  return {
    "@type": "SoftwareApplication",
    "@id": APP_ID,
    name: SITE.name,
    url: SITE.url,
    description: SITE.description,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web (RevenueDot Cloud); self-host with Docker",
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    isAccessibleForFree: true,
    publisher: { "@id": ORG_ID },
    sameAs: [SITE.github],
    offers: PLANS.filter((p) => p.available).map((p) => ({
      "@type": "Offer",
      name: p.name,
      price: "0",
      priceCurrency: "USD",
      description: p.summary,
      url: p.id === "cloud-free" ? SITE.signup : `${SITE.url}/pricing`,
    })),
  };
}

export function breadcrumbList(crumbs: Crumb[]) {
  const all = [{ name: "Home", path: "/" }, ...crumbs];
  return {
    "@type": "BreadcrumbList",
    itemListElement: all.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: new URL(c.path, SITE.url).href })),
  };
}

export function faqPage(faq: Faq[]) {
  return {
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
}

type ArticleInput = { title: string; description: string; path: string; modified?: string; published?: string; section?: string };

/** A docs page: TechArticle, published by RevenueDot, with the page as its main entity. */
export function techArticle(a: ArticleInput) {
  const url = new URL(a.path, SITE.url).href;
  return {
    "@type": "TechArticle",
    "@id": `${url}#article`,
    headline: a.title,
    description: a.description,
    url,
    mainEntityOfPage: url,
    inLanguage: "en",
    ...(a.section ? { articleSection: a.section } : {}),
    ...(a.modified ? { dateModified: a.modified } : {}),
    author: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    image: new URL(SITE.ogImage, SITE.url).href,
    license: "https://creativecommons.org/licenses/by/4.0/",
    isPartOf: { "@type": "WebSite", "@id": `${SITE.url}/#website`, name: SITE.name, url: SITE.url },
  };
}

/** A blog post. */
export function blogPosting(a: ArticleInput & { author?: string }) {
  const url = new URL(a.path, SITE.url).href;
  return {
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    headline: a.title,
    description: a.description,
    url,
    mainEntityOfPage: url,
    inLanguage: "en",
    ...(a.published ? { datePublished: a.published } : {}),
    ...(a.modified || a.published ? { dateModified: a.modified ?? a.published } : {}),
    author: a.author && a.author !== "RevenueDot team" ? { "@type": "Person", name: a.author } : { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    image: new URL(SITE.ogImage, SITE.url).href,
  };
}
