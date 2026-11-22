/**
 * Dev-only design preview for the 2D smart-home floor map.
 *
 *   npm run dev:web  →  http://localhost:5173/preview/floor-map.html
 *
 * It mounts the *real* Overview page component and answers the handful of API
 * calls it makes with the sample home in `demo-home.ts`, so the map, the room
 * inspector and the device control panels can be reviewed without a Worker,
 * Supabase or MQTT broker. Nothing here is part of the production bundle.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@/styles/globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { TimezoneContext } from "@/lib/timezone";
import { OverviewPage } from "@/features/user/OverviewPage";
import { demoOverview } from "./demo-home";
import type { OverviewData } from "@/features/types";

// /** Dev harness: answer overview reads from the sample home. */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();

  if (url.startsWith("/api/homes/overview")) {
    return json(demoOverview);
  }

  const switchToggle = url.match(/^\/api\/switches\/([^/]+)\/toggle$/);
  if (switchToggle && init?.method === "POST") {
    const id = switchToggle[1];
    const body = JSON.parse(String(init.body ?? "{}")) as { isOn?: boolean };
    const target = demoOverview.switches.find((item) => item.id === id);
    if (target) target.is_on = Boolean(body.isOn);
    return json({ switch: target });
  }

  // Room move / resize and badge placement persist into the in-memory sample so
  // Arrange mode can be reviewed end-to-end (drag a room, drag its corner grip).
  const roomPatch = url.match(/^\/api\/homes\/rooms\/([^/]+)$/);
  if (roomPatch && init?.method === "PATCH") {
    const id = roomPatch[1];
    const body = JSON.parse(String(init.body ?? "{}")) as {
      floorX?: number;
      floorY?: number;
      floorW?: number;
      floorH?: number;
      layoutConfig?: OverviewData["rooms"][number]["layout_config"];
    };
    const room = demoOverview.rooms.find((item) => item.id === id);
    if (room) {
      if (typeof body.floorX === "number") room.floor_x = body.floorX;
      if (typeof body.floorY === "number") room.floor_y = body.floorY;
      if (typeof body.floorW === "number") room.floor_w = body.floorW;
      if (typeof body.floorH === "number") room.floor_h = body.floorH;
      if (body.layoutConfig !== undefined) room.layout_config = body.layoutConfig;
    }
    return json({ room });
  }

  const deviceCommand = url.match(/^\/api\/devices\/([^/]+)\/command$/);
  if (deviceCommand && init?.method === "POST") {
    const id = deviceCommand[1];
    const body = JSON.parse(String(init.body ?? "{}")) as { state?: string };
    const target = demoOverview.devices.find((item) => item.id === id);
    if (target && body.state) target.state = body.state;
    return json({ device: target });
  }

  return json({ ok: true });
}) as typeof fetch;

function PreviewShell() {
  return (
    <TimezoneContext.Provider value="Asia/Dhaka">
      <div className="mx-auto w-full max-w-[1240px] px-4 py-6">
        <div className="mb-4 rounded-xl border border-dashed border-primary/30 bg-primary/5 px-3 py-2 text-[11px] font-medium text-primary">
          Design preview · sample home rendered by the real Overview page component,
          with API responses stubbed locally. Production always uses your live HomecoreOS data.
        </div>
        <OverviewPage canManage canOperate onNavigate={(path) => console.info("navigate", path)} />
      </div>
      <Toaster />
    </TimezoneContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={200}>
      <PreviewShell />
    </TooltipProvider>
  </StrictMode>
);
