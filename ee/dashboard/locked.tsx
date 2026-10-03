// RevenueDot Enterprise (ee/LICENSE). What a locked feature shows instead of hiding: what it does and the plan that has
// it ("Part of Cloud Standard. Upgrade in Billing" or "Part of Enterprise. Contact sales"). Spec: prd/enterprise/PRD.md §2a.
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
  data_location: "Set where each organization's and project's data is stored.",
  audit_retention: "Keep audit logs from 30 days to 10 years, or forever. Cloud Free and Cloud Standard keep them 90 days.",
  compliance_exports: "Download signed CSV or JSON files of the audit log and an access review for your auditors.",
};

/** "Part of Cloud Standard. Upgrade in Billing" / "Part of Enterprise. Contact sales". */
export function LockNote({ plan }: { plan: string }) {
  return plan === "standard"
    ? <>Part of Cloud Standard. <Link to="/account/billing" style={{ textDecoration: "underline" }}>Upgrade in Billing</Link></>
    : <>Part of Enterprise. <a href={CONTACT_SALES} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Contact sales</a></>;
}

/** The panel a locked tab shows: what the feature does, which plan has it, and the one action that unlocks it. */
export function LockedPanel({ lock }: { lock: Locked }) {
  const standard = lock.plan === "standard";
  return (
    <section className="panel" data-locked={lock.feature}>
      <div className="ph"><b className="hrow"><Icon name="lock" />{FEATURE_LABEL[lock.feature] ?? lock.feature}</b><Tag tone="gold">{standard ? "Cloud Standard" : "Enterprise"}</Tag></div>
      <div className="pb stack">
        <p className="section-sub">{FEATURE_TEXT[lock.feature]}</p>
        <p><b>{standard ? "Part of Cloud Standard." : "Part of Enterprise."}</b> {standard
          ? "Cloud Standard costs 0.5% of tracked revenue above $10,000 a month, at most $999 a month, so below $10,000 it still costs $0."
          : "Enterprise is priced for your company, from $50,000 a year, and adds SCIM, long audit retention, compliance exports, an uptime SLA and a support promise."}</p>
        <div>{standard
          ? <Link className="btn btn-dark" to="/account/billing">Upgrade in Billing</Link>
          : <a className="btn btn-dark" href={CONTACT_SALES} target="_blank" rel="noreferrer">Contact sales</a>}</div>
      </div>
    </section>
  );
}
