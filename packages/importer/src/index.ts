// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the programmatic API of the importer (the `revenuedot` CLI is built on it).
// Docs: https://revenuedot.app/docs/migrate
export { runImport, formatReport, type ImportOptions, type ImportReport } from "./run.js";
export { verifyImport, type VerifyReport, type Mismatch } from "./verify.js";
export { buildPlan, formatPlan, type PlanStep } from "./plan.js";
export { toImportCustomer, parseTokenCsv, type ImportCustomer, type ImportSubscription, type ImportPurchase, type RcCustomerBundle, type TokenBook } from "./convert.js";
export { RevenueCatClient } from "./revenuecat.js";
export { RevenueDotClient } from "./revenuedot.js";
export { requestJson, HttpError, TimeoutError, type HttpOptions } from "./http.js";
export { main } from "./cli.js";
export { runMove, newMoveState, formatPlan as formatMovePlan, formatVerify as formatMoveVerify, formatFinish, type MoveState, type MoveSource, type MoveTarget, type Manifest } from "./move/core.js";
export { HttpSource, HttpTarget, ArchiveSource, exportArchive } from "./move/clients.js";
