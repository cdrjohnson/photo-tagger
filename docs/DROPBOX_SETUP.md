# Setting up Dropbox (Dropbox as your library)

From v1.0.7, Photo Tagger connects to Dropbox once and then lets you **browse your Dropbox folders inside the app** and tag them. **Tags live in Dropbox, not on your computer.**

- Each photo is downloaded **into memory only**, long enough to run the on-device tagger and face recognition, then discarded.
- Tags, face names (and the face/CLIP data needed to match people) are **written into your Dropbox**, in a hidden folder `/.photo-tagger/` — one small JSON file per photo (`/.photo-tagger/meta/<file id>.json`) plus `/.photo-tagger/people.json`.
- The tags (and the names of people you've identified) are also added to each photo as **Dropbox tags**, so searching Dropbox for `beach` or `grandma` finds the photos themselves. Dropbox tags are lowercase letters, digits and `_` (max 32 characters, 20 per photo): `Sunny Day!` becomes `sunny_day`; if a photo has more than 20, people come first, then your own tags, then the most confident auto tags. Photo Tagger only removes tags it added itself (it remembers them in `/.photo-tagger/`); tags you or other apps add in Dropbox are left alone. Removing a photo from Photo Tagger takes its Photo Tagger tags off the file.
- Photo Tagger keeps **nothing about your Dropbox photos on this device**: no originals, thumbnails, previews, tags, embeddings or faces. The grid shows Dropbox's own thumbnails, fetched live and held in memory until you close the app.
- The **only** things stored locally are the app key, your Dropbox sign-in (so you don't have to log in every launch), the list of folders you linked, and normal app settings.
- Your photos are **never changed, moved or deleted**. Photo Tagger only ever writes or deletes files inside `/.photo-tagger/`.

To talk to Dropbox, Photo Tagger needs an **app key** from a Dropbox app that *you* create (free, a few minutes). The app key is not a password. Photo Tagger never ships a key and never asks you for one anywhere except your own Settings screen. It also never needs, and never asks for, your Dropbox password or the app *secret*: sign-in happens on dropbox.com using OAuth 2 with PKCE.

## 1. Create (or reuse) the Dropbox app

If you already created an app for the old Chooser import, reuse it — just do steps 2 and 3 on it.

1. Open <https://www.dropbox.com/developers/apps> (sign in) and pick your app, or click **Create app**: **Scoped access** → **Full Dropbox** → any unique name.
2. **Access type matters:**
   - **Full Dropbox** — you can browse all your folders (e.g. `/Photos`, `/Camera Uploads`). Choose this to tag your real photo folders.
   - **App folder** — Photo Tagger can only see `/Apps/<your app name>/`. Anything outside that folder is invisible. The access type can't be changed later; create a new Full Dropbox app if needed.

## 2. Permissions (scopes)

On the app's **Permissions** tab tick these, then click **Submit**:

| Scope | Why |
| --- | --- |
| `files.metadata.read` | list folders and files |
| `files.content.read` | download an image into memory to tag it, show Dropbox thumbnails, read the tag files back |
| `files.metadata.write` | add/remove Dropbox tags on your photos (tags only — file contents are never changed) |
| `files.content.write` | save tag/face files in `/.photo-tagger/` (the app refuses to write anywhere else) |
| `account_info.read` | show which account is connected |

No sharing scopes are needed.

> **Upgrading from 1.0.7?** Tick **`files.metadata.write`** on the Permissions tab, click **Submit**, then in Photo Tagger go to Settings → Dropbox → **Disconnect** → **Connect Dropbox**. A token only gets the permissions that were enabled when you connected. Existing photos get their Dropbox tags the next time their tags change or you re-tag the library.

Dropbox tags (and Dropbox's tags API) need **Full Dropbox** access — they don't work for App folder apps.

## 3. OAuth settings (redirect URIs)

On the app's **Settings** tab, in the **OAuth 2** section:

1. **Allow public clients (Implicit Grant & PKCE)** → **Allow**.
2. **Redirect URIs** — add each one exactly (click **Add** after each):
   - `https://cdrjohnson.github.io/photo-tagger/` — the website
   - `http://127.0.0.1:53682/` — the Windows desktop app
   - `http://localhost:5173/photo-tagger/` — only if you run the dev server yourself

Photo Tagger's **Settings → Dropbox** shows the exact URI(s) and scopes for the copy you're using.

A new Dropbox app is in *development* status, which is fine for your own account.

## 4. Connect

Copy the **App key** (not the App secret) from the app's **Settings** tab. In Photo Tagger: **Settings → Dropbox** → paste the key → **Connect Dropbox**.

- **Website:** you go to dropbox.com, click **Allow**, and come back to Photo Tagger connected.
- **Windows app:** your web browser opens on dropbox.com; click **Allow**, you'll see "Dropbox is connected", close that tab and return to the app. (The app listens on `127.0.0.1:53682` only while you sign in.)

The sign-in (access + refresh token) is stored only on this device — in the browser's IndexedDB, or in the desktop library's `.photo-tagger` folder — and refreshed automatically. **Disconnect** forgets it. You can also set a build-time key: `VITE_DROPBOX_APP_KEY` in `.env`; the Settings key takes priority.

## 5. Browse and tag

**Add photos → From Dropbox** opens Photo Tagger's Dropbox browser: breadcrumbs, subfolders and images (other files are hidden). Open a folder and click **Tag new photos here**. Turn on **Include subfolders** to take everything below it (off by default so you don't tag your whole Dropbox by accident).

Each image is downloaded **into memory**, tagged and scanned for faces; its tags and face data are written to `/.photo-tagger/` in your Dropbox, and the bytes are dropped. Photos are identified by their Dropbox file id, so a photo is never processed twice. The folder is remembered: **Add photos → Refresh Dropbox** re-checks your linked folders and tags only new photos.

Closing the app, or **Disconnect**, leaves nothing behind locally; connecting again reads all tags back from Dropbox. Removing a Dropbox photo in Photo Tagger deletes only its `/.photo-tagger/` tag file — the photo stays in Dropbox. **Download original** and **Save to folder / zip** fetch the original from Dropbox at that moment (you need to be connected and online).

Photos imported with the old Chooser (v1.0.6 and earlier) stay exactly as they were, with their local copy.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| From Dropbox opens Settings | No key saved, or not connected yet — follow steps 1–4. |
| Dropbox says "Invalid redirect_uri" | Add the exact URI shown in Settings → Dropbox to the app's Redirect URIs (trailing `/` included). |
| Dropbox says the app doesn't allow PKCE / public clients | Set **Allow public clients** to **Allow** (step 3). |
| Error mentioning `missing_scope` | Tick the five scopes in step 2, **Submit**, then Disconnect and Connect again. |
| You only see an empty folder | The app has **App folder** access. Create a **Full Dropbox** app (step 1). |
| Windows: "Port 53682 is busy" | Another program is using that port; close it and try again. |
| "Dropbox session expired" | Settings → Dropbox → Connect again. |
