# SkyTide — free live flight & ship tracker

Run it on your computer: double-click **Start SkyTide.bat** (Windows) or run `node server.js`
(needs Node 22+, nothing to install), then open http://localhost:8080

## Put it online for free, with your own domain

**1. Put the code on GitHub** (free account at github.com)
- Click **+ → New repository**, name it `skytide`, keep it **Public**, click **Create repository**.
- Click **uploading an existing file**, drag in everything from this folder
  (`server.js`, `package.json`, `render.yaml`, `public/`…), then **Commit changes**.

**2. Host it on Render** (free, no credit card)
- Sign up at render.com with your GitHub account.
- **New → Blueprint**, pick the `skytide` repo, click **Apply**. Render reads `render.yaml` and builds it.
- After a minute it's live at `https://skytide-xxxx.onrender.com`, worldwide, with HTTPS.

**3. Get a domain**
- Free: a subdomain like `skytide.is-a.dev` (is-a.dev, request via GitHub) or `skytide.dpdns.org` (DigitalPlat FreeDomain).
- Your own `.com` or similar: about $2–12 a year from Cloudflare, Porkbun or Namecheap.

**4. Connect the domain**
- In Render: your service → **Settings → Custom Domains → Add**, type your domain.
- At your domain provider, add the DNS record Render shows you (a `CNAME` to your `onrender.com`
  address, or an `A` record for a root domain). Back in Render click **Verify**; HTTPS is set up automatically.
- In Render: **Environment** → set `ALLOWED_HOSTS` to your domain (e.g. `skytide.is-a.dev`, comma-separate several) → **Save**.
  SkyTide refuses unknown domain names for security, so this step is required.

**Free plan limits:** the site sleeps after 15 minutes with no visitors, and the next visit takes about a minute to wake it.
750 free hours a month covers one site running all month. Upgrading to Render's paid Starter plan removes the sleep.

## Features
- 3D globe (CesiumJS): zoom from street level all the way out to space — stars, sun, moon, real day/night line
- Fly around: scroll / + − to zoom, Ctrl+drag to tilt, WASD to fly, Q/E up/down, arrow keys to look around, Space = jump to space, H = home
- Map styles: Satellite, Geographical (relief, rivers, place names) or Street
- 🏳 Borders overlay (country lines, light colour tint, names) on top of any map style
- ⛰ Real 3D mountains (Esri World Elevation, free, no key): tilt with Ctrl+drag to see them
- ☀ Day/Night from the sun's real position: night shading at every zoom, NASA city lights on the night side, sun-overhead marker, ±24 h time slider and "Watch a day"
- "Side view" to see a plane at its real altitude
- 📻 World radio: 15,000+ live stations as orange dots on the globe. Click to listen, search, random, "near view"
- 🎧 ATC & marine comms: click a plane for nearest airports (opens LiveATC's free player) plus nearby aviation/scanner streams; click a ship for nearby marine VHF/coast streams
- Live aircraft map, refreshed every 8 s, coloured by altitude
- **Military only** mode: every military aircraft broadcasting worldwide (unfiltered)
- Live ship map (Both / Ships tabs)
- Click any plane or ship for details (type, registration, altitude, speed, squawk, destination…)
- Flight/ship trail, Follow and Zoom-to buttons
- Search by callsign, registration, hex, ship name or MMSI (Enter jumps to the first match)
- "Me" button to center on your location

## Data sources (all free)
| What | Source | Key needed |
|---|---|---|
| Aircraft (incl. military/private) | adsb.lol | No |
| Ships – Baltic / Nordic | Digitraffic (Finland) | No |
| Ships – worldwide (optional) | aisstream.io | Free key |
| Map | OpenStreetMap / Esri satellite | No |
| Radio stations & comms streams | radio-browser.info (cached in `data/`) | No |
| Airports (for ATC) | OurAirports | No |
| Tower audio | liveatc.net (opens their player) | No |

For worldwide ships, get a free key at https://aisstream.io and start with:

```
$env:AISSTREAM_KEY="your-key"; node live-tracker/server.js
```
