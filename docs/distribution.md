# Distribution

Every tag `v*` builds and publishes installers for Windows, macOS and Linux.
This page is the rest: how the Windows builds get a signature, and how each
package manager — winget, the Microsoft Store, Homebrew, apt — is fed.

## Code signing on Windows (Azure Trusted Signing)

The release workflow signs the `.exe`, the `.msi` and the binary inside them
whenever the repository holds Azure credentials. Without them the workflow
runs exactly as before and produces unsigned builds, so nothing breaks while
this is being set up.

One-time setup, in the Azure portal:

1. **Create a Trusted Signing account** (search "Trusted Signing"). Basic
   tier, in a region that has the service (West Europe or East US). The
   endpoint for the region is shown on the account's overview page, for
   example `https://weu.codesigning.azure.net`.
2. **Identity validation**, under the account. Individual validation asks for
   a government ID and takes one to three days; organization validation asks
   for company records.
3. **Certificate profile**, under the account: type *Public Trust*, name it
   `pdf-next`. It becomes usable when the validation above completes.
4. **App registration** in Microsoft Entra ID: new registration, then
   *Certificates & secrets → New client secret*. Note the tenant ID, the
   application (client) ID and the secret value.
5. On the Trusted Signing account, *Access control (IAM) → Add role
   assignment*: role **Trusted Signing Certificate Profile Signer**, member =
   the app registration.

Then in the GitHub repository, *Settings → Secrets and variables → Actions*:

| Kind     | Name                      | Value                                   |
| -------- | ------------------------- | --------------------------------------- |
| secret   | `AZURE_TENANT_ID`         | from step 4                             |
| secret   | `AZURE_CLIENT_ID`         | from step 4                             |
| secret   | `AZURE_CLIENT_SECRET`     | from step 4                             |
| variable | `AZURE_SIGNING_ENDPOINT`  | from step 1, e.g. `https://weu.codesigning.azure.net` |
| variable | `AZURE_SIGNING_ACCOUNT`   | the account name from step 1            |
| variable | `AZURE_SIGNING_PROFILE`   | `pdf-next`, from step 3                 |

The next tag is signed. The Windows job installs
[`trusted-signing-cli`](https://github.com/levminer/trusted-signing-cli) and
hands Tauri a `signCommand` through a config overlay; the shared
`tauri.conf.json` never mentions signing, so local builds are unaffected.

Cost: about US$10 a month for the account. There is no certificate file to
keep safe and nothing expires on a schedule; Azure issues short-lived
certificates per signature.

## winget

`winget/` holds the manifests, one folder per version, in the layout the
[winget-pkgs](https://github.com/microsoft/winget-pkgs) repository expects.
Check one locally before submitting:

```
winget validate --manifest winget/RicardoFrantz.pdf-next/0.9.0
winget install --manifest winget/RicardoFrantz.pdf-next/0.9.0
```

To publish a version, copy its folder into a fork of winget-pkgs at
`manifests/r/RicardoFrantz/pdf-next/<version>/` and open a pull request.
The first submission takes a moderator a few days; later ones are checked by
the bot and merged in hours. Once merged:

```
winget install RicardoFrantz.pdf-next
```

For a new version: copy the folder, change `PackageVersion`, `InstallerUrl`,
`InstallerSha256` (`sha256sum` of the `.exe` from the release page, upper
case), `ReleaseDate` and `ReleaseNotesUrl`. Or let
[`wingetcreate update`](https://github.com/microsoft/winget-create) do it:

```
wingetcreate update RicardoFrantz.pdf-next --version 0.9.1 \
  --urls https://github.com/ricardofrantz/pdf-next/releases/download/v0.9.1/pdf-next_0.9.1_x64-setup.exe \
  --submit
```

## Microsoft Store

The Store accepts a plain Win32 installer by URL; no MSIX packaging.

1. A [Partner Center](https://partner.microsoft.com/dashboard) account,
   *Windows & Xbox* program. One-time fee, about US$19 for an individual.
2. *Apps and games → New product → EXE or MSI app*, reserve the name
   `pdf-next`.
3. **Packages**: installer URL = the versioned `.exe` from the release page
   (the Store hashes the file, so `latest` would fail certification on the
   next release), architecture x64, language en-US, silent install switch
   `/S`. The installer needs no reboot and is served over HTTPS, as required.
4. **Store listing**: description, at least one screenshot (1366×768 or
   larger PNG), a 300×300 icon, category *Productivity*, and the privacy
   policy URL — `https://github.com/ricardofrantz/pdf-next/blob/main/PRIVACY.md`.
   The policy is mandatory because the app reaches the network for its update
   check.
5. **Age ratings**: the IARC questionnaire, every answer "no".
6. Submit. Certification takes one to three business days; reviewers run the
   installer and scan the binaries, so a signed build (above) goes through
   with far fewer questions.

Each release is a new submission with the new versioned URL. Store users are
told of updates by the Store; the app's own launch check fires too and sends
them to the same installer on GitHub, which is harmless.

## Homebrew

Homebrew's own cask repository asks a package to be notable — 75 stars, or 30
forks, or 30 watchers — which pdf-next is not yet. A personal tap has no such
bar and works the same way for the person installing:

```
brew install --cask --no-quarantine ricardofrantz/tap/pdf-next
```

The tap is [ricardofrantz/homebrew-tap](https://github.com/ricardofrantz/homebrew-tap).
`Casks/pdf-next.rb` names the version and the checksum of the universal
`.dmg`; a workflow in that repository reads the latest release here once a
day and commits the new version by itself, so a release needs nothing from
you.

`--no-quarantine` is needed only while the app is unsigned. Signing it means
an Apple Developer Program membership (US$99 a year) and notarization, which
is a separate matter from the Windows signing above.

When the project does become notable, the same cask can be submitted to
`homebrew/homebrew-cask` and the tap retired.

## apt

The apt repository is the `gh-pages` branch of this repository, served by
GitHub Pages at <https://ricardofrantz.github.io/pdf-next>. The `apt` job in
`release.yml` rebuilds it after every tag: it takes the `.deb` that was just
published, regenerates `Packages` and `Release`, signs them, and pushes.
Every version stays in `pool/`, so `apt install pdf-next=0.9.0` keeps working
after a newer one lands.

Apt refuses an unsigned repository, so the job needs a signing key. The
public half lives at `pdf-next.asc` on that branch and is what a user adds to
`/etc/apt/keyrings/`; the private half is the `APT_GPG_PRIVATE_KEY` secret.

To create a key and install it:

```
gpg --batch --gen-key <<'EOF'
%no-protection
Key-Type: RSA
Key-Length: 4096
Key-Usage: sign
Name-Real: pdf-next apt repository
Name-Email: you@example.com
Expire-Date: 0
%commit
EOF
fpr=$(gpg --list-keys --with-colons | awk -F: '/^fpr:/ {print $10; exit}')
gpg --armor --export-secret-keys "$fpr" | gh secret set APT_GPG_PRIVATE_KEY
gpg --armor --export "$fpr" > pdf-next.asc   # commit this to gh-pages
```

The key has no passphrase because the workflow runs unattended. It signs
index files, not the packages themselves, and can be replaced at any time by
setting a new secret and committing the new `pdf-next.asc`.

Without the secret the job prints a warning and stops; the rest of the
release is unaffected.

An `.rpm` is built too, but no yum repository is published. The same pattern
would work — `createrepo_c` in place of `dpkg-scanpackages` — if anyone asks.
