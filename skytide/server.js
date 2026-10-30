// SkyTide live tracker — tiny zero-dependency server.
// Serves the site and proxies free data sources (no CORS issues, no paid APIs).
//   Aircraft: adsb.lol (free, unfiltered, includes military)
//   Ships:    Digitraffic AIS (free, no key, Baltic/Nordic waters)
//             AISStream.io (free key, worldwide) — optional: set AISSTREAM_KEY
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
// Only this computer can reach the server unless you opt in with HOST=0.0.0.0
// On a host like Render the app sits behind their HTTPS proxy and must listen publicly
const BEHIND_PROXY = process.env.TRUST_PROXY === "1" || process.env.RENDER === "true";
const HOST = process.env.HOST || (BEHIND_PROXY ? "0.0.0.0" : "127.0.0.1");
// Host names the server answers to (blocks DNS-rebinding attacks from other websites)
// Set ALLOWED_HOSTS=yourdomain.com,www.yourdomain.com when you add a custom domain
const ALLOWED_HOSTS = new Set([
  "localhost", "127.0.0.1", "[::1]",
  process.env.RENDER_EXTERNAL_HOSTNAME, // e.g. skytide.onrender.com (Render sets this automatically)
  ...(process.env.ALLOWED_HOSTS || "").split(","),
].map((h) => (h || "").trim().toLowerCase()).filter(Boolean));
const AIS_KEY = process.env.AISSTREAM_KEY || "";
const PUBLIC = path.join(__dirname, "public");
const UA = { "User-Agent": "SkyTide/1.0", "Digitraffic-User": "SkyTide/1.0" };

const cache = new Map();
const inflight = new Map(); // many viewers asking for the same thing at once share one upstream request
function cachedJson(url, ttlMs) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.data);
  if (!inflight.has(url)) inflight.set(url, fetchJson(url, hit).finally(() => inflight.delete(url)));
  return inflight.get(url);
}
// Many different map positions create many cache keys, so drop old entries regularly
setInterval(() => { const cutoff = Date.now() - 10 * 60 * 1000; for (const [k, v] of cache) if (v.t < cutoff) cache.delete(k); }, 60 * 1000);
async function fetchJson(url, hit) {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    const data = await res.json();
    cache.set(url, { t: Date.now(), data });
    return data;
  } catch (e) {
    if (hit) return hit.data; // upstream busy/rate-limited: serve the last good copy
    throw e;
  }
}

// ---------- Ships ----------
const ships = new Map(); // mmsi -> ship
const clean = (v, max = 40) => (v == null ? v : String(v).replace(/[\u0000-\u001f]/g, "").trim().slice(0, max));
let vesselMeta = new Map();
let metaLoadedAt = 0;

async function refreshDigitraffic() {
  try {
    if (Date.now() - metaLoadedAt > 30 * 60 * 1000) {
      const meta = await cachedJson("https://meri.digitraffic.fi/api/ais/v1/vessels", 30 * 60 * 1000);
      vesselMeta = new Map(meta.map((v) => [v.mmsi, v]));
      metaLoadedAt = Date.now();
    }
    const since = Date.now() - 15 * 60 * 1000;
    const geo = await cachedJson(`https://meri.digitraffic.fi/api/ais/v1/locations?from=${since}`, 20 * 1000);
    for (const f of geo.features || []) {
      const p = f.properties;
      const m = vesselMeta.get(f.mmsi) || {};
      const prev = ships.get(f.mmsi) || {};
      ships.set(f.mmsi, {
        ...prev,
        mmsi: f.mmsi,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        sog: p.sog,
        cog: p.cog,
        heading: p.heading === 511 ? p.cog : p.heading,
        navStat: p.navStat,
        name: clean(m.name || prev.name || ""),
        callSign: clean(m.callSign || prev.callSign, 12),
        shipType: m.shipType ?? prev.shipType,
        destination: clean(m.destination || prev.destination),
        draught: m.draught || prev.draught,
        imo: m.imo || prev.imo,
        source: "Digitraffic",
        t: p.timestampExternal || Date.now(),
      });
    }
  } catch (e) {
    console.warn("Digitraffic:", e.message);
  }
}

