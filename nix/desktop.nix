{
  pkgs,
  pnpm,
  src,
  pnpmDeps,
  mobilePnpmDeps,
  desktopNative,
  electronRelease,
  buildCommit,
  sourceDateEpoch ? 1,
}: let
  inherit (pkgs) lib;
  manifest = builtins.fromJSON (builtins.readFile ../package.json);
  # Upstream pins an exact Electron patch release that nixpkgs' electron_<major>-bin
  # rarely matches, so build the same binary package at upstream's version.
  # Path concatenation, not interpolation: "${pkgs.path}" copies nixpkgs into a second
  # store path that evaluation without builds cannot realise.
  electron =
    pkgs.callPackage (pkgs.path + "/pkgs/development/tools/electron/binary/generic.nix") {}
    electronRelease.version
    electronRelease.hashes;
  # Upstream's native helper builders fall back to Docker when a staged prebuild's
  # fingerprint stamp misses; fail with the cause instead of "spawnSync docker ENOENT".
  dockerShim = pkgs.writeShellScriptBin "docker" ''
    echo "docker is unavailable in the Nix build: a native helper prebuild from nix/desktop-native.nix" \
      "no longer matches upstream's fingerprint (see nix/prepare-desktop-native.mjs)." >&2
    exit 1
  '';
  node = pkgs.nodejs_24;
  nodeVersion = "24.22.1";
  nodeArchive = pkgs.fetchurl {
    url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.gz";
    sha256 = "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c";
  };
  nodeHeaders = pkgs.fetchurl {
    url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-headers.tar.gz";
    sha256 = "322e0a27db9088093ab8347bdc8c7e0aaa21dc9ed548390bf06b394494c09267";
  };
  python = pkgs.python3.withPackages (ps: [ps.pygobject3]);
  runtimeLibraries = with pkgs; [
    stdenv.cc.cc.lib
    (lib.getLib glibc)
    alsa-lib
    at-spi2-atk
    at-spi2-core
    cairo
    cups
    dbus
    expat
    gdk-pixbuf
    glib
    gtk3
    gtk4
    nss
    nspr
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxkbfile
    pango
    pciutils
    systemd
    libnotify
    pipewire
    libsecret
    libpulseaudio
    speechd-minimal
    libdrm
    libgbm
    libxkbcommon
    libxshmfence
    libGL
    vulkan-loader
    wayland
  ];
  runtimeLibraryPath = lib.makeLibraryPath runtimeLibraries;
  angleRunpaths = map (p: "${lib.getLib p}/lib") [pkgs.libGL pkgs.pciutils pkgs.vulkan-loader];
  desktopItem = pkgs.makeDesktopItem {
    name = "orca-ide";
    desktopName = "Orca";
    comment = manifest.description;
    exec = "orca-desktop %U";
    icon = "orca-ide";
    categories = ["Development" "IDE"];
    mimeTypes = ["x-scheme-handler/orca" "text/markdown" "text/csv" "text/tab-separated-values"];
    startupWMClass = "orca";
  };
