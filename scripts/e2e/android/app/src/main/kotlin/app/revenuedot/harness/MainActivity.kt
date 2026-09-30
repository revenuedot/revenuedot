// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the Android contract harness app. The unmodified RevenueCat Android SDK, pointed at a RevenueDot server
// with Purchases.proxyURL and a Test Store (test_) key from the launch intent, exposes each SDK call as a button that
// the UIAutomator test in androidTest drives. Docs: https://revenuedot.app/docs/sdks/android
package app.revenuedot.harness

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.revenuecat.purchases.CacheFetchPolicy
import com.revenuecat.purchases.CustomerInfo
import com.revenuecat.purchases.LogLevel
import com.revenuecat.purchases.Package
import com.revenuecat.purchases.PurchaseParams
import com.revenuecat.purchases.Purchases
import com.revenuecat.purchases.PurchasesConfiguration
import com.revenuecat.purchases.PurchasesError
import com.revenuecat.purchases.getCustomerInfoWith
import com.revenuecat.purchases.getOfferingsWith
import com.revenuecat.purchases.logInWith
import com.revenuecat.purchases.purchaseWith
import java.net.URL

class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var appUserID: TextView
    private lateinit var entitlement: TextView
    private lateinit var packagesText: TextView
    private lateinit var buyButtons: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val extras = intent.extras
        if (!Purchases.isConfigured) {
            Purchases.logLevel = LogLevel.DEBUG
            // The one line an app changes to move to RevenueDot (proxy mode), set before configure.
            Purchases.proxyURL = URL(extras?.getString("RD_SERVER_URL") ?: "http://10.0.2.2:8787")
            Purchases.configure(PurchasesConfiguration.Builder(this, extras?.getString("RD_API_KEY") ?: "test_missing").build())
        }

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 96, 32, 32) }
        fun label(desc: String, text: String) = TextView(this).also { it.contentDescription = desc; it.text = text; root.addView(it) }
        fun button(desc: String, text: String, onClick: () -> Unit) =
            Button(this).also { it.contentDescription = desc; it.text = text; it.setOnClickListener { onClick() }; root.addView(it) }

        status = label("status", "configured")
        appUserID = label("appUserID", Purchases.sharedInstance.appUserID)
        entitlement = label("entitlement", "pro: unknown")
        packagesText = label("packages", "")
        button("customerInfoButton", "getCustomerInfo") {
            step("customerInfo")
            Purchases.sharedInstance.getCustomerInfoWith(CacheFetchPolicy.FETCH_CURRENT, ::fail) { show(it); ok("customerInfo") }
        }
        button("offeringsButton", "getOfferings") {
            step("offerings")
            Purchases.sharedInstance.getOfferingsWith(::fail) { o ->
                val packages = o.current?.availablePackages.orEmpty()
                packagesText.text = packages.joinToString(", ") { "${it.identifier}=${it.product.id} ${it.product.price.formatted}" }
                buyButtons.removeAllViews()
                packages.forEach { p -> buyButtons.addView(Button(this).also { b -> b.contentDescription = "buy-${p.identifier}"; b.text = "purchase ${p.identifier}"; b.setOnClickListener { buy(p) } }) }
                if (packages.isEmpty()) status.text = "offerings: failed no current offering" else ok("offerings")
            }
        }
        buyButtons = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also { root.addView(it) }
        val loginField = EditText(this).apply { contentDescription = "loginField"; setText(extras?.getString("RD_LOGIN_ID") ?: "harness_user") }
        root.addView(loginField)
        button("loginButton", "logIn") {
            step("logIn")
            Purchases.sharedInstance.logInWith(loginField.text.toString(), ::fail) { info, _ -> show(info); ok("logIn") }
        }
        setContentView(ScrollView(this).apply { addView(root) })
    }

    private var current = ""
    private fun step(name: String) { current = name; status.text = "$name: running" }
    private fun ok(name: String) { status.text = "$name: ok" }
    private fun fail(e: PurchasesError) { status.text = "$current: failed ${e.code} ${e.message}" }

    private fun show(info: CustomerInfo) {
        appUserID.text = Purchases.sharedInstance.appUserID
        val pro = info.entitlements["pro"]
        entitlement.text = if (pro?.isActive == true) "pro: active (${pro.productIdentifier})" else "pro: inactive"
    }

    private fun buy(p: Package) {
        step("purchase")
        Purchases.sharedInstance.purchaseWith(
            PurchaseParams.Builder(this, p).build(),
            onError = { e, userCancelled -> status.text = if (userCancelled) "purchase: failed cancelled" else "purchase: failed ${e.code} ${e.message}" },
            onSuccess = { _, info -> show(info); ok("purchase") },
        )
    }
}
