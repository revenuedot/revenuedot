// Third-party YouTube videos a developer would find useful next to the pricing, migration, alternatives and feature
// pages. Data only: nothing embeds them yet. Each one was checked on its watch page on 2026-10-04 (length, views,
// publish date and channel size from the page itself); every video is under two years old, from a channel with a real
// following, and none makes claims about a vendor that it does not source. Views are rounded; re-check before quoting.
export type ThirdPartyVideoFit = "pricing" | "migrate" | "alternatives" | "features";

export interface ThirdPartyVideo {
  title: string;
  url: string;
  channel: string;
  /** Subscribers of the channel when checked, rounded. */
  channelSize: string;
  /** mm:ss or h:mm:ss. */
  length: string;
  /** Rounded view count when checked. */
  views: string;
  /** YYYY-MM-DD. */
  published: string;
  /** Why a developer on our pages would want it. */
  reason: string;
  /** The page it fits best. */
  fits: ThirdPartyVideoFit;
}

export const THIRD_PARTY_VIDEOS: ThirdPartyVideo[] = [
  {
    title: "WWDC25: Dive into App Store server APIs for In-App Purchase",
    url: "https://www.youtube.com/watch?v=Z1N4ar9nfR4",
    channel: "Apple Developer",
    channelSize: "about 330K subscribers",
    length: "22:47",
    views: "about 2,300",
    published: "2025-06-09",
    reason: "Apple's own walkthrough of the App Store Server API, Server Notifications v2 and the App Store Server Library: the server work a team takes on when it stops paying a hosted backend 1%.",
    fits: "migrate",
  },
  {
    title: "Build a SwiftUI Paywall: StoreKit 2 Subscriptions Tutorial (2026)",
    url: "https://www.youtube.com/watch?v=9QmnlxGHINU",
    channel: "Noah Does Coding",
    channelSize: "about 5.2K subscribers",
    length: "1:06:01",
    views: "about 1,600",
    published: "2026-04-08",
    reason: "A code-along with no third-party SDK: product fetch, purchase flow, transaction verification, restore, a local StoreKit configuration and sandbox testing, with a GitHub repo.",
    fits: "migrate",
  },
  {
    title: "How Attackers Can Hack Your In-App Purchases (+ How You Protect Them)",
    url: "https://www.youtube.com/watch?v=WHfmXHqEmnM",
    channel: "Philipp Lackner",
    channelSize: "about 260K subscribers",
    length: "31:55",
    views: "about 9,700",
    published: "2026-04-08",
    reason: "Shows two real attacks on client-side entitlement checks and why purchases must be verified on a server, which is the job a backend such as RevenueDot does.",
    fits: "migrate",
  },
  {
    title: "WWDC26: What's new in Apple In-App Purchase",
    url: "https://www.youtube.com/watch?v=yTkVCs9OfBY",
    channel: "Apple Developer",
    channelSize: "about 330K subscribers",
    length: "13:26",
    views: "about 9,500",
    published: "2026-06-08",
    reason: "The newest official summary of StoreKit and In-App Purchase changes, so a reader of the feature pages sees what the platform itself now supports.",
    fits: "features",
  },
  {
    title: "How to understand Play's expanded billing options and lower fees",
    url: "https://www.youtube.com/watch?v=hcvvo6Sag0Q",
    channel: "Android Developers",
    channelSize: "about 1.43M subscribers",
    length: "2:10",
    views: "about 20,000",
    published: "2026-06-24",
    reason: "Google's two-minute explainer of the 2026 Play billing options and fee cuts; the store commission is the base that a backend's 1% sits on top of.",
    fits: "pricing",
  },
  {
    title: "Do You Really Need RevenueCat?",
    url: "https://www.youtube.com/watch?v=zbXBbXJ-Ltw",
    channel: "NoCode ProCode (Despia CEO)",
    channelSize: "about 9.4K subscribers",
    length: "21:20",
    views: "about 710",
    published: "2026-08-11",
    reason: "A declared no-sponsorship breakdown of what RevenueCat does under the hood, what you build yourself without it (StoreKit 2 vs Play Billing, receipt validation, entitlements) and the trade-off of a third party in the revenue path.",
    fits: "pricing",
  },
  {
    title: "StoreKit VS RevenuCat VS Adapty VS Qonversion",
    url: "https://www.youtube.com/watch?v=OpVzL6kBMn4",
    channel: "Aivars Meijers",
    channelSize: "about 47.7K subscribers",
    length: "20:21",
    views: "about 4,600",
    published: "2025-06-08",
    reason: "An indie iOS developer compares native StoreKit with RevenueCat, Adapty and Qonversion in one sitting, the shortlist the alternatives pages cover.",
    fits: "alternatives",
  },
  {
    title: "I made 4,000 app paywalls and learned this",
    url: "https://www.youtube.com/watch?v=lkwX_kc0NS8",
    channel: "Superwall",
    channelSize: "about 35K subscribers",
    length: "56:50",
    views: "about 28,800",
    published: "2026-02-08",
    reason: "Superwall's founder on what moved conversion across thousands of paywalls (design and packaging over copy, a plain Continue button, cancel-anytime copy), so a reader of the Superwall comparison sees what that product is for.",
    fits: "alternatives",
  },
  {
    title: "We've Tested 100s of Paywalls. Here's What Actually Converts.",
    url: "https://www.youtube.com/watch?v=vZXn_BSi5AE",
    channel: "App Masters",
    channelSize: "about 76.9K subscribers",
    length: "17:52",
    views: "about 10,200",
    published: "2026-08-18",
    reason: "A paywall A/B testing playbook (hard vs soft paywalls, trials, pricing, calls to action, social proof, onboarding placement) with case studies, which is what the experiments feature is for.",
    fits: "features",
  },
  {
    title: "Subscription App Growth Is Getting Brutal (RevenueCat Data Explained)",
    url: "https://www.youtube.com/watch?v=8Tk_EHQUeaY",
    channel: "App Masters",
    channelSize: "about 76.9K subscribers",
    length: "1:12:33",
    views: "about 1,900",
    published: "2026-03-14",
    reason: "Walks through the 2026 State of Subscription Apps benchmarks (retention, churn, trial-to-paid and hard-paywall conversion) that a developer can hold their own MRR and churn charts against.",
    fits: "features",
  },
];
