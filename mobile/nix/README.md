# Android builds on NixOS

This opt-in flake provides an x86_64 Linux FHS build environment. It does not change
upstream application dependencies, install an app, or activate a NixOS configuration.

From the repository root:

```sh
nix develop path:./mobile/nix
```

For scripted commands, use the application rather than `nix develop --command`:

```sh
nix run path:./mobile/nix -- -c 'node --version; pnpm --version; java -version'
```

The first invocation realizes a substantial SDK/NDK closure. The flake explicitly
accepts the [Android SDK license](https://developer.android.com/studio/terms) for
this environment only. FHS/bubblewrap provides compatibility with downloaded
Android/Hermes Linux binaries; it is not a security sandbox. Home and network
access remain available.

## Follow upstream, pin the environment

The Node 24 major and pnpm 12.18.0 match the root/mobile package manifests. Java 17
matches the Android release workflow. Android settings follow React Native 0.88.1
and the lockfile's Expo SDK 58 / expo-modules-autolinking 58.0.16:

- Android compile platform 37, with platform 36 available for linked native modules.
- Build-Tools 37.0.0, with 36.0.0 available for Android Gradle Plugin defaults.
- NDK 27.1.12297006.
- SDK CMake 3.22.1 and 3.30.5 for Gradle defaults and React Native respectively.
- SDK command-line tools 21.0 and platform-tools 37.0.1.

The lock pins nixpkgs. pnpm's upstream native executable is separately hash-pinned
to avoid substituting nixpkgs' package-manager version. A symlink-based SDK overlay
uses Nixpkgs Ninja at both SDK CMake paths, including Gradle's absolute invocations.
The original SDK is not modified. `GRADLE_OPTS` selects the patched SDK aapt2.

Source requirements:

- `../../package.json` and `../package.json`.
- `../../.github/workflows/mobile-android-release.yml`.
- Installed `react-native/gradle/libs.versions.toml` and
  `react-native/ReactAndroid/build.gradle.kts`.
- Installed `expo-modules-autolinking/android/expo-gradle-plugin`.

On an upstream merge, inspect those requirements before changing the flake. Update
the environment to fit upstream, not upstream to fit the environment. Node used
for packaged desktop/server runtimes has a separate exact upstream pin; this
Android environment does not replace that runtime.

## Validate the toolchain

Inside the shell:

```sh
node --version
pnpm --version
java -version
apksigner version
"$ANDROID_BUILD_TOOLS/aapt2" version
"$ANDROID_HOME/cmake/3.22.1/bin/ninja" --version
"$ANDROID_HOME/cmake/3.30.5/bin/ninja" --version
"$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin/clang" --version
test -f "$ANDROID_HOME/platforms/android-37.0/android.jar"
```

Non-realizing Nix checks, from the repository root:

```sh
nix-instantiate --parse mobile/nix/flake.nix >/dev/null
nix eval --offline --option allow-import-from-derivation false --no-update-lock-file --raw path:./mobile/nix#apps.x86_64-linux.default.program
```

Offline evaluation requires the locked nixpkgs source in the local store. A
successful evaluation alone does not prove the executables or Android build work.

## Build without installing

Inside the shell, from the repository root:

```sh
cd mobile
export EXPO_NO_TELEMETRY=1 EXPO_NO_DOTENV=1
pnpm install --frozen-lockfile
pnpm exec expo prebuild --platform android --no-install
cd android
NODE_ENV=production ./gradlew assembleRelease --no-daemon --max-workers=2 --console=plain
```

This downloads dependencies and generates `mobile/android`. It is a pinned
build environment, not an offline/sandboxed Nix APK derivation. No emulator or
persistent Metro development server is started; Metro runs for release bundling.
Native/bootstrap JavaScript is bundled, but the paired
server can still supply executable web-interface assets; APK signing does not pin
those host-supplied assets.

Historical validation on fork revision `3ae47e04643e68806c041f9f0a4c8bc34548c20c`
(not the v1.4.272 baseline): frozen
dependency installation, Expo prebuild and Gradle `assembleRelease` succeeded
with 1,204 tasks executed in 12m 25s. The APK reports version 0.0.67/code 31,
`dev.orca.app`, compile SDK 37, target SDK 36 and all four supported ABIs.
`apksigner verify` and `zipalign -c -P 16 4` passed. This intermediate used the
public Expo template certificate, not a private signer.

The v1.4.272 source declares Android version 0.0.68/code 32 in `mobile/app.json`;
its APK has not been built or validated by this packaging adaptation. Do not use
the historical version or task counts as evidence for this release.

The intermediate APK is `mobile/android/app/build/outputs/apk/release/app-release.apk`.
Without explicit signing configuration it can carry Expo's public template key.
Do not distribute or install that intermediate as a locally signed build. Keep
signing keys outside the checkout and Nix store. No signing key belongs in the
flake, Git, logs or CI cache.

Upstream's current Android application ID is `dev.orca.app`. Older local builds
used `com.stably.orca.mobile`: the new ID is a separate application, not an in-place
update, even when using the same signing key. Do not uninstall the old app or
assume pairing data migrates. Installation is always a separate explicit step.

The shell sets `ORCA_BACKGROUND_LAUNCH=1` and `ORCA_TELEMETRY_DISABLED=1` for host-side
commands; these are not a promise that every SDK or the installed phone app makes
no outbound requests.
