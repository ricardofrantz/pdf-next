# Privacy

pdf-next is a viewer. It reads the files you open and nothing else.

**Network.** A few seconds after launch the app sends one request to
`api.github.com` to learn the latest release version, and it sends the same
request again when you press the update button. The request carries no
identifier, no file name and no content; the reply is the release number and
download links. Nothing else is fetched, and nothing is sent anywhere. The
application's Content Security Policy names `api.github.com` as the only host
it may reach, so this is enforced by the browser engine, not just promised.

**Storage.** The app remembers the window size for the last 80 files you
opened, by path, in its own preferences folder. That is the only thing it
writes. There is no account, no telemetry, no crash reporting and no
analytics.

**Documents.** PDFs, images and markdown are rendered on your machine. A
markdown file's relative links and images are never fetched; `#` links
scroll, web links open in your own browser, and links to other files open
them in the viewer only when you click.

Questions: https://github.com/ricardofrantz/pdf-next/issues
