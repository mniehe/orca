import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { parseArgs, buildPrivateAndroid, verifyApkSigner } from './build-private-android.mjs'

const fingerprint = '1212121212121212121212121212121212121212121212121212121212121212'

test('SDK 37 scheme-labelled certificates require one signer and the pinned fingerprint', () => {
  const certificates = `Number of signers: 1\nV2 Signer: certificate SHA-256 digest: ${fingerprint}\n`
  assert.equal(verifyApkSigner(certificates, fingerprint), fingerprint)
  assert.throws(() =>
    verifyApkSigner(certificates.replace('signers: 1', 'signers: 2'), fingerprint)
  )
  assert.throws(() =>
    verifyApkSigner(certificates.replace('Number of signers: 1\n', ''), fingerprint)
  )
  assert.throws(() => verifyApkSigner(certificates, '34'.repeat(32)))
})

test('signing requires a pinned non-template fingerprint and rejects password flags', () => {
  assert.throws(() => parseArgs([]), /--keystore/)
  const args = [
    '--keystore',
    'private.jks',
    '--alias',
    'release',
    '--output',
    'private.apk',
    '--build-tools',
    'sdk/build-tools/36.0.0'
  ]
  assert.throws(() => parseArgs(args), /--expected-sha256/)
  assert.throws(() => parseArgs([...args, '--expected-sha256', 'abc']), /64 hexadecimal/)
  assert.throws(
    () =>
      parseArgs([
        ...args,
        '--expected-sha256',
        'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'
      ]),
    /template/
  )
  assert.throws(() => parseArgs(['--password', 'do-not-accept']), /Unknown/)
  assert.throws(() => parseArgs(['--keystore']), /needs a value/)
  assert.throws(() => parseArgs(['--build-only', '--input', 'x.apk']), /cannot be combined/)
})

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-private-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const tools = path.join(directory, 'sdk', 'build-tools', '36.0.0')
  fs.mkdirSync(tools, { recursive: true })
  fs.mkdirSync(path.join(directory, 'node_modules', '.bin'), { recursive: true })
  const files = [
    path.join(
      directory,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'expo.cmd' : 'expo'
    ),
    path.join(tools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'),
    path.join(directory, 'signing-placeholder.dat')
  ]
  for (const file of files) {
    fs.writeFileSync(file, 'synthetic test placeholder', { mode: 0o700 })
  }
  const options = parseArgs([
    '--keystore',
    path.join(directory, 'signing-placeholder.dat'),
    '--alias',
    'private-key',
    '--expected-sha256',
    fingerprint,
    '--build-tools',
    tools,
    '--output',
    path.join(directory, 'result.apk')
  ])
  const calls = []
  const run = async (spec) => {
    calls.push(spec)
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  return {
    directory,
    options,
    calls,
    runtime: {
      mobileRoot: directory,
      env: { ANDROID_HOME: path.join(directory, 'sdk') },
      interactive: true,
      run
    }
  }
}

function syntheticBuild(f, digest = fingerprint, failure) {
  const source = path.join(
    f.directory,
    'android',
    'app',
    'build',
    'outputs',
    'apk',
    'release',
    'app-release.apk'
  )
  f.runtime.run = async (spec) => {
    f.calls.push(spec)
    const command = spec.args[0]
    if (command === 'prebuild') {
      const wrapper = path.join(
        f.directory,
        'android',
        process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'
      )
      fs.mkdirSync(path.dirname(source), { recursive: true })
      fs.writeFileSync(wrapper, 'synthetic wrapper', { mode: 0o700 })
      fs.writeFileSync(source, 'stale artifact')
    }
    if (command === 'assembleRelease') {
      assert.equal(fs.existsSync(source), false, 'stale APK must be removed before Gradle')
      fs.writeFileSync(source, 'synthetic unsigned APK bytes')
    }
    if (command === 'sign') {
      assert.equal(spec.stdio, 'inherit', 'apksigner owns the terminal password prompt')
      assert.equal(spec.input, undefined)
      assert.equal(
        spec.args.some((arg) => /pass:|--ks-pass|--key-pass/.test(arg)),
        false
      )
      fs.writeFileSync(spec.args[spec.args.indexOf('--out') + 1], 'synthetic signed APK bytes')
    }
    if (command === 'verify') {
      assert.equal(fs.existsSync(f.options.output), false)
    }
    return {
      code: command === failure ? 1 : 0,
      stdout: command === 'verify' ? `Signer #1 certificate SHA-256 digest: ${digest}\n` : '',
      stderr: '',
      timedOut: false
    }
  }
}

test('build-only needs neither private signing inputs nor an interactive terminal', async (t) => {
  const f = fixture(t)
  syntheticBuild(f)
  const options = parseArgs(['--build-only', '--output', f.options.output])
  const result = await buildPrivateAndroid(options, { ...f.runtime, interactive: false })
  assert.equal(fs.readFileSync(result.output, 'utf8'), 'synthetic unsigned APK bytes')
  assert.equal(
    f.calls.some((spec) => ['sign', 'verify'].includes(spec.args[0])),
    false
  )
})

test('sign-existing does not require Expo or an SDK root and never rebuilds', async (t) => {
  const f = fixture(t)
  syntheticBuild(f)
  fs.rmSync(path.join(f.directory, 'node_modules'), { recursive: true })
  const input = path.join(f.directory, 'existing.apk')
  fs.writeFileSync(input, 'synthetic existing APK')
  const result = await buildPrivateAndroid({ ...f.options, input }, { ...f.runtime, env: {} })
  assert.equal(fs.readFileSync(result.output, 'utf8'), 'synthetic signed APK bytes')
  assert.equal(fs.readFileSync(input, 'utf8'), 'synthetic existing APK')
  assert.equal(
    f.calls.some((spec) => ['prebuild', 'assembleRelease'].includes(spec.args[0])),
    false
  )
})

test('preflight checks prerequisites without building, prompting, or writing outputs', async (t) => {
  const f = fixture(t)
  await buildPrivateAndroid({ ...f.options, preflight: true }, f.runtime)
  assert.deepEqual(
    f.calls.map((spec) => spec.args),
    [['-version']]
  )
  assert.equal(fs.existsSync(path.join(f.directory, 'android')), false)
  assert.equal(fs.existsSync(f.options.output), false)
  fs.unlinkSync(f.options.keystore)
  await assert.rejects(
    buildPrivateAndroid({ ...f.options, preflight: true }, f.runtime),
    /keystore/
  )
})

test('build publishes only after verifying the actual candidate signer', async (t) => {
  const f = fixture(t)
  syntheticBuild(f)
  const result = await buildPrivateAndroid(f.options, f.runtime)
  assert.equal(result.output, f.options.output)
  assert.equal(fs.readFileSync(result.output, 'utf8'), 'synthetic signed APK bytes')
  assert.deepEqual(
    f.calls.map((spec) => spec.args[0]),
    ['-version', 'prebuild', 'assembleRelease', 'sign', 'verify']
  )
  assert.deepEqual(f.calls[1].args, ['prebuild', '--platform', 'android', '--no-install'])
})

test('mismatch, template/multiple/malformed signers and subprocess failures never publish', async (t) => {
  for (const [digest, failure] of [
    ['3434343434343434343434343434343434343434343434343434343434343434'],
    ['fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'],
    [''],
    ['not-a-certificate-digest'],
    [`${fingerprint}\nSigner #2 certificate SHA-256 digest: ${fingerprint}`],
    [fingerprint, 'prebuild'],
    [fingerprint, 'sign'],
    [fingerprint, 'verify'],
    [fingerprint, 'assembleRelease']
  ]) {
    const f = fixture(t)
    syntheticBuild(f, digest, failure)
    await assert.rejects(buildPrivateAndroid(f.options, f.runtime), /signer|failed/)
    assert.equal(fs.existsSync(f.options.output), false)
    assert.equal(
      fs.readdirSync(f.directory).some((name) => name.startsWith('.orca-private-')),
      false
    )
    if (failure) {
      assert.equal(f.calls.at(-1).args[0], failure)
    }
  }
})

test('noninteractive build and existing output fail closed before any build', async (t) => {
  const f = fixture(t)
  syntheticBuild(f)
  await assert.rejects(
    buildPrivateAndroid(f.options, { ...f.runtime, interactive: false }),
    /terminal/
  )
  assert.equal(
    f.calls.some((spec) => spec.args[0] === 'prebuild'),
    false
  )
  fs.writeFileSync(f.options.output, 'keep existing file')
  await assert.rejects(buildPrivateAndroid(f.options, f.runtime), /already exists/)
  assert.equal(fs.readFileSync(f.options.output, 'utf8'), 'keep existing file')
})

test('missing SDK, Expo, signer and broken Java stop during preflight', async (t) => {
  for (const missing of ['sdk', 'expo', 'signer', 'java']) {
    const f = fixture(t)
    if (missing === 'sdk') {
      f.runtime.env = {}
    }
    if (missing === 'expo') {
      fs.rmSync(path.join(f.directory, 'node_modules'), { recursive: true })
    }
    if (missing === 'signer') {
      fs.rmSync(f.options['build-tools'], { recursive: true })
    }
    if (missing === 'java') {
      f.runtime.run = async () => {
        throw new Error('synthetic missing Java')
      }
    }
    await assert.rejects(
      buildPrivateAndroid({ ...f.options, preflight: true }, f.runtime),
      /SDK|dependencies|apksigner|Java/
    )
    assert.equal(fs.existsSync(f.options.output), false)
    assert.equal(fs.existsSync(path.join(f.directory, 'android')), false)
  }
})
