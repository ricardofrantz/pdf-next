# Privacy

pdf-next reads the documents you open and their review sidecars. When you
navigate an image folder, it lists neighboring files and opens the one you select.

**Network.** A few seconds after launch the app sends one request to
`api.github.com` to learn the latest release version, and it sends the same
request again when you press the update button. The request carries no
identifier, no file name and no content; the reply is the release number and
download links. Nothing else is fetched, and nothing is sent anywhere. The
application's Content Security Policy names `api.github.com` as the only host
it may reach, so this is enforced by the browser engine, not just promised.

**Storage.** The app saves your page appearance, poll interval, raw Markdown
preference, and review text size in local browser storage. Tab paths, zoom,
and scroll positions stay in memory for the current session. Reviews are saved
beside the document as `{stem}_review.json`. The Reduce button can write
`{stem}_reduced.pdf` beside the original. There is no account, telemetry,
crash reporting, or analytics.

**Documents.** PDFs, images and markdown are rendered on your machine. A
markdown file's images are removed; `#` links
scroll, web links open in your own browser, and links to other files open
them in the viewer only when you click.

Questions: https://github.com/ricardofrantz/pdf-next/issues
