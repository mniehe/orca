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
import {
  buildJournalFileLock,
  desktopJournalFileLockFingerprint
} from '../config/scripts/native-build/build-journal-file-lock.mjs'

const root = resolve(import.meta.dirname, '..')
const [nativePackage] = process.argv.slice(2)
if (!nativePackage) {
  throw new Error('Usage: prepare-desktop-native.mjs <native-package>')
}
function refuseBuild(command) {
  const name = typeof command === 'string' ? command : command.program
  throw new Error(`Prepared native helper cache missed: refusing to execute ${name}`)
}

function stage(executable, relativeDestination, fingerprint) {
  const destination = join(root, relativeDestination)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(join(nativePackage, 'bin', executable), destination)
  chmodSync(destination, 0o755)
  writeFileSync(`${destination}.sha256`, fingerprint)
  return destination
}

stage(
  'orca-wayland-clipboard',
  'native/wayland-clipboard/.build/x64/orca-wayland-clipboard',
  waylandClipboardFingerprint(root, 'x64')
)
buildWaylandClipboard({ root, arch: 'x64', run: refuseBuild })

stage(
  'orca-provider-exec',
  'native/provider-exec/.build/linux-x64/orca-provider-exec',
  providerExecFingerprint(root, 'linux-x64', 'docker')
)
buildProviderExec({ target: 'linux-x64', root, run: refuseBuild })

const journalFileLock = stage(
  'journal-file-lock',
  'native/journal-file-lock/.build/x64/journal-file-lock',
  desktopJournalFileLockFingerprint(root, 'x64')
)
buildJournalFileLock(journalFileLock, 'x64', { glibcFloor: 'desktop', run: refuseBuild })
