#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { getMobileExpoExecutablePath } from './mobile-expo-cli.mjs'

const TEMPLATE_SHA256 = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'
const USAGE = `Usage (from mobile/, Node 24+):
  pnpm exec tsx --conditions=orca-source scripts/build-private-android.mjs --build-only --output <new.apk>
  pnpm exec tsx --conditions=orca-source scripts/build-private-android.mjs [--input <existing.apk>] --keystore <private.jks> --alias <key-alias> --expected-sha256 <64-hex> --build-tools <SDK/build-tools/version> --output <new.apk>
Add --preflight to check prerequisites (including java -version) without building/signing.
Without --input, runs Expo prebuild --no-install then Gradle assembleRelease.
--build-only exports the release artifact AS BUILT; it is NOT verified as privately signed.
--input signs an existing APK without Expo, Gradle, or an SDK root requirement.
Signing requires an interactive terminal; passwords are never accepted as arguments.
No automatic installs or device operations. Existing output files are never replaced.`

export function parseSigningFingerprint(value) {
  if (!/^[a-fA-F0-9]{64}$/.test(value ?? '')) {
    throw new Error('--expected-sha256 must contain exactly 64 hexadecimal characters (no colons)')
  }
  const fingerprint = value.toLowerCase()
  if (fingerprint === TEMPLATE_SHA256) {
    throw new Error('The public Expo template signer is forbidden')
  }
  return fingerprint
}

export function verifyApkSigner(certificates, expected) {
  const fingerprint = parseSigningFingerprint(expected)
  const signers = [
    ...certificates.matchAll(
      /^(?:Signer #\d+|V\d+(?:\.\d+)? Signer(?: #\d+)?:) certificate SHA-256 digest: ([a-fA-F0-9]{64})[\t ]*\r?$/gm
    )
  ]
  const counts = [...certificates.matchAll(/^Number of signers: (\d+)[\t ]*\r?$/gm)]
  const schemeLabelled = /^V\d+(?:\.\d+)? Signer/m.test(certificates)
  if (
    (schemeLabelled && counts.length !== 1) ||
    counts.length > 1 ||
    (counts.length === 1 && counts[0][1] !== '1') ||
    signers.length !== 1 ||
    signers[0][1].toLowerCase() !== fingerprint
  ) {
    throw new Error('APK signer does not match the required private SHA256; no output published')
  }
  return fingerprint
}

export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    return { help: true }
  }
  const options = {}
  const values = ['keystore', 'alias', 'expected-sha256', 'output', 'build-tools', 'input']
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].slice(2)
    if (argv[i] !== `--${name}` || ![...values, 'preflight', 'build-only'].includes(name)) {
      throw new Error('Unknown argument; use --help (password arguments are not supported)')
    }
    if (Object.hasOwn(options, name)) {
      throw new Error(`Duplicate --${name}`)
    }
    if (['preflight', 'build-only'].includes(name)) {
      options[name] = true
    } else {
      const value = argv[++i]
      if (!value || value.startsWith('-') || /[\r\n\0]/.test(value)) {
        throw new Error(`--${name} needs a value without line breaks`)
      }
      options[name] = value
    }
  }
  if (
    options['build-only'] &&
    ['input', 'keystore', 'alias', 'expected-sha256', 'build-tools'].some((key) => options[key])
  ) {
    throw new Error('--build-only cannot be combined with signing inputs')
  }
  const required = options['build-only']
    ? ['output']
    : ['keystore', 'alias', 'output', 'expected-sha256', 'build-tools']
  for (const name of required) {
    if (!options[name]) {
      throw new Error(`Required: --${name}`)
    }
  }
  if (!options['build-only']) {
    options['expected-sha256'] = parseSigningFingerprint(options['expected-sha256'])
  }
  return options
}

function requireFile(file, label, executable = false) {
  try {
    if (!fs.statSync(file).isFile()) {
      throw new Error('not a file')
    }
    fs.accessSync(
      file,
      executable && process.platform !== 'win32' ? fs.constants.X_OK : fs.constants.R_OK
    )
  } catch {
    throw new Error(`Missing or inaccessible ${label}`)
  }
}