in
  assert pkgs.stdenv.hostPlatform.system == "x86_64-linux";
  assert builtins.match "[0-9a-f]{40}" buildCommit != null;
  assert electronRelease.version == manifest.devDependencies.electron;
  assert pkgs.bun.version == manifest.devDependencies.bun;
  assert lib.versions.major node.version == manifest.engines.node;
    pkgs.stdenv.mkDerivation {
      pname = "orca-desktop";
      version = manifest.version;
      inherit src pnpmDeps;

      nativeBuildInputs = [
        node
        pnpm
        pkgs.bun
        pkgs.python3
        pkgs.pkg-config
        pkgs.git
        pkgs.makeWrapper
        pkgs.autoPatchelfHook
        pkgs.wrapGAppsHook3
        pkgs.binutils
        pkgs.patchelf
        pkgs.pnpmConfigHook
        dockerShim
      ];
      buildInputs = runtimeLibraries;
      runtimeDependencies = map lib.getLib runtimeLibraries;
      appendRunpaths = angleRunpaths;
      dontWrapGApps = true;
      dontAutoPatchelf = true;
      stripExclude = ["lib/orca/resources/node-runtime/bin/node"];
      strictDeps = true;

      CI = "1";
      ORCA_BACKGROUND_LAUNCH = "1";
      ORCA_TELEMETRY_DISABLED = "1";
      ORCA_PNPM_GLOBAL_VIRTUAL_STORE = "0";
      ORCA_REUSE_PREPARED_NATIVE_RUNTIME = "1";
      ORCA_BUILD_COMMIT = buildCommit;
      SOURCE_DATE_EPOCH = toString sourceDateEpoch;
      ELECTRON_OVERRIDE_DIST_PATH = "${electron.dist}";
      ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
      CSC_IDENTITY_AUTO_DISCOVERY = "false";
      npm_config_build_from_source = "true";
      # nixpkgs' cc-wrapper adds -mtls-dialect=gnu2 on x86_64 Linux (cc-cflags-before);
      # TLS descriptors need GLIBC_ABI_GNU2_TLS, which fails upstream's glibc 2.31
      # floor check for addons that use thread_local. This later flag wins.
      NIX_CFLAGS_COMPILE = "-mtls-dialect=gnu";

      preConfigure = ''
        export HOME="$TMPDIR/home"
        export XDG_CACHE_HOME="$HOME/.cache"
        mkdir -p "$HOME" "$XDG_CACHE_HOME"
        export LD_LIBRARY_PATH="${runtimeLibraryPath}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
      '';

      postPatch = ''
        substituteInPlace config/scripts/build-identity/build-source-commit.mjs \
          --replace-fail "commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()" \
          "commit = process.env.ORCA_BUILD_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()"
        substituteInPlace src/shared/skills/installation/agent-feature-install-commands.ts \
          --replace-fail 'https://github.com/stablyai/orca' 'https://github.com/mniehe/orca'
        # Patch only the staged, already hash-verified Node, never the raw download cache.
        substituteInPlace config/scripts/desktop-distribution/linux/appimage-node-runtime.cjs \
          --replace-fail '  chmodSync(destination, 0o755)' \
          '  chmodSync(destination, 0o755); require("node:child_process").execFileSync("${pkgs.patchelf}/bin/patchelf", ["--set-interpreter", "${pkgs.stdenv.cc.bintools.dynamicLinker}", "--set-rpath", "${runtimeLibraryPath}", destination])'
        # Reuse the externally-managed update gate, regardless of host dpkg/rpm availability.
        substituteInPlace src/main/updater/linux-package/linux-update-package-type.ts \
          --replace-fail 'export function isExternallyManagedLinuxInstall(): boolean {' \
          'export function isExternallyManagedLinuxInstall(): boolean { if (process.platform === "linux" && process.execPath.startsWith("/nix/store/")) return true;'
      '';

      buildPhase = ''
        runHook preBuild
        (
          cd mobile
          pnpmDeps=${mobilePnpmDeps} pnpmConfigHook
          node scripts/build-terminal-webview-engine.mjs
          node scripts/build-mermaid-page-engine.mjs
          node scripts/build-katex-page-style.mjs
          node scripts/build-terminal-document-script.mjs
        )
        export npm_config_node_gyp="$PWD/node_modules/node-gyp/bin/node-gyp.js"
        export ORCA_NODE_RUNTIME_CACHE_DIR="$PWD/out/node-runtime-cache"
        mkdir -p "$ORCA_NODE_RUNTIME_CACHE_DIR" "$TMPDIR/node-headers"
        cp ${nodeArchive} "$ORCA_NODE_RUNTIME_CACHE_DIR/node-v${nodeVersion}-linux-x64.tar.gz"
        cp ${nodeHeaders} "$ORCA_NODE_RUNTIME_CACHE_DIR/node-v${nodeVersion}-headers.tar.gz"
        tar -xzf ${nodeHeaders} -C "$TMPDIR/node-headers"
        export npm_config_nodedir="$TMPDIR/node-headers/node-v${nodeVersion}"
        node --input-type=module -e '
          import { NODE_RUNTIME_PIN, NODE_RUNTIME_ASSETS } from "./src/shared/node-runtime/node-runtime-pin.ts";
          import assert from "node:assert/strict";
          assert.equal(NODE_RUNTIME_PIN.version, "${nodeVersion}");
          assert.equal(NODE_RUNTIME_PIN.headers.sha256, "322e0a27db9088093ab8347bdc8c7e0aaa21dc9ed548390bf06b394494c09267");
          assert.equal(NODE_RUNTIME_ASSETS["linux-x64-glibc"].archiveSha256, "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c");
        '
        node -e '
          const fs = require("node:fs"), path = require("node:path");
          const bun = require.resolve("bun/package.json");
          const executable = path.join(path.dirname(bun), JSON.parse(fs.readFileSync(bun)).bin.bun);
          fs.rmSync(executable, {force:true});
          fs.symlinkSync("${pkgs.bun}/bin/bun", executable);
          const electronPackage = path.dirname(require.resolve("electron/package.json"));
          fs.symlinkSync("${electron.dist}", path.join(electronPackage, "dist"), "dir");
          fs.writeFileSync(path.join(electronPackage, "path.txt"), "electron");
        '
        node config/scripts/workspace-package-build/build-workspace-packages.mjs
        node nix/prepare-desktop-native.mjs ${desktopNative}
        node config/scripts/native-build/node-addons/ensure-native-runtime.mjs --runtime=node --force
        node config/scripts/native-build/node-addons/ensure-native-runtime.mjs --runtime=electron
        node config/scripts/cli-build/build-cli.mjs
        node config/scripts/cli-build/verify-cli-bin.mjs --fix-executable --fix-package-json
        pnpm run build:electron-vite
        pnpm run verify:built-skills-cli
        pnpm run build:web-from-renderer
        pnpm run build:mobile-web
        pnpm exec electron-builder --config config/electron-builder.config.cjs \
          --linux --x64 --dir --publish never \
          -c.electronDist=${electron.dist} -c.electronVersion=${electron.version}
        test -f dist/linux-unpacked/resources/app.asar
        test -f dist/linux-unpacked/resources/app.asar.unpacked/out/cli/index.js
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p "$out/lib/orca" "$out/bin"
        cp -a dist/linux-unpacked/. "$out/lib/orca/"
        chmod -R u+w "$out/lib/orca"
        printf '%s\n' nix > "$out/lib/orca/resources/package-type"
        install -Dm644 resources/build/icon.png "$out/share/icons/hicolor/1024x1024/apps/orca-ide.png"
        cp -r ${desktopItem}/share/applications "$out/share/"
        # Koffi ships both libcs; this package and its Node/Electron runtimes use glibc.
        rm -r "$out/lib/orca/resources/node_modules/@koromix/koffi-linux-x64/musl_x64"
        substituteInPlace "$out/lib/orca/resources/bin/orca-ide" \
          --replace-fail '#!/usr/bin/env bash' '#!${pkgs.bash}/bin/bash'
        runHook postInstall
      '';

      preFixup = ''
        # Keep GTK schemas available without leaking plugin paths into host subprocesses.
        orcaWrapperArgs=(
          --set-default XDG_DATA_DIRS /usr/local/share/:/usr/share/
          --prefix XDG_DATA_DIRS : "$GSETTINGS_SCHEMAS_PATH"
          --set-default ORCA_TELEMETRY_DISABLED 1
          --suffix PATH : ${lib.makeBinPath [python pkgs.xdotool pkgs.xclip pkgs.xorg-server pkgs.wl-clipboard pkgs.xdg-utils]}
        )
        makeWrapper "$out/lib/orca/orca-ide" "$out/bin/orca-desktop" \
          "''${orcaWrapperArgs[@]}"
        makeWrapper "$out/lib/orca/resources/bin/orca-ide" "$out/bin/orca-ide" \
          "''${orcaWrapperArgs[@]}"
      '';

      postFixup = ''
        # Preserve dlopen search paths after the standard RPATH shrink step.
        autoPatchelf "$out/lib/orca"
        for library in libEGL.so libGLESv2.so; do
          rpath="$(patchelf --print-rpath "$out/lib/orca/$library")"
          for required in ${lib.escapeShellArgs angleRunpaths}; do
            case ":$rpath:" in
              *":$required:"*) ;;
              *) echo "$library is missing its dlopen search path: $required" >&2; exit 1 ;;
            esac
          done
        done
        test "$(head -n 1 "$out/lib/orca/resources/bin/orca-ide")" = '#!${pkgs.bash}/bin/bash'
        "$out/lib/orca/resources/node-runtime/bin/node" --version
      '';

      passthru = {
        inherit electron node desktopNative dockerShim;
        includesOrcadTemplate = false;
      };
      meta = {
        description = "${manifest.description} (source-built Nix desktop)";
        homepage = manifest.homepage;
        mainProgram = "orca-desktop";
        platforms = ["x86_64-linux"];
      };
    }
