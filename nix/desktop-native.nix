{
  pkgs,
  floorPkgs,
}: let
  arch =
    if pkgs.stdenv.hostPlatform.system == "x86_64-linux"
    then "x64"
    else throw "Orca's Nix desktop native build currently supports x86_64-linux only";
in
  floorPkgs.stdenv.mkDerivation {
    pname = "orca-desktop-native";
    version = "1";
    src = pkgs.lib.fileset.toSource {
      root = ../native;
      fileset = pkgs.lib.fileset.unions [
        ../native/wayland-clipboard/wayland-clipboard.c
        ../native/wayland-clipboard/x11-clipboard-publisher.c
        ../native/wayland-clipboard/x11-clipboard-publisher.h
        ../native/wayland-clipboard/protocol_test.py
        ../native/provider-exec/provider-exec.c
      ];
    };

    nativeBuildInputs = [pkgs.patchelf pkgs.nodejs_24 pkgs.binutils pkgs.python3];
    buildInputs = [floorPkgs.wayland];
    phases = ["unpackPhase" "buildPhase" "installPhase" "checkPhase"];
    doCheck = true;

    buildPhase = ''
      runHook preBuild
      flags=(-O2 -Wall -Wextra -Werror -fstack-protector-strong
        -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now)
      $CC "''${flags[@]}" wayland-clipboard/wayland-clipboard.c \
        wayland-clipboard/x11-clipboard-publisher.c -ldl -o orca-wayland-clipboard
      $CC -std=c11 "''${flags[@]}" provider-exec/provider-exec.c -o orca-provider-exec
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      for helper in orca-wayland-clipboard orca-provider-exec; do
        install -Dm755 "$helper" "$out/bin/$helper"
        patchelf --set-interpreter ${pkgs.stdenv.cc.bintools.dynamicLinker} \
          --set-rpath ${pkgs.lib.getLib pkgs.glibc}/lib "$out/bin/$helper"
      done
      patchelf --set-rpath ${pkgs.lib.makeLibraryPath [pkgs.glibc pkgs.wayland pkgs.gtk3]} \
        "$out/bin/orca-wayland-clipboard"
      strip --strip-unneeded "$out/bin/"*
      runHook postInstall
    '';

    checkPhase = ''
      runHook preCheck
      node -e 'require(process.argv[1]).verifyLinuxGlibcFloor(process.argv[2], { targetArch: "${arch}" })' \
        ${../config/scripts/native-build/linux/verify-linux-glibc-floor.cjs} "$out/bin"
      python3 wayland-clipboard/protocol_test.py "$out/bin/orca-wayland-clipboard"
      runHook postCheck
    '';

    meta = {
      description = "Orca desktop native helpers built against upstream's glibc ABI floor";
      platforms = ["x86_64-linux"];
    };
  }
