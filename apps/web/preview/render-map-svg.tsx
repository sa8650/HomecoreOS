/**
 * Dev-only renderer: prints the floor map as a standalone SVG.
 *
 *   npx vite-node preview/render-map-svg.tsx src/components/floorplan/... 
 *
 * Used to review the map design in docs and screenshots without a browser.
 */
import { writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { SmartHomeMap } from "@/components/floorplan/SmartHomeMap";
import { demoOverview } from "./demo-home";

// `RENDER_MODE=auto` strips the saved positions so the generated house layout
// (used before the user arranges the plan) can be reviewed too.
const rooms =
  process.env.RENDER_MODE === "auto"
    ? demoOverview.rooms.map((room) => ({
        ...room,
        floor_x: 0,
        floor_y: 0,
        floor_w: null,
        floor_h: null,
      }))
    : demoOverview.rooms;

const selectedRoomId =
  process.env.RENDER_SELECTED === "none" ? null : (process.env.RENDER_SELECTED ?? "living");

const markup = renderToStaticMarkup(
  <SmartHomeMap
    rooms={rooms}
    devices={demoOverview.devices}
    switches={demoOverview.switches}
    sensors={demoOverview.sensors}
    controllers={demoOverview.controllers}
    selectedRoomId={selectedRoomId}
    selectedDeviceKey={null}
    onSelectRoom={() => {}}
    onSelectDevice={() => {}}
    canOperate
    canEdit
    editMode={false}
    pendingIds={{}}
    zoom={1}
    pan={{ x: 0, y: 0 }}
    onZoomChange={() => {}}
    onPanChange={() => {}}
    onToggleSwitch={() => {}}
    onToggleDevice={() => {}}
    onSetDeviceState={() => {}}
    onRoomRectCommit={() => {}}
    onDevicePositionCommit={() => {}}
    heightClassName="h-full"
  />
);

const match = markup.match(/<svg[\s\S]*<\/svg>/);
if (!match) {
  throw new Error("SVG not found in rendered markup");
}
const svg = match[0];
const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 1200 800";
const [, , vbW, vbH] = viewBox.split(" ").map(Number);
const background = `<rect x="0" y="0" width="100%" height="100%" fill="#EDF1F6" />`;
const output = svg.replace(/(<svg[^>]*>)/, `$1${background}`).replace("<svg", `<svg xmlns="http://www.w3.org/2000/svg" width="${vbW}" height="${vbH}"`);

const outPath = process.argv[2] ?? "preview/floor-map.svg";

if (outPath.endsWith(".html")) {
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>HomecoreOS — 2D smart home floor map</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 40px;
    font-family: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #eff3f7; color: #0f172a;
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  .eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #64748b; font-weight: 600; }
  h1 { margin: 6px 0 6px; font-size: 22px; letter-spacing: -.01em; }
  p.lead { margin: 0 0 18px; font-size: 13px; line-height: 1.6; color: #475569; max-width: 78ch; }
  .stage { border-radius: 18px; background: linear-gradient(180deg,#ffffff 0%,#f4f7fa 100%); border: 1px solid #dfe6ee; box-shadow: 0 18px 40px -28px rgba(15,23,42,.45); padding: 14px; }
  .stage svg { display: block; width: 100%; height: auto; border-radius: 12px; }
  .legend { display: flex; flex-wrap: wrap; gap: 18px; margin: 16px 2px 0; font-size: 12px; color: #475569; }
  .legend span { display: inline-flex; align-items: center; gap: 7px; }
  .dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; margin-top: 22px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 14px 16px; }
  .card h2 { margin: 0 0 6px; font-size: 12.5px; letter-spacing: .02em; }
  .card p { margin: 0; font-size: 12px; line-height: 1.6; color: #56637a; }
  code { font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background: #eef2f7; border-radius: 5px; padding: 1px 5px; }
</style>
</head>
<body>
  <div class="wrap">
    <p class="eyebrow">HomecoreOS · Overview</p>
    <h1>2D smart-home floor map</h1>
    <p class="lead">
      Snapshot rendered from the real <code>SmartHomeMap</code> component with the sample home used by the
      design harness. Rooms come from the user's room records, walls and doorways are generated from the
      shared edges between them, and every badge is a live switch / device / sensor with its true state.
    </p>
    <div class="stage">
      ${output}
    </div>
    <div class="legend">
      <span><i class="dot" style="background:#FBBF24"></i> Light on</span>
      <span><i class="dot" style="background:#2563EB"></i> Active device (TV, fan, AC, plug)</span>
      <span><i class="dot" style="background:#94A3B8"></i> Idle</span>
      <span><i class="dot" style="background:#EF4444"></i> Offline hardware</span>
    </div>
    <div class="cards">
      <div class="card"><h2>One connected plan</h2><p>Rooms share single walls, doorways are cut between adjacent rooms, and windows sit on exterior walls.</p></div>
      <div class="card"><h2>Real devices only</h2><p>Badges show the actual online / on / off state of HomecoreOS switches, devices and sensors. No decorative activity.</p></div>
      <div class="card"><h2>Live controls</h2><p>Clicking a badge opens a compact panel with power, fan speed, lock/valve position and live sensor readings.</p></div>
      <div class="card"><h2>Automatic or arranged</h2><p>Unconfigured homes get a generated layout. Dragging rooms and badges persists through the existing Rooms API.</p></div>
    </div>
  </div>
</body>
</html>`;
  writeFileSync(outPath, page, "utf8");
  console.log(`wrote ${outPath} (${page.length} bytes)`);
} else {
  writeFileSync(outPath, output, "utf8");
  console.log(`wrote ${outPath} (${output.length} bytes)`);
}
