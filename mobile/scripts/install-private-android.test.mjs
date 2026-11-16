import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { installPrivateAndroid, parseArgs } from './install-private-android.mjs'

const fingerprint = '1212121212121212121212121212121212121212121212121212121212121212'

function fixture(t, changes = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-install-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const apk = path.join(directory, 'input.apk')
  fs.writeFileSync(apk, 'synthetic APK placeholder, not a real APK')
  const calls = []
  const options = parseArgs([
    '--apk',
    apk,
    '--serial',
    'TEST-SERIAL',
    '--expected-package',
    'dev.orca.app',
    '--expected-sha256',
    fingerprint,
    '--build-tools',
    directory
  ])
  const runtime = {
    run: async (spec) => {
      calls.push(spec)
      const command = spec.args[0]
      let stdout = ''
      if (command === 'dump') {
        stdout =
          changes.metadata ??
          "package: name='dev.orca.app' versionCode='31' versionName='0.0.67' platformBuildVersionName='16'\n"
      } else if (command === 'verify') {
        stdout = changes.signer ?? `Signer #1 certificate SHA-256 digest: ${fingerprint}\n`
      } else if (spec.args[2] === 'get-state') {
        stdout = changes.state ?? 'device\n'
      } else if (spec.args.includes('path')) {
        stdout = changes.installed ?? 'package:/data/app/test/base.apk\n'
      } else if (spec.args.includes('dumpsys')) {
        stdout =
          changes.readback ??
          'Packages:\n  Package [dev.orca.app] (abc):\n    versionCode=31 minSdk=24 targetSdk=36\n    versionName=0.0.67\n'
      } else if (spec.args.includes('install')) {
        stdout = changes.installResult ?? 'Success\n'
      } else {
        assert.fail(`Unexpected process: ${spec.program} ${spec.args.join(' ')}`)
      }
      return {
        code: changes.failure === command ? 1 : 0,
        stdout,
        stderr: '',
        timedOut: false,
        outputTruncated: changes.truncated === command
      }
    }
  }
  return { options, runtime, calls }
}

function installations(f) {
  return f.calls.filter((spec) => spec.args.includes('install'))
}

test('installer requires explicit target, package and non-template signing pin', () => {
  assert.throws(() => parseArgs([]), /Required/)
  const args = [
    '--apk',
    'x.apk',
    '--serial',
    'TEST',
    '--expected-package',
    'dev.orca.app',
    '--build-tools',
    'tools'
  ]
  assert.throws(() => parseArgs(args), /expected-sha256/)
  assert.throws(
    () =>
      parseArgs([
        ...args,
        '--expected-sha256',
        'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'
      ]),
    /template/
  )
  assert.throws(
    () => parseArgs([...args, '--expected-sha256', fingerprint, '--serial', 'other']),
    /Duplicate/
  )
  assert.throws(
    () => parseArgs([...args, '--expected-sha256', fingerprint, '--downgrade']),
    /Unknown/
  )
})

test('wrong package or actual signer is rejected before contacting a device', async (t) => {
  for (const changes of [
    { metadata: "package: name='com.stably.orca.mobile' versionCode='31' versionName='0.0.67'\n" },
    { metadata: "package: name='dev.orca.app' versionCode='bad' versionName='0.0.67'\n" },
    {
      signer:
        'Signer #1 certificate SHA-256 digest: 3434343434343434343434343434343434343434343434343434343434343434\n'
    },
    { truncated: 'verify' },
    { failure: 'verify' }
  ]) {
    const f = fixture(t, changes)
    await assert.rejects(
      installPrivateAndroid(f.options, f.runtime),
      /package|metadata|signer|failed/
    )
    assert.equal(
      f.calls.some((spec) => spec.args.includes('get-state')),
      false
    )
  }
})

test('unauthorized device and missing installed package fail closed without installation', async (t) => {
  for (const changes of [{ state: 'unauthorized\n' }, { state: 'offline\n' }, { installed: '' }]) {
    const f = fixture(t, changes)
    await assert.rejects(installPrivateAndroid(f.options, f.runtime), /authorized|not installed/)
    assert.equal(installations(f).length, 0)
  }
})

test('update installs only with -r to explicit serial then verifies exact package/version', async (t) => {
  const f = fixture(t)
  const result = await installPrivateAndroid(f.options, f.runtime)
  assert.deepEqual(result, {
    serial: 'TEST-SERIAL',
    packageId: 'dev.orca.app',
    versionCode: '31',
    versionName: '0.0.67',
    sha256: fingerprint
  })
  const install = installations(f)[0]
  assert.deepEqual(install.args.slice(0, 4), ['-s', 'TEST-SERIAL', 'install', '-r'])
  assert.equal(install.args.length, 5)
  assert.deepEqual(f.calls.at(-1).args, [
    '-s',
    'TEST-SERIAL',
    'shell',
    'dumpsys',
    'package',
    'dev.orca.app'
  ])
  assert.equal(fs.existsSync(install.args[4]), false, 'temporary APK snapshot is cleaned up')
})

test('new package requires explicit opt-in and still uses only install -r', async (t) => {
  const f = fixture(t, { installed: '' })
  await installPrivateAndroid({ ...f.options, 'allow-new-package': true }, f.runtime)
  assert.deepEqual(installations(f)[0].args.slice(0, 4), ['-s', 'TEST-SERIAL', 'install', '-r'])
})

test('an explicit install failure cannot be mistaken for an already-present matching version', async (t) => {
  const f = fixture(t, { installResult: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n' })
  await assert.rejects(installPrivateAndroid(f.options, f.runtime), /installation/)
})

test('a successful install cannot hide mismatching or absent installed metadata', async (t) => {
  for (const readback of [
    'Package [dev.orca.app] (abc):\n versionCode=30 minSdk=24\n versionName=0.0.66\n',
    'Package [com.stably.orca.mobile] (abc):\n versionCode=31 minSdk=24\n versionName=0.0.67\n',
    ''
  ]) {
    const f = fixture(t, { readback })
    await assert.rejects(installPrivateAndroid(f.options, f.runtime), /readback/)
    assert.equal(installations(f).length, 1)
  }
})
