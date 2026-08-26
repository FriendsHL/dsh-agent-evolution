import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = join(pluginRoot, 'test', 'fixtures', 'current-dsh')
const checkout = process.env.DSH_CHECKOUT ?? join(pluginRoot, '..', 'deepseek-harness')

async function runDsh(args, options) {
  try {
    return await execFileAsync('pnpm', ['dsh', ...args], {
      cwd: checkout,
      env: options.env,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    throw new Error(`dsh command failed: pnpm dsh ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error })
  }
}

async function startWebDsh(args, env) {
  const child = spawn(process.execPath, [join(checkout, 'apps', 'cli', 'lib', 'bin.js'), ...args], {
    cwd: checkout,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for DSH Web startup\n${output}`))
    }, 120_000)
    const inspect = (chunk) => {
      output += chunk.toString()
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      if (match?.[1]) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`DSH Web exited before startup (code=${code}, signal=${signal})\n${output}`))
    })
  })
  return { child, url, output: () => output }
}

async function stopWebDsh(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  child.kill('SIGINT')
  if (await settlesWithin(closed, 5_000)) return
  child.kill('SIGTERM')
  if (await settlesWithin(closed, 5_000)) return
  child.kill('SIGKILL')
  if (!await settlesWithin(closed, 5_000)) throw new Error('DSH Web process did not terminate')
}

async function settlesWithin(promise, timeoutMs) {
  return await Promise.race([
    promise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
  ])
}

async function filesBelow(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => join(entry.parentPath, entry.name))
}

function parseJsonl(content) {
  return content.split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
}

test('installs into current DSH, boots headless, and runs preset tools plus a child Agent', {
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-agent-factory-integration-'))
  const env = {
    ...process.env,
    DSH_CHECKOUT: checkout,
    DSH_HOME: home,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
  }

  try {
    await runDsh([
      'plugin', '--profile', 'agent-factory-integration', 'add',
      `link:${checkout}/packages/bundle/headless`,
      `link:${pluginRoot}`,
    ], { env })
    await copyFile(
      join(fixtureRoot, 'mock-llm.mjs'),
      join(home, 'profiles', 'agent-factory-integration', 'mock-llm.mjs'),
    )

    const run = await runDsh([
      '--profile', 'agent-factory-integration',
      '--patch', join(fixtureRoot, 'overlay.cordis.yml'),
      'Run the Agent Factory integration probe.',
    ], { env })
    assert.equal(run.stdout, 'FACTORY_PARENT_OK\n')

    const sessionFiles = await filesBelow(join(home, 'sessions'))
    assert.equal(sessionFiles.length, 2, `expected parent and child sessions, found ${sessionFiles.length}`)
    const sessions = await Promise.all(sessionFiles.map(async file => parseJsonl(await readFile(file, 'utf8'))))
    const child = sessions.find(records => records[0]?.agentPreset === 'minimal')
    const parent = sessions.find(records => records[0]?.parentSession === undefined && records !== child)
    assert.ok(child, 'child session with agentPreset=minimal was not persisted')
    assert.ok(parent, 'parent session was not persisted')
    assert.equal(child[0].origin, 'subagent')
    assert.equal(child[0].delegationDepth, 1)

    const parentToolNames = parent
      .filter(record => record.type === 'tool/call')
      .map(record => record.data?.name)
    assert.deepEqual(parentToolNames, ['agent_presets', 'agent_run'])
    assert.match(JSON.stringify(child), /FACTORY_CHILD_OK/)
    assert.match(JSON.stringify(parent), /FACTORY_PARENT_OK/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('installs into the current DSH Web profile and serves the built application', {
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-agent-factory-web-integration-'))
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
  }
  let server

  try {
    await runDsh([
      'plugin', '--profile', 'agent-factory-web-integration', 'add',
      `link:${checkout}/packages/bundle/web-app`,
      `link:${pluginRoot}`,
    ], { env })
    server = await startWebDsh([
      '--profile', 'agent-factory-web-integration',
      '--no-open',
      '--port', '0',
    ], env)
    const response = await fetch(`${server.url}/`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<!doctype html>/i)
  } finally {
    if (server !== undefined) await stopWebDsh(server.child)
    await rm(home, { recursive: true, force: true })
  }
})
