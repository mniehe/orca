{
  pkgs,
  pnpm,
  src,
  hash,
  pname ? "orca-desktop",
  sourceRoot ? null,
}:
pkgs.fetchPnpmDeps ({
    inherit pname pnpm src hash;
    fetcherVersion = 5;
    CI = "1";
    ORCA_PNPM_GLOBAL_VIRTUAL_STORE = "0";
    nativeBuildInputs = [pkgs.git];
  }
  // pkgs.lib.optionalAttrs (sourceRoot != null) {
    inherit sourceRoot;
  })
