import type { PartnerDef } from "./common.js";
import { AIRBRIDGE } from "./airbridge.js";
import { APPSTACK } from "./appstack.js";
import { ASAPTY } from "./asapty.js";
import { BRANCH } from "./branch.js";
import { GOOGLE_TAG_MANAGER } from "./google-tag-manager.js";
import { KOCHAVA } from "./kochava.js";
import { SINGULAR } from "./singular.js";
import { SOLARENGINE } from "./solarengine.js";
import { SPLITMETRICS } from "./splitmetrics.js";
import { TENJIN } from "./tenjin.js";

/** Batch D attribution partners (prd/integrations/PRD.md, "Batch D partners"). Apple Search Ads is added elsewhere. */
export const ATTRIBUTION_PARTNERS: PartnerDef[] = [APPSTACK, ASAPTY, BRANCH, GOOGLE_TAG_MANAGER, KOCHAVA, AIRBRIDGE, SPLITMETRICS, SINGULAR, SOLARENGINE, TENJIN];
