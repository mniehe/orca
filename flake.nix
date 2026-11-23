{
  description = "Orca source packages for NixOS";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    nixpkgs-floor = {
      url = "github:NixOS/nixpkgs/1c1f5649bb9c1b0d98637c8c365228f57126f361";
      flake = false;
    };
  };

  outputs = {
    self,
    nixpkgs,
    nixpkgs-floor,
  }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {inherit system;};
    floorPkgs = import nixpkgs-floor {inherit system;};
    desktopNative = import ./nix/desktop-native.nix {inherit pkgs floorPkgs;};
    pnpm = import ./mobile/nix/pnpm.nix {inherit pkgs;};
    src = nixpkgs.lib.cleanSourceWith {
      src = self;
      name = "source";
      filter = path: type:
        nixpkgs.lib.cleanSourceFilter path type
        && !(builtins.elem (builtins.baseNameOf path) ["node_modules" ".hermes" ".direnv"])
        && !(builtins.elem (nixpkgs.lib.removePrefix "${self}/" path) ["mobile/android" "mobile/ios" "out" "dist"]);
    };
    pnpmDeps = import ./nix/desktop-deps.nix {
      inherit pkgs pnpm src;
      hash = "sha256-wPqoNcUt5RY989Iq6DiSO5UPlFChoWfJXWgcULzrdzs=";
    };
    mobilePnpmDeps = import ./nix/desktop-deps.nix {
      inherit pkgs pnpm src;
      pname = "orca-mobile";
      sourceRoot = "source/mobile";
      hash = "sha256-T3XQGn88U3lMOKOjoMkarlqGj3ovoI2BtZtTJMB9xlc=";
    };
    desktop = import ./nix/desktop.nix {
      inherit pkgs pnpm src pnpmDeps mobilePnpmDeps desktopNative;
      electronHash = "sha256-ZXmY6NZ1rv0W9iS0dx57no9t401sEav8nPkNVYlK3FM=";
      buildCommit = nixpkgs.lib.removeSuffix "-dirty" (self.rev or self.dirtyRev or "unknown");
      sourceDateEpoch = self.lastModified or 1;
    };
  in {
    packages.${system} = {
      default = desktop;
      orca = desktop;
      desktop-native = desktopNative;
      desktop-deps = pnpmDeps;
      mobile-web-deps = mobilePnpmDeps;
    };
    checks.${system}.desktop-native = desktopNative;
    apps.${system}.verify-desktop = {
      type = "app";
      meta.description = "Validate the installed Orca desktop on an isolated display";
      program = nixpkgs.lib.getExe (pkgs.writeShellApplication {
        name = "orca-verify-desktop";
        runtimeInputs = [pkgs.nodejs_24 pkgs.xorg-server pkgs.python3 pkgs.xclip];
        text = ''
          export ORCA_CI_PLAYWRIGHT=${pkgs.playwright-driver}
          export ORCA_CI_EXPECTED_VERSION=${nixpkgs.lib.escapeShellArg (builtins.fromJSON (builtins.readFile ./package.json)).version}
          export ORCA_CI_EXPECTED_ELECTRON=${nixpkgs.lib.escapeShellArg (builtins.fromJSON (builtins.readFile ./package.json)).devDependencies.electron}
          export ORCA_CI_GSETTINGS=${pkgs.glib.bin}/bin/gsettings
          export ORCA_CI_CLIPBOARD_TESTS=${./native/wayland-clipboard}
          exec node ${./nix}/verify-desktop.mjs "$@"
        '';
      });
    };
  };
}