export async function buildPrivateAndroid(options, runtime = {}) {
  const mobileRoot = runtime.mobileRoot ?? path.resolve(import.meta.dirname, '..')
  const env = runtime.env ?? process.env
  const buildOnly = options['build-only'] === true
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Node 24+ is required')
  }
  let keystore
  let signer
  if (!buildOnly) {
    parseSigningFingerprint(options['expected-sha256'])
    keystore = path.resolve(options.keystore)
    requireFile(keystore, 'keystore')
    signer = path.resolve(
      options['build-tools'],
      process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'
    )
    requireFile(signer, 'SDK apksigner', true)
  }
  let expo
  let source
  if (options.input) {
    if (buildOnly) {
      throw new Error('--build-only cannot be combined with --input')
    }
    source = path.resolve(options.input)
    requireFile(source, 'input APK')
  } else {
    const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT
    if (!sdk || !fs.statSync(sdk, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('Set ANDROID_HOME or ANDROID_SDK_ROOT to an installed Android SDK')
    }
    expo = getMobileExpoExecutablePath(mobileRoot)
    if (!expo) {
      throw new Error('Mobile dependencies are missing; install them manually first')
    }
    requireFile(expo, 'Expo executable', true)
  }
  const output = path.resolve(options.output)
  if (!output.endsWith('.apk')) {
    throw new Error('--output must end with .apk')
  }
  if (fs.lstatSync(output, { throwIfNoEntry: false })) {
    throw new Error('Output already exists; choose a new path')
  }
  if (!fs.statSync(path.dirname(output), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Output parent directory must exist')
  }
  fs.accessSync(path.dirname(output), fs.constants.W_OK)
  const run = runtime.run ?? (await import('@orca/process-host')).runProcess
  const checked = async (label, program, args, extra = {}) => {
    let result
    try {
      result = await run({ program, args, cwd: mobileRoot, env, timeoutMs: null, ...extra })
    } catch {
      throw new Error(`${label} could not start`)
    }
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(`${label} failed; no verified output published`)
    }
    return result.stdout
  }
  const java = env.JAVA_HOME
    ? path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : 'java'
  await checked('Java prerequisite check', java, ['-version'], { timeoutMs: 30_000 })
  if (options.preflight) {
    return { preflight: true }
  }
  if (!buildOnly && !(runtime.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    throw new Error('An interactive terminal is required for private apksigner password prompts')
  }
  if (!source) {
    await checked('Expo prebuild', expo, ['prebuild', '--platform', 'android', '--no-install'], {
      stdio: 'inherit'
    })
    const android = path.join(mobileRoot, 'android')
    const gradle = path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
    requireFile(gradle, 'generated Gradle wrapper', true)
    source = path.join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
    fs.rmSync(source, { force: true })
    await checked('Gradle release build', gradle, ['assembleRelease'], {
      cwd: android,
      stdio: 'inherit'
    })
    requireFile(source, 'fresh release APK')
  }
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.orca-private-'))
  try {
    const candidate = path.join(staging, 'candidate.apk')
    let sha256
    if (buildOnly) {
      fs.copyFileSync(source, candidate, fs.constants.COPYFILE_EXCL)
    } else {
      await checked(
        'Private APK signing',
        signer,
        [
          'sign',
          '--ks',
          keystore,
          '--ks-key-alias',
          options.alias,
          '--v4-signing-enabled',
          'false',
          '--out',
          candidate,
          source
        ],
        { stdio: 'inherit' }
      )
      requireFile(candidate, 'signed APK')
      const certificates = await checked(
        'APK signature verification',
        signer,
        ['verify', '--verbose', '--print-certs', candidate],
        { timeoutMs: 120_000 }
      )
      sha256 = verifyApkSigner(certificates, options['expected-sha256'])
    }
    // A same-filesystem hard link publishes atomically without overwriting a race winner.
    fs.linkSync(candidate, output)
    return { output, sha256, buildOnly }
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
      const result = await buildPrivateAndroid(options)
      if (result.preflight) {
        console.log('Preflight passed; no build or password prompt performed.')
      } else {
        console.log(
          `${result.buildOnly ? 'Unverified build-only APK' : 'Verified private APK'}: ${result.output}`
        )
      }
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
