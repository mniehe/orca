import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  buildWaylandClipboard,
  waylandClipboardFingerprint
} from '../config/scripts/native-build/linux/build-wayland-clipboard.mjs'
import {
  buildProviderExec,
  providerExecFingerprint
} from '../config/scripts/native-build/posix/build-provider-exec.mjs'

const root = resolve(import.meta.dirname, '..')
const [toolchain, nativePackage] = process.argv.slice(2)
if (!['host', 'docker'].includes(toolchain) || !nativePackage) {
  throw new Error('Usage: prepare-desktop-native.mjs host|docker <native-package>')
}
const noCompile = (command) => {
  throw new Error(`Prepared native helper cache missed: refusing to execute ${command}`)
}
for (const [name, directory, fingerprint] of [
  [
    'orca-wayland-clipboard',
    'native/wayland-clipboard/.build/x64',
    waylandClipboardFingerprint(root, 'x64')
  ],
  [
    'orca-provider-exec',
    'native/provider-exec/.build/linux-x64',
    providerExecFingerprint(root, 'linux-x64', toolchain)
  ]
]) {
  const destination = join(root, directory, name)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(join(nativePackage, 'bin', name), destination)
  chmodSync(destination, 0o755)
  writeFileSync(`${destination}.sha256`, fingerprint)
}
buildWaylandClipboard({ root, arch: 'x64', run: noCompile })
buildProviderExec({ root, target: 'linux-x64', hostCompiler: toolchain === 'host', run: noCompile })
