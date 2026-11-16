{
  description = "Orca Android build shell for x86_64 Linux";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = {nixpkgs, ...}: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {
      inherit system;
      config = {
        allowUnfree = true;
        android_sdk.accept_license = true;
      };
    };
    buildToolsVersion = "37.0.0";
    ndkVersion = "27.1.12297006";
    android = pkgs.androidenv.composeAndroidPackages {
      cmdLineToolsVersion = "21.0";
      platformToolsVersion = "37.0.1";
      platformVersions = ["36" "37.0"];
      buildToolsVersions = ["36.0.0" buildToolsVersion];
      includeNDK = true;
      ndkVersions = [ndkVersion];
      includeCmake = true;
      cmakeVersions = ["3.22.1" "3.30.5"];
      includeEmulator = false;
      includeSystemImages = false;
      includeSources = false;
    };
    androidSdk = pkgs.runCommand "orca-android-sdk" {} ''
      cp -rs --no-preserve=mode ${android.androidsdk} "$out"
      for version in 3.22.1 3.30.5; do
        cmake="$out/libexec/android-sdk/cmake/$version"
        rm "$cmake"
        mkdir -p "$cmake"
        cp -rs --no-preserve=mode ${android.androidsdk}/libexec/android-sdk/cmake/$version/. "$cmake/"
        rm "$cmake/bin/ninja"
        ln -s ${pkgs.ninja}/bin/ninja "$cmake/bin/ninja"
      done
    '';
    sdk = "${androidSdk}/libexec/android-sdk";
    # Match the packageManager pin in mobile/package.json.
    pnpm = import ./pnpm.nix {inherit pkgs;};
    shell = pkgs.buildFHSEnv {
      name = "orca-android-shell";
      targetPkgs = p:
        [pnpm androidSdk]
        ++ (with p; [
          nodejs_24
          jdk17
          git
          bashInteractive
          coreutils
          findutils
          gnugrep
          gnused
          gnutar
          gzip
          unzip
          zip
          which
          pkg-config
          ninja
          cacert
          openssl
          zlib
          stdenv.cc.cc.lib
        ]);
      runScript = "bash";
      profile = ''
        export JAVA_HOME=${pkgs.jdk17.home}
        export ANDROID_HOME=${sdk}
        export ANDROID_SDK_ROOT="$ANDROID_HOME"
        export ANDROID_NDK_ROOT="$ANDROID_HOME/ndk/${ndkVersion}"
        export ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
        export ANDROID_BUILD_TOOLS="$ANDROID_HOME/build-tools/${buildToolsVersion}"
        export PATH="$ANDROID_BUILD_TOOLS:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmake/3.22.1/bin:$PATH"
        export GRADLE_OPTS="''${GRADLE_OPTS-} -Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_BUILD_TOOLS/aapt2"
        export ORCA_BACKGROUND_LAUNCH=1
        export ORCA_TELEMETRY_DISABLED=1
      '';
    };
  in {
    devShells.${system}.default = shell.env;
    apps.${system}.default = {
      type = "app";
      program = "${shell}/bin/orca-android-shell";
    };
  };
}
