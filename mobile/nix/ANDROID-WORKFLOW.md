# Local Android build, private re-signing, and explicit installation

This is an opt-in local workflow, not a release publishing system. App code and
upstream's `plugins/android-release-signing.js` stay unchanged. The plugin can
sign official releases from environment variables; this trial workflow instead
allows re-signing an already-built APK with an existing private key.

Use the development environment and dependency setup in [README.md](README.md).
Commands below run from `mobile/`, with Node 24+, Java, installed mobile
dependencies, and Android tools available. Paths and fingerprints are placeholders;
substitute your own values. Neither script installs dependencies or Android tools.
On Windows, use the same argv in PowerShell (join multiline examples onto one line);
processes use `@orca/process-host`, including `.bat`/`.cmd` tools, without a shell.

## 1. Build only (no private key or password prompt)

Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` to the installed SDK. Choose an output path
whose parent directory already exists. All output paths must be new `.apk` files.

```sh
pnpm exec tsx --conditions=orca-source scripts/build-private-android.mjs \
  --build-only --output "$HOME/orca-trial-as-built.apk" --preflight

pnpm exec tsx --conditions=orca-source scripts/build-private-android.mjs \
  --build-only --output "$HOME/orca-trial-as-built.apk"
```

Preflight checks files and runs `java -version`; it does not prebuild, compile,
sign, or prove a build will succeed. The actual build runs the installed Expo CLI
with `prebuild --platform android --no-install`, then the generated Gradle wrapper
with `assembleRelease`. It removes the previous release artifact first, so a
successful command cannot publish a stale artifact. Expo generates/updates
`mobile/android/`; Gradle may download its configured wrapper/dependencies.

**Build-only output is not verified as privately signed.** With no upstream release
signing environment configured, Expo's public template/debug signer may still be
present. Do not distribute or install this artifact as a private release. Avoid
configuring upstream release-signing secret environment variables for this local
re-signing path; partial settings can make upstream's plugin fail deliberately.

## 2. Sign an existing APK (no rebuild)

Use your existing private keystore and its independently known certificate SHA256.
The required fingerprint is exactly 64 hex characters without colons; it is the
**signing certificate digest**, not the APK file hash. No key generation, key export,
or password storage is performed. Public Expo template signer
`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` is forbidden.

```sh
pnpm exec tsx --conditions=orca-source scripts/build-private-android.mjs \
  --input "$HOME/orca-trial-as-built.apk" \
  --keystore /private/path/existing-trial.jks --alias localtrial \
  --expected-sha256 YOUR_64_HEX_CERTIFICATE_SHA256 \
  --build-tools "$ANDROID_HOME/build-tools/36.0.0" \
  --output "$HOME/orca-trial-private.apk"
```

Use your installed build-tools version, not necessarily the example version.
`--input` also works for a release APK produced separately by the upstream build.
It needs Java and `apksigner`, but not Expo dependencies, a generated Android
project, Gradle, or an SDK-root environment variable (the tools path is explicit).
An interactive terminal is required: `apksigner` reads passwords itself. Password
flags are rejected; do not put passwords in commands, files, or environment
variables for this script. Existing input APKs are left unchanged.

Omit `--input` to build and then sign in one invocation. Add `--preflight` to either
signing form for prerequisite checks without signing or password prompts.

Signing writes a temporary candidate beside the output, verifies its actual
signature with `apksigner verify --verbose --print-certs`, and requires exactly one
signer matching your pin. A same-filesystem hard link publishes only the verified
candidate, atomically and without overwriting an existing output (including a
concurrent writer). Temporary files are removed on completion/failure. A filesystem
without hard-link support fails rather than falling back to unsafe overwrite.

## 3. Explicit ADB update (separate opt-in command)

**Package identity is not a migration.** This fork uses `dev.orca.app`, version
`0.0.68` / code `32` at the v1.4.272 source baseline. The previous phone app
`com.stably.orca.mobile` (`0.0.62`) is a different package, even when both use your
existing `localtrial` key. Installing this fork does not move the old app's data,
credentials, permissions, or settings, and does not remove the old app.

Manually select a connected, authorized device serial. The installer never chooses
a device automatically. It checks the APK's package/version and actual certificate
before contacting that device. Then it checks authorization and whether the exact
package is installed. No broad logs or other app data are read.

```sh
pnpm exec tsx --conditions=orca-source scripts/install-private-android.mjs \
  --apk "$HOME/orca-trial-private.apk" --serial YOUR_EXPLICIT_SERIAL \
  --expected-package dev.orca.app \
  --expected-sha256 YOUR_64_HEX_CERTIFICATE_SHA256 \
  --build-tools "$ANDROID_HOME/build-tools/36.0.0"
```

The default is **update-only**: if `dev.orca.app` is missing, this fails. If you intend
to install that distinct new package alongside the old app, repeat the command with
`--allow-new-package`. This flag does not permit overwriting another package.
Use `--adb /absolute/path/to/adb` when needed; otherwise `adb` is resolved on PATH.

The installer snapshots the APK locally, validates and installs that same snapshot,
and invokes only `adb -s SERIAL install -r APK`. It never adds downgrade (`-d`),
permission-grant (`-g`), uninstall, clear-data, or app-launch operations. Android
itself enforces installed-certificate compatibility and version downgrade checks;
this workflow does not bypass them. Existing same-package updates must have a
compatible signing identity. After installation it reads `dumpsys package` scoped
to the exact package and compares package ID, version code, and version name with
the inspected APK. A mismatch/failure is reported as failure; installation may
already have occurred, and the script does not try a destructive rollback.

## Dependency-free safety checks

From the repository root:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --test \
  mobile/scripts/build-private-android.test.mjs \
  mobile/scripts/install-private-android.test.mjs
node --check mobile/scripts/build-private-android.mjs
node --check mobile/scripts/install-private-android.mjs
```

These tests inject process runners and use explicitly synthetic files/transcripts.
They exercise fail-closed decisions, publication, command safety, and readback; they
are not real APK, private-key, build-tool, Windows, or device integration validation.
They do not build, sign, install dependencies, or run phone commands.
