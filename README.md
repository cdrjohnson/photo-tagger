# Photo Tagger

**Live app: <https://cdrjohnson.github.io/photo-tagger/>** (open it on your phone or laptop; no sign-up, nothing is uploaded)

Bring in photos from your **phone, laptop and Dropbox**, have each one **tagged automatically from what's in it**, then **filter by tag** in a fast, clean interface. Everything runs **in your browser**: the AI model, the tagging and the storage. **No photo ever leaves your device**, and there is no server and no paid API key.

It is an installable web app (PWA) – open it on your laptop or phone, then "install" it for a home-screen icon and offline use.

| Library | Filter by tags | Photo detail |
| --- | --- | --- |
| ![Library](docs/images/desktop-library.png) | ![Filtered](docs/images/desktop-filtered.png) | ![Detail](docs/images/desktop-detail.png) |

<p>
<img src="docs/images/mobile-library.png" width="230" alt="Phone: library">
<img src="docs/images/mobile-filters.png" width="230" alt="Phone: filters">
<img src="docs/images/mobile-detail.png" width="230" alt="Phone: detail">
<img src="docs/images/mobile-dark.png" width="230" alt="Phone: dark mode">
</p>

## Features

- **Ingest**: file picker, drag-and-drop, paste, whole folders (desktop), camera roll **or camera** (phones), and **Dropbox** (Dropbox Chooser, needs your own free app key – see [docs/DROPBOX_SETUP.md](docs/DROPBOX_SETUP.md)).
- **Automatic tags** from the image content with CLIP zero-shot classification over ~90 built-in labels (people, selfie, dog, cat, food, pizza, landscape, mountain, beach, city, night, document, receipt, screenshot, meme, art and more). Related tags are added automatically (dog → pets, animals).
- **Metadata tags** from EXIF: year taken, camera, and `geotagged` (GPS coordinates are shown on the photo with an OpenStreetMap link).
- **Quality checks**: `blurry`, `dark`, `bright` (thresholds adjustable).
- **Your own tags**: add or remove tags on one photo or on many at once. Tags you remove stay removed when you re-tag.
- **Your own vocabulary**: switch built-in labels off, or add custom labels ("lighthouse", "my dog Rex") and re-tag your whole library instantly.
- **Filter**: tag chips with counts, **AND / OR**, search box, date range, quality filter, sort. Counts update live as other filters change.
- **Multi-select** (checkbox, shift-click, long-press on phones) with bulk tag/untag, bulk export and bulk delete.
- **Export / import tags** as **JSON** (everything, including custom labels) or **CSV**.
- **Storage** in IndexedDB: thumbnail + a 2048 px copy per photo (optionally the full original). Nothing is uploaded.
- **Responsive**, touch-friendly, **dark mode** (auto / light / dark), keyboard shortcuts in the detail view (←, →, Esc).

## Quick start

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev          # http://localhost:5173/photo-tagger/
```

Production build and local preview:

```bash
npm run build        # type-checks, then builds to dist/
npm run preview      # http://127.0.0.1:4174/photo-tagger/
```

The first time you add a photo the app downloads the tagging model (~64 MB) from Hugging Face and caches it in the browser. After that tagging works offline.

### Run the tests

```bash
npx playwright install chromium     # once
npm run build
npm run test:e2e                    # 26 end-to-end tests in Chromium
npm run screenshots                 # regenerates docs/images/*.png
node scripts/smoke-live.mjs         # smoke-test the deployed site (real network)
```

The e2e suite uses the real model and the sample photos in [`samples/`](samples/) (CC0 / public domain, see [`samples/ATTRIBUTION.md`](samples/ATTRIBUTION.md)). Model files are cached under `.model-cache/` after the first run so later runs are quick. Dropbox is exercised against a stubbed Chooser (a real key is not needed and none is used).

## Install on your phone (and laptop)

The live link above is already HTTPS. Installing needs the app to be served over **HTTPS** (browsers only allow service workers, install prompts and the model cache on secure origins). `http://192.168.x.x:5173/photo-tagger/` from your laptop will let you *try* the app on a phone, but it can't be installed and the model cache may not persist.

1. **Host it over HTTPS.** This repo already deploys to GitHub Pages (**Settings → Pages → Source: GitHub Actions**): the workflow in `.github/workflows/deploy.yml` builds and publishes every push to `main` at <https://cdrjohnson.github.io/photo-tagger/>. If you fork it under another name, set the base path to match (`BASE_PATH=/your-repo/ npm run build`, or edit the default in `vite.config.ts`). For another static host (Netlify, Cloudflare Pages, …) build with `BASE_PATH=/` and upload `dist/`.
2. **Open that address on your phone.**
   - **iPhone / iPad (Safari):** Share button → **Add to Home Screen**.
   - **Android (Chrome):** ⋮ menu → **Install app** (or *Add to Home screen*).
   - **Laptop (Chrome / Edge):** click the install icon at the right of the address bar.
