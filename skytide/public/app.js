// ---------- globe ----------
const viewer = new Cesium.Viewer("map", {
  baseLayer: false,
  animation: false, timeline: false, geocoder: false, homeButton: false, sceneModePicker: false,
  baseLayerPicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false,
  selectionIndicator: false,
  // Only draw a frame when something changed (camera, tiles, data) instead of 60 fps all the time
  requestRenderMode: true, maximumRenderTimeChange: Infinity,
});
const scene = viewer.scene, camera = viewer.camera, globe = scene.globe;
globe.tileCacheSize = 400;                // keep more map tiles around so revisiting areas doesn't re-download
const redraw = () => scene.requestRender();
globe.enableLighting = true;              // real day / night line
globe.showGroundAtmosphere = true;
scene.skyAtmosphere.show = true;
scene.fog.enabled = true;
scene.highDynamicRange = false;
const ssc = scene.screenSpaceCameraController;
ssc.minimumZoomDistance = 50;             // ~street level
ssc.maximumZoomDistance = 4.5e8;          // past the Moon
ssc.inertiaSpin = 0.85;

// Free map styles
const esri = (svc, maximumLevel) => new Cesium.UrlTemplateImageryProvider({
  url: `https://services.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`, maximumLevel, credit: "Esri",
});
const PROVIDERS = {
  satellite: () => esri("World_Imagery", 19),
  geographical: () => esri("NatGeo_World_Map", 16),   // relief, mountains, rivers, place names
  street: () => new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
};
// NASA Black Marble city lights: only drawn on the night side of the globe
const nightProvider = new Cesium.UrlTemplateImageryProvider({
  url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
  maximumLevel: 8, credit: "NASA GIBS",
});
const providers = {};
let imagery = "satellite";
function setImagery(kind) {
  imagery = kind;
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider((providers[kind] ??= PROVIDERS[kind]()));
  const night = viewer.imageryLayers.addImageryProvider(nightProvider);
  night.dayAlpha = 0.0;
  night.nightAlpha = sun.on && document.getElementById("lightsOn").checked ? 0.9 : 0.0;
  sun.nightLayer = night;
  redraw();
}

// ---------- real 3D mountains (Esri World Elevation, free, no key) ----------
let terrainOn = true, esriTerrain = null;
async function setTerrain(on) {
  terrainOn = on;
  $("#terrainBtn").classList.toggle("on", on);
  if (!on) { viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider(); redraw(); return; }
  try {
    esriTerrain ??= await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
      "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer");
    if (terrainOn) { viewer.terrainProvider = esriTerrain; redraw(); }
  } catch (e) { toast("3D mountains unavailable: " + e.message); $("#terrainBtn").classList.remove("on"); }
}

// ---------- borders overlay: country lines, light colour tint, names (works on any map) ----------
const politicalDS = new Cesium.CustomDataSource("borders");
viewer.dataSources.add(politicalDS);
const countryLabels = scene.primitives.add(new Cesium.LabelCollection());
const POL_COLORS = ["#f4c97a", "#a8d08d", "#f7a6a6", "#c7b3e5", "#9fd3e0", "#f2e394", "#e8b59a"];
let politicalLoaded = false;
async function showBorders(on) {
  politicalDS.show = on;
  countryLabels.show = on;
  redraw();
  $("#bordersBtn").classList.toggle("on", on);
  if (!on || politicalLoaded) return;
  politicalLoaded = true;
  try {
    const countries = await (await fetch("/api/countries")).json();
    const border = new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString("#fff").withAlpha(0.9));
    for (const c of countries) {
      // light tint so mountains and terrain still show through
      const fill = new Cesium.ColorMaterialProperty(Cesium.Color.fromCssColorString(POL_COLORS[(c.color - 1) % 7] || "#ddd").withAlpha(0.18));
      const polys = c.geometry.type === "Polygon" ? [c.geometry.coordinates] : c.geometry.coordinates;
      for (const rings of polys) {
        const toPos = (ring) => Cesium.Cartesian3.fromDegreesArray(ring.flat());
        if (c.name !== "Antarctica") { // polygons around a pole render badly; borders are enough there
          const e = politicalDS.entities.add({
            polygon: { hierarchy: new Cesium.PolygonHierarchy(toPos(rings[0]), rings.slice(1).map((h) => new Cesium.PolygonHierarchy(toPos(h)))), material: fill },
          });
          e._country = c.name;
        }
        politicalDS.entities.add({ polyline: { positions: toPos(rings[0]), clampToGround: true, width: 1.5, material: border } });
      }
      const far = c.rank <= 2 ? 3e7 : c.rank <= 4 ? 1.2e7 : 5e6;
      countryLabels.add({
        position: Cesium.Cartesian3.fromDegrees(c.lx, c.ly, 20000), text: c.name.toUpperCase(),
        font: `600 ${c.rank <= 2 ? 14 : 12}px system-ui, sans-serif`, fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER, verticalOrigin: Cesium.VerticalOrigin.CENTER,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, far), scaleByDistance: new Cesium.NearFarScalar(1e6, 1.1, 2.5e7, 0.6),
      });
    }
    redraw();
  } catch (e) { politicalLoaded = false; toast("Couldn't load country borders: " + e.message); }
}

