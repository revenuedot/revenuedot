#!/usr/bin/env node
// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the `revenuedot` executable; everything else lives in cli.ts so tests can call it.
// Docs: https://revenuedot.app/docs/migrate
import { main } from "./cli.js";

main(process.argv.slice(2)).then((code) => process.exit(code));
