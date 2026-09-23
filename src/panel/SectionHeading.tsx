import { useState, type ReactNode } from "react";
import { Info } from "lucide-react";

/**
 * A panel's heading: its title, an (i) that reveals what the panel is for, and its
 * actions. The tab bar already names the panel, so the explanation stays folded away
 * and the panel's own content starts right under the tabs.
 */
export function SectionHeading({
  title,
  info,
  children,
}: {
  title: string;
  info?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="section-heading">
      <div className="section-title">
        <h1>{title}</h1>
        {info && (
          <button
            className="info-toggle"
            aria-label={open ? "Hide help" : "What is this?"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Info size={15} />
          </button>
        )}
      </div>
      {children}
      {info && open && <p className="section-info">{info}</p>}
    </div>
  );
}
