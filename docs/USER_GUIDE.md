
## Windows desktop app

Use the desktop build when your library is too large for a browser tab. Both an **installer** and a **portable zip** are published on [GitHub Releases](https://github.com/cdrjohnson/photo-tagger/releases/tag/desktop-v1.0.2).

### Installer
1. Download `Photo.Tagger_*_x64-setup.exe` (NSIS) or the `.msi`.
2. Run the installer (NSIS current-user mode does not need admin).
3. Open **Photo Tagger**.

### Portable (no install)
1. Download `Photo.Tagger_*_x64_portable.zip`.
2. Unzip anywhere (USB stick, Desktop, Documents).
3. Run `Photo Tagger.exe`. A `portable.txt` file in the folder makes settings live in `data/` beside the exe so they travel with the folder.
4. On first launch, click **Use folder next to the app** to use the included `library/` folder, or choose any other folder.

### Shared notes
1. **WebView2** is required (Windows 11 and most Windows 10 already have it).
2. Unsigned builds may trigger **SmartScreen** — More info → Run anyway. We do not ship a code-signing certificate.
3. Photo Tagger copies new photos (and Dropbox downloads) into your library folder and stores metadata under `.photo-tagger/` inside it. Originals always remain on disk.
4. Cancel + confirm for Dropbox works the same as on the web: already-added photos stay in the library.
5. “Save to folder” from the web app is unnecessary on desktop — your library folder *is* that location. You can still download a zip backup from Settings → Data.
6. Existing data from the **browser/PWA** is not imported automatically; add photos again (or copy files into the library folder and re-ingest).

Linux/macOS desktop ports are expected to reuse the same Tauri project later. iPhone/Android are out of scope for now.

# Photo Tagger – user guide

Photo Tagger looks at each photo, writes down what's in it as **tags** ("dog", "beach", "document"…), and lets you find photos by combining those tags. It all happens on your own device: **your photos are never uploaded**.

## 1. Add photos

Tap **＋ Add photos** (top right):

| Option | What it does |
| --- | --- |
| **Choose photos** | Opens your camera roll / gallery (on a phone) or a file picker (on a computer). Select as many as you like. |
| **Take a photo** | Phones: opens the camera and adds the shot. |
| **Add a folder** | Computers: adds every image inside a folder. |
| **From Dropbox** | Opens the Dropbox picker. Needs a one-time setup: see [Dropbox setup](DROPBOX_SETUP.md). While their dialog is open, Photo Tagger shows a waiting banner under the header (their dialog itself has no spinner). After **Choose**, the same banner tracks download/ingest progress (n/N, Cancel). Works even when the library is still empty. |

On a computer you can also **drag and drop** images anywhere on the page, or paste an image from the clipboard.

![Add menu](images/desktop-add-menu.png)

The first time, the app downloads its tagging model (about 64 MB) – a progress bar shows this. It is stored in the browser, so this only happens once. Photos you add again later (same name, size and date) are skipped as duplicates.

While a photo is being processed its tile shows *tagging…*; tags appear a moment later.

## 2. What the tags mean

Each photo can carry four kinds of tags, shown with a coloured dot:

- 🟣 **Detected in image** – found by the AI (for example `dog`, `pets`, `beach`, `city`, `screenshot`). In the detail view each shows its confidence.
- 🟢 **Added by you** – tags you typed yourself.
- 🟠 **From photo metadata** – the year it was taken, the camera, and `geotagged` if the photo has GPS coordinates.
- 🔴 **Quality check** – `blurry`, `dark` or `bright`.

## 3. Find photos

![Filtering](images/desktop-filtered.png)

- **Tag chips** (below the search bar) – tap one or more. The number on each chip is how many photos have it *given your other filters*. **All 27** (the number varies) shows every tag.
- **AND / OR** – with **AND** a photo must have *all* selected tags (`pets` AND `geotagged`); with **OR** it needs *any* of them.
- **Search** – matches file names, tag names and camera models ("pizza", "iphone").
- **Quality** – *Good only* hides blurry/dark/bright photos; or show just one of those kinds (handy for clean-up).
- **From / To** – date range, using the date the photo was taken (EXIF) or the file date if there isn't one.
- **Sort** – newest, oldest, recently added or by name.
- **Clear** resets the filters.

On a phone, the date, quality and sort controls fold into the **Filters ▾** button.

## 4. Look at one photo

Tap a photo to open it. From here you can:

![Detail](images/desktop-detail.png)

- **Add a tag**: type in the box and press Enter (separate several with commas; suggestions appear as you type).
- **Remove a tag**: tap the **×** on it. A detected tag you remove will not come back when you re-tag.
- See the **date, camera, GPS location** (tap the coordinates to open a map), size, sharpness and brightness.
- Move between photos with ‹ › (or the ← → keys). **Esc** closes.
- **Re-run tagging**, **Download** (the original if kept, otherwise the stored copy) or **Delete** (this only removes it from the app).

## 5. Work on many photos at once

Tap **Select** (or press and hold a photo on a phone, or tick the circle that appears on a tile). On a computer, **Shift-click** selects a range.

![Bulk tagging](images/desktop-bulk.png)

The bar at the bottom lets you **Select all** photos matching the current filter, edit **Tags…** (add tags to all selected photos, or remove a tag from all of them), **Export** just those photos' tags, or **Delete** them.

## 6. People (face naming)

Open the **People** tab at the top. The red badge counts suggestions waiting for you.

![People view](images/desktop-people.png)

- **Everything stays on this device.** Faces are found and compared by a ~12 MB model that runs in your browser. Face crops, face "fingerprints" (128 numbers per face) and names are kept only in this browser.
- **Find faces**: new photos are checked automatically. Photos added while recognition was off show a **Find faces** button.
- **Unnamed faces** are grouped – faces that look like the same person sit together. Type a name under a group and press **Name** to name them all, or tap individual faces first to name only those. Tap **×** on something that isn't a face (or someone you don't want to name) to ignore it.
- **Is this…?** After you name someone, other faces that look like them are suggested. Tap **✓** (yes) or **✕** (no), or **Yes to all**. A "no" is remembered: that face will not be suggested as that person again.
- **Match strictness**: move the slider left for fewer, safer suggestions, right to catch more (e.g. older photos or side views) – then review more carefully.
- **A person**: tap their card to see their faces, remove a wrong one (**×**), **Show photos**, **Rename**, **Merge into** another person (if you named someone twice), or **Delete person** (their faces go back to Unnamed; the photos are kept). Renaming to an existing name merges the two.
- **Person tags**: each named person becomes a tag (in its own colour, listed first in the chip bar). Filter with it like any tag – pick two people with **AND** for photos of both together, **OR** for either. Removing a person tag from a photo (in the photo or with bulk edit) tells the app that face isn't them.
- **Exports** (JSON / CSV) include person tags. Importing turns them into ordinary tags.
- **Privacy controls**: untick **Face recognition on** to stop checking new photos; **Clear all face data** (tap twice) deletes all faces, fingerprints, names and person tags.