function startAisStream() {
  if (!AIS_KEY) return;
  if (typeof WebSocket === "undefined") return console.warn("AISStream needs Node 22+");
  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
  ws.onopen = () => {
    console.log("AISStream connected (worldwide ships)");
    ws.send(JSON.stringify({
      APIKey: AIS_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ["PositionReport", "ShipStaticData", "StandardClassBPositionReport"],
    }));
  };
  ws.onmessage = async (ev) => {
    try {
      const text = typeof ev.data === "string" ? ev.data : await new Response(ev.data).text();
      const msg = JSON.parse(text);
      const md = msg.MetaData || {};
      const mmsi = md.MMSI;
      if (!mmsi) return;
      const prev = ships.get(mmsi) || { mmsi };
      const s = { ...prev, name: clean(md.ShipName || prev.name || ""), source: "AISStream", t: Date.now() };
      const pr = msg.Message?.PositionReport || msg.Message?.StandardClassBPositionReport;
      if (pr) {
        Object.assign(s, {
          lat: md.latitude, lon: md.longitude, sog: pr.Sog, cog: pr.Cog,
          heading: pr.TrueHeading === 511 ? pr.Cog : pr.TrueHeading, navStat: pr.NavigationalStatus,
        });
      }
      const sd = msg.Message?.ShipStaticData;
      if (sd) Object.assign(s, { callSign: clean(sd.CallSign, 12), shipType: sd.Type, destination: clean(sd.Destination), imo: sd.ImoNumber, draught: sd.MaximumStaticDraught });
      if (s.lat != null) ships.set(mmsi, s);
    } catch {}
  };
  ws.onclose = () => { console.warn("AISStream closed, reconnecting in 10s"); setTimeout(startAisStream, 10000); };
  ws.onerror = () => {};
}

function pruneShips() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, s] of ships) if (s.t < cutoff) ships.delete(k);
}

// ---------- Radio (Radio Browser: free, open directory of internet radio) ----------
const dns = require("dns").promises;
const DATA = path.join(__dirname, "data");
fs.mkdirSync(DATA, { recursive: true });
const COMMS_TAGS = ["atc", "air traffic control", "aviation", "airport", "airband", "scanner", "police scanner", "marine", "maritime", "vhf", "coast guard", "ham radio"];
let radio = { stations: loadJson("stations.json") || [], comms: loadJson("comms.json") || [], at: 0 };
// Used only while the directory is unreachable and nothing is cached yet (all checked working, free public streams)
const BACKUP_STATIONS = [
  ["BBC World Service", "https://stream.live.vc.bbcmedia.co.uk/bbc_world_service", "The United Kingdom", "GB", 51.52, -0.14, "news,talk"],
  ["Classic FM", "https://media-ice.musicradio.com/ClassicFMMP3", "The United Kingdom", "GB", 51.51, -0.13, "classical"],
  ["FIP", "https://icecast.radiofrance.fr/fip-midfi.mp3", "France", "FR", 48.85, 2.28, "eclectic,jazz"],
  ["France Inter", "https://icecast.radiofrance.fr/franceinter-midfi.mp3", "France", "FR", 48.86, 2.29, "news,talk"],
  ["Deutschlandfunk", "https://st01.sslstream.dlf.de/dlf/01/128/mp3/stream.mp3", "Germany", "DE", 50.94, 6.96, "news,talk"],
  ["Radio Swiss Jazz", "https://stream.srg-ssr.ch/m/rsj/mp3_128", "Switzerland", "CH", 47.56, 7.59, "jazz"],
  ["NPR News", "https://npr-ice.streamguys1.com/live.mp3", "The United States", "US", 38.9, -77.0, "news,talk"],
  ["WNYC 93.9 FM", "https://fm939.wnyc.org/wnycfm", "The United States", "US", 40.73, -74.0, "news,talk"],
  ["SomaFM Groove Salad", "https://ice1.somafm.com/groovesalad-128-mp3", "The United States", "US", 37.77, -122.42, "ambient,chill"],
  ["SomaFM Drone Zone", "https://ice1.somafm.com/dronezone-128-mp3", "The United States", "US", 37.78, -122.41, "ambient,space"],
  ["Radio Paradise", "https://stream.radioparadise.com/mp3-128", "The United States", "US", 39.73, -121.84, "eclectic,rock"],
  ["1.FM Jamz", "https://strm112.1.fm/jamz_mobile_mp3", "Switzerland", "CH", 46.2, 6.15, "hip-hop,r&b"],
].map(([name, url, country, cc, lat, lon, tags]) => ({ id: "backup-" + name.toLowerCase().replace(/\W+/g, "-"), name, url, country, cc, lat, lon, tags, codec: "MP3" }));

