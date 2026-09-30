// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: drives the harness app on the Android emulator: configure, getCustomerInfo, getOfferings, a Test Store
// purchase through the SDK's own purchase dialog, and logIn. run.ts passes the server and key as instrumentation
// arguments and checks the server's state afterwards. Docs: https://revenuedot.app/docs/sdks/android
package app.revenuedot.harness

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.File
import java.util.regex.Pattern
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HarnessTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val args = InstrumentationRegistry.getArguments()

    private fun find(desc: String, timeout: Long = 10_000): UiObject2 {
        val found: UiObject2? = device.wait(Until.findObject(By.desc(desc)), timeout)
        assertNotNull("'$desc' did not appear", found)
        return found!!
    }

    private fun waitStatus(text: String, timeout: Long = 30_000) {
        device.wait(Until.hasObject(By.desc("status").text(text)), timeout)
        assertEquals(text, find("status").text)
    }

    // Screenshots for the run report, pulled by run.ts from the app's external files directory.
    private fun shot(name: String) {
        val dir = instrumentation.targetContext.getExternalFilesDir(null) ?: return
        device.takeScreenshot(File(dir, "$name.png"))
    }

    @Test
    fun sdkAgainstRevenueDot() {
        val ctx = instrumentation.targetContext
        val loginId = args.getString("RD_LOGIN_ID") ?: "harness_user"
        ctx.startActivity(Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            for (k in listOf("RD_SERVER_URL", "RD_API_KEY", "RD_LOGIN_ID")) putExtra(k, args.getString(k))
        })

        // configure happened at launch; the SDK made an anonymous id.
        val anon = find("appUserID", 20_000).text
        assertTrue(anon, anon.startsWith("\$RCAnonymousID:"))

        find("customerInfoButton").click()
        waitStatus("customerInfo: ok")
        assertEquals("pro: inactive", find("entitlement").text)

        find("offeringsButton").click()
        waitStatus("offerings: ok")
        val packages = find("packages").text
        assertTrue(packages, packages.contains("\$rc_monthly=pro_monthly"))

        // The SDK's Test Store shows its own purchase dialog; tap its success action.
        find("buy-\$rc_monthly").click()
        assertNotNull("the Test Store purchase dialog did not appear", device.wait(Until.findObject(By.text("Test Store Purchase")), 15_000))
        shot("android-1-test-store-dialog")
        val valid = device.findObject(By.text(Pattern.compile("Test valid purchase", Pattern.CASE_INSENSITIVE)))
        assertNotNull("no 'Test valid purchase' button", valid)
        valid.click()
        waitStatus("purchase: ok", 45_000)
        assertEquals("pro: active (pro_monthly)", find("entitlement").text)
        shot("android-2-purchased")

        find("loginButton").click()
        waitStatus("logIn: ok")
        assertEquals(loginId, find("appUserID").text)
        assertEquals("pro: active (pro_monthly)", find("entitlement").text)
        shot("android-3-logged-in")
    }
}
