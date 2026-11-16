#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { parseSigningFingerprint, verifyApkSigner } from './build-private-android.mjs'

const USAGE = `Usage (from mobile/, Node 24+):
  pnpm exec tsx --conditions=orca-source scripts/install-private-android.mjs --apk <private.apk> --serial <device-serial> --expected-package <package.id> --expected-sha256 <64-hex> --build-tools <SDK/build-tools/version> [--adb <adb-path>] [--allow-new-package]
Explicit opt-in only: verifies APK metadata and private signer before contacting the device.
Requires an authorized connected device and, by default, the exact package already installed.
Installs only with adb -s <serial> install -r. No downgrade, uninstall, clear, launch,
or permission-grant flags. Reads back only the exact installed package/version.
--allow-new-package permits first installation; it does not migrate another package.`

export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    return { help: true }
  }
  const options = {}
  const values = ['apk', 'serial', 'expected-package', 'expected-sha256', 'build-tools', 'adb']
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].slice(2)
    if (argv[i] !== `--${name}` || ![...values, 'allow-new-package'].includes(name)) {
      throw new Error('Unknown argument; use --help')
    }
    if (Object.hasOwn(options, name)) {
      throw new Error(`Duplicate --${name}`)
    }
    if (name === 'allow-new-package') {
      options[name] = true
    } else {
      const value = argv[++i]
      if (!value || value.startsWith('-') || /[\r\n\0]/.test(value)) {
        throw new Error(`--${name} needs a value without line breaks`)
      }
      options[name] = value
    }
  }
  for (const name of ['apk', 'serial', 'expected-package', 'expected-sha256', 'build-tools']) {
    if (!options[name]) {
      throw new Error(`Required: --${name}`)
    }
  }
  options['expected-sha256'] = parseSigningFingerprint(options['expected-sha256'])
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:[\]-]*$/.test(options.serial)) {
    throw new Error('Invalid explicit device serial')
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(options['expected-package'])) {
    throw new Error('Invalid expected package ID')
  }
  return options
}

export async function installPrivateAndroid(options, runtime = {}) {
  // Revalidate at the action boundary, including callers other than the CLI.
  const argv = Object.entries(options).flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, value]
  )
  options = parseArgs(argv)
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Node 24+ is required')
  }
  const apk = path.resolve(options.apk)
  if (!fs.statSync(apk).isFile()) {
    throw new Error('Input APK must be a file')
  }
  const tools = path.resolve(options['build-tools'])
  const signer = path.join(tools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')
  const aapt = path.join(tools, process.platform === 'win32' ? 'aapt.exe' : 'aapt')
  const adb = options.adb ? path.resolve(options.adb) : 'adb'
  const run = runtime.run ?? (await import('@orca/process-host')).runProcess
  const checked = async (label, program, args, allowMissing = false) => {
    let result
    try {
      result = await run({
        program,
        args,
        cwd: path.resolve(import.meta.dirname, '..'),
        env: runtime.env ?? process.env,
        timeoutMs: 120_000
      })
    } catch {
      throw new Error(`${label} could not start`)
    }
    const absent =
      allowMissing && result.code === 1 && !result.stdout.trim() && !result.stderr.trim()
    if ((result.code !== 0 && !absent) || result.timedOut || result.outputTruncated) {
      throw new Error(`${label} failed`)
    }
    return result.stdout
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-install-'))
  try {
    const candidate = path.join(staging, 'candidate.apk')
    fs.copyFileSync(apk, candidate, fs.constants.COPYFILE_EXCL)
    const badging = await checked('APK metadata inspection', aapt, ['dump', 'badging', candidate])
    const packages = [
      ...badging.matchAll(
        /^package: name='([^'\r\n]+)' versionCode='([0-9]+)' versionName='([^'\r\n]+)'[^\r\n]*\r?$/gm
      )
    ]
    if (packages.length !== 1) {
      throw new Error('Invalid APK package/version metadata')
    }
    const [, packageId, versionCode, versionName] = packages[0]
    if (packageId !== options['expected-package']) {
      throw new Error('APK package does not match --expected-package')
    }
    const certificates = await checked('APK signature verification', signer, [
      'verify',
      '--verbose',
      '--print-certs',
      candidate
    ])
    const sha256 = verifyApkSigner(certificates, options['expected-sha256'])
    const target = ['-s', options.serial]
    const state = await checked('Authorized device check', adb, [...target, 'get-state'])
    if (state.trim() !== 'device') {
      throw new Error('An authorized connected device is required')
    }
    const installed = await checked(
      'Installed package check',
      adb,
      [...target, 'shell', 'pm', 'path', packageId],
      true
    )
    if (!installed.trim()) {
      if (!options['allow-new-package']) {
        throw new Error(
          'Exact package is not installed; --allow-new-package is required for first installation'
        )
      }
    } else if (
      !installed
        .trim()
        .split(/\r?\n/)
        .every((line) => /^package:\S+$/.test(line))
    ) {
      throw new Error('Installed package check returned unrecognized metadata')
    }
    const installation = await checked('APK installation', adb, [
      ...target,
      'install',
      '-r',
      candidate
    ])
    if (!/^Success\r?$/m.test(installation) || /^Failure\b/m.test(installation)) {
      throw new Error('APK installation did not report success; inspect manually')
    }
    const readback = await checked('Installed package readback', adb, [
      ...target,
      'shell',
      'dumpsys',
      'package',
      packageId
    ])
    const ids = [...readback.matchAll(/^\s*Package \[([^\]\r\n]+)\] [^\r\n]*$/gm)]
    const codes = [...readback.matchAll(/^\s*versionCode=([0-9]+)(?:\s[^\r\n]*)?$/gm)]
    const names = [...readback.matchAll(/^[\t ]*versionName=([^\r\n]+)\r?$/gm)]
    if (
      ids.length !== 1 ||
      ids[0][1] !== packageId ||
      codes.length !== 1 ||
      codes[0][1] !== versionCode ||
      names.length !== 1 ||
      names[0][1] !== versionName
    ) {
      throw new Error(
        'Installed package/version readback did not match APK; installation may have occurred, inspect manually'
      )
    }
    return { serial: options.serial, packageId, versionCode, versionName, sha256 }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log(USAGE)
    } else {
      const result = await installPrivateAndroid(options)
      console.log(
        `Verified installed ${result.packageId} ${result.versionName} (code ${result.versionCode}) on ${result.serial}; signer SHA256 ${result.sha256}`
      )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
