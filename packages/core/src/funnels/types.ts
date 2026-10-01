/**
 * Web-to-app funnels (prd/web-billing/PRD.md §5): a theme and an ordered list of steps. The builder edits a draft; visitors
 * see the published copy, rendered to HTML by render.ts on the server and in the builder's live preview alike.
 */

export type FunnelStepType = "question" | "info" | "email" | "paywall" | "success";

export interface FunnelOption {
  id: string;
  label: string;
  /** Jump to this step when the option is chosen (a path). Unset: the next step. */
  next?: string | null;
}

interface StepBase { id: string; type: FunnelStepType; title: string; subtitle?: string | null }

export interface QuestionStep extends StepBase {
  type: "question";
  options: FunnelOption[];
  multiple?: boolean;
  /** Saved as this customer attribute (answers joined with ", "). */
  attribute?: string | null;
  button_label?: string | null;
}
export interface InfoStep extends StepBase { type: "info"; body?: string | null; image_url?: string | null; button_label?: string | null }
export interface EmailStep extends StepBase { type: "email"; placeholder?: string | null; required?: boolean; button_label?: string | null }
export interface PaywallStep extends StepBase {
  type: "paywall";
  /** Offering lookup key; null: the project's current offering. */
  offering?: string | null;
  features?: string[];
  /** Package lookup key selected first. */
  highlight_package?: string | null;
  /** A web discount id applied without a code. */
  discount_id?: string | null;
  /** Show the discount code field. */
  allow_codes?: boolean;
  button_label?: string | null;
}
export interface SuccessStep extends StepBase { type: "success"; body?: string | null; show_redemption?: boolean }

export type FunnelStep = QuestionStep | InfoStep | EmailStep | PaywallStep | SuccessStep;

export interface FunnelTheme {
  background: string;
  text: string;
  /** Buttons, the progress bar, the selected option. */
  accent: string;
  button_text: string;
  /** 0 (square, the RevenueDot default) to 24. */
  corner_radius: number;
}

export interface FunnelDoc { theme: FunnelTheme; steps: FunnelStep[] }

export const DEFAULT_THEME: FunnelTheme = { background: "#FFFFFF", text: "#0A0A0A", accent: "#0A0A0A", button_text: "#FFFFFF", corner_radius: 0 };

/** Colour presets offered in the builder and the web config (the first is RevenueDot's own ink and white). */
export const THEME_PRESETS: { name: string; theme: FunnelTheme }[] = [
  { name: "Ink", theme: DEFAULT_THEME },
  { name: "Night", theme: { background: "#0A0A0A", text: "#FAFAFA", accent: "#F7B500", button_text: "#0A0A0A", corner_radius: 0 } },
  { name: "Ocean", theme: { background: "#F4F8FB", text: "#0B2540", accent: "#2F6F9F", button_text: "#FFFFFF", corner_radius: 12 } },
  { name: "Forest", theme: { background: "#F6F8F2", text: "#1E2A12", accent: "#5F822B", button_text: "#FFFFFF", corner_radius: 12 } },
  { name: "Sunset", theme: { background: "#FFF8F3", text: "#2B1608", accent: "#C2410C", button_text: "#FFFFFF", corner_radius: 20 } },
];

/** A funnel to start from: a short quiz, an email step, the paywall and the success step. */
export function starterFunnel(): FunnelDoc {
  return {
    theme: { ...DEFAULT_THEME },
    steps: [
      { id: "goal", type: "question", title: "What do you want to get done?", subtitle: "Pick one. We will set up your plan around it.", attribute: "goal",
        options: [{ id: "focus", label: "Focus on deep work" }, { id: "habits", label: "Build better habits" }, { id: "sleep", label: "Sleep better" }] },
      { id: "plan", type: "info", title: "Your plan is ready", body: "People with the same goal kept going 3 times longer with a daily plan.", button_label: "Continue" },
      { id: "email", type: "email", title: "Where should we send your plan?", subtitle: "We will email your plan and your receipt.", placeholder: "you@example.com", required: true },
      { id: "paywall", type: "paywall", title: "Unlock your full plan", subtitle: "Cancel anytime.", features: ["Your personal daily plan", "Reminders that adapt to you", "Progress on every device"], allow_codes: true, button_label: "Continue" },
      { id: "success", type: "success", title: "You are in", body: "Open the app to start your plan. Your purchase is waiting there.", show_redemption: true },
    ],
  };
}

/** The two-step funnel a purchase link shows: the offering's packages, then the success page. */
export function purchaseLinkFunnel(o: { title: string; offering: string; allowCodes: boolean }): FunnelDoc {
  return {
    theme: { ...DEFAULT_THEME },
    steps: [
      { id: "paywall", type: "paywall", title: o.title, offering: o.offering, allow_codes: o.allowCodes, button_label: "Continue to payment" },
      { id: "success", type: "success", title: "Thank you for your purchase", body: "Open the app to start using it. Your purchase is waiting there.", show_redemption: true },
    ],
  };
}
