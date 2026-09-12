import * as Tabs from "@radix-ui/react-tabs";
import {
  Route,
  Layers,
  Wrench,
  Palette,
  Settings,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { TracksPanel } from "./TracksPanel";
import { DataPanel } from "./DataPanel";
import { ToolsPanel } from "./ToolsPanel";
import { ConfigurePanel } from "./ConfigurePanel";
import { SymbologyPanel } from "./SymbologyPanel";
import type { PanelContext } from "./context";
import type { PanelHeight } from "../state/usePanelHeight";

const tabs = [
  ["tracks", "Tracks", Route],
  ["data", "Data", Layers],
  ["tools", "Tools", Wrench],
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
  const { height, open, setOpen, startResize, resizing } = panel;

  return (
    <section
      className={`panel glass ${open ? "" : "collapsed"} ${resizing ? "resizing" : ""}`}
      aria-label="Route planner"
    >
      {/* Dragging the grab bar resizes; the caret alone says open or closed. */}
      <div
        className="panel-handle"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize panel"
      >
        <span className="save-status" role="status">
          {tracks.saving ? "Saving…" : "Saved"}
        </span>
        <span className="grab" />
        <button
          className="expand-button"
          aria-label={open ? "Collapse panel" : "Open panel"}
          aria-expanded={open}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown
            style={{ transform: open ? undefined : "rotate(180deg)" }}
            size={16}
          />
        </button>
      </div>
      <Tabs.Root
        value={tab}
        onValueChange={setTab}
      >
        <Tabs.List className="tabs" aria-label="Planner tabs">
          {tabs.map(([id, label, Icon]) => (
            <Tabs.Trigger key={id} value={id}>
              <Icon size={23} />
              <span>{label}</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <div
          className="panel-content"
          style={{ height: open ? `${height}px` : 0 }}
        >
          {error && (
            <p className="error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </p>
          )}
          {routing.busy && (
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
          <Tabs.Content value="data">
            <DataPanel ctx={ctx} />
          </Tabs.Content>
          <Tabs.Content value="tools">
            <ToolsPanel ctx={ctx} />
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
