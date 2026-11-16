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
      hash = "sha256-0nm1ijYdeEkX/+40VIn+nXJYnq/JhGo91WU9RMw9ePM=";
    };
    mobilePnpmDeps = import ./nix/desktop-deps.nix {
      inherit pkgs pnpm src;
      pname = "orca-mobile";
      sourceRoot = "source/mobile";
      hash = "sha256-n1BQTMrF4A7T9faxog6rdoApkZeTCgFHBlSvWXASHK4=";
    };
    desktop = import ./nix/desktop.nix {
      inherit pkgs pnpm src pnpmDeps mobilePnpmDeps desktopNative;
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
  };
}
