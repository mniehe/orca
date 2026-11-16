# Orca on Nix

This fork packages the Orca desktop application from source for **x86_64 Linux**.
It uses upstream's build entry points and tool versions rather than wrapping an
AppImage or maintaining a separate application build system.

The root flake exports packages and a runtime-verification app. It does **not**
currently export a NixOS service module, Home Manager module, overlay or
server-only package. Install its desktop package through your existing NixOS or
Home Manager configuration.

For Android builds, private signing and explicit device installation, use the
separate [Android Nix guide](../mobile/nix/README.md) and
[Android workflow](../mobile/nix/ANDROID-WORKFLOW.md).

## Quick start

Nix must have the `nix-command` and `flakes` experimental features enabled.
From a checkout of this fork:

```sh
nix build .#orca
./result/bin/orca-desktop
./result/bin/orca-ide --version
```

To build without cloning:

```sh
nix build github:mniehe/orca#orca
./result/bin/orca-desktop
```

The remote command follows the fork's current default branch. For reproducible
configuration, use a locked flake input or an explicit full commit revision.
Initial builds fetch the locked toolchain and dependency archives; application
compilation then runs offline in the Nix sandbox. This is not a development
shell, and a system Node.js, pnpm or Android SDK installation is not required to
build the desktop package.

## Use from NixOS or Home Manager

Add this input to your configuration's flake and commit the resulting
`flake.lock`:

```nix
inputs.orca.url = "github:mniehe/orca";
```

Keep Orca's own nixpkgs input: its package asserts exact upstream tool versions,
so adding `inputs.orca.inputs.nixpkgs.follows = "nixpkgs"` can break those pins.

For a NixOS module that receives `inputs` through `specialArgs`:

```nix
{ inputs, pkgs, ... }: {
  environment.systemPackages = [
    inputs.orca.packages.${pkgs.stdenv.hostPlatform.system}.orca
  ];
}
```

For a Home Manager module that receives `inputs` through `extraSpecialArgs`:

```nix
{ inputs, pkgs, ... }: {
  home.packages = [
    inputs.orca.packages.${pkgs.stdenv.hostPlatform.system}.orca
  ];
}
```

Pass `specialArgs = { inherit inputs; };` to `nixpkgs.lib.nixosSystem`, or
`extraSpecialArgs = { inherit inputs; };` to
`home-manager.lib.homeManagerConfiguration`, respectively. When Home Manager is
used as a NixOS module, pass `home-manager.extraSpecialArgs = { inherit inputs; };`
instead. These examples support `x86_64-linux` only; no Darwin, Windows or ARM
package is exported.

The package installs the Orca desktop menu entry and the `orca-desktop`,
`orca-ide` and `orca` commands. Do not install a second Orca package exposing the
same commands alongside it. No system service, pairing endpoint or background
server is enabled by installing the package.

To update only this input from your configuration repository:

```sh
nix flake update orca
```

