const assert = require('node:assert/strict')
const path = require('node:path')

const resources = process.argv[2]
assert(resources, 'Pass the installed resources directory')
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