On a phone the People view works the same way:

<img src="images/mobile-people.png" width="300" alt="People view on a phone">

## 7. Settings

Open **⚙️**.

### General
- **Confidence needed for a tag** – lower gives more tags per photo (and more mistakes); higher gives fewer, safer tags.
- **Maximum auto-tags per photo.**
- **Blur / Dark / Bright thresholds** – decide when the quality tags appear. For example, raise the blur threshold to flag more photos as blurry.
- **Keep full-size originals** – off by default to save space (each photo is stored as a 2048 px copy plus a thumbnail).
- **Model** – shows whether the model is loaded; you can download it ahead of time (handy on Wi-Fi before you travel).

Changes to tagging settings are applied to your whole library when you close Settings.

### Dropbox
Paste your Dropbox **app key** here. See [Dropbox setup](DROPBOX_SETUP.md).

When you import many photos, watch the **banner under the header** (visible even on an empty library): first “Choose files in the Dropbox window…” with a waiting bar, then “Downloading from Dropbox · n/N” (with a **Cancel** button). Each photo is tagged as soon as it finishes downloading, so it appears in your library during the import — Photo Tagger does not wait for the whole batch (that kept thousands of files in memory and could abort in Firefox). Failed downloads are retried a couple of times; any that still fail are summarised in one toast at the end, not a stack of red errors. If you hit **Cancel**, you get a confirm dialog: remaining downloads stop; photos already in your library stay. Choose **Keep downloading** if you tapped Cancel by mistake.

