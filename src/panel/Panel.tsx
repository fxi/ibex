import * as Tabs from "@radix-ui/react-tabs";
import {
  Route,
  Layers,
  NotebookPen,
  Palette,
  Settings,
  RefreshCw,
  SquarePen,
  ChevronDown,
  ChevronUp,
  Minimize2,
} from "lucide-react";
import { TracksPanel } from "./TracksPanel";
import { DataPanel } from "./DataPanel";
import { NotesPanel } from "./NotesPanel";
import { ConfigurePanel } from "./ConfigurePanel";
import { SymbologyPanel } from "./SymbologyPanel";
import { EditPanel } from "./EditPanel";
import type { PanelContext } from "./context";
import type { PanelHeight } from "../state/usePanelHeight";

const tabs = [
  ["tracks", "Tracks", Route],
  ["edit", "Edit", SquarePen],
  ["data", "Data", Layers],
  ["notes", "Notes", NotebookPen],
  ["symbology", "Legend", Palette],
  ["configure", "Configure", Settings],
] as const;

export function Panel({
  ctx,
  tab,
  error,
  panel,
}: {
  ctx: PanelContext;
  tab: string;
  error: string;
  panel: PanelHeight;
}) {
  const { tracks, routing, status, setError, setStatus, setTab } = ctx;
  const { height, reduced, open, toggle, fold, expand, startResize, resizing } =
    panel;

  return (
    <section
      className={`panel glass ${reduced ? "reduced" : ""} ${resizing ? "resizing" : ""}`}
      aria-label="Route planner"
      // Saving is quick and silent; the attribute lets tests wait for it before reloading.
      data-saving={tracks.saving}
    >
      {/* Drag the grab bar for any height, or tap it to swing between the tabs alone
          and the last height chosen; the buttons either side fold and open outright. */}
      <div className="panel-header">
        <button
          className="panel-fold"
          onClick={fold}
          disabled={reduced}
          aria-label="Fold panel"
          title="Fold panel"
        >
          <ChevronDown size={20} />
        </button>
        <button
          className="panel-handle"
          onPointerDown={startResize}
          onClick={toggle}
          aria-label="Resize panel"
          aria-expanded={!reduced}
        >
          <span className="grab" />
        </button>
        <button
          className="panel-expand"
          onClick={expand}
          aria-label={open ? "Restore panel" : "Expand panel"}
          title={open ? "Restore panel" : "Expand panel"}
        >
          {open ? <Minimize2 size={18} /> : <ChevronUp size={20} />}
        </button>
      </div>
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="tabs" aria-label="Planner tabs">
          {tabs.map(([id, label, Icon]) => (
            <Tabs.Trigger key={id} value={id}>
              <Icon size={23} />
              <span>{label}</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {/* The padding shrinks with the last 32px so the content can reach zero: with
            border-box sizing it would otherwise hold the box open. */}
        <div
          className="panel-content"
          style={{
            height: `${height}px`,
            paddingBlock: `${Math.min(16, height / 2)}px`,
          }}
        >
          {error && (
            <p className="error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </p>
          )}
          {/* The Edit tab reports its own run beside the Compute button. */}
          {routing.busy && tab !== "edit" && (
            <div className="calculation" role="status">
              <RefreshCw className="spin" size={16} />
              {status}
              <button
                onClick={() => {
                  routing.cancel();
                  setStatus("Cancelled");
                }}
              >
                Cancel
              </button>
            </div>
          )}
          <Tabs.Content value="tracks">
            <TracksPanel ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="edit">
            <EditPanel ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="data">
            <DataPanel ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="notes">
            <NotesPanel ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="symbology">
            <SymbologyPanel ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="configure">
            <ConfigurePanel ctx={ctx} />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </section>
  );
}
