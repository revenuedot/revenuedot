/**
 * The audience condition builder, shared by Targeting (audiences), Refund Control (policy eligibility) and Customers
 * (filters). Rules are groups OR-ed together; the conditions inside a group are AND-ed (the server's `rulesMatch`).
 */
import { Icon } from "./icons";

export interface Condition { field: string; operator: string; value?: string }
export interface Rules { groups: { conditions: Condition[] }[] }
export type Groups = Condition[][];

export const FIELDS: { value: string; label: string; hint?: string }[] = [
  { value: "country", label: "Country", hint: "Two-letter code, e.g. US" }, { value: "platform", label: "Platform", hint: "ios, android, web" },
  { value: "customerId", label: "App user ID" }, { value: "appVersion", label: "App version", hint: "e.g. 2.4.0" }, { value: "sdkVersion", label: "SDK version" },
  { value: "locale", label: "Locale", hint: "e.g. en_US" },
  { value: "status", label: "Subscription status", hint: "active, trialing, expired, never" }, { value: "activeEntitlements", label: "Active entitlements", hint: "Lookup key, e.g. pro" },
  { value: "hasActiveEntitlement", label: "Has an active entitlement", hint: "true or false" }, { value: "totalSpent", label: "Total spent (USD)" },
  { value: "firstSeenAt", label: "First seen", hint: "within: 7d; before/after: a date" }, { value: "lastSeenAt", label: "Last seen", hint: "within: 7d; before/after: a date" },
  { value: "firstPurchaseAt", label: "First purchase", hint: "within: 7d; before/after: a date" }, { value: "lastRenewalAt", label: "Last renewal", hint: "within: 24h; before/after: a date" },
  { value: "latestProduct", label: "Latest product", hint: "Store product id" }, { value: "latestStore", label: "Latest store", hint: "app_store, play_store, stripe …" },
  { value: "isCurrentlyTrialing", label: "In a trial", hint: "true or false" },
  { value: "email", label: "Email" }, { value: "campaign", label: "Campaign" }, { value: "mediaSource", label: "Media source" },
];
export const OPS: { value: string; label: string }[] = [
  { value: "is", label: "is" }, { value: "isNot", label: "is not" }, { value: "isAnyOf", label: "is any of" }, { value: "isNotAnyOf", label: "is none of" },
  { value: "contains", label: "contains" }, { value: "greaterThan", label: "greater than" }, { value: "lessThan", label: "less than" },
  { value: "within", label: "within the last" }, { value: "before", label: "before" }, { value: "after", label: "after" }, { value: "isEmpty", label: "is empty" }, { value: "isNotEmpty", label: "is set" },
];
const NO_VALUE = ["isEmpty", "isNotEmpty"];

export const fieldLabel = (f: string) => (f.startsWith("customAttribute:") ? `Attribute ${f.slice(16)}` : FIELDS.find((x) => x.value === f)?.label ?? f);
export const opLabel = (o: string) => OPS.find((x) => x.value === o)?.label ?? o;
export const describeRules = (r: Rules | null | undefined) =>
  (r?.groups ?? []).filter((g) => g.conditions.length).map((g) => g.conditions.map((c) => `${fieldLabel(c.field)} ${opLabel(c.operator)}${c.value ? ` ${c.value}` : ""}`).join(" and ")).join(" — or — ") || "Everyone";

/** The editor's groups as the API's rules (no value for "is empty" and "is set"). */
export const toRules = (groups: Groups): Rules => ({
  groups: groups.filter((g) => g.length).map((conditions) => ({ conditions: conditions.map((c) => ({ field: c.field, operator: c.operator, ...(NO_VALUE.includes(c.operator) ? {} : { value: c.value ?? "" }) })) })),
});
export const fromRules = (r: Rules | null | undefined): Groups => (r?.groups ?? []).map((g) => g.conditions.map((c) => ({ ...c })));
/** Conditions that still need a value, so the page can say so before the API does. */
export const incomplete = (groups: Groups) => groups.some((g) => g.some((c) => (c.field === "customAttribute:" || (!NO_VALUE.includes(c.operator) && !(c.value ?? "").trim()))));

const blank = (): Condition => ({ field: "country", operator: "is", value: "" });

/**
 * Groups of conditions. `labelPrefix` keeps the accessible names unique when a page shows several builders
 * ("Policy 2 field 1.1"); without it the names are "Field 1.1", "Operator 1.1", "Value 1.1".
 */
export function ConditionBuilder({ value, onChange, labelPrefix = "", emptyText }: { value: Groups; onChange: (g: Groups) => void; labelPrefix?: string; emptyText?: string }) {
  const L = (s: string) => (labelPrefix ? `${labelPrefix} ${s.toLowerCase()}` : s);
  const setCond = (gi: number, ci: number, patch: Partial<Condition>) => onChange(value.map((g, i) => (i === gi ? g.map((c, j) => (j === ci ? { ...c, ...patch } : c)) : g)));
  return (
    <div className="cond">
      {!value.length && emptyText && <p className="cond-empty">{emptyText}</p>}
      {value.map((g, gi) => (
        <fieldset key={gi} className="cond-g">
          <legend>{gi === 0 ? "Customers where all of these are true" : "Or where all of these are true"}</legend>
          {g.map((c, ci) => {
            const n = `${gi + 1}.${ci + 1}`;
            return (
              <div key={ci} className="cond-r">
                <select aria-label={L(`Field ${n}`)} className="select" value={c.field.startsWith("customAttribute:") ? "custom" : c.field} onChange={(e) => setCond(gi, ci, { field: e.target.value === "custom" ? "customAttribute:" : e.target.value })}>
                  {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}<option value="custom">Custom attribute…</option>
                </select>
                {c.field.startsWith("customAttribute:") && <input aria-label={L(`Attribute ${n}`)} className="input mono cond-key" placeholder="key" value={c.field.slice(16)} onChange={(e) => setCond(gi, ci, { field: `customAttribute:${e.target.value}` })} />}
                <select aria-label={L(`Operator ${n}`)} className="select" value={c.operator} onChange={(e) => setCond(gi, ci, { operator: e.target.value })}>{OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                {!NO_VALUE.includes(c.operator) && <input aria-label={L(`Value ${n}`)} className="input cond-v" placeholder={FIELDS.find((f) => f.value === c.field)?.hint ?? "value"} value={c.value ?? ""} onChange={(e) => setCond(gi, ci, { value: e.target.value })} />}
                <button type="button" className="ib" aria-label={L(`Remove condition ${n}`)} onClick={() => onChange(value.map((x, i) => (i === gi ? x.filter((_, j) => j !== ci) : x)).filter((x) => x.length))}><Icon name="trash" /></button>
              </div>
            );
          })}
          <button type="button" className="btn btn-ghost" aria-label={labelPrefix ? L(`And (group ${gi + 1})`) : undefined} onClick={() => onChange(value.map((x, i) => (i === gi ? [...x, blank()] : x)))}><Icon name="plus" />And</button>
        </fieldset>
      ))}
      <div>
        <button type="button" className="btn btn-line" aria-label={labelPrefix ? L(value.length ? "Or another group" : "Add a condition") : undefined} onClick={() => onChange([...value, [blank()]])}>
          <Icon name="plus" />{value.length ? "Or another group" : "Add a condition"}
        </button>
      </div>
    </div>
  );
}
