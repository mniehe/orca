import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import {
  verifyJournalFileLock,
  verifyProviderExec,
  verifyX11Clipboard
} from './verify-desktop-helpers.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.ORCA_CI_PLAYWRIGHT)
const [packageArgument, artifactPath] = process.argv.slice(2)
assert(packageArgument && artifactPath, 'Usage: verify-desktop <package> <artifact-directory>')
const packagePath = fs.realpathSync(packageArgument)
const expectedVersion = process.env.ORCA_CI_EXPECTED_VERSION
assert(expectedVersion, 'Missing expected source version')
const expectedElectron = process.env.ORCA_CI_EXPECTED_ELECTRON
assert(expectedElectron, 'Missing expected Electron version')
const clipboardTests = process.env.ORCA_CI_CLIPBOARD_TESTS
assert(clipboardTests, 'Missing the wayland-clipboard test directory')
const artifacts = path.resolve(artifactPath)
fs.mkdirSync(artifacts, { recursive: true })
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-nix-smoke-'))
const home = path.join(root, 'home')
const runtime = path.join(root, 'runtime')
fs.mkdirSync(home)
fs.mkdirSync(runtime, { mode: 0o700 })
const allowed = new Set(['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'NIX_SSL_CERT_FILE'])
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)))
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  XDG_RUNTIME_DIR: runtime,
  TMPDIR: root,
  ORCA_BACKGROUND_LAUNCH: '1',
  ORCA_TELEMETRY_DISABLED: '1'
})
const executable = path.join(packagePath, 'bin/orca-desktop')
const resources = path.join(packagePath, 'lib/orca/resources')
function run(command, args, extraEnv = {}, expectedStatus = 0) {
  const result = spawnSync(command, args, {
    env: { ...env, ...extraEnv },
    cwd: root,
    encoding: 'utf8',
    timeout: 30000
  })
  assert.ifError(result.error)
  assert.equal(result.status, expectedStatus, `${command} failed: ${result.stderr}`)
  return result.stdout.trim()
}
const nativeProbe = path.join(import.meta.dirname, 'verify-desktop-native.cjs')
const server = net.createServer()
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const port = server.address().port
await new Promise((resolve) => server.close(resolve))
let displayNumber = 200
const sockets = fs.readFileSync('/proc/net/unix', 'utf8')
while (
  displayNumber < 300 &&
  (fs.existsSync(`/tmp/.X${displayNumber}-lock`) ||
    fs.existsSync(`/tmp/.X11-unix/X${displayNumber}`) ||
    sockets.includes(`@/tmp/.X11-unix/X${displayNumber}\n`))
) {
  displayNumber++
}
assert(displayNumber < 300, 'No unused isolated X display')
const display = `:${displayNumber}`
const xvfbLog = fs.openSync(path.join(root, 'xvfb.log'), 'w')
const appLog = fs.openSync(path.join(root, 'app.log'), 'w')
let xvfb
let child
let browser
async function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) {
    return
  }
  process.kill('SIGTERM')
  for (let i = 0; i < 40 && process.exitCode === null && process.signalCode === null; i++) {
    await delay(100)
  }
  if (process.exitCode === null && process.signalCode === null) {
    process.kill('SIGKILL')
  }
}
try {
  assert.equal(run(path.join(packagePath, 'bin/orca-ide'), ['--version']), expectedVersion)
  assert(!fs.existsSync(path.join(packagePath, 'bin/orca')), 'Do not shadow the Orca screen reader')
  run(path.join(resources, 'bin/orca-wayland-clipboard'), ['--help'], {}, 64)
  run(path.join(packagePath, 'lib/orca/chrome_crashpad_handler'), ['--version'])
  const node = JSON.parse(
    run(path.join(resources, 'node-runtime/bin/node'), [nativeProbe, resources])
  )
  const electron = JSON.parse(
    run(executable, [nativeProbe, resources], {
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_CI_PARENT_PATH: env.PATH,
      ORCA_CI_GSETTINGS: process.env.ORCA_CI_GSETTINGS
    })
  )
  assert.equal(node.node, electron.node)
  assert.equal(
    electron.electron,
    expectedElectron,
    'Packaged Electron must be the declared release'
  )
  const helpers = {
    providerExec: await verifyProviderExec({
      helper: path.join(resources, 'bin/orca-provider-exec'),
      env,
      cwd: root
    }),
    journalFileLock: await verifyJournalFileLock({
      helper: path.join(resources, 'bin/journal-file-lock'),
      node: path.join(resources, 'node-runtime/bin/node'),
      env,
      directories: [root, artifacts]
    }),
    x11Clipboard: verifyX11Clipboard({
      binary: path.join(resources, 'bin/orca-wayland-clipboard'),
      tests: clipboardTests,
      env,
      cwd: root
    })
  }
  xvfb = spawn('Xvfb', [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], {
    env,
    stdio: ['ignore', xvfbLog, xvfbLog]
  })
  let spawnError
  xvfb.once('error', (error) => (spawnError = error))
  for (let i = 0; i < 100 && !fs.existsSync(`/tmp/.X11-unix/X${displayNumber}`); i++) {
    assert.ifError(spawnError)
    assert.equal(xvfb.exitCode, null, 'Isolated Xvfb exited')
    await delay(50)
  }
  assert.equal(
    Number(fs.readFileSync(`/tmp/.X${displayNumber}-lock`, 'utf8').trim()),
    xvfb.pid,
    'Display lock must belong to this probe'
  )
  child = spawn(
    executable,
    [
      `--user-data-dir=${path.join(root, 'profile')}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--ozone-platform=x11',
      '--password-store=basic'
    ],
    {
      env: { ...env, DISPLAY: display, XDG_SESSION_TYPE: 'x11' },
      cwd: root,
      stdio: ['ignore', appLog, appLog]
    }
  )
  child.once('error', (error) => (spawnError = error))
  const deadline = Date.now() + 90000
  let ready = false
  while (Date.now() < deadline) {
    assert.ifError(spawnError)
    assert.equal(child.exitCode, null, `App exited; diagnostic logs: ${root}`)
    assert.equal(child.signalCode, null, 'App was signalled')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000)
      })
      if (response.ok) {
        ready = true
        break
      }
    } catch {}
    await delay(250)
  }
  assert(ready, `No CDP endpoint; diagnostic logs: ${root}`)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 })
  let page
  while (!page && Date.now() < deadline) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().includes('index.html'))
    if (!page) {
      await delay(250)
    }
  }
  assert(page, 'No application renderer')
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(
    () =>
      Boolean(
        window.api?.updater &&
        document.body?.innerText.includes('Projects') &&
        document.body.innerText.includes('Tasks')
      ),
    undefined,
    { timeout: 45000 }
  )
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  const version = await page.evaluate(() => window.api.updater.getVersion())
  assert.equal(version, expectedVersion)
  await page.evaluate(() => window.api.updater.getStatus())
  assert(
    !fs.readFileSync(path.join(root, 'app.log'), 'utf8').includes('package-type marker unusable'),
    'The updater must recognise the nix package-type marker'
  )
  await page.screenshot({
    path: path.join(artifacts, 'desktop.png'),
    animations: 'disabled',
    timeout: 30000
  })
  assert.equal(errors.length, 0, JSON.stringify(errors))
  const result = {
    passed: true,
    version,
    node,
    electron,
    helpers,
    isolatedDisplay: display,
    viewport: '1440x900',
    pageErrors: errors
  }
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  const log = fs.readFileSync(path.join(root, 'app.log'), 'utf8')
  const diagnostics = {
    sandboxFailure: /No usable sandbox|SUID sandbox|Failed to move to new namespace/.test(log),
    libraryFailure: /error while loading shared libraries|symbol lookup error/.test(log),
    displayFailure: /Missing X server|needs a usable display/.test(log)
  }
  fs.writeFileSync(
    path.join(artifacts, 'result.json'),
    JSON.stringify({ passed: false, error: error.message, diagnostics }, null, 2)
  )
  console.error(JSON.stringify(diagnostics))
  throw error
} finally {
  await browser?.close().catch(() => {})
  await stop(child)
  await stop(xvfb)
  fs.closeSync(xvfbLog)
  fs.closeSync(appLog)
}
