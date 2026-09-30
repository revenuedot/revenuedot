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
    operatingSystem: "Linux, macOS, Windows (Docker); iOS, Android and web clients",
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
      url: `${SITE.url}/pricing`,
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
