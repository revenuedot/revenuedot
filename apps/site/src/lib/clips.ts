// Which pages show which dashboard clip (public/clips/<name>.mp4).
export const CLIPS: Record<string, { name: string; alt: string; caption: string }> = {
  "/features/paywalls": { name: "paywalls", alt: "Picking the trial timeline paywall template in RevenueDot, creating it, and editing its layers in the visual editor", caption: "Template to editor in a few clicks. Recorded in the RevenueDot dashboard with demo data." },
  "/features/funnels": { name: "funnels", alt: "Stepping through a web-to-app funnel in the RevenueDot funnel builder: a question, a plan page, an email step, the paywall and the success page", caption: "The funnel builder with its live phone preview. Recorded with demo data." },
  "/solutions/web-to-app": { name: "funnels", alt: "Stepping through a web-to-app funnel in the RevenueDot funnel builder", caption: "A web funnel from question to paywall. Recorded with demo data." },
  "/features/charts": { name: "charts", alt: "Clicking through the MRR, Revenue, Active Subscriptions, Trial Conversion Funnel, Subscription Status and MRR Movement charts in RevenueDot", caption: "Six of the 43 charts. Recorded in the RevenueDot dashboard with demo data." },
  "/charts": { name: "charts", alt: "Clicking through the MRR, Revenue, Active Subscriptions, Trial Conversion Funnel, Subscription Status and MRR Movement charts in RevenueDot", caption: "Six of the 43 charts. Recorded in the RevenueDot dashboard with demo data." },
  "/features/integrations": { name: "integrations", alt: "Browsing the RevenueDot integrations catalogue and opening the Amplitude integration settings", caption: "The integrations catalogue. Recorded with demo data." },
  "/integrations": { name: "integrations", alt: "Browsing the RevenueDot integrations catalogue and opening the Amplitude integration settings", caption: "The integrations catalogue in the dashboard. Recorded with demo data." },
};