Review the new revision and its [Nix CI result](https://github.com/mniehe/orca/actions/workflows/nix.yml)
before building and activating your configuration. In-app updates are disabled
for the Nix-managed installation; update through the flake input instead.

## Flake outputs

| Output                                  | Purpose                                                 |
| --------------------------------------- | ------------------------------------------------------- |
| `packages.x86_64-linux.orca`            | Source-built desktop package                            |
| `packages.x86_64-linux.default`         | Alias of `orca`                                         |
| `packages.x86_64-linux.desktop-native`  | Clipboard/provider C helpers and their checks           |
| `packages.x86_64-linux.desktop-deps`    | Fixed-output root pnpm dependency archive               |
| `packages.x86_64-linux.mobile-web-deps` | Fixed-output mobile dependency archive                  |
| `checks.x86_64-linux.desktop-native`    | Native ABI-floor and protocol checks                    |
| `apps.x86_64-linux.verify-desktop`      | Final installed-package CLI, native and GUI smoke tests |

`nix flake check --no-build` checks evaluation without compiling the outputs.
`nix flake check` builds the exported native check; it does not by itself build
and launch the full desktop. Use `nix build .#orca` and the runtime verification
command below for that boundary.

## Server: use upstream's server-only distribution

The current upstream revision provides a server artifact without Electron, GTK or
X11. Prefer this over the older dotfiles AppImage wrapper for the VM. The native
build/template pipeline and artifact packer already exist; do not create another
server bundler.

The authoritative sequence is in `.github/workflows/orca-server-artifact.yml`:

```sh
pnpm install --frozen-lockfile
pnpm -C mobile install --frozen-lockfile
pnpm run build:mobile-web
pnpm run build:orcad-template --targets linux-x64-glibc
pnpm run build:packages
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" node config/scripts/orcad-distribution/server-artifact/pack-orcad-server-artifact.mjs --template out/orcad-template --target linux-x64-glibc --out-dir out/orca-server
```

This is a source-supported recipe, not a validated Nix build command. It needs the
full native build environment, writable caches, network access and the upstream
native ABI-floor checks. The corresponding arm64 target is `linux-arm64-glibc`.
The output is `out/orca-server/orca-server-linux-x64.tar.gz`; upstream provides a
smoke script alongside the packer. Do not run smoke pairing output into shared logs.

`build:orcad` alone is not this complete distribution. Mobile web assets are
required, but Android SDK/signing are not required to package the server.

The build shell's Node major comes from `package.json`; the packaged runtime has a
separate exact upstream pin in `src/shared/node-runtime/node-runtime-pin.ts`.
Preserve upstream's runtime bytes/hashes and download verification. Do not patch a
cached Node executable before upstream verifies its hash.

## Desktop: x86_64 Linux

The root flake exposes `packages.x86_64-linux.orca`, also the default package:

```sh
nix build .#orca
./result/bin/orca-desktop
```

Build from a Git checkout with the Nix support files tracked, or a committed
GitHub fork revision. A plain `path:` source without Git revision metadata cannot
supply the full source commit required by upstream's skill-install provenance.
Dirty checkout builds identify their committed base; use a committed, pushed
fork revision for dotfiles integration.

This compiles the workspace packages, CLI, Electron main/preload/renderer and
embedded mobile-web assets from source, then uses electron-builder's unpacked
directory output. It does not wrap an upstream AppImage. Electron itself is the
matching prebuilt nixpkgs runtime dependency, not a Chromium source build. The
package asserts that Electron, Bun and Node's major match the source manifest.

Separate hash-pinned root/mobile pnpm stores, the shared exact pnpm package and
upstream-pinned Node runtime/headers support offline application compilation in
the normal Nix sandbox. Required mobile asset generators run explicitly;
unrestricted dependency lifecycle scripts are not enabled.

Linux C helpers use a separately pinned GCC 9/glibc 2.31 toolchain to retain
upstream's ABI floor without Docker. Their derivation runs the upstream ELF-floor
checks and seven mocked Wayland protocol tests. Installed helper interpreter/
RPATH fixups use current Nix libraries. Patched node-pty is built through
upstream's native-runtime pipeline, retaining compatibility checks and packaging
probes.

Installed entry points:

- `orca-desktop`: GUI, registered as Orca in the desktop application menu.
- `orca-ide`: upstream packaged CLI launcher.
- `orca`: alias for that CLI launcher.

Wrappers default `ORCA_TELEMETRY_DISABLED=1`. The copied application's existing
externally-managed Linux update gate prevents in-app package replacement under
`/nix/store`; update through the pinned Nix input instead. Skill-install links use
this fork, since fork-only commits need not exist in the upstream repository.

The optional `orcad-template` SSH deployment resource is not included. This is not
a server-only package, and automatic SSH server deployment parity is not claimed.
Installing the desktop package does not declare or enable the VM's systemd
service. Existing remote-server connections and a server-only derivation remain
separate validation/integration concerns.

## Verification and integration boundaries

The fork's `Nix desktop` workflow builds and validates the final package on a
GitHub-hosted Linux runner; see [the CI policy](FORK-CI.md). To repeat its runtime
checks against an existing output:

```sh
nix run .#verify-desktop -- ./result ./nix-smoke-artifacts
```

This launches only on its own Xvfb display with a fresh profile. It writes a JSON
result and screenshot to the supplied artifact directory, without publishing
application logs or profile data.

A successful native-helper build or staging-tree packaging probe does not prove
the final installed desktop works. Before changing dotfiles, verify the complete
package output, installed CLI, packaged PTY and background GUI startup through
Playwright CDP on a disposable profile. Keep `ORCA_BACKGROUND_LAUNCH=1`, never
reveal/focus test windows, and use an isolated display for rendered checks.

Also trace later executable-digest checks when enabling new server/deployment
paths; fixing up a verified installed Node copy does not update every subsequent
runtime consumer automatically. The server recipe above is not a Nix package.

No NixOS/Home Manager activation, phone installation, commit or publication is
performed automatically by these packages. Pin the pushed fork revision in
dotfiles and preserve the VM's persistent profile, private endpoint,
telemetry-disable and mobile-pairing-log settings. Activation remains an explicit
operator action.
