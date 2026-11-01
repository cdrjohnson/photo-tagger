# Setting up Dropbox import

Photo Tagger imports from Dropbox with the official **Dropbox Chooser**. Dropbox requires every site that uses the Chooser to have an **app key**. You create your own (free, about two minutes). The app key identifies *your* little Dropbox app – it is **not a password** and gives nobody access to your files; each time you import, Dropbox asks you to pick the files in its own pop-up.

Photo Tagger never ships a key and never asks you for one anywhere except your own Settings screen.

## 1. Create the Dropbox app

1. Sign in to Dropbox and open <https://www.dropbox.com/developers/apps/create>.
2. Choose **Scoped access**.
3. Choose **App folder** or **Full Dropbox**. Photo Tagger does not use the Dropbox API, only the Chooser pop-up, so either works – App folder is the more restrictive choice.
4. Give it any unique name (for example `my-photo-tagger-123`) and click **Create app**.

## 2. Allow your site's address

On the new app's **Settings** tab:

1. Find **Chooser / Saver domains**.
2. Add the address where you run Photo Tagger, for example:
   - `http://localhost:5173` (dev server) or `http://127.0.0.1:4174` (preview) – while testing on your computer
   - `https://cdrjohnson.github.io` – for the live GitHub Pages app (use just the origin, not the `/photo-tagger/` path)
3. Press Enter after each one. Photo Tagger shows the exact origin to use in **Settings → Dropbox**.

> Until you add a domain, the Chooser pop-up will show an error instead of your files. A new Dropbox app starts in *development* status, which is fine for your own account – you do not need to apply for production status.

## 3. Give the key to Photo Tagger

Copy the **App key** (not the App secret – you never need that) from the app's **Settings** tab, then either:

- **In the app:** Settings → **Dropbox** → paste the key → **Save key**. It is stored only in this browser (IndexedDB), or
- **At build time:** copy `.env.example` to `.env` and set `VITE_DROPBOX_APP_KEY=your_app_key`, then `npm run dev` / `npm run build`. (For GitHub Pages, set a repository *variable* named `VITE_DROPBOX_APP_KEY`.)

The key typed into Settings takes priority over the build-time one.

## 4. Import

**Add photos → From Dropbox** opens Dropbox's pop-up. Select one or many images. Photo Tagger downloads each file straight from Dropbox into your browser's storage (nothing passes through any other server) and tags it. The Chooser's download links are temporary (about four hours), which is why files are copied locally immediately.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The Dropbox button opens Settings asking for a key | No key saved yet – follow steps 1–3. |
| Pop-up says the app is not configured for this domain | Add the exact origin from Settings → Dropbox to *Chooser / Saver domains*. |
| Pop-up is blocked | Allow pop-ups for the site; it must open from a click. |
| "Could not load the Dropbox Chooser" | You are offline, or a content blocker blocks `dropbox.com/static`. |
| Download fails after picking | Links expire after about 4 hours; just pick the files again. |