function loadJson(name) { try { return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8")); } catch { return null; } }
function saveJson(name, data) { fs.writeFile(path.join(DATA, name), JSON.stringify(data), () => {}); }

async function radioHosts() {
  let hosts = [];
  try { hosts = (await dns.resolveSrv("_api._tcp.radio-browser.info")).map((s) => s.name); } catch {}
  return [...new Set([...hosts, "de1.api.radio-browser.info", "de2.api.radio-browser.info", "all.api.radio-browser.info"])];
}
async function radioGet(pathAndQuery) {
  let lastErr;
  for (const host of await radioHosts()) {
    try {
      const res = await fetch(`https://${host}${pathAndQuery}`, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`${host} ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const httpUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
const slim = (s) => ({
  id: s.stationuuid, name: clean(s.name, 120), url: httpUrl(s.url_resolved) || httpUrl(s.url), country: s.country, cc: s.countrycode,
  tags: clean(s.tags, 200), lat: s.geo_lat, lon: s.geo_long, icon: httpUrl(s.favicon), codec: s.codec, br: s.bitrate, hls: s.hls === 1,
});
async function refreshRadio() {
  try {
    const all = await radioGet("/json/stations/search?has_geo_info=true&hidebroken=true&order=clickcount&reverse=true&limit=15000");
    radio.stations = all.filter((s) => !s.hls).map(slim).filter((s) => s.lat != null && s.url);
    saveJson("stations.json", radio.stations);
    const seen = new Map();
    for (const tag of COMMS_TAGS) {
      const list = await radioGet(`/json/stations/search?tag=${encodeURIComponent(tag)}&hidebroken=true&limit=1000`);
      for (const s of list) if (!seen.has(s.stationuuid)) seen.set(s.stationuuid, { ...slim(s), kind: /marine|maritime|vhf|coast/i.test(s.tags) ? "marine" : /scanner|police|ham/i.test(s.tags) && !/atc|air|aviation/i.test(s.tags) ? "scanner" : "atc" });
    }
    radio.comms = [...seen.values()].filter((s) => s.url && !s.hls);
    saveJson("comms.json", radio.comms);
    radio.at = Date.now();
    console.log(`Radio: ${radio.stations.length} stations, ${radio.comms.length} comms streams`);
  } catch (e) {
    console.warn("Radio Browser unavailable (will retry):", e.message);
    if (!radio.stations.length) setTimeout(refreshRadio, 2 * 60 * 1000);
  }
}

// ---------- Airports (OurAirports, public domain) for ATC lookups ----------
let airports = loadJson("airports.json") || [];
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}
async function loadAirports() {
  if (airports.length) return;
  try {
    const text = await (await fetch("https://davidmegginson.github.io/ourairports-data/airports.csv", { headers: UA })).text();
    const lines = text.split("\n");
    const head = parseCsvLine(lines[0]);
    const col = (n) => head.indexOf(n);
    const [cType, cName, cLat, cLon, cCity, cCountry, cIcao, cGps, cIata, cSched] =
      ["type", "name", "latitude_deg", "longitude_deg", "municipality", "iso_country", "icao_code", "gps_code", "iata_code", "scheduled_service"].map(col);
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const r = parseCsvLine(line);
      if (r[cType] !== "large_airport" && r[cType] !== "medium_airport") continue;
      const icao = r[cIcao] || r[cGps];
      if (!icao || icao.length !== 4) continue;
      airports.push({ icao, iata: r[cIata], name: r[cName], city: r[cCity], cc: r[cCountry], lat: +r[cLat], lon: +r[cLon], big: r[cType] === "large_airport", sched: r[cSched] === "yes" });
    }
    saveJson("airports.json", airports);
    console.log(`Airports: ${airports.length}`);
  } catch (e) { console.warn("Airports:", e.message); }
}

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * toR) / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(((lon2 - lon1) * toR) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

refreshRadio();
setInterval(refreshRadio, 30 * 60 * 1000); // retries if down, refreshes if up
loadAirports();

refreshDigitraffic();
setInterval(refreshDigitraffic, 30 * 1000);
setInterval(pruneShips, 60 * 1000);
startAisStream();

// ---------- HTTP ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

const zlib = require("zlib");

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net", // Cesium needs WebAssembly (still no JS eval)
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "img-src 'self' data: blob: https: http:",          // map tiles + station logos come from many hosts
  "connect-src 'self' https:",                          // map tiles / elevation are fetched by the globe
  "media-src https: http:",                             // radio streams (many are plain http)
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "object-src 'none'", "base-uri 'self'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");
const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(self), camera=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  // public deployments are HTTPS-only: tell browsers to never use plain http for this site
  ...(BEHIND_PROXY ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
};

// Simple per-visitor rate limit for /api (protects the free upstream services from being hammered through us)
const RATE = { windowMs: 60 * 1000, max: 240 };
const hits = new Map();
function rateLimited(req) {
  // behind a proxy every request comes from the proxy, so use the visitor address it forwards
  const fwd = BEHIND_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || req.socket.remoteAddress || "?";
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.start > RATE.windowMs) hits.set(ip, (h = { start: now, n: 0 }));
  return ++h.n > RATE.max;
}
setInterval(() => { const now = Date.now(); for (const [ip, h] of hits) if (now - h.start > RATE.windowMs) hits.delete(ip); }, RATE.windowMs);

const num = (v, min, max) => { const n = parseFloat(v); return Number.isFinite(n) && n >= min && n <= max ? n : NaN; };
const gzCache = new WeakMap(); // big, rarely-changing payloads (stations, countries) are compressed once

function send(res, code, type, body, extra = {}) {
  const gzipOk = /\bgzip\b/.test(res.req.headers["accept-encoding"] || "");
  const headers = { "Content-Type": type, "Cache-Control": "no-store", Vary: "Accept-Encoding", ...SECURITY_HEADERS, ...extra };
  if (gzipOk && body.length > 1024) {
    body = zlib.gzipSync(body, { level: 6 });
    headers["Content-Encoding"] = "gzip";
  }
  res.writeHead(code, headers);
  res.end(body);
}
function sendJson(res, code, obj, { cacheGzip = false } = {}) {
  const gzipOk = /\bgzip\b/.test(res.req.headers["accept-encoding"] || "");
  if (cacheGzip && gzipOk && obj && typeof obj === "object") {
    let gz = gzCache.get(obj);
    if (!gz) gzCache.set(obj, (gz = zlib.gzipSync(JSON.stringify(obj), { level: 6 })));
    res.writeHead(code, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Cache-Control": "no-store", Vary: "Accept-Encoding", ...SECURITY_HEADERS });
    return res.end(gz);
  }
  send(res, code, "application/json", Buffer.from(JSON.stringify(obj)));
}

// Only the aircraft fields the page uses (adsb.lol sends ~60 per plane)
const PLANE_FIELDS = ["hex", "flight", "r", "t", "desc", "ownOp", "alt_baro", "baro_rate", "geom_rate", "gs", "track", "true_heading", "squawk", "lat", "lon", "seen", "dbFlags"];
const slimPlanes = new WeakMap();
function planesPayload(data) {
  let out = slimPlanes.get(data);
  if (!out) {
    out = { ac: (data.ac || []).filter((a) => a.lat != null).map((a) => { const o = {}; for (const k of PLANE_FIELDS) if (a[k] != null) o[k] = a[k]; return o; }) };
    slimPlanes.set(data, out);
  }
  return out;
}

const stationsPayload = new WeakMap();
const staticCache = new Map();
let countries = null;

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD", ...SECURITY_HEADERS }); return res.end(); }
  // Hosting health checks arrive on an internal address, so answer them before the host check (no data exposed)
  if (req.url === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain", ...SECURITY_HEADERS }); return res.end("ok"); }
  const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  if (!ALLOWED_HOSTS.has(host)) { res.writeHead(421, SECURITY_HEADERS); return res.end("Unknown host"); }
  let url;
  try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400, SECURITY_HEADERS); return res.end(); }
  if (url.pathname.startsWith("/api/") && rateLimited(req)) return sendJson(res, 429, { error: "Too many requests, slow down a little" });
  try {
    if (url.pathname === "/api/planes") {
      const lat = num(url.searchParams.get("lat"), -90, 90);
      const lon = num(url.searchParams.get("lon"), -180, 180);
      const r = Math.min(250, Math.max(10, num(url.searchParams.get("r"), 0, 1e6) || 150));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return sendJson(res, 400, { error: "lat/lon required" });
      const key = `https://api.adsb.lol/v2/point/${lat.toFixed(1)}/${lon.toFixed(1)}/${Math.round(r)}`;
      return sendJson(res, 200, planesPayload(await cachedJson(key, 4000)), { cacheGzip: true });
    }
    if (url.pathname === "/api/military") {
      return sendJson(res, 200, planesPayload(await cachedJson("https://api.adsb.lol/v2/mil", 8000)), { cacheGzip: true });
    }
    if (url.pathname === "/api/ships") {
      const [s, w, n, e] = [["s", 90], ["w", 180], ["n", 90], ["e", 180]].map(([k, m]) => num(url.searchParams.get(k), -m, m));
      let list = [...ships.values()];
      if ([s, w, n, e].every(Number.isFinite)) list = list.filter((v) => v.lat >= s && v.lat <= n && v.lon >= w && v.lon <= e);
      if (list.length > 4000) list = list.slice(0, 4000);
      return sendJson(res, 200, { ships: list, total: ships.size, worldwide: !!AIS_KEY });
    }
    if (url.pathname === "/api/radio/stations") {
      const list = radio.stations.length ? radio.stations : BACKUP_STATIONS;
      let payload = stationsPayload.get(list);
      if (!payload) stationsPayload.set(list, (payload = { stations: list, updated: radio.at, ok: true, backup: list === BACKUP_STATIONS }));
      return sendJson(res, 200, payload, { cacheGzip: true });
    }
    if (url.pathname === "/api/countries") {
      // Natural Earth country borders (public domain), slimmed + cached on disk and in memory
      countries ??= loadJson("countries.json");
      if (!countries) {
        const ne = await cachedJson("https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_110m_admin_0_countries.geojson", 864e5);
        countries = ne.features.map((f) => ({
          name: f.properties.NAME, color: f.properties.MAPCOLOR7, rank: f.properties.LABELRANK,
          lx: f.properties.LABEL_X, ly: f.properties.LABEL_Y, geometry: f.geometry,
        }));
        saveJson("countries.json", countries);
      }
      return sendJson(res, 200, countries, { cacheGzip: true });
    }
    if (url.pathname === "/api/comms") {
      // nearest ATC / marine / scanner streams + nearest airports to a point
      const lat = num(url.searchParams.get("lat"), -90, 90), lon = num(url.searchParams.get("lon"), -180, 180);
      const kind = url.searchParams.get("kind") === "ship" ? "ship" : "plane";
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return sendJson(res, 400, { error: "lat/lon required" });
      const prefer = kind === "ship" ? ["marine", "scanner", "atc"] : ["atc", "scanner", "marine"];
      const streams = radio.comms
        .map((s) => ({ ...s, km: s.lat != null ? Math.round(distKm(lat, lon, s.lat, s.lon)) : null }))
        .sort((a, b) => prefer.indexOf(a.kind) - prefer.indexOf(b.kind) || (a.km ?? 1e9) - (b.km ?? 1e9))
        .filter((s) => s.kind === prefer[0] || (s.km != null && s.km < 300))
        .slice(0, 12);
      const near = airports
        .map((a) => ({ ...a, km: Math.round(distKm(lat, lon, a.lat, a.lon)) }))
        .sort((a, b) => a.km - (a.big ? 40 : 0) - (b.km - (b.big ? 40 : 0))) // nudge toward big airports (more likely on LiveATC)
        .slice(0, 4);
      return sendJson(res, 200, { streams, airports: near, radioOk: radio.comms.length > 0 });
    }
    // static
    if (url.pathname.includes("\0") || url.pathname.includes("..")) return sendJson(res, 400, { error: "bad path" });
    const file = path.resolve(PUBLIC, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: "forbidden" });
    // static files: kept in memory (re-read only when the file changes on disk)
    let stat;
    try { stat = await fs.promises.stat(file); } catch { return sendJson(res, 404, { error: "not found" }); }
    let hit = staticCache.get(file);
    if (!hit || hit.mtime !== stat.mtimeMs) staticCache.set(file, (hit = { mtime: stat.mtimeMs, buf: await fs.promises.readFile(file) }));
    const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304); return res.end(); }
    send(res, 200, MIME[path.extname(file)] || "application/octet-stream", hit.buf, { "Cache-Control": "no-cache", ETag: etag });
  } catch (e) {
    console.warn(req.url, "->", e.message); // details stay in the server log
    sendJson(res, 502, { error: "Data source is unavailable right now, retrying shortly" });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`Port ${PORT} is busy: SkyTide is probably already running. Open http://localhost:${PORT} or close the other window first.`);
  else console.error(e.message);
  process.exit(1);
});
server.listen(PORT, HOST,() => console.log(`SkyTide running at http://localhost:${PORT} (listening on ${HOST})`));
