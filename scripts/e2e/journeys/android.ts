// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (b), the unmodified RevenueCat Android SDK on a device against the journey server (lib/device.ts).
// Heavy: run it on its own (pnpm tsx scripts/e2e/journeys/run.ts android), one device journey at a time.
import type { Journey } from "./run.ts";
import { deviceJourney } from "./lib/device.ts";

const journey: Journey = {
  name: "android", title: "End user buys with the unmodified Android SDK (Test Store) against the journey server", heavy: true, needsDashboard: true,
  run: (ctx) => deviceJourney(ctx, "android"),
};
export default journey;
