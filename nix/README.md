# Orca on Nix

This fork packages the Orca desktop application for **x86_64 Linux** as a Nix flake.
The application is built from source with upstream's build entry points; it is not a wrapped AppImage.
Electron is upstream's prebuilt release binary at the exact version upstream pins, packaged with nixpkgs' Electron builder, not a Chromium source build.

The flake exports the desktop package and a verification app.
It does not export a NixOS or Home Manager module, an overlay or a server-only package.

For Android builds, see the [Android Nix guide](../mobile/nix/README.md) and the [Android workflow](../mobile/nix/ANDROID-WORKFLOW.md).

## Source baseline

The packaging targets upstream stable **v1.4.272**, commit
`6272306c5a5a59ed1c6b604896610bfadde180cc`, with Electron 43.8.10, Bun 1.4.4
and pnpm 12.18.0. The build runs on nixpkgs' Node 24.22.2; the package bundles
upstream's pinned Node 24.22.1. This release builds and bundles three C helpers
on Linux: the Wayland/X11 clipboard helper, the provider-exec helper and the
journal file lock. Nix builds them against upstream's glibc ABI floor and
prepares their caches using upstream's fingerprints. If a prepared helper no
longer matches its fingerprint, the build stops at a `docker` stub that names
the cause, instead of reaching Docker.

| Helper                   | Build check (`nix flake check`)       | Installed check (`verify-desktop`)                                                     |
| ------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------- |
| `orca-wayland-clipboard` | ELF and ABI floor, `protocol_test.py` | `--help`, upstream's `x11_test.py` on a private Xvfb                                   |
| `orca-provider-exec`     | ELF and ABI floor                     | `--exec-without-inherited-fds` drops inherited descriptors and keeps `NODE_CHANNEL_FD` |
| `journal-file-lock`      | ELF and ABI floor                     | Excludes a live SQLite reader, blocks SQLite while held, releases on end of input      |

electron-builder repeats the ABI-floor check on every bundled native binary when
it packages the application.

The Electron, desktop and mobile-web dependency hashes in `flake.nix` match this
release.
After an upstream sync they must be measured again by the Nix CI build before
the new revision is ready to install. Evaluation does not validate fixed-output
hashes or demonstrate a successful package build.

## Build and run

Nix needs the `nix-command` and `flakes` experimental features.
From a checkout of this fork:

```sh
nix build .#orca
./result/bin/orca-desktop
./result/bin/orca-ide --version
```

Without a checkout:

```sh
nix build github:mniehe/orca#orca
./result/bin/orca-desktop
```

The remote form follows the fork's default branch.
For a reproducible build, use a locked flake input or a full commit revision.

The first build fetches the pinned toolchain and dependency archives.
Compilation then runs offline in the Nix sandbox.
You do not need a system Node.js, pnpm or Android SDK.

The build records the full source commit, so the source must carry Git revision metadata.
Build from a Git checkout in which the Nix files are tracked, or from a committed revision of the fork.
A plain `path:` source without Git metadata does not evaluate.
Dirty builds record their committed base revision.

## Install with NixOS or Home Manager

Add the fork as an input to your configuration's flake and commit the resulting `flake.lock`:

```nix
inputs.orca.url = "github:mniehe/orca";
```

Do not add `inputs.orca.inputs.nixpkgs.follows`.
The package asserts the Electron, Bun and Node versions that upstream requires, and a different nixpkgs can fail those assertions.

NixOS module:

```nix
{ inputs, pkgs, ... }: {
  environment.systemPackages = [
    inputs.orca.packages.${pkgs.stdenv.hostPlatform.system}.orca
  ];
}
```

Home Manager module:

```nix
{ inputs, pkgs, ... }: {
  home.packages = [
    inputs.orca.packages.${pkgs.stdenv.hostPlatform.system}.orca
  ];
}
```

Both modules need `inputs` as a module argument:

| Configuration                  | Setting                                                |
| ------------------------------ | ------------------------------------------------------ |
| `nixpkgs.lib.nixosSystem`      | `specialArgs = { inherit inputs; };`                   |
| Standalone Home Manager        | `extraSpecialArgs = { inherit inputs; };`              |
| Home Manager as a NixOS module | `home-manager.extraSpecialArgs = { inherit inputs; };` |

The package installs these entry points:

