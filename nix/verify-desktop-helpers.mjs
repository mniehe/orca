import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PROBE_TIMEOUT_MS = 10000
// Exit codes from native/journal-file-lock/main.c.
const LOCK_UNSUPPORTED_STORAGE = 4
const LOCK_HELD = 6

function waitForExit(child, label) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${label} did not exit within ${PROBE_TIMEOUT_MS} ms`))
    }, PROBE_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function waitForOutput(child, expected, label) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(
      () => reject(new Error(`${label} never printed ${JSON.stringify(expected)}: ${output}`)),
      PROBE_TIMEOUT_MS
    )
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes(expected)) {
        clearTimeout(timer)
        resolve(output)
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${label} exited with ${code} before printing ${expected}: ${output}`))
    })
  })
}

function collectOutput(child) {
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => (output.stdout += chunk))
  child.stderr.on('data', (chunk) => (output.stderr += chunk))
  return output
}

// Mirrors daemon-fd-closing-exec.ts: the helper must drop every inherited descriptor above 2
// except NODE_CHANNEL_FD before it execs the daemon.
export async function verifyProviderExec({ helper, env, cwd }) {
  const leakPath = path.join(cwd, 'provider-exec-inherited')
  const leaked = fs.openSync(leakPath, 'w')
  const report = 'for n in 3 4; do printf "%s=%s\\n" "$n" "$(readlink /proc/$$/fd/$n)"; done'
  try {
    const child = spawn(helper, ['--exec-without-inherited-fds', '--', '/bin/sh', '-c', report], {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe', leaked, 'ipc']
    })
    const output = collectOutput(child)
    const { code } = await waitForExit(child, 'orca-provider-exec')
    assert.equal(code, 0, `orca-provider-exec failed: ${output.stderr}`)
    const fds = Object.fromEntries(
      output.stdout
        .trim()
        .split('\n')
        .map((line) => line.split('='))
    )
    assert.notEqual(fds['3'], leakPath, 'orca-provider-exec leaked an inherited descriptor')
    assert.match(fds['4'] ?? '', /^socket:/, 'orca-provider-exec closed NODE_CHANNEL_FD')
    return { inheritedClosed: true, channelKept: true }
  } finally {
    fs.closeSync(leaked)
  }
}

const createDatabase = `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA journal_mode=WAL;CREATE TABLE fixture_history(value TEXT);INSERT INTO fixture_history VALUES('history never opened')");db.close()`
const holdReader = `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});db.prepare('SELECT * FROM fixture_history').get();process.stdout.write('ready');process.stdin.resume();process.stdin.on('end',()=>{db.close()})`
const tryReader = `const{DatabaseSync}=require('node:sqlite');let db;try{db=new DatabaseSync(process.argv[1],{readOnly:true});db.prepare('SELECT * FROM fixture_history').get();process.stdout.write('opened')}catch{process.stdout.write('blocked')}finally{db?.close()}`

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// The helper accepts only local filesystems it can trust SQLite locks on, so try each candidate.
function lockableDatabase({ helper, node, env, directories }) {
  for (const directory of directories) {
    const root = fs.mkdtempSync(path.join(directory, 'orca-journal-lock-'))
    const database = path.join(root, 'source.db')
    const created = spawnSync(node, ['-e', createDatabase, database], {
      env,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS
    })
    assert.equal(created.status, 0, `Could not create the SQLite fixture: ${created.stderr}`)
    const check = spawnSync(helper, [database, '--check'], {
      env,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS
    })
    if (check.status === 0 && check.stdout === 'eligible\n') {
      return { root, database }
    }
    fs.rmSync(root, { recursive: true, force: true })
    assert.equal(check.status, LOCK_UNSUPPORTED_STORAGE, `journal-file-lock --check failed`)
  }
  assert.fail(
    `journal-file-lock accepts none of ${directories.join(', ')} (ext4/xfs/btrfs/zfs only)`
  )
}

function readerOutcome({ node, env, database }) {
  const result = spawnSync(node, ['-e', tryReader, database], {
    env,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

// Follows journal-legacy-file-lock.test.ts: a live SQLite reader excludes the helper, the held
// lock excludes SQLite, and end of input releases the lock without touching the file.
export async function verifyJournalFileLock({ helper, node, env, directories }) {
  const { root, database } = lockableDatabase({ helper, node, env, directories })
  const children = []
  try {
    const reader = spawn(node, ['-e', holdReader, database], { env, stdio: 'pipe' })
    children.push(reader)
    reader.stderr.resume()
    await waitForOutput(reader, 'ready', 'SQLite reader')
    const contended = spawnSync(helper, [database], {
      env,
      input: '',
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS
    })
    assert.equal(contended.status, LOCK_HELD, 'journal-file-lock ignored a live SQLite reader')
    reader.stdin.end()
    await waitForExit(reader, 'SQLite reader')

    const before = sha256(database)
    const holder = spawn(helper, [database], { env, stdio: 'pipe' })
    children.push(holder)
    const holderOutput = collectOutput(holder)
    await waitForOutput(holder, 'locked\n', 'journal-file-lock')
    assert.equal(readerOutcome({ node, env, database }), 'blocked', 'SQLite read a locked file')
    holder.stdin.end()
    const { code } = await waitForExit(holder, 'journal-file-lock after end of input')
    assert.equal(code, 0, 'journal-file-lock failed to release on end of input')
    assert.equal(holderOutput.stdout, 'locked\n', 'journal-file-lock acted on end of input')
    assert.equal(readerOutcome({ node, env, database }), 'opened', 'Lock outlived the helper')
    assert.equal(sha256(database), before, 'journal-file-lock changed the database')
    return { excluded: true, releasedOnEof: true, filesystem: path.dirname(root) }
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// Upstream's own X11 publisher test, run against the installed binary on a private Xvfb.
export function verifyX11Clipboard({ binary, tests, env, cwd }) {
  const result = spawnSync('python3', [path.join(tests, 'x11_test.py'), binary], {
    env: { ...env, PYTHONDONTWRITEBYTECODE: '1' },
    cwd,
    encoding: 'utf8',
    timeout: 120000
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `x11_test.py failed: ${result.stderr}`)
  return { x11Test: true }
}
