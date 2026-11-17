import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  buildWaylandClipboard,
  waylandClipboardFingerprint
} from '../config/scripts/native-build/linux/build-wayland-clipboard.mjs'

const root = resolve(import.meta.dirname, '..')
const [nativePackage] = process.argv.slice(2)
if (!nativePackage) {
  throw new Error('Usage: prepare-desktop-native.mjs <native-package>')
}
const destination = join(root, 'native/wayland-clipboard/.build/x64/orca-wayland-clipboard')
mkdirSync(dirname(destination), { recursive: true })
copyFileSync(join(nativePackage, 'bin/orca-wayland-clipboard'), destination)
chmodSync(destination, 0o755)
writeFileSync(`${destination}.sha256`, waylandClipboardFingerprint(root, 'x64'))
buildWaylandClipboard({
  root,
  arch: 'x64',
  run: (command) => {
    throw new Error(`Prepared native helper cache missed: refusing to execute ${command}`)
  }
})