- `orca-desktop`: the GUI, also registered as Orca in the desktop application menu.
- `orca-ide`: the upstream CLI launcher.

There is no `orca` command alias, to avoid colliding with the GNOME Orca screen reader.
Do not install a second Orca IDE package that provides the same commands.

## Behavior and limitations

- It runs only on `x86_64-linux`. No Darwin, Windows or ARM package is exported.
- It enables no system service or pairing endpoint. The running application may start its own background processes.
- It omits the optional `orcad-template` resource used for SSH server deployment, so automatic remote-server deployment is unsupported.
- It sends no telemetry by default. The wrappers set `ORCA_TELEMETRY_DISABLED=1` unless you set the variable yourself.
- It does not update itself. In-app updates are disabled for installs under `/nix/store`.

Skill-install links point at this fork instead of upstream, because fork-only commits may not exist upstream.

## Update

From your configuration repository:

```sh
nix flake update orca
```

Review the new revision and its [Nix CI result](https://github.com/mniehe/orca/actions/workflows/nix.yml), then rebuild and activate your configuration as usual.

### Sync a new upstream release

Merge the upstream release tag, then measure each fixed-output hash in
`flake.nix` again: the `electronRelease` hashes, the desktop dependency hash and
the mobile-web dependency hash. If upstream changed `packageManager`, update the
pnpm version and hash in `mobile/nix/pnpm.nix` first, because the dependency
archives depend on it.

`electronRelease` holds the Electron version with the hashes of its Linux zip
(`x86_64-linux`) and its Node headers (`headers`). The build asserts that the
version equals `devDependencies.electron` in `package.json`, so a release that
moves Electron fails to evaluate until the version and both hashes are updated
together.

Measure a hash on x86_64 Linux: set it to `nixpkgs.lib.fakeHash`, build, and
copy the `got:` value.

```sh
nix build .#packages.x86_64-linux.orca.electron
nix build .#packages.x86_64-linux.orca.electron.headers
nix build .#desktop-deps .#mobile-web-deps
```

Measure again with a fake hash whenever an archive's inputs change, such as
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, the mobile
lockfile or the pnpm version. Do not rely on CI to catch a stale hash: Nix
reuses any cached fixed-output path whose hash matches, without fetching again.

Then build `.#orca` and run the verification below.

## Flake outputs

| Output                                  | Purpose                                              |
| --------------------------------------- | ---------------------------------------------------- |
| `packages.x86_64-linux.orca`            | Source-built desktop package                         |
| `packages.x86_64-linux.default`         | Alias of `orca`                                      |
| `packages.x86_64-linux.desktop-native`  | Native C helpers, built with their checks            |
| `packages.x86_64-linux.desktop-deps`    | Fixed-output pnpm dependency archive for the desktop |
| `packages.x86_64-linux.mobile-web-deps` | Fixed-output pnpm dependency archive for mobile web  |
| `checks.x86_64-linux.desktop-native`    | Native ABI-floor and protocol checks                 |
| `apps.x86_64-linux.verify-desktop`      | Runtime verification of a built desktop package      |

## Verify

There are three levels of check, and only the last one exercises the installed application.

| Command                           | What it proves                                                                |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `nix flake check --no-build`      | The flake evaluates. Nothing is compiled.                                     |
| `nix flake check`                 | The native helpers build and pass their ABI-floor and protocol checks.        |
| `nix run .#verify-desktop -- ...` | The installed package passes CLI, native-module, helper and GUI smoke checks. |

To verify a built package:

```sh
nix build .#orca
nix run .#verify-desktop -- ./result ./nix-smoke-artifacts
```

The first argument is the package output and the second is a directory for the results.
The verification uses its own Xvfb display and fresh profile, rather than your existing desktop session or Orca profile.
It writes a JSON result and a screenshot to the results directory.
Checks include the exact Electron release, GTK file-chooser schema discovery, inherited tool precedence, final native executable loading, the installed helper behaviour in the table above and the updater's handling of the `nix` package-type marker.
The journal-file-lock check needs a directory on ext4, XFS, Btrfs or ZFS; it tries `TMPDIR` first, then the results directory.
The build also checks ANGLE library search paths; hardware GPU acceleration and interactive dialogs still need testing in a real desktop session.

The fork's `Nix desktop` workflow runs the same build and verification on a GitHub-hosted runner.
See the [CI policy](FORK-CI.md) for what that workflow covers.
