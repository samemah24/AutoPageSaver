# Auto Page Saver — standalone Chrome extension

Saves the page you are viewing, plus the pages it links to (depth 0 to 3), directly inside Chrome so you can read them offline.

**No server, no Python, no window to keep open**: everything runs inside the extension, and saves are stored in Chrome's internal database (IndexedDB).

## Installation

1. Unzip the archive.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `aps-extension` folder (the one that contains `manifest.json`).
4. Pin the Auto Page Saver icon to the toolbar.

Chrome 116 or newer is required.

## Usage

1. Open a web page (for example a Wikipedia article).
2. Click the icon: the URL of the current tab is detected automatically.
3. Choose the depth and the maximum number of pages, then click **Save**.
4. When it finishes, **Open saved copy** shows the local copy. Links between saved pages work without a connection.

You can close the popup while a save is running and reopen it to follow progress or cancel. **Chrome must stay open** until the save finishes.

## Finding your saves

- **Popup**: the "Recent saves" list opens a saved copy directly.
- **Library** (button in the popup): every save with its title, date, page count, size and the total space used. You can open a saved copy or any of its pages, **search** the titles and addresses of all saved pages, open the original page online, or **delete** a save.
- **Viewer**: a drop-down lets you jump between the pages of a saved copy; the browser's Back button works.

## Behaviour
- Limits: 500 pages, 4,000 resources, 10 MB per file, 500 MB per save.
- Breadth-first crawl, never visiting the same URL twice (no loops); redirects are followed.
- Same site only; technical Wikipedia namespaces (`Spécial:`, `Discussion:`, …) are skipped.
- `robots.txt` is honoured (Allow/Disallow, `*` and `$` wildcards, Crawl-delay up to 10 s). If the file cannot be fetched (server or network error), the site is treated as disallowed to be safe.
- Politeness: 0.5 s between two pages of the same site, at most 4 simultaneous resource downloads.
- Images, stylesheets (including their `url(...)` and `@import` references) and fonts are downloaded and stored.
- A cancelled or failed save leaves no data behind.

## Security and privacy

- **Scripts, iframes, objects, active forms and `on…=` attributes** are removed from saved pages. The viewer shows them in an isolated frame where no script can run.
- No data is sent to any third party: downloads go only to the sites being saved.
- Requests are sent **without your cookies**: pages that require a login are not saved the way you see them when signed in.
- Permissions requested: access to all sites (needed to download pages and resources from any site), unlimited storage (for the saves), and an "offscreen" document (to parse HTML in the background).

## Limitations

- **Saves belong to the extension**: uninstalling the extension, or clearing its data in Chrome's settings, deletes all saves. There is no export yet.
- Pages built with JavaScript may be incomplete (scripts are not kept).
- Responsive images (`srcset`) are reduced to their first variant; videos, streams and protected content are not saved.
- Links to pages that were not saved stay online links (they open in a new tab and need a connection).
- Chrome does not let an extension change its `User-Agent` header, so `robots.txt` is evaluated for the "AutoPageSaver" token and then for "*".
- Respect each site's terms of use and copyright: personal use only.

## Troubleshooting

- **The Save button is greyed out**: the current page is not `http`/`https` (internal Chrome tab, local file, …).
- **"The start page is disallowed by robots.txt."**: the site refuses automated crawling.
- **"Could not download the start page"**: network or HTTP error (the reason is shown in parentheses).
- After editing the extension's files, click the reload icon in `chrome://extensions`.