### Labels (the vocabulary)
![Labels](images/desktop-labels.png)

The photos are matched against a list of labels. You can:
- **Switch labels off** you don't want (for example `wedding`).
- **Add your own**: type a name ("lighthouse", "bike race", "my dog Rex") and, if you like, a short description such as *a photo of a lighthouse by the sea* – a good description improves accuracy. The first custom label downloads a small text model (about 72 MB, once).
- **Re-tag library now** applies changes immediately (also done automatically when you close Settings). This is quick, because the app remembers what each photo "looks like".
- **Reset labels** puts the built-in list back.

### Data

- **Duplicates** – exact copies (same bytes, even renamed) are skipped when you add photos. Near-duplicates open a review: **Skip new**, **Keep both**, or **Mark as duplicate**. **Find duplicates in library** scans what you already have. The **Near-duplicate sensitivity** slider (0–20, default 8) is the maximum dHash distance; lower = stricter.
- **Save photos to a drive** – copies the photos (original if kept, otherwise the 2048 px version) plus tags onto disk. On Chrome/Edge desktop you pick a folder (remembered for next time; optional auto-save of newly tagged photos). On Safari, Firefox and phones you get a **zip** download instead. Layout: `photos/` with each image and a `.json` sidecar, plus `photo-tagger.json` and `photo-tagger.csv`. The in-browser library remains the working copy — this is backup/export, not two-way sync. Use **Select** to save only the current selection.
- **Export tags** – JSON or CSV of tags and metadata only (not the images). JSON keeps custom labels; CSV is handy for spreadsheets.
- **Import tags** – matches photos by file name (and size). Add the photos first, then import.
- **Delete all local data** – wipes this app’s IndexedDB in this browser (your originals elsewhere are untouched).


- **Export JSON / CSV** – saves every photo's tags and metadata (not the images). JSON also keeps your custom labels.
- **Import JSON or CSV** – add the photos to the app first, then import. Photos are matched by file name (and size); tags are merged with the ones already there. CSV needs `name` and `tags` columns, tags separated by `;`.
- **Delete all local data** – wipes this app's photos, tags and settings from this browser (asks you to click twice).

## 8. Install it as an app

If the app is served from an https address (see the README):

- **iPhone / iPad:** Safari → Share → *Add to Home Screen*.
- **Android:** Chrome → ⋮ → *Install app*.
- **Computer:** click the install icon in the address bar.

Once installed and used once online, it works offline. Use **🌓** (top right) to switch between automatic, light and dark themes.

## 9. Tips and troubleshooting

| Problem | What to try |
| --- | --- |
| "Tagging model unavailable" | The model couldn't download (offline?). Photos are kept untagged – connect, then tap **Retry tagging** in the banner. |
| "Face detection unavailable" / HTML JSON error | Face models (~12 MB) ship with the app. On desktop, reinstall the latest build if you see this once (photos still import and tag; face naming is skipped). Only one toast is shown — not one per photo. |
| A tag is wrong | Remove it with ×. Lower-confidence mistakes disappear if you raise *Confidence needed for a tag*. |
| A photo is missing tags it should have | Lower the confidence threshold, or add a custom label for it. |
| A photo won't import | The browser may not be able to read that format (for example HEIC on desktop Chrome). Convert to JPEG first. |
| Photos disappeared | Browser data was cleared, or you opened the app in a different browser/profile – each has its own library. Export your tags regularly. |
| Dropbox pop-up shows an error | Add this site's **hostname** (e.g. `cdrjohnson.github.io`, no `https://`) to your Dropbox app's *Chooser / Saver / Embedder domains* ([steps](DROPBOX_SETUP.md)). |
| Slow tagging on a phone | Keep the screen on and the app open while it works; photos are processed one by one. |