3. Open it once while online and add a photo, so the model downloads. From then on it works offline.
4. Tip: on a phone, *Add photos → Choose photos* opens your camera roll (or Files), and *Take a photo* opens the camera.

Your library lives **per browser and per device** (it is stored in that browser's IndexedDB). To move tags between devices, use **Settings → Data → Export / Import** and add the same photos on both.

## How it works

| Step | Technology |
| --- | --- |
| Decode, thumbnails, EXIF, quality | Canvas + [exifr](https://github.com/MikeKovarik/exifr); blur = variance of the Laplacian (exposure-normalised), exposure = mean luma |
| Tagging model | **CLIP ViT-B/32** (OpenAI, MIT) via [Transformers.js](https://huggingface.co/docs/transformers.js) + ONNX Runtime Web (WebAssembly, in a Web Worker) |
| Zero-shot labels | Each label has a few text prompts ("a photo of a dog"…). Their text embeddings are **pre-computed at build time** (`npm run labels:embed`), so only the image tower is downloaded. A photo's image embedding is compared to every label, a softmax gives confidences, and labels above the threshold become tags |
| Re-tagging | Image embeddings are stored, so changing labels or the threshold re-tags the library instantly without re-running the model |
| Storage | IndexedDB (via `idb`): photos, thumbnails, 2048 px copies, embeddings, settings |
| PWA | `vite-plugin-pwa` (Workbox) precaches the app; ONNX Runtime wasm is served from the app's own origin and cached |

**Model and size.** `Xenova/clip-vit-base-patch32`, vision tower in 4-bit (`vision_model_q4.onnx`, **63.6 MB**), downloaded once from Hugging Face. Custom labels additionally load the text tower (`text_model_q4f16.onnx`, **72.5 MB**) the first time you add one. The ONNX Runtime wasm (14 MB) ships with the app.

**Privacy.** Photos, thumbnails, tags and embeddings never leave the device. The only network requests are: the one-time model download (Hugging Face), the Dropbox Chooser and downloads when *you* use Dropbox import, and OpenStreetMap when you click a location link.

## Limits worth knowing

- **First tag is slow, later ones are fast.** The model is ~64 MB and must be downloaded and initialised once (a few seconds on broadband; longer on mobile data). Tagging then took about **0.5 s per photo** (including decoding, thumbnails and EXIF) in headless Chromium on the 8-core machine used to build this. Phones are slower – I have not measured one, but expect a few times that – and the work runs in a background worker so the interface stays responsive.
- **Dropbox needs your own app key** ([setup guide](docs/DROPBOX_SETUP.md)). The Dropbox pop-up and download links need an internet connection.
- **CLIP is a general-purpose model**: it is great at scenes and common objects, weaker on fine detail (breeds, small text) and sometimes picks a plausible-but-wrong neighbour. Adjust the confidence slider, edit tags by hand, or add custom labels.
- **Browser storage**: browsers limit how much a site may store. By default only a 2048 px copy + thumbnail is kept per photo (≈0.3–1 MB each); turn on *Keep full-size originals* if you need them. Clearing site data erases the library.
- **HEIC** photos are only readable where the browser can decode them (Safari/iOS convert them to JPEG when you pick from the camera roll; desktop Chrome cannot decode HEIC).
- Single-threaded WebAssembly is used (static hosts such as GitHub Pages cannot send the headers that multi-threading needs). WebGPU is not used yet.

## Project layout

```
src/            React + TypeScript app (App.tsx, store.tsx, components/)
src/ml/         CLIP web worker, client, pre-computed label embeddings
src/labels.ts   the built-in label vocabulary (edit, then `npm run labels:embed`)
scripts/        e2e tests, screenshots, sample fetcher, icon + embedding generators
samples/        public-domain test photos (+ ATTRIBUTION.md)
docs/           user guide, Dropbox setup, screenshots
```

To change the built-in labels: edit `src/labels.ts`, run `npm run labels:embed` (downloads the full-precision text model once, in Node) and rebuild.

## Documentation

- [User guide](docs/USER_GUIDE.md)
- [Dropbox setup](docs/DROPBOX_SETUP.md)

## License

[MIT](LICENSE) © 2026 cdrjohnson. Third-party components and the CLIP model are listed in [NOTICE](NOTICE).
