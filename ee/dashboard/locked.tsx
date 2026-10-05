// RevenueDot Enterprise (ee/LICENSE). What a locked feature shows instead of hiding: what it does and the plan that has
// it ("Part of Pro. Start Pro in Billing" or "Part of Enterprise. Contact sales"). Spec: prd/enterprise/PRD.md §2a.
import { Link } from "react-router-dom";
import { Icon } from "../../apps/dashboard/src/components/icons";
import { Tag } from "../../apps/dashboard/src/components/ui";
import type { Locked } from "./lib";

export const CONTACT_SALES = "https://revenuedot.app/contact-sales";

export const FEATURE_LABEL: Record<string, string> = {
  organizations: "Organizations", custom_roles: "Custom roles", sso: "Single sign-on", scim: "SCIM provisioning",
  data_location: "Data location", audit_retention: "Audit log retention", compliance_exports: "Compliance exports",
};

const FEATURE_TEXT: Record<string, string> = {
  organizations: "Group projects and people under one organization, with shared members, settings and an organization audit log.",
  custom_roles: "Build roles from exact API permissions, such as a support role that can refund but not edit the catalog.",
  sso: "Sign in with Okta, Microsoft Entra ID, Google Workspace or any SAML 2.0 or OpenID Connect provider, and require it for your email domain.",
  scim: "Let your identity provider create, update and deactivate people and groups, so leavers lose access the moment they are offboarded.",
  data_location: "Record and enforce where each organization's and project's data is stored. RevenueDot Cloud runs in the US today.",
  audit_retention: "Keep audit logs from 30 days to 10 years, or forever. Pro keeps them 90 days.",
  compliance_exports: "Download signed CSV or JSON files of the audit log and an access review for your auditors.",
};

/** "Part of Pro. Start Pro in Billing" / "Part of Enterprise. Contact sales". ("standard" is Pro's old name.) */
export function LockNote({ plan }: { plan: string }) {
  return plan === "pro" || plan === "standard"
    ? <>Part of Pro, which costs $0 until your apps make $10,000 a month. <Link to="/account/billing" style={{ textDecoration: "underline" }}>Start Pro in Billing</Link></>
    : <>Part of Enterprise. <a href={CONTACT_SALES} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Contact sales</a></>;
}

/** The panel a locked tab shows: what the feature does, which plan has it, and the one action that unlocks it. */
export function LockedPanel({ lock }: { lock: Locked }) {
  const pro = lock.plan === "pro" || (lock.plan as string) === "standard";
  return (
    <section className="panel" data-locked={lock.feature}>
      <div className="ph"><b className="hrow"><Icon name="lock" />{FEATURE_LABEL[lock.feature] ?? lock.feature}</b><Tag tone="gold">{pro ? "Pro" : "Enterprise"}</Tag></div>
      <div className="pb stack">
        <p className="section-sub">{FEATURE_TEXT[lock.feature]}</p>
        <p><b>{pro ? "Part of Pro." : "Part of Enterprise."}</b> {pro
          ? "Pro costs $0 until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month."
          : "Enterprise is priced for your company, from $50,000 a year, and adds SCIM, long audit retention, compliance exports, an uptime SLA and a support promise."}</p>
        <div>{pro
          ? <Link className="btn btn-dark" to="/account/billing">Start Pro in Billing</Link>
          : <a className="btn btn-dark" href={CONTACT_SALES} target="_blank" rel="noreferrer">Contact sales</a>}</div>
      </div>
    </section>
  );
}