// ---------- sun: day / night, subsolar point, time scrubbing ----------
const sun = { on: true, offsetH: 0, nightLayer: null };
globe.lightingFadeOutDistance = 1;  // show day/night at every zoom level (Cesium hides it when close by default)
globe.lightingFadeInDistance = 2;
// Where the sun is directly overhead (low-precision solar formulas, accurate to ~0.1°)
function subsolarPoint(date) {
  const rad = Math.PI / 180, d = date.getTime() / 864e5 - 10957.5; // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / rad;
  const gmst = (280.46061837 + 360.98564736629 * d) % 360;
  let lon = (ra - gmst) % 360;
  if (lon > 180) lon -= 360; if (lon < -180) lon += 360;
  return { lat: dec, lon };
}
const SUN_IMG = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44"><g stroke="#ffcf3f" stroke-width="2.5" stroke-linecap="round">${[...Array(8)].map((_, i) => { const a = i * Math.PI / 4; return `<line x1="${22 + Math.cos(a) * 14}" y1="${22 + Math.sin(a) * 14}" x2="${22 + Math.cos(a) * 20}" y2="${22 + Math.sin(a) * 20}"/>`; }).join("")}</g><circle cx="22" cy="22" r="9" fill="#ffd84d" stroke="#e8a400" stroke-width="2"/></svg>`);
const sunMarker = viewer.entities.add({
  position: Cesium.Cartesian3.fromDegrees(0, 0, 50000),
  billboard: { image: SUN_IMG, scaleByDistance: new Cesium.NearFarScalar(1e6, 1.2, 3e7, 0.8) },
  label: { text: "Sun overhead", font: "600 12px system-ui", fillColor: Cesium.Color.fromCssColorString("#ffd84d"), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, 28) },
});
function sunTime() { return new Date(Date.now() + sun.offsetH * 3600e3); }
function updateSun() {
  const t = sunTime();
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(t);
  const p = subsolarPoint(t);
  sunMarker.position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 50000);
  sunMarker.show = sun.on;
  redraw();
  const hh = (n) => String(n).padStart(2, "0");
  $("#sunTime").textContent = `${t.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })} (${hh(t.getUTCHours())}:${hh(t.getUTCMinutes())} UTC)`;
  $("#sunWhere").textContent = `Sun overhead: ${Math.abs(p.lat).toFixed(1)}°${p.lat >= 0 ? "N" : "S"}, ${Math.abs(p.lon).toFixed(1)}°${p.lon >= 0 ? "E" : "W"}`;
}
viewer.clock.shouldAnimate = false; // the clock follows real time (plus the slider) via updateSun
setInterval(updateSun, 1000);

setImagery(imagery);

const HOME = Cesium.Cartesian3.fromDegrees(15, 50, 2.6e6);
camera.setView({ destination: Cesium.Cartesian3.fromDegrees(15, 40, 2.2e7) });
setTimeout(() => camera.flyTo({ destination: HOME, duration: 3 }), 600);

const planesBB = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
const shipsBB = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
const trailPC = scene.primitives.add(new Cesium.PolylineCollection());

