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

async function runDsh(args, env) {
  try {
    return await execFileAsync('pnpm', ['dsh', ...args], {
      cwd: checkout,
      env,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    throw new Error(`dsh command failed: pnpm dsh ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error })
  }
}

async function packPlugin(destination) {
  const { stdout } = await execFileAsync('npm', [
    'pack', '--silent', '--pack-destination', destination,
  ], {
    cwd: pluginRoot,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const filename = stdout.trim().split(/\r?\n/).at(-1)
  if (!filename) throw new Error('npm pack did not report an archive')
  return join(destination, filename)
}

async function installFixtureFiles(home, profile) {
  for (const file of ['mock-llm.mjs', 'preset-headless-runner.mjs']) {
    await copyFile(join(fixtureRoot, file), join(home, 'profiles', profile, file))
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
    const timer = setTimeout(() => reject(new Error(`timed out waiting for DSH Web startup\n${output}`)), 120_000)
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
  return { child, url }
}

async function settlesWithin(promise, timeoutMs) {
  return await Promise.race([
    promise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
  ])
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

async function sessionLogs(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(async entry => (await readFile(join(entry.parentPath, entry.name), 'utf8'))
      .split(/\r?\n/)
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line))))
}

test('installed package runs all three experiment tools with durable non-SubAgent children', {
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-agent-evolution-integration-'))
  const profile = 'agent-evolution-integration'
  const env = {
    ...process.env,
    DSH_CHECKOUT: checkout,
    DSH_HOME: home,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
  }

  try {
    const pluginArchive = await packPlugin(home)
    await runDsh([
      'plugin', '--profile', profile, 'add',
      `link:${checkout}/packages/bundle/headless`,
      pluginArchive,
    ], env)
    await installFixtureFiles(home, profile)

    const run = await runDsh([
      '--profile', profile,
      '--patch', join(fixtureRoot, 'overlay.cordis.yml'),
      'Run the Agent Evolution integration probe.',
    ], env)
    assert.equal(run.stdout, 'AGENT_EVOLUTION_PARENT_OK\n')

    const sessions = await sessionLogs(join(home, 'sessions'))
    assert.equal(sessions.length, 4, `expected parent and three experiment sessions, found ${sessions.length}`)
    const parent = sessions.find(records => records[0]?.parentSession === undefined)
    const children = sessions.filter(records => records[0]?.parentSession !== undefined)
    assert.ok(parent, 'parent session was not persisted')
    assert.equal(children.length, 3)
    for (const child of children) {
      assert.equal(child[0].agentPreset, 'minimal')
      assert.equal(child[0].delegationDepth, 1)
      assert.equal(child[0].origin, undefined)
      assert.equal(child.some(record => record.type === 'subagent/descriptor'), false)
      assert.ok(child.some(record => record.type === 'sandbox/mode'
        && record.data?.mode === 'danger-full-access'
        && record.data?.source === 'delegation'))
    }
    assert.equal(children.filter(records => JSON.stringify(records).includes('EXPERIMENT_SINGLE_OK')).length, 1)
    assert.equal(children.filter(records => JSON.stringify(records).includes('EXPERIMENT_COMPARE_OK')).length, 2)

    const parentToolNames = parent
      .filter(record => record.type === 'tool/call')
      .map(record => record.data?.name)
    assert.deepEqual(parentToolNames, [
      'agent_experiment_list_presets',
      'agent_experiment_run',
      'agent_experiment_compare',
    ])
    const parentResultText = JSON.stringify(parent.filter(record => record.type === 'tool/result'))
    assert.match(parentResultText, /persisted=true/)
    assert.match(parentResultText, /No winner was selected/)
    assert.equal((parentResultText.match(/stop=completed/g) ?? []).length, 3)
    assert.match(JSON.stringify(parent), /AGENT_EVOLUTION_PARENT_OK/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('installed package composes into current DSH Web and serves the built application', {
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-agent-evolution-web-integration-'))
  const profile = 'agent-evolution-web-integration'
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  let server

  try {
    const pluginArchive = await packPlugin(home)
    await runDsh([
      'plugin', '--profile', profile, 'add',
      `link:${checkout}/packages/bundle/web-app`,
      pluginArchive,
    ], env)
    server = await startWebDsh(['--profile', profile, '--no-open', '--port', '0'], env)
    const response = await fetch(`${server.url}/`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<!doctype html>/i)
  } finally {
    if (server !== undefined) await stopWebDsh(server.child)
    await rm(home, { recursive: true, force: true })
  }
})
