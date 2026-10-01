# Distribution

Every tag `v*` builds and publishes installers for Windows, macOS and Linux.
This page is the rest: how the Windows builds get a signature, and how each
package manager — winget, the Microsoft Store, Homebrew, apt — is fed.

## Build the Windows installer from Linux/WSL

The Windows NSIS installer can be built without Windows: the Rust code is
cross-compiled for `x86_64-pc-windows-msvc`, linked with LLVM `lld`, and
packed with `makensis`. Only the NSIS installer works this way; the MSI does
not.

Packages (Debian/Ubuntu):

```
sudo apt-get install -y nsis lld llvm clang
```

One-time setup:

```
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
```

Build, from the repository root:

```
XWIN_ACCEPT_LICENSE=1 CFLAGS="-DHAVE_INTRIN_H" bun run build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

`XWIN_ACCEPT_LICENSE=1` accepts Microsoft's license for the CRT and SDK
files the cross toolchain downloads on first use. `CFLAGS="-DHAVE_INTRIN_H"`
works around a mozjpeg-sys quirk: it enables `_BitScanForward64` for MSVC
targets but only includes `<intrin.h>` when that macro is set, which MSVC
tolerates and clang-cl does not. The installer lands at
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/pdf-next_<version>_x64-setup.exe`.

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
winget validate --manifest winget/RicardoFrantz.pdf-next/0.13.2
winget install --manifest winget/RicardoFrantz.pdf-next/0.13.2
```

To publish a version, copy its folder into a fork of winget-pkgs at
`manifests/r/RicardoFrantz/pdf-next/<version>/` and open a pull request.
The [first submission](https://github.com/microsoft/winget-pkgs/pull/428398)
is updated to 0.13.2 and awaits Microsoft's policy review. Its manifests use
schema 1.12.0 and omit `DisplayVersion` when it equals `PackageVersion`.
Keep the publisher and product code entries: they describe the installer
registry values. The 0.13.2 installer registers publisher `Ricardo Frantz`
and product code `pdf-next`. Once merged:

```
winget install RicardoFrantz.pdf-next
```

The Windows NSIS template is `src-tauri/windows/installer.nsi`, a copy of
Tauri's with two extra behaviours. A previous install is found under
`Software\frantz\pdf-next` (0.9.0), `Software\Ricardo Frantz\pdf-next`
(0.9.2), or Add/Remove Programs `InstallLocation`. Without that, a
publisher change runs the old uninstaller with an empty `_?=` path and
the setup says "Unable to uninstall!". And a double-click is passive:
progress, then the app, no wizard (`/W` brings it back; `/S` stays
silent for the Store). Re-copy the file from `@tauri-apps/cli` when that
crate is upgraded.

For a new version: copy the folder, change `PackageVersion`, `InstallerUrl`,
`InstallerSha256` (`sha256sum` of the `.exe` from the release page, upper
case), `ReleaseDate` and `ReleaseNotesUrl`. Omit `DisplayVersion` when it is
the same as `PackageVersion`. Or let
[`wingetcreate update`](https://github.com/microsoft/winget-create) do it:

```
wingetcreate update RicardoFrantz.pdf-next --version 0.13.2 \
  --urls https://github.com/ricardofrantz/pdf-next/releases/download/v0.13.2/pdf-next_0.13.2_x64-setup.exe \
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
brew install --cask ricardofrantz/tap/pdf-next
xattr -dr com.apple.quarantine /Applications/pdf-next.app
```

The tap is [ricardofrantz/homebrew-tap](https://github.com/ricardofrantz/homebrew-tap).
`Casks/pdf-next.rb` names the version and the checksum of the universal
`.dmg`; a workflow in that repository reads the latest release here once a
day and commits the new version by itself, so a release needs nothing from
you.

The second line is there because the app is not signed: macOS quarantines it
and refuses the first launch. Homebrew offered `--no-quarantine` for exactly
this and removed it in 5.0 on purpose — it will not help anyone past a
Gatekeeper check again, and the cask prints the `xattr` line as a caveat
instead. The same removal came with a rule that casks in Homebrew's own
repository must be signed and notarized from September 2026, so the personal
tap is not a way around notarization; it is a way around the popularity bar
only.

Signing a Mac build means an Apple Developer Program membership (US$99 a
year) and notarizing each build, which is a separate matter from the Windows
signing above. It is what would remove the `xattr` line, and what the
official cask repository would need.

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
