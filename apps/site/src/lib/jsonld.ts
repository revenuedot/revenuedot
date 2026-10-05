import { SITE, type Crumb, type Faq } from "../site";
import { CARD_RULE, ENTERPRISE_PRICE, PLANS, PRICE_LINE } from "./pricing";

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

/** The product, with its two plans as offers: Pro (price 0, usage-priced above $10,000 a month) and Enterprise (from $50,000 a year). */
export function softwareApplication() {
  const [pro, ent] = [PLANS.find((p) => p.id === "pro")!, PLANS.find((p) => p.id === "enterprise")!];
  return {
    "@type": "SoftwareApplication",
    "@id": APP_ID,
    name: SITE.name,
    url: SITE.url,
    description: SITE.description,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web (RevenueDot Cloud)",
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    isAccessibleForFree: true,
    publisher: { "@id": ORG_ID },
    sameAs: [SITE.github],
    offers: [
      {
        "@type": "Offer",
        name: `RevenueDot ${pro.name}`,
        price: "0",
        priceCurrency: "USD",
        description: `${PRICE_LINE} ${CARD_RULE}`,
        url: SITE.signup,
      },
      {
        "@type": "Offer",
        name: `RevenueDot ${ent.name}`,
        price: "50000",
        priceCurrency: "USD",
        priceSpecification: { "@type": "UnitPriceSpecification", minPrice: 50000, priceCurrency: "USD", unitText: "YEAR" },
        description: `${ENTERPRISE_PRICE}. ${ent.summary}`,
        url: `${SITE.url}/contact-sales`,
      },
    ],
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
export function blogPosting(a: ArticleInput & { author?: string; image?: string }) {
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
    image: new URL(a.image ?? SITE.ogImage, SITE.url).href,
  };
}

/** A how-to built from numbered steps on the page. */
export function howTo(name: string, description: string, steps: { name: string; text: string }[], path: string) {
  const url = new URL(path, SITE.url).href;
  return {
    "@type": "HowTo",
    "@id": `${url}#howto`,
    name,
    description,
    step: steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, name: s.name, text: s.text })),
  };
}

/** A hub page's list of child pages. */
export function itemList(name: string, items: { name: string; path: string }[]) {
  return {
    "@type": "ItemList",
    name,
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, url: new URL(it.path, SITE.url).href })),
  };
}

/** A marketing or reference page about one subject, published by RevenueDot. */
export function webPage(a: { title: string; description: string; path: string; image?: string; about?: string; modified?: string }) {
  const url = new URL(a.path, SITE.url).href;
  return {
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    name: a.title,
    description: a.description,
    url,
    inLanguage: "en",
    isPartOf: { "@id": `${SITE.url}/#website` },
    publisher: { "@id": `${SITE.url}/#organization` },
    ...(a.image ? { primaryImageOfPage: { "@type": "ImageObject", url: new URL(a.image, SITE.url).href, width: 1200, height: 630 } } : {}),
    ...(a.about ? { about: { "@type": "Thing", name: a.about } } : {}),
    ...(a.modified ? { dateModified: a.modified } : {}),
  };
}
