# Orca on Nix

This fork packages the Orca desktop application for **x86_64 Linux** as a Nix flake.
The application is built from source with upstream's build entry points; it is not a wrapped AppImage.
Electron is the matching prebuilt nixpkgs runtime, not a Chromium source build.

The flake exports the desktop package and a verification app.
It does not export a NixOS or Home Manager module, an overlay or a server-only package.

For Android builds, see the [Android Nix guide](../mobile/nix/README.md) and the [Android workflow](../mobile/nix/ANDROID-WORKFLOW.md).

## Source baseline

The packaging targets upstream stable **v1.4.261**, commit
`92d4266cc4ffa945dbc1fa52850e62448d2dfc1c`, with Electron 43.8.7, Bun 1.4.4,
pnpm 12.14.0 and packaged Node 24.22.1. This release builds and bundles only the
Wayland/X11 clipboard C helper on Linux; it has no provider-exec helper. Nix
prepares the clipboard cache using upstream's fingerprint and retains its ELF
architecture, ABI-floor and protocol gates.

The desktop and mobile-web dependency hashes in `flake.nix` still belong to the
previous source baseline. They must be measured against this release by the
authorized Nix CI build before this revision is ready to install. Evaluation
does not validate fixed-output hashes or demonstrate a successful package build.

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

## Flake outputs

| Output                                  | Purpose                                              |
| --------------------------------------- | ---------------------------------------------------- |
| `packages.x86_64-linux.orca`            | Source-built desktop package                         |
| `packages.x86_64-linux.default`         | Alias of `orca`                                      |
| `packages.x86_64-linux.desktop-native`  | Native clipboard helper, built with its checks       |
| `packages.x86_64-linux.desktop-deps`    | Fixed-output pnpm dependency archive for the desktop |
| `packages.x86_64-linux.mobile-web-deps` | Fixed-output pnpm dependency archive for mobile web  |
| `checks.x86_64-linux.desktop-native`    | Native ABI-floor and protocol checks                 |
| `apps.x86_64-linux.verify-desktop`      | Runtime verification of a built desktop package      |

## Verify

There are three levels of check, and only the last one exercises the installed application.

| Command                           | What it proves                                                            |
| --------------------------------- | ------------------------------------------------------------------------- |
| `nix flake check --no-build`      | The flake evaluates. Nothing is compiled.                                 |
| `nix flake check`                 | The clipboard helper builds and passes its ABI-floor and protocol checks. |
| `nix run .#verify-desktop -- ...` | The installed package passes CLI, native-module and GUI smoke checks.     |

To verify a built package:

```sh
nix build .#orca
nix run .#verify-desktop -- ./result ./nix-smoke-artifacts
```

The first argument is the package output and the second is a directory for the results.
The verification uses its own Xvfb display and fresh profile, rather than your existing desktop session or Orca profile.
It writes a JSON result and a screenshot to the results directory.
Checks include GTK file-chooser schema discovery, inherited tool precedence and final native executable loading.
The build also checks ANGLE library search paths; hardware GPU acceleration and interactive dialogs still need testing in a real desktop session.

The fork's `Nix desktop` workflow runs the same build and verification on a GitHub-hosted runner.
See the [CI policy](FORK-CI.md) for what that workflow covers.
