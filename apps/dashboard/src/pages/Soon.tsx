import { Shell } from "../components/Shell";

/** Areas planned for later tiers keep their place in the navigation so RevenueCat users find everything where they expect it. */
export function Soon({ title, what }: { title: string; what: string }) {
  return (
    <Shell title={title}>
      <div className="page">
        <div className="head"><div><h1>{title}</h1><p>{what}</p></div></div>
        <div className="empty"><h3>Coming in a later release</h3><p>{what} Track progress in the public roadmap.</p>
          <a className="btn btn-line" href="https://github.com/revenuedot/revenuedot/blob/main/prd/SCOPE.md" target="_blank" rel="noreferrer">View roadmap</a></div>
      </div>
    </Shell>
  );
}