const state = {
  mode: "planes", milOnly: false, query: "", selected: null, // { kind, id, follow }
  planes: new Map(), ships: new Map(),
  bb: new Map(), trails: new Map(), shipsWorldwide: false,
};

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = "none"), 3500); }
function altColor(alt) {
  if (alt === "ground" || alt == null) return "#9aa4b1";
  const stops = [[0, [255, 210, 63]], [10000, [255, 159, 28]], [20000, [255, 92, 168]], [30000, [167, 123, 255]], [40000, [63, 182, 255]]];
  alt = Math.round(alt / 1000) * 1000; // bucket so icons can be reused
  if (alt >= 40000) return "rgb(63,182,255)";
  for (let i = 0; i < stops.length - 1; i++) {
    const [a0, c0] = stops[i], [a1, c1] = stops[i + 1];
    if (alt <= a1) { const f = (alt - a0) / (a1 - a0); return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * f)).join(",")})`; }
  }
}
const isMil = (a) => (a.dbFlags & 1) === 1;
// Escape anything from outside data before it goes into HTML (ship names, station names etc. are user-controlled)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, unit = "", d = 0) => (v == null || v === "" ? "—" : esc(`${typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : v}${unit}`));
const svgUri = (s) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
const PLANE_IMG = (c) => svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path fill="${c}" stroke="#000" stroke-width=".6" d="M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.5v2l-7.7-2.4v4.3l2.2 1.7V21L12 20l-3.5 1v-1.7l2.2-1.7v-4.3L3 15.7v-2l7.7-4.5V4c0-1.1.5-2 1.3-2z"/></svg>`);
const SHIP_IMG = (c) => svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="24" viewBox="0 0 18 22"><path fill="${c}" stroke="#000" stroke-width=".7" d="M9 1l6 7v12H3V8z"/></svg>`);
const idOf = (kind, o) => (kind === "plane" ? "p:" + o.hex : "s:" + o.mmsi);
const labelOf = (kind, o) => kind === "plane" ? (o.flight?.trim() || o.r || o.hex.toUpperCase()) : (o.name || "MMSI " + o.mmsi);
const FT = 0.3048;
function heightOf(kind, o) { return kind === "plane" ? (typeof o.alt_baro === "number" ? Math.max(o.alt_baro, 0) * FT : 0) + 20 : 15; }

function matches(kind, o) {
  if (!state.query) return true;
  const q = state.query;
  const hay = kind === "plane" ? [o.flight, o.r, o.hex, o.t, o.desc, o.ownOp] : [o.name, String(o.mmsi), o.callSign, o.destination];
  return hay.some((h) => h && String(h).toLowerCase().includes(q));
}

// What part of Earth is the camera looking at?
function viewCenter() {
  const c = new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  const p = camera.pickEllipsoid(c) || camera.positionWC;
  const g = Cesium.Cartographic.fromCartesian(p);
  return { lat: Cesium.Math.toDegrees(g.latitude), lon: Cesium.Math.toDegrees(g.longitude) };
}
const camHeight = () => Cesium.Cartographic.fromCartesian(camera.positionWC).height;

// ---------- data ----------
// Each feed keeps one request at a time: a newer request cancels the older one
const feeds = {};
async function getLatest(name, url) {
  feeds[name]?.abort();
  const ctl = (feeds[name] = new AbortController());
  try { return await (await fetch(url, { signal: ctl.signal })).json(); }
  finally { if (feeds[name] === ctl) delete feeds[name]; }
}
const isAbort = (e) => e.name === "AbortError";
function dropStaleTrails(prefix, liveMap) {
  for (const id of state.trails.keys())
    if (id.startsWith(prefix) && !liveMap.has(prefix === "p:" ? id.slice(2) : +id.slice(2)) && state.selected?.id !== id) state.trails.delete(id);
}

async function fetchPlanes() {
  if (state.mode === "ships") return;
  try {
    let url;
    if (state.milOnly) url = "/api/military";
    else {
      const c = viewCenter();
      const radiusNm = Math.min(250, Math.max(20, camHeight() / 1852));
      url = `/api/planes?lat=${c.lat}&lon=${c.lon}&r=${radiusNm}`;
    }
    const data = await getLatest("planes", url);
    if (data.error) throw new Error(data.error);
    state.planes = new Map();
    for (const a of data.ac || []) {
      state.planes.set(a.hex, a);
      pushTrail("p:" + a.hex, a.lon, a.lat, heightOf("plane", a));
    }
    dropStaleTrails("p:", state.planes);
    render();
  } catch (e) { if (!isAbort(e)) toast("Aircraft feed: " + e.message); }
}

async function fetchShips() {
  if (state.mode === "planes") return;
  try {
    let q = "";
    const r = camera.computeViewRectangle();
    if (r && r.west < r.east && camHeight() < 8e6) {
      const d = Cesium.Math.toDegrees;
      q = `?s=${d(r.south)}&w=${d(r.west)}&n=${d(r.north)}&e=${d(r.east)}`;
    }
    const data = await getLatest("ships", "/api/ships" + q);
    state.shipsWorldwide = data.worldwide;
    state.ships = new Map(data.ships.map((s) => [s.mmsi, s]));
    for (const s of data.ships) pushTrail("s:" + s.mmsi, s.lon, s.lat, heightOf("ship", s));
    dropStaleTrails("s:", state.ships);
    render();
  } catch (e) { if (!isAbort(e)) toast("Ship feed: " + e.message); }
}

function pushTrail(id, lon, lat, h) {
  let t = state.trails.get(id);
  if (!t) state.trails.set(id, (t = []));
  const last = t[t.length - 1];
  if (!last || last[0] !== lon || last[1] !== lat) t.push([lon, lat, h]);
  if (t.length > 300) t.shift();
}

// ---------- render ----------
const scaler = new Cesium.NearFarScalar(2e4, 1.1, 2e7, 0.35);
function render() {
  const want = new Map();
  if (state.mode !== "ships") for (const a of state.planes.values()) if (matches("plane", a)) want.set("p:" + a.hex, ["plane", a]);
  if (state.mode !== "planes") for (const s of state.ships.values()) if (matches("ship", s)) want.set("s:" + s.mmsi, ["ship", s]);

  for (const [id, b] of state.bb) if (!want.has(id)) { (b._kind === "plane" ? planesBB : shipsBB).remove(b); state.bb.delete(id); }
  for (const [id, [kind, o]] of want) {
    const pos = Cesium.Cartesian3.fromDegrees(o.lon, o.lat, heightOf(kind, o));
    const img = kind === "plane" ? PLANE_IMG(isMil(o) ? "#ff5c5c" : altColor(o.alt_baro)) : SHIP_IMG((o.sog || 0) > 0.5 ? "#3ee08f" : "#2a8a5e");
    const hdg = kind === "plane" ? o.track ?? o.true_heading ?? 0 : o.heading ?? o.cog ?? 0;
    let b = state.bb.get(id);
    if (!b) {
      b = (kind === "plane" ? planesBB : shipsBB).add({
        position: pos, image: img, id, scaleByDistance: scaler,
        alignedAxis: Cesium.Cartesian3.UNIT_Z, // rotate relative to north
      });
      b._kind = kind; b._img = img;
      state.bb.set(id, b);
    } else {
      b.position = pos;
      if (b._img !== img) { b.image = img; b._img = img; }
    }
    b.rotation = -Cesium.Math.toRadians(hdg);
    b.scale = state.selected?.id === id ? 1.8 : 1;
    b._obj = o;
  }

  if (state.selected) {
    const b = state.bb.get(state.selected.id);
    if (b) {
      showInfo(b._kind, b._obj);
      if (state.selected.follow) {
        camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(b._obj.lon, b._obj.lat, Math.max(camHeight(), 3000)),
          orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 }, duration: 1.5,
        });
      }
    }
  }
  drawTrail();

  let p = 0, s = 0;
  for (const [k] of want.values()) k === "plane" ? p++ : s++;
  const bits = [];
  if (state.mode !== "ships") bits.push(`<b>${p.toLocaleString()}</b> aircraft${state.milOnly ? " (military, worldwide)" : " near view"}`);
  if (state.mode !== "planes") bits.push(`<b>${s.toLocaleString()}</b> ships${state.shipsWorldwide ? "" : " · free Baltic feed"}`);
  bits.push(`updated ${new Date().toLocaleTimeString()}`);
  $("#stats").innerHTML = `<span class="pulse"></span><span>${bits.join(' <span class="muted">·</span> ')}</span>`;
  redraw();
}

const trailMaterial = Cesium.Material.fromType("Color", { color: Cesium.Color.fromCssColorString("#3fb6ff").withAlpha(0.9) });
let trailKey = "";
function drawTrail() {
  const pts = state.selected && state.trails.get(state.selected.id);
  const key = pts && pts.length > 1 ? state.selected.id + pts.length + pts[pts.length - 1].join() : "";
  if (key === trailKey) return; // unchanged: don't rebuild the line
  trailKey = key;
  trailPC.removeAll();
  if (key) trailPC.add({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(pts.flat()), width: 3, material: trailMaterial });
}

function select(id) {
  state.selected = { id, follow: false };
  state.comms = null;
  render();
  const b = state.bb.get(id);
  if (b) loadComms(id, b._kind, b._obj);
}
function deselect() {
  state.selected = null;
  $("#info").style.display = "none";
  render();
}

const NAV = ["Under way (engine)", "At anchor", "Not under command", "Restricted manoeuvrability", "Constrained by draught", "Moored", "Aground", "Fishing", "Under way (sail)"];
function shipType(t) {
  if (t == null) return "—";
  if (t >= 70 && t < 80) return "Cargo"; if (t >= 80 && t < 90) return "Tanker"; if (t >= 60 && t < 70) return "Passenger";
  if (t === 30) return "Fishing"; if (t === 52) return "Tug"; if (t === 36) return "Sailing"; if (t === 37) return "Pleasure craft";
  if (t >= 40 && t < 50) return "High-speed craft"; if (t === 35) return "Military"; return "Type " + t;
}

function showInfo(kind, o) {
  const el = $("#info");
  el.style.display = "block";
  $("#help").style.display = "none";
  const follow = state.selected?.follow;
  let body;
  if (kind === "plane") {
    const alt = o.alt_baro === "ground" ? "On ground" : fmt(o.alt_baro, " ft");
    body = `
      <h2>${esc(labelOf("plane", o))}</h2>
      <div class="sub">${isMil(o) ? '<span class="tag mil"><span class="dot"></span>Military</span>' : ""}${o.t ? `<span class="tag">${esc(o.t)}</span>` : ""}<span>${esc(o.desc)}</span></div>
      <dl>
        <dt>Registration</dt><dd>${fmt(o.r)}</dd>
        <dt>Operator</dt><dd>${fmt(o.ownOp)}</dd>
        <dt>ICAO hex</dt><dd>${esc(o.hex.toUpperCase())}</dd>
        <dt>Altitude</dt><dd>${alt}</dd>
        <dt>Vertical rate</dt><dd>${fmt(o.baro_rate ?? o.geom_rate, " ft/min")}</dd>
        <dt>Ground speed</dt><dd>${fmt(o.gs, " kt")}</dd>
        <dt>Heading</dt><dd>${fmt(o.track, "°")}</dd>
        <dt>Squawk</dt><dd>${fmt(o.squawk)}${["7500", "7600", "7700"].includes(o.squawk) ? ' <span class="tag mil"><span class="dot"></span>Emergency</span>' : ""}</dd>
        <dt>Position</dt><dd>${(+o.lat).toFixed(3)}, ${(+o.lon).toFixed(3)}</dd>
        <dt>Last seen</dt><dd>${fmt(o.seen, " s ago", 1)}</dd>
      </dl>`;
  } else {
    body = `
      <h2>${esc(labelOf("ship", o))}</h2>
      <div class="sub"><span class="tag">${shipType(o.shipType)}</span><span>${esc(o.source)}</span></div>
      <dl>
        <dt>MMSI</dt><dd>${esc(o.mmsi)}</dd>
        <dt>IMO</dt><dd>${fmt(o.imo)}</dd>
        <dt>Call sign</dt><dd>${fmt(o.callSign)}</dd>
        <dt>Status</dt><dd>${NAV[o.navStat] || "—"}</dd>
        <dt>Speed</dt><dd>${fmt(o.sog, " kn", 1)}</dd>
        <dt>Course</dt><dd>${fmt(o.cog, "°", 0)}</dd>
        <dt>Destination</dt><dd>${fmt(o.destination)}</dd>
        <dt>Draught</dt><dd>${o.draught ? esc((o.draught > 30 ? o.draught / 10 : o.draught) + " m") : "—"}</dd>
        <dt>Position</dt><dd>${(+o.lat).toFixed(3)}, ${(+o.lon).toFixed(3)}</dd>
      </dl>`;
  }
  $("#radioPanel").style.display = "none";
  $("#sunPanel").style.display = "none";
  el.innerHTML = `<button class="btn icon close" id="closeInfo" title="Close">${icon("x")}</button>${body}
    <div class="row"><button class="btn solid ${follow ? "on" : ""}" id="followBtn">${icon("locate")}${follow ? "Following" : "Follow"}</button>
    <button class="btn solid" id="zoomBtn">${icon("plus")}Zoom to</button>
    ${kind === "plane" ? `<button class="btn solid" id="cockpitBtn">${icon("mountain")}Side view</button>` : ""}</div>
    ${commsHtml(kind)}`;
  $("#closeInfo").onclick = deselect;
  $("#followBtn").onclick = () => { state.selected.follow = !state.selected.follow; render(); };
  $("#zoomBtn").onclick = () => camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(o.lon, o.lat, heightOf(kind, o) + 15000), duration: 2 });
  const cb = $("#cockpitBtn");
  if (cb) cb.onclick = () => {
    // look at the plane from the side so you can see its real altitude above the ground
    const target = Cesium.Cartesian3.fromDegrees(o.lon, o.lat, heightOf(kind, o));
    camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 1), {
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians((o.track || 0) + 90), Cesium.Math.toRadians(-8), 30000), duration: 2,
    });
  };
}

// ---------- radio & comms ----------
const audio = $("#audio");
const radioPts = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const streamIndex = new Map(); // id -> station, for click-to-play buttons
const KIND_LABEL = { atc: "ATC / aviation", marine: "Marine VHF", scanner: "Scanner" };
const radio = { stations: [], loaded: false, on: false, current: null };

async function loadStations() {
  if (radio.loaded) return;
  $("#radioNote").textContent = "Loading stations…";
  try {
    const data = await (await fetch("/api/radio/stations")).json();
    if (!data.ok) { $("#radioNote").textContent = "The free radio directory (radio-browser.info) is down right now. The server keeps retrying, so reopen this in a few minutes."; return; }
    radio.stations = data.stations;
    radio.loaded = true;
    radioPts.removeAll();
    const col = Cesium.Color.fromCssColorString("#ffb347");
    for (const s of radio.stations) {
      streamIndex.set(s.id, s);
      radioPts.add({ position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 30), color: col, pixelSize: 5, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, id: "r:" + s.id,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.6, 2e7, 0.7) });
    }
    $("#radioNote").textContent = data.backup
      ? "The full world directory (radio-browser.info) is down right now, so here is a starter list. Reload in a few minutes for 15,000+ stations."
      : `${radio.stations.length.toLocaleString()} live stations. Orange dots on the globe: click one to listen.`;
    if (data.backup) radio.loaded = false; // pick up the full list next time the panel opens
    listStations(radio.stations.slice(0, 60));
    redraw();
  } catch (e) { $("#radioNote").textContent = "Couldn't load stations: " + e.message; }
}

function stationRow(s) {
  streamIndex.set(s.id, s);
  const icon = s.icon ? `<img src="${esc(s.icon)}" loading="lazy" data-fallback="ph">` : '<span class="ph"></span>';
  const sub = [s.kind ? KIND_LABEL[s.kind] : null, s.country, s.tags?.split(",").slice(0, 2).join(", ")].filter(Boolean).join(" · ");
  return `<div class="st" data-sid="${esc(s.id)}">${icon}<div class="nm"><div>${esc(s.name)}</div><small>${esc(sub)}</small></div>${s.km != null ? `<span class="km">${s.km.toLocaleString()} km</span>` : ""}</div>`;
}
function listStations(list) { $("#radioList").innerHTML = list.map(stationRow).join("") || '<div class="note">No stations found.</div>'; }

function play(s) {
  radio.current = s;
  audio.src = s.url;
  audio.volume = +$("#plVol").value;
  audio.play().catch(() => {});
  $("#player").style.display = "flex";
  document.body.classList.add("playing");
  $("#plName").innerHTML = `<span class="live"></span>${esc(s.name)}`;
  $("#plSub").textContent = [s.kind ? KIND_LABEL[s.kind] : null, s.country, s.codec && `${s.codec}${s.br ? " " + s.br + "k" : ""}`].filter(Boolean).join(" · ");
  $("#plIcon").outerHTML = s.icon ? `<img id="plIcon" src="${esc(s.icon)}" data-fallback="hide">` : '<span class="ph" id="plIcon"></span>';
  $("#plToggle").innerHTML = icon("pause");
}
audio.onerror = () => { if (radio.current) toast(`"${radio.current.name}" is offline right now. Try another station.`); $("#plToggle").innerHTML = icon("play"); };
audio.onplaying = () => ($("#plToggle").innerHTML = icon("pause"));
$("#plToggle").onclick = () => { if (audio.paused) { audio.play().catch(() => {}); } else { audio.pause(); $("#plToggle").innerHTML = icon("play"); } };
$("#plVol").oninput = (e) => (audio.volume = +e.target.value);
$("#plStop").onclick = () => { audio.pause(); audio.removeAttribute("src"); audio.load(); $("#player").style.display = "none"; document.body.classList.remove("playing"); };
$("#plGo").onclick = () => { const s = radio.current; if (s?.lat != null) camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 3e5), duration: 3 }); };

// broken station logos: swap for a placeholder (or hide) without inline onerror handlers
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  if (img.dataset.fallback === "hide") img.style.visibility = "hidden";
  else img.replaceWith(Object.assign(document.createElement("span"), { className: "ph" }));
}, true);

// click-to-play anywhere (radio list, plane/ship panels)
document.addEventListener("click", (e) => {
  const row = e.target.closest("[data-sid]");
  if (row && streamIndex.has(row.dataset.sid)) play(streamIndex.get(row.dataset.sid));
});

$("#radioBtn").onclick = () => {
  radio.on = !radio.on;
  $("#radioBtn").classList.toggle("on", radio.on);
  radioPts.show = radio.on;
  redraw();
  $("#radioPanel").style.display = radio.on ? "flex" : "none";
  if (radio.on) { if (state.selected) deselect(); $("#help").style.display = "none"; loadStations(); }
};
radioPts.show = false;
let radioTimer;
$("#radioSearch").oninput = (e) => {
  clearTimeout(radioTimer);
  radioTimer = setTimeout(() => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) return listStations(radio.stations.slice(0, 60));
    listStations(radio.stations.filter((s) => [s.name, s.country, s.tags].some((h) => h && h.toLowerCase().includes(q))).slice(0, 100));
  }, 150);
};
$("#radioRandom").onclick = () => {
  if (!radio.stations.length) return;
  const s = radio.stations[Math.floor(Math.random() * radio.stations.length)];
  play(s);
  camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 1.5e6), duration: 3 });
};
function kmBetween(a, b, c, d) { return Cesium.Cartesian3.distance(Cesium.Cartesian3.fromDegrees(b, a), Cesium.Cartesian3.fromDegrees(d, c)) / 1000; }
$("#radioNear").onclick = () => {
  const c = viewCenter();
  listStations(radio.stations.map((s) => ({ ...s, km: Math.round(kmBetween(c.lat, c.lon, s.lat, s.lon)) })).sort((a, b) => a.km - b.km).slice(0, 60));
};
$("#radioComms").onclick = async () => {
  const c = viewCenter();
  const [a, m] = await Promise.all([
    fetch(`/api/comms?lat=${c.lat}&lon=${c.lon}&kind=plane`).then((r) => r.json()),
    fetch(`/api/comms?lat=${c.lat}&lon=${c.lon}&kind=ship`).then((r) => r.json()),
  ]);
  const seen = new Set();
  const list = [...a.streams, ...m.streams].filter((s) => !seen.has(s.id) && seen.add(s.id)).sort((x, y) => (x.km ?? 1e9) - (y.km ?? 1e9));
  if (!a.radioOk) $("#radioList").innerHTML = '<div class="note">The radio directory is down right now. Try again in a few minutes.</div>';
  else listStations(list);
};

async function loadComms(id, kind, o) {
  try {
    const data = await (await fetch(`/api/comms?lat=${o.lat}&lon=${o.lon}&kind=${kind}`)).json();
    if (state.selected?.id !== id) return;
    state.comms = { id, data };
    render();
  } catch {}
}
function commsHtml(kind) {
  const title = icon("headphones") + (kind === "plane" ? "Listen to ATC" : "Marine radio");
  const c = state.comms && state.comms.id === state.selected?.id ? state.comms.data : null;
  if (!c) return `<div class="comms"><h4>${title}</h4><div class="note">Finding nearby radio…</div></div>`;
  let html = `<div class="comms"><h4>${title}</h4>`;
  if (kind === "plane" && c.airports.length) {
    html += `<div class="label" style="margin:12px 0 4px">Nearest airports · LiveATC</div>`;
    html += c.airports.map((a) => `<div class="airport"><a href="https://www.liveatc.net/search/?icao=${esc(a.icao)}" target="_blank" rel="noopener noreferrer">${esc(a.icao)}${a.iata ? " / " + esc(a.iata) : ""} · ${esc(a.name)}</a><span class="note">${a.km.toLocaleString()} km</span></div>`).join("");
  }
  if (c.streams.length) {
    html += `<div class="label" style="margin:16px 0 4px">${kind === "plane" ? "Aviation &amp; scanner streams" : "Marine VHF &amp; coast streams"}</div>`;
    html += c.streams.map(stationRow).join("");
  } else if (!c.radioOk) {
    html += `<div class="note" style="margin-top:8px">In-app streams come from radio-browser.info, which is down right now. The server keeps retrying.</div>`;
  }
  if (kind === "ship") html += `<div class="note" style="margin-top:8px">Ship-to-shore radio (VHF ch 16) is mostly not streamed online, so only places with a volunteer receiver have a live feed.</div>`;
  return html + "</div>";
}

// ---------- picking & hover ----------
const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
handler.setInputAction((e) => {
  const picked = scene.pick(e.position);
  const id = picked && typeof picked.id === "string" ? picked.id : null;
  if (id?.startsWith("r:") && streamIndex.has(id.slice(2))) play(streamIndex.get(id.slice(2)));
  else if (id && state.bb.has(id)) select(id);
  else if (state.selected) deselect();
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
// Hover tooltips. scene.pick is expensive, so do it at most once per frame and never while dragging.
const tip = $("#tip");
let hoverPos = null, hoverQueued = false, dragging = false;
scene.canvas.addEventListener("pointerdown", () => { dragging = true; tip.style.display = "none"; });
window.addEventListener("pointerup", () => (dragging = false));
function hoverPick() {
  hoverQueued = false;
  if (dragging || !hoverPos) return;
  const picked = scene.pick(hoverPos);
  const id = picked && typeof picked.id === "string" ? picked.id : null;
  const st = id?.startsWith("r:") && streamIndex.get(id.slice(2));
  const b = !st && id && state.bb.get(id);
  const country = !st && !b && picked?.id instanceof Cesium.Entity && picked.id._country;
  const text = st ? `${st.name}${st.country ? " · " + st.country : ""}` : b ? labelOf(b._kind, b._obj) : country || "";
  scene.canvas.style.cursor = st || b ? "pointer" : "";
  if (!text) { tip.style.display = "none"; return; }
  tip.textContent = text;
  tip.style.left = hoverPos.x + 14 + "px"; tip.style.top = hoverPos.y - 10 + "px";
  tip.style.display = "block";
}
handler.setInputAction((e) => {
  hoverPos = Cesium.Cartesian2.clone(e.endPosition, hoverPos);
  if (!hoverQueued && !dragging) { hoverQueued = true; requestAnimationFrame(hoverPick); }
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

// ---------- camera controls ----------
function zoom(dir) {
  const h = camHeight();
  dir > 0 ? camera.zoomIn(h * 0.5) : camera.zoomOut(h * 1.0);
}
function goSpace() {
  const c = viewCenter();
  camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 3.5e7), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 }, duration: 3 });
}
function goHome() { camera.flyTo({ destination: HOME, orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 }, duration: 3 }); }
function faceNorth() {
  const c = viewCenter();
  camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, camHeight()), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 }, duration: 1.2 });
}
$("#zoomIn").onclick = () => zoom(1);
$("#zoomOut").onclick = () => zoom(-1);
$("#spaceBtn").onclick = goSpace;
$("#northBtn").onclick = faceNorth;

// Keyboard flying: WASD move, QE up/down, arrows look around
const keys = new Set();
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); goSpace(); return; }
  if (k === "h") { goHome(); return; }
  if (k === "+" || k === "=") { zoom(1); return; }
  if (k === "-" || k === "_") { zoom(-1); return; }
  if (["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
    e.preventDefault();
    if (!keys.has(k)) applyKey(k, 3); // a quick tap still moves
    keys.add(k);
  }
});
document.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());
function applyKey(k, mult = 1) {
  const step = (Math.max(camHeight(), 200) / 60) * mult;
  const look = 0.02 * mult;
  switch (k) {
    case "w": camera.moveForward(step); break;
    case "s": camera.moveBackward(step); break;
    case "a": camera.moveLeft(step); break;
    case "d": camera.moveRight(step); break;
    case "q": camera.moveUp(step); break;
    case "e": camera.moveDown(step); break;
    case "arrowleft": camera.lookLeft(look); break;
    case "arrowright": camera.lookRight(look); break;
    case "arrowup": camera.lookUp(look); break;
    case "arrowdown": camera.lookDown(look); break;
  }
}
viewer.clock.onTick.addEventListener(() => { for (const k of keys) applyKey(k); });

// camera altitude readout
function altText(m) {
  if (m < 1000) return Math.round(m) + " m";
  if (m < 1e6) return Math.round(m / 1000).toLocaleString() + " km";
  const km = m / 1000;
  return km.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " km" + (m > 3.5e8 ? " · near the Moon" : m > 1e7 ? " · in space" : m > 1e5 ? " · above the atmosphere" : "");
}
scene.postRender.addEventListener(() => { $("#altVal").textContent = altText(camHeight()); });

// ---------- UI ----------
document.querySelectorAll("#modes button").forEach((b) => b.onclick = () => {
  document.querySelectorAll("#modes button").forEach((x) => x.classList.toggle("on", x === b));
  state.mode = b.dataset.mode;
  $("#legend").style.display = state.mode === "ships" ? "none" : "";
  refresh();
});
$("#search").oninput = (e) => { state.query = e.target.value.trim().toLowerCase(); render(); };
$("#search").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const first = [...state.bb.values()][0];
  if (first) {
    camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(first._obj.lon, first._obj.lat, heightOf(first._kind, first._obj) + 40000), duration: 2 });
    select(first.id);
  }
};
$("#milBtn").onclick = () => {
  state.milOnly = !state.milOnly;
  $("#milBtn").classList.toggle("on", state.milOnly);
  if (state.milOnly && state.mode === "ships") $("#modes button[data-mode=planes]").click();
  else refresh();
  if (state.milOnly) {
    camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-20, 35, 2.2e7), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 }, duration: 3 });
    toast("Showing every military aircraft currently broadcasting");
  }
};
$("#locBtn").onclick = () => navigator.geolocation?.getCurrentPosition(
  (p) => camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(p.coords.longitude, p.coords.latitude, 6e5), duration: 3 }),
  () => toast("Location unavailable")
);
$("#mapStyle").onchange = (e) => setImagery(e.target.value);
$("#bordersBtn").onclick = () => showBorders(!politicalDS.show);
$("#terrainBtn").onclick = () => setTerrain(!terrainOn);
showBorders(true);
setTerrain(true);

// day & night panel
$("#sunBtn").onclick = () => {
  const p = $("#sunPanel"), open = p.style.display !== "block";
  p.style.display = open ? "block" : "none";
  if (open) { $("#help").style.display = "none"; $("#radioPanel").style.display = "none"; if (state.selected) deselect(); }
};
function applySun() {
  sun.on = $("#sunOn").checked;
  globe.enableLighting = sun.on;
  globe.showGroundAtmosphere = true;
  if (sun.nightLayer) sun.nightLayer.nightAlpha = sun.on && $("#lightsOn").checked ? 0.9 : 0;
  $("#sunBtn").classList.toggle("on", sun.on);
  updateSun();
}
$("#sunOn").onchange = applySun;
$("#lightsOn").onchange = applySun;
$("#sunSlider").oninput = (e) => { sun.offsetH = +e.target.value; updateSun(); };
$("#sunNow").onclick = () => { stopSunPlay(); sun.offsetH = 0; $("#sunSlider").value = 0; updateSun(); };
let sunPlayTimer = null;
function stopSunPlay() { clearInterval(sunPlayTimer); sunPlayTimer = null; $("#sunPlay").innerHTML = icon("play") + "Watch a day"; }
stopSunPlay();
$("#sunPlay").onclick = () => {
  if (sunPlayTimer) return stopSunPlay();
  $("#sunPlay").innerHTML = icon("pause") + "Pause";
  if (sun.offsetH >= 24) sun.offsetH = -24;
  sunPlayTimer = setInterval(() => {   // 7.5 hours per second: a full day in about 3 seconds
    sun.offsetH += 0.125;
    if (sun.offsetH > 24) sun.offsetH = -24;
    $("#sunSlider").value = sun.offsetH;
    updateSun();
  }, 1000 / 60);
};
$("#sunFly").onclick = () => {
  const p = subsolarPoint(sunTime());
  camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 2.2e7), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 }, duration: 3 });
};
applySun();
$("#helpBtn").onclick = () => { const h = $("#help"); h.style.display = h.style.display === "block" ? "none" : "block"; };

function refresh() {
  if (state.mode === "ships") state.planes.clear();
  if (state.mode === "planes") state.ships.clear();
  render(); fetchPlanes(); fetchShips();
}
let moveTimer;
camera.moveEnd.addEventListener(() => { clearTimeout(moveTimer); moveTimer = setTimeout(() => { if (!state.milOnly) fetchPlanes(); fetchShips(); }, 400); });

setInterval(fetchPlanes, 8000);
setInterval(fetchShips, 20000);
refresh();
