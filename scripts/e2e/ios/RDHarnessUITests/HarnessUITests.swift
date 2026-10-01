// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: drives the harness app on the iOS simulator: configure, getCustomerInfo, getOfferings, a Test Store purchase
// through the SDK's own purchase alert after attribution, logIn, then sync, virtual currencies, web purchase redemption,
// reward verification and the Customer Center fetch. run.ts passes the server and key as TEST_RUNNER_RD_* variables and
// checks the server's state afterwards. Docs: https://revenuedot.app/docs/sdks/ios
import XCTest

final class HarnessUITests: XCTestCase {
    func testSdkAgainstRevenueDot() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        let app = XCUIApplication()
        for k in ["RD_SERVER_URL", "RD_API_KEY", "RD_LOGIN_ID"] { app.launchEnvironment[k] = env[k] }
        // Screenshots for the run report (the simulator shares the Mac's file system).
        func shot(_ name: String) {
            let png = XCUIScreen.main.screenshot().pngRepresentation
            add(XCTAttachment(data: png, uniformTypeIdentifier: "public.png"))
            if let dir = env["RD_SHOT_DIR"] { try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")) }
        }
        app.launch()

        let status = app.staticTexts["status"]
        func waitStatus(_ text: String, _ timeout: TimeInterval = 30) {
            let ok = NSPredicate(format: "label == %@", text)
            let found = expectation(for: ok, evaluatedWith: status)
            let result = XCTWaiter().wait(for: [found], timeout: timeout)
            XCTAssertEqual(result, .completed, "status is '\(status.label)', expected '\(text)'")
        }

        // configure happened at launch; the SDK made an anonymous id.
        XCTAssertTrue(app.staticTexts["appUserID"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["appUserID"].label.hasPrefix("$RCAnonymousID:"), app.staticTexts["appUserID"].label)

        app.buttons["customerInfoButton"].tap()
        waitStatus("customerInfo: ok")
        XCTAssertEqual(app.staticTexts["entitlement"].label, "pro: inactive")

        app.buttons["offeringsButton"].tap()
        waitStatus("offerings: ok")
        XCTAssertTrue(app.staticTexts["packages"].label.contains("$rc_monthly=pro_monthly"), app.staticTexts["packages"].label)

        // Attribution on the anonymous user, before the purchase, so the purchase's webhook carries it; logIn below
        // carries it over to the new app user id.
        app.buttons["attributionButton"].tap()
        waitStatus("attribution: ok", 30)

        // The SDK's Test Store shows its own purchase alert; tap its success action.
        app.buttons["buy-$rc_monthly"].tap()
        let alert = app.alerts["Test Store Purchase"]
        XCTAssertTrue(alert.waitForExistence(timeout: 15), "the Test Store purchase alert did not appear")
        shot("ios-1-test-store-alert")
        alert.buttons["Test valid purchase"].tap()
        waitStatus("purchase: ok", 45)
        XCTAssertEqual(app.staticTexts["entitlement"].label, "pro: active (pro_monthly)")
        shot("ios-2-purchased")

        app.buttons["loginButton"].tap()
        waitStatus("logIn: ok")
        XCTAssertEqual(app.staticTexts["appUserID"].label, env["RD_LOGIN_ID"] ?? "harness_user")
        XCTAssertEqual(app.staticTexts["entitlement"].label, "pro: active (pro_monthly)")
        shot("ios-3-logged-in")

        // The List is lazy: scroll until the row exists.
        for _ in 0..<5 where !app.buttons["othersButton"].isHittable { app.swipeUp() }
        app.buttons["othersButton"].tap()
        waitStatus("others: ok", 60)
        XCTAssertEqual(app.staticTexts["extras"].label, "sync=ok vc=0 redeem=invalidToken reward=failed cc=loaded")
        shot("ios-4-other-calls")

        // The paywall made from the RevenueDot gallery template "Annual first" renders in RevenueCatUI: headline, benefit
        // rows with icons, both plans, the purchase button and the restore link.
        let has = { (text: String) in app.descendants(matching: .any).containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch }
        for _ in 0..<5 where !app.buttons["paywallButton"].isHittable { app.swipeUp() }
        app.buttons["paywallButton"].tap()
        XCTAssertTrue(app.staticTexts["Unlock Harness"].waitForExistence(timeout: 30), "template paywall headline")
        shot("ios-5-paywall")
        XCTAssertTrue(has("Unlimited access to every feature").exists, "template paywall benefit")
        // The seeded offering has weekly, monthly and yearly: the template shows yearly first, then weekly.
        XCTAssertTrue(has("Yearly").exists, "template paywall yearly plan")
        XCTAssertTrue(has("Weekly").exists, "template paywall second plan")
        XCTAssertTrue(has("Continue").exists || has("Start free trial").exists, "template paywall purchase button")
        XCTAssertTrue(has("Restore").exists, "template paywall restore button")
        app.swipeDown(velocity: .fast)
        XCTAssertTrue(app.buttons["editorPaywallButton"].waitForExistence(timeout: 10))

        // The paywall built with the editor's operations on the "editor" offering: timeline, tabs, carousel and countdown.
        for _ in 0..<5 where !app.buttons["editorPaywallButton"].isHittable { app.swipeUp() }
        app.buttons["editorPaywallButton"].tap()
        XCTAssertTrue(app.staticTexts["Built in the editor"].waitForExistence(timeout: 30), "editor paywall headline")
        shot("ios-6-editor-paywall")
        XCTAssertTrue(has("Full access starts now").exists, "editor paywall timeline")
        XCTAssertTrue(has("Plus").exists, "editor paywall tabs")
        XCTAssertTrue(has("Page 1").exists, "editor paywall carousel")
        XCTAssertTrue(has("Ends in").exists, "editor paywall countdown")
    }
}
