// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// The Android contract harness: the unmodified RevenueCat Android SDK from Maven Central, driven against a RevenueDot
// server by a UIAutomator test. `run.ts` does everything (server, seed, emulator, test, checks).
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "RDHarness"
include(":app")
