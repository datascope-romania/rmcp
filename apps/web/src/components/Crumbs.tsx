import { Link } from "react-router-dom";

export interface Crumb { label: string; to?: string }

/** Breadcrumb trail. The last item is the current page and is never a link. */
export default function Crumbs({ trail }: { trail: Crumb[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {trail.map((c, i) => {
        const last = i === trail.length - 1;
        return (
          <span className="crumb" key={i}>
            {c.to && !last
              ? <Link to={c.to}>{c.label}</Link>
              : <span aria-current={last ? "page" : undefined}>{c.label}</span>}
            {!last && <span className="crumb-sep" aria-hidden="true">/</span>}
          </span>
        );
      })}
    </nav>
  );
}
