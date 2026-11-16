{pkgs}:
pkgs.stdenvNoCC.mkDerivation {
  pname = "pnpm";
  version = "12.14.0";
  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.14.0.tgz";
    hash = "sha256-HemO0uliEROwiHsGMitGHvud9z2RP8HRUQObELcRekE=";
  };
  dontConfigure = true;
  dontBuild = true;
  nativeBuildInputs = [pkgs.autoPatchelfHook];
  buildInputs = [pkgs.stdenv.cc.cc.lib];
  installPhase = ''
    runHook preInstall
    install -Dm755 pnpm "$out/bin/pnpm"
    install -Dm644 LICENSE "$out/share/licenses/pnpm/LICENSE"
    runHook postInstall
  '';
  passthru.nodejs-slim = pkgs.nodejs_24;
  meta = {
    license = pkgs.lib.licenses.mit;
    mainProgram = "pnpm";
    platforms = ["x86_64-linux"];
  };
}
