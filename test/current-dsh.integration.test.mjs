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

function descriptorLabel(records) {
  return records.find(record => record.type === 'subagent/descriptor')?.data?.label
}

test('installed package runs all reviewed development roles and records real QA shell evidence', {
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-reviewed-development-integration-'))
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
      'plugin', '--profile', 'reviewed-development-integration', 'add',
      `link:${checkout}/packages/bundle/headless`,
      pluginArchive,
    ], { env })
    await copyFile(
      join(fixtureRoot, 'mock-llm.mjs'),
      join(home, 'profiles', 'reviewed-development-integration', 'mock-llm.mjs'),
    )
    await copyFile(
      join(fixtureRoot, 'preset-headless-runner.mjs'),
      join(home, 'profiles', 'reviewed-development-integration', 'preset-headless-runner.mjs'),
    )

    const run = await runDsh([
      '--profile', 'reviewed-development-integration',
      '--patch', join(fixtureRoot, 'overlay.cordis.yml'),
      'Run the reviewed development integration probe.',
    ], { env })
    assert.equal(run.stdout, 'ORCHESTRATOR_PARENT_OK\n')

    const sessionFiles = await filesBelow(join(home, 'sessions'))
    assert.equal(sessionFiles.length, 6, `expected parent and five child sessions, found ${sessionFiles.length}`)
    const sessions = await Promise.all(sessionFiles.map(async file => parseJsonl(await readFile(file, 'utf8'))))
    const parent = sessions.find(records => records[0]?.parentSession === undefined)
    const children = sessions.filter(records => records[0]?.parentSession !== undefined)
    assert.ok(parent, 'parent session was not persisted')
    assert.deepEqual(children.map(descriptorLabel).sort(), [
      'code_reviewer', 'design_reviewer', 'designer', 'implementer', 'qa',
    ])
    for (const child of children) {
      assert.equal(child[0].agentPreset, 'minimal')
      assert.equal(child[0].origin, 'subagent')
      assert.equal(child[0].delegationDepth, 1)
      assert.ok(child.some(record => record.type === 'sandbox/mode'
        && record.data?.mode === 'danger-full-access'
        && record.data?.source === 'delegation'))
    }

    const parentToolNames = parent
      .filter(record => record.type === 'tool/call')
      .map(record => record.data?.name)
    assert.deepEqual(parentToolNames, ['run_reviewed_development'])
    const parentCall = parent.find(record => record.type === 'tool/call'
      && record.data?.name === 'run_reviewed_development')
    const parentResult = parent.find(record => record.type === 'tool/result'
      && record.data?.message?.source?.callId === parentCall?.data?.callId)
    assert.ok(parentResult, 'parent did not persist the orchestrator tool result')
    const qa = children.find(records => descriptorLabel(records) === 'qa')
    assert.ok(qa, 'QA session was not persisted')
    const shellCall = qa.find(record => record.type === 'tool/call' && record.data?.name === 'bash')
    assert.ok(shellCall, 'QA did not call the real bash tool')
    assert.equal(JSON.parse(shellCall.data.arguments).command, "printf 'QA_OK\\n'")
    const shellResult = qa.find(record => record.type === 'tool/result'
      && record.data?.message?.source?.callId === shellCall.data.callId)
    assert.equal(shellResult?.data?.message?.content?.[0]?.isError, false)
    assert.match(JSON.stringify(shellResult), /QA_OK/)
    assert.equal(await readFile(join(home, 'reviewed-development-implementer.marker'), 'utf8'), 'implemented\n')
    const persistedToolResult = JSON.stringify(parentResult)
    assert.match(JSON.stringify(parent), /ORCHESTRATOR_PARENT_OK/)
    assert.match(persistedToolResult, /Reviewed development: completed/)
    assert.match(persistedToolResult, /Inspect the listed child sessions for complete prompts, tool calls, results, and structured evidence/)
    for (const child of children) assert.match(persistedToolResult, new RegExp(child[0].id))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('installed package stops after a rejected design review', { timeout: 180_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-reviewed-development-reject-'))
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
      'plugin', '--profile', 'reviewed-development-reject', 'add',
      `link:${checkout}/packages/bundle/headless`,
      pluginArchive,
    ], { env })
    await copyFile(
      join(fixtureRoot, 'mock-llm.mjs'),
      join(home, 'profiles', 'reviewed-development-reject', 'mock-llm.mjs'),
    )
    await copyFile(
      join(fixtureRoot, 'preset-headless-runner.mjs'),
      join(home, 'profiles', 'reviewed-development-reject', 'preset-headless-runner.mjs'),
    )
    const run = await runDsh([
      '--profile', 'reviewed-development-reject',
      '--patch', join(fixtureRoot, 'overlay.cordis.yml'),
      'REJECT_DESIGN',
    ], { env })
    assert.equal(run.stdout, 'ORCHESTRATOR_REJECT_OK\n')
    const sessionFiles = await filesBelow(join(home, 'sessions'))
    const sessions = await Promise.all(sessionFiles.map(async file => parseJsonl(await readFile(file, 'utf8'))))
    const labels = sessions.map(descriptorLabel).filter(Boolean).sort()
    assert.deepEqual(labels, ['design_reviewer', 'designer'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('installs into the current DSH Web profile and serves the built application', {
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-reviewed-development-web-integration-'))
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
  }
  let server

  try {
    const pluginArchive = await packPlugin(home)
    await runDsh([
      'plugin', '--profile', 'reviewed-development-web-integration', 'add',
      `link:${checkout}/packages/bundle/web-app`,
      pluginArchive,
    ], { env })
    server = await startWebDsh([
      '--profile', 'reviewed-development-web-integration',
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
