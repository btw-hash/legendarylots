# LegendaryLots — Spin Wheel (Tech Spec)

**Source:** forwarded chat with Nox, 2026-07-08 (Nox task #184).
**One-liner:** a fortune-wheel randomizer where you upload a batch of images that auto-fill the wheel sectors (or type text options), spin with smooth deceleration, and highlight the winner. Branded LegendaryLots. Set up on a PC, spin on a tablet.

---

## Goal & scope

Simple, mostly static web app — a "крутилка" for giveaways/streams. MVP is deliberately small; stream/OBS integrations are explicitly deferred (see Out of scope). The one hard constraint that shapes the architecture: **configure on PC, run on tablet** — so the wheel setup must be portable between devices.

- Primary user: the owner (giveaways, streams).
- Devices: desktop browser (setup) + tablet/iPad browser (spinning). Touch-friendly.
- Reference UX: `spinthewheel.io/uk` — text list input, auto-colored sectors, spin with deceleration, winner popup.

---

## Requirements (REQ)

- **REQ-1 — Image mode.** User uploads a batch of images at once (drag & drop or file picker). Each image becomes one wheel sector automatically; sectors are laid out evenly around the wheel.
- **REQ-2 — Full-size preview on hover.** Hovering a sector image shows the picture in full format (overlay/lightbox). On touch devices, tap-and-hold or a "preview" tap acts as the hover equivalent.
- **REQ-3 — Text mode.** Alternative input: one line = one sector (like spinthewheel.io). Auto-colored sectors, readable font. User can switch between Image mode and Text mode.
- **REQ-4 — Spin.** A spin button (and a large touch target on tablet) rotates the wheel with smooth easing/deceleration and a fixed pointer. On stop: highlight the winning sector + a centered winner popup.
- **REQ-5 — LegendaryLots branding.** Logo placed on the page (header/corner). Brand accent colors on the wheel/UI.
- **REQ-6 — Cross-device portability (the key flow).** Set a wheel up on PC → use it on tablet. **Shipped in MVP as server save-by-code** (owner's forwarded chat pinned "нажал сохранить и открыл на айпаде" as a hard requirement): "Зберегти" → 8-char code + `/w/:id` link; open on the tablet by URL or by typing the code. Images upload to the server on add (webp, downscaled), so the wheel is fully portable. localStorage keeps an autosaved draft on the editing device.
- **REQ-7 — Tablet ergonomics.** Touch-friendly spin (tap/swipe to spin), large controls, layout works on iPad-sized screens.

---

## Non-functional

- **NFR-1** — Static-first: MVP is a single-page app (HTML/CSS/JS) deployable to any static host (Vercel/Netlify/GitHub Pages). No server required for MVP.
- **NFR-2** — Offline-capable after load (images live in the browser, not fetched per spin).
- **NFR-3** — Image handling: downscale/compress large uploads client-side (canvas) before storing, so localStorage / export files stay reasonable.
- **NFR-4** — Reasonable sector count (target up to ~30–50); above that, fall back to labels/thumbnails to keep the wheel readable.

---

## Tasks (TASK) — MVP build order

- **TASK-1** — Project skeleton: static SPA (plain Vite + TS, or React — builder's call), single page, LegendaryLots theme + logo (REQ-5).
- **TASK-2** — Wheel renderer: draw N sectors (canvas or SVG), fixed pointer, even angular layout, auto-color per sector (REQ-3/REQ-1).
- **TASK-3** — Text mode input: textarea, one line = sector, live re-render (REQ-3).
- **TASK-4** — Image mode: batch upload (drag & drop + picker), client-side downscale, render image inside each sector (REQ-1, NFR-3).
- **TASK-5** — Hover/tap full-size preview overlay (REQ-2).
- **TASK-6** — Spin physics: randomized target angle, eased deceleration, pointer collision → winner; winner highlight + centered popup (REQ-4).
- **TASK-7** — Persistence: serialize wheel (mode, sectors, images-as-base64, brand) → localStorage autosave + Export/Import file (REQ-6).
- **TASK-8** — Tablet pass: touch spin (tap/swipe), large buttons, responsive layout, verify on real iPad-sized viewport (REQ-7).
- **TASK-9** — Polish: winner popup styling, optional confetti + tick sound with a mute toggle (nice-to-have, keep light).

---

## Services / data (SVC)

- **SVC-STORE (MVP)** — Client-side only. Data model:
  ```
  Wheel {
    id, name, brand: "LegendaryLots",
    mode: "image" | "text",
    sectors: [{ label?, imageBase64?, color, weight? }]
  }
  ```
  Persisted to localStorage; Export/Import serializes the same object to a file.
- **SVC-CLOUD (v2, optional)** — Only if manual file transfer proves annoying. "Save" → upload wheel + images to object storage (e.g. S3/R2), return a short code/link; "Open by code" on the tablet pulls it down. Turns the app into a small app-with-backend; not part of MVP.

---

## Out of scope (v2+ / "на будущее")

Explicitly deferred per owner ("в целом пока это всё, просто нужна крутилка"):

- OBS / chroma-key (transparent background) browser-source mode for streaming.
- Fullscreen winner overlay for stream viewers.
- Hotkey to spin.
- Load options from Twitch/YouTube chat (`!add ...`).
- "Remove winner" multi-round giveaway mode.
- Weighted sectors (rare prizes).
- Share-by-link, win history, screenshot-for-stories, theme presets.
- Real cross-device cloud sync (SVC-CLOUD).

---

## Decisions taken (2026-07-08, at build time)

1. **Cross-device on day one:** promoted server save-by-code into MVP — the forwarded chat made "save on PC → open on iPad" a hard requirement, and a file-export flow doesn't survive that UX. Wheels are JSON files on disk, images deduped by content hash; no DB.
2. **Stack:** vanilla Vite+TS + Express (`server/index.ts`). No framework.
3. **Wheel tech:** canvas, whole rotating part baked to an offscreen bitmap (rotate-only frames); HTML overlay for the hover preview.
4. **Assets:** brand PNGs from the owner (`specs/`) → `public/logo.png` (hub + favicon + header). Skin derived from the logo: wood `#2E1A0C`, gold `#E0A82E`, felt `#1B57A6`; Forum + Alegreya Sans (cyrillic bundled).
5. **PC + tablet only** (owner: "моб респонсив не нужен"): drawer settings panel under 1100px, tap-to-spin, long-press preview.
6. **Radial labels invert on the left half at rest** — genre norm (spinthewheel.io behaves the same); deliberately not "fixed" since the wheel stops at arbitrary angles.

---

## Verification (before "done")

- Text mode: type 5 lines → 5 colored sectors → spin → winner highlighted + popup.
- Image mode: drop ~8 images → 8 sectors with pictures → hover shows full size → spin picks one.
- Portability: set up on desktop → Export file → Import on a second browser/tablet viewport → identical wheel.
- Tablet: tap/swipe spins; controls usable at iPad width; no mouse-only interactions.
