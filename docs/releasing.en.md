# Manual builds and releases

[中文](releasing.md) · [English](releasing.en.md) · [Documentation](README.en.md)

The current release targets are **macOS Apple Silicon (ARM64) and Windows x64 (64-bit Intel/AMD)**.
GitHub Actions builds run only when manually dispatched. Pushing code or tags, or creating a Release draft, does not start a build.

## Prepare a version

1. Update the version in `package.json`, `package-lock.json` (both the top-level value and root package), `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (the project entry), and `src-tauri/tauri.conf.json`.
2. Write the Chinese release notes at `docs/releases/v<version>.md` and their English companion at `docs/releases/v<version>.en.md`, complete the relevant checks, and commit the changes. The workflow uses the Chinese file as the Release body.
3. Push the commit and its corresponding `v<version>` tag to GitHub. Do not move an existing version tag to different content.
4. Create a draft Release using that tag. Leave it unpublished. If no draft exists, the workflow creates a Release after a successful build.

## Start a build on GitHub

1. Open the [Build & Release workflow](https://github.com/jintianzhouyine/my-translator/actions/workflows/release.yml).
2. Click **Run workflow** and keep **Use workflow from: main**.
3. Enter an existing tag in **Existing version tag to build and publish**, for example `v0.10.6`.
4. Click **Run workflow** again.

The workflow validates the tag, application version and release notes, then resolves the tag to a fixed commit. Both platform jobs build that commit, rather than other changes currently on `main`. Each platform runs JavaScript and Rust tests, builds the installer, and checks the binary's architecture and version.

Once both platforms pass, the workflow uploads these files and publishes the Release:

- `MyTranslator_<version>_aarch64.dmg`
- `MyTranslator_<version>_x64-setup.exe`
- `SHA256SUMS`

A failed build leaves the draft unpublished; inspect the failed job's logs before changing the code. If uploading to a draft fails partway through, rerun the workflow: draft assets with the same names are replaced. The workflow refuses to overwrite installers on a published Release. Code fixes should use a new version and tag.

## In-app update checks

**设置 → 关于 → 检查更新** (Settings → About → Check for updates) reads this repository's latest published Release and compares its version with the installed app. If an update is found, click **前往 GitHub 下载** (Download from GitHub), choose the installer for your computer, and install it. The repository and issue links also point to `jintianzhouyine/my-translator`.

Releases provide the installers and checksum file above. They do not include Tauri signed updater packages or `latest.json`; the app does not download, install or restart itself automatically. Network failures and GitHub rate limits show an error, so you can retry later or visit the [latest Release page](https://github.com/jintianzhouyine/my-translator/releases/latest) directly.

## Build details

- macOS: `macos-14` / `aarch64-apple-darwin`.
- Windows: `windows-2022` / `x86_64-pc-windows-msvc`.
- Windows x64 first runs `scripts/prepare-windows-x64.ps1` to prepare the official sherpa-onnx static-MD libraries, matching Rust's default dynamic CRT.
- Speech-library preparation reports download, checksum and extraction progress. Downloads have connection, low-speed and total time limits, with up to three attempts.
- Windows uses the preinstalled 7-Zip to unpack bzip2 and tar in two stages, avoiding stalled `tar.exe` extraction.
- Archives must pass size and SHA-256 checks before extraction. The preparation step has a 25-minute limit and reports the failing stage and error.
- Verified libraries have a separate cache for later runs. A cache-service failure does not prevent normal download and preparation.
- Older Windows ARM64 installers remain in historical Releases.
- Tests and binary checks do not replace installation, cloud translation and audio-routing acceptance tests on real devices.
