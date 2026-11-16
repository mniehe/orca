# Fork packaging scope

Keep fork changes limited to build/deployment support and consume upstream's build
entry points. The Android environment is documented in [mobile/nix](../mobile/nix/README.md).
It follows upstream's dependency/tool requirements; it does not freeze the app at an old release.

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
