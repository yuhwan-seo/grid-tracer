# Grid Trace — My footprint grid map

A personal web app (PWA) that overlays a GIS grid on satellite imagery and, linked to your phone's GPS, **paints the grid cells you've walked through in red**.
It runs entirely as static files (no server needed) and can be hosted directly on GitHub Pages for use in a phone browser.

## Folder structure

```
gps-grid-map/
├── index.html                    # main screen
├── manifest.json                 # PWA config (for "Add to Home Screen")
├── service-worker.js             # offline cache (app shell only — tiles/grid always fetched fresh)
├── css/style.css
├── js/app.js                     # map, GPS, and grid visit-detection logic
├── icons/icon-192.png, icon-512.png
└── data/rissho32654_5m.geojson   # grid data (bring your own, EPSG:32654)
```

## 1. Adding your own GIS grid data

Replace `data/rissho32654_5m.geojson` with your own **GeoJSON FeatureCollection** (`js/app.js`'s `DEFAULT_GRID_URL` points at this filename — if you use a different name, update that constant too).

- Each feature should be one `Polygon` (or `MultiPolygon`) representing a single grid cell.
- If `properties.id` is present, it's used as the cell's unique ID; otherwise the array index is used.
- Any resolution works — 1m, 3m, 5m, etc. The app uses the polygon geometry as-is and doesn't compute cell size separately.

### Coordinate reference system (CRS)

The app automatically converts **EPSG:32654 (UTM Zone 54N)** coordinates to WGS84 (lon/lat) — see `SOURCE_CRS` and `proj4.defs(...)` in `js/app.js`. In other words, if your GeoJSON coordinates are large numbers in meters (e.g. `430000, 4000000`), you can drop the file in as-is — no manual conversion needed.

- Coordinates that already look like lon/lat (roughly `longitude 128–146, latitude 24–46`) are left unchanged — the app auto-detects this from the value range.
- EPSG:32654 (zone 54N) is correct for areas around 138–144°E (e.g. Kumagaya). If you're working in a different UTM zone (e.g. still zone 54N for Tokyo, zone 53N for Okinawa, etc.), update `SOURCE_CRS` and the `zone` value in `proj4.defs(...)` at the top of `js/app.js`.
- When a conversion actually happens, a "Coordinates converted" toast appears once on launch.

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "id": "c0" },
      "geometry": { "type": "Polygon", "coordinates": [[[430123.4, 3997654.3], ...]] }
    }
  ]
}
```

**Notes**
- To test quickly without deploying, use the 📄 button at the bottom of the app to load a GeoJSON file directly from your device (it's loaded into browser memory only — nothing is written back to the repo).
- A very dense grid (e.g. 1m resolution over a wide area) increases file size and rendering cost. It's best to start with just your area of activity (a campus, a neighborhood).
- Visit detection is a point-in-polygon check using the GPS coordinate (WGS84). Near a cell boundary, the GPS fix needs to land just inside the polygon to count as a visit.

## 2. Deploying to GitHub Pages

1. Push this entire folder to a new GitHub repository.
2. In the repo, go to **Settings → Pages** and set Source to `Deploy from a branch`, branch `main` (or whichever you use), folder `/root`.
3. After a few minutes it will be live at `https://<your-username>.github.io/<repo-name>/`.
4. **GPS only works over HTTPS** — GitHub Pages serves HTTPS by default, so no extra setup is needed there.

## 3. Using it on your phone

- Open the deployed URL in your phone's browser (Safari/Chrome) and choose **"Add to Home Screen"** — you'll get an icon that launches full-screen like a native app (PWA).
- On first launch, a location-permission prompt appears — you must **allow** it for GPS tracking to work.
- Bottom controls:
  - ▶︎ (red circular button): start / stop GPS tracking
  - crosshair icon: toggle follow-my-location on the map
  - 📄: load a local GeoJSON grid file
  - 🗑: clear the visit history (red cells) for the currently loaded grid
  - ⬇: export the current grid + visit state as a GeoJSON file

## 4. How data is stored

- The list of visited cell IDs is stored in the browser's **localStorage**, keyed per grid dataset. Nothing is sent to a server — it stays on that device and browser only (and is cleared if the app or browser data is removed).
- Changing the grid data (geometry, coordinates, etc.) is detected as a new dataset, so it won't mix with previous progress.
- To sync across multiple devices, you'd add a backend (Firebase, Supabase, etc.) and swap out `saveVisited()` / `loadVisitedFor()` for API calls.

## 5. Customization points (js/app.js)

| Item | Location |
|---|---|
| Default map center | `setView([lat, lon], zoom)` in `initMap()` |
| Satellite tile source | the `L.tileLayer(...)` URL in `initMap()` (currently Esri World Imagery — free, no key needed) |
| Visited-cell color | the `--red` variable in `css/style.css`, and `styleForCell()` in `app.js` |
| GPS accuracy / polling options | `enableHighAccuracy`, `maximumAge`, `timeout` in `startTracking()` |

## Known limitations

- Esri World Imagery's free tier is intended for personal/non-commercial use and may be rate-limited under very heavy traffic. Swap in Mapbox Satellite or similar if needed.
- Point-in-polygon lookup can slow down once the grid grows into the tens of thousands of polygons (it's bbox-filtered first, then checked precisely). Splitting your area into multiple GeoJSON files is recommended for large regions.
- iOS Safari restricts GPS tracking while the app is backgrounded (screen off / app switched away). The app assumes the screen stays on during use.
