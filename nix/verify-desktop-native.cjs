const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const resources = process.argv[2]
assert(resources, 'Pass the installed resources directory')
assert.equal(
  process.env.LD_LIBRARY_PATH,
  undefined,
  'Packaged runtimes must not inject libraries into host subprocesses'
)
if (process.versions.electron) {
  assert(process.env.ORCA_CI_PARENT_PATH, 'Pass the parent PATH to the Electron probe')
  assert(
    process.env.PATH === process.env.ORCA_CI_PARENT_PATH ||
      process.env.PATH.startsWith(`${process.env.ORCA_CI_PARENT_PATH}:`),
    'Packaged tools must be fallbacks, not shadow the parent PATH'
  )
  assert.equal(process.env.GDK_PIXBUF_MODULE_FILE, undefined)
  assert.equal(process.env.GIO_EXTRA_MODULES, undefined)
  assert(process.env.ORCA_CI_GSETTINGS, 'Pass the pinned gsettings executable')
  const keys = execFileSync(
    process.env.ORCA_CI_GSETTINGS,
    ['list-keys', 'org.gtk.Settings.FileChooser'],
    { encoding: 'utf8', timeout: 10000 }
  )
  assert(keys.trim().split('\n').includes('show-hidden'), 'GTK file chooser schema is unavailable')
}
const koffi = require(path.join(resources, 'node_modules/@koromix/koffi-linux-x64'))
assert.equal(typeof koffi.version, 'string')
const pty = require(path.join(resources, 'node_modules/node-pty'))
const child = pty.spawn('/bin/sh', ['-c', 'printf orca-installed-nix-pty'], {
  name: 'xterm',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { PATH: process.env.PATH }
})
let output = ''
const timer = setTimeout(() => {
  process.exitCode = 1
  child.kill()
}, 10000)
child.onData((data) => (output += data))
child.onExit((event) => {
  clearTimeout(timer)
  assert.equal(event.exitCode, 0)
  assert(output.includes('orca-installed-nix-pty'))
  console.log(
    JSON.stringify({
      node: process.versions.node,
      electron: process.versions.electron,
      koffi: koffi.version,
      pty: true
    })
  )
})
