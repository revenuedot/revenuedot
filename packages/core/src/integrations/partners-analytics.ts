import type { PartnerDef } from "./common.js";
import { MPARTICLE } from "./mparticle.js";
import { STATSIG } from "./statsig.js";
import { SUPERWALL } from "./superwall.js";
import { TELEMETRYDECK } from "./telemetrydeck.js";

/** Batch D analytics partners (prd/integrations/PRD.md, "Batch D partners"). */
export const ANALYTICS_PARTNERS: PartnerDef[] = [MPARTICLE, STATSIG, SUPERWALL, TELEMETRYDECK];
