import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareExperiments,
  experimentChildMeta,
  listAuthorizedPresets,
  normalizeConfig,
  preflightAllowedPresets,
  resolveAuthorizedPreset,
  resolveRequest,
  runPreparedExperiment,
} from '../src/experiment.js'
import { outputText, renderComparison, stopReasonOf } from '../src/result.js'

const systemPreset = { id: 'minimal', trust: 'system', description: 'Minimal Agent' }
const secondPreset = { id: 'coding', trust: 'system' }
const userPreset = { id: 'mine', trust: 'user' }
const brokenPreset = { id: 'broken', trust: 'system', broken: 'invalid YAML' }

function roster(presets = [systemPreset, secondPreset, userPreset, brokenPreset]) {
  return {
    async list() { return presets },
    async resolve(id) {
      const preset = presets.find(candidate => candidate.id === id)
      if (preset === undefined) throw new Error(`unknown preset ${id}`)
      return preset
    },
  }
}

function parent() {
  return {
    session: { header: { id: 'parent-session', cwd: '/workspace' } },
    options: { provider: 'parent-provider', model: 'parent-model' },
  }
}

function harness(options = {}) {
  const creates = []
  const disposals = []
  const flushes = []
  const cancellations = []
  const operations = {
    resolveDepth: () => 1,
    resolveAgentOptions: (_parent, requested, depth) => ({ ...requested, subagentDepth: depth }),
    capturePolicy: () => ({ sandboxMode: 'workspace-write', approvalPolicy: 'never' }),
    async create(details) {
      const index = creates.length
      creates.push(details)
      if (options.createRejectAt === index) throw new Error('create failed')
      const child = {
        session: { header: { id: `child-${index + 1}` }, events: [{ index }] },
        cancel(reason) { cancellations.push({ index, reason }) },
        async whenIdle() {
          if (options.waitRejectAt === index) throw new Error('wait failed')
          if (options.abortAfterWaitAt === index) options.controller.abort(new Error('cancelled'))
        },
      }
      return {
        agent: child,
        async dispose() {
          disposals.push(index)
          if (options.disposeRejectAt === index) throw new Error('dispose failed')
        },
      }
    },
    followup(_child, _task) {},
    result(events) {
      const index = events[0].index
      return {
        stopReason: options.stopReasons?.[index] ?? 'completed',
        output: [{ type: 'text', text: `output-${index}` }],
      }
    },
    async flush(session) {
      const index = Number(session.header.id.split('-').at(-1)) - 1
      flushes.push(index)
      if (options.flushRejectAt === index) throw new Error('flush failed')
      return options.persistedAt?.[index] ?? true
    },
  }
  return { operations, creates, disposals, flushes, cancellations }
}

test('configuration and request validation reject ambiguous values', () => {
  assert.throws(() => normalizeConfig({ maxDepth: -1 }), /maxDepth/)
  assert.throws(() => normalizeConfig({ maxTokens: 0 }), /maxTokens/)
  assert.throws(() => normalizeConfig({ runToolName: ' ' }), /runToolName/)
  assert.throws(() => normalizeConfig({ runToolName: 'same', compareToolName: 'same' }), /distinct/)
  assert.throws(() => normalizeConfig({ allowedPresets: [] }), /non-empty/)
  assert.throws(() => normalizeConfig({ allowedPresets: ['mine', 'mine'] }), /duplicate/)
  assert.throws(() => normalizeConfig({ allowedPresets: [''] }), /entry/)
  const config = normalizeConfig({ maxTokens: 256 })
  assert.throws(() => resolveRequest({ task: '' }, config), /task/)
  assert.throws(() => resolveRequest({ task: 'x', provider: 'p' }, config), /together/)
  assert.throws(() => resolveRequest({ task: 'x', max_tokens: 0 }, config), /max_tokens/)
  assert.deepEqual(resolveRequest({ task: 'x', provider: 'p', model: 'm' }, config), {
    task: 'x', agentOptions: { provider: 'p', model: 'm', maxTokens: 256 },
  })
})

test('default authorization exposes only system presets and explicit allowlists admit user presets', async () => {
  const presets = roster()
  const defaults = normalizeConfig()
  assert.deepEqual((await listAuthorizedPresets(presets, defaults)).map(preset => preset.id), [
    'minimal', 'coding', 'broken',
  ])
  assert.equal((await resolveAuthorizedPreset(presets, defaults, 'minimal')).id, 'minimal')
  await assert.rejects(resolveAuthorizedPreset(presets, defaults, 'mine'), /system-trust/)
  await assert.rejects(resolveAuthorizedPreset(presets, defaults, 'broken'), /broken/)

  const explicit = normalizeConfig({ allowedPresets: ['mine'] })
  await preflightAllowedPresets(presets, explicit)
  assert.deepEqual((await listAuthorizedPresets(presets, explicit)).map(preset => preset.id), ['mine'])
  assert.equal((await resolveAuthorizedPreset(presets, explicit, 'mine')).trust, 'user')
  await assert.rejects(resolveAuthorizedPreset(presets, explicit, 'minimal'), /allowedPresets/)
  await assert.rejects(preflightAllowedPresets(presets, normalizeConfig({ allowedPresets: ['absent'] })), /unknown/)
  await assert.rejects(preflightAllowedPresets(presets, normalizeConfig({ allowedPresets: ['broken'] })), /broken/)
})

test('experiment lineage does not claim SubAgent origin or descriptor state', () => {
  assert.deepEqual(experimentChildMeta(parent(), 'minimal', 1), {
    cwd: '/workspace',
    parentSession: 'parent-session',
    delegationDepth: 1,
    agentPreset: 'minimal',
  })
  assert.equal('origin' in experimentChildMeta(parent(), 'minimal', 1), false)
})

test('a run checkpoints before disposal and reports absent durability listeners', async () => {
  const run = harness({ persistedAt: [false] })
  const result = await runPreparedExperiment(
    run.operations,
    normalizeConfig(),
    parent(),
    { task: 'probe', agentOptions: {} },
    systemPreset,
    new AbortController().signal,
  )
  assert.equal(result.persisted, false)
  assert.equal(result.sessionId, 'child-1')
  assert.deepEqual(run.flushes, [0])
  assert.deepEqual(run.disposals, [0])
  assert.deepEqual(run.creates[0].meta, {
    cwd: '/workspace', parentSession: 'parent-session', delegationDepth: 1, agentPreset: 'minimal',
  })
  assert.deepEqual(run.creates[0].deniedTools, [
    'agent_experiment_list_presets', 'agent_experiment_run', 'agent_experiment_compare',
  ])
})

test('flush, child execution, and cleanup failures dispose every acquired handle', async () => {
  for (const options of [{ waitRejectAt: 0 }, { flushRejectAt: 0 }, { disposeRejectAt: 0 }]) {
    const run = harness(options)
    await assert.rejects(runPreparedExperiment(
      run.operations,
      normalizeConfig(),
      parent(),
      { task: 'probe', agentOptions: {} },
      systemPreset,
      new AbortController().signal,
    ))
    assert.deepEqual(run.disposals, [0])
  }
})

test('comparison preflights both presets and keeps non-completed baseline evidence', async () => {
  const presets = roster()
  const run = harness({ stopReasons: ['refusal', 'completed'] })
  const result = await compareExperiments(
    run.operations,
    presets,
    normalizeConfig(),
    parent(),
    { baseline_preset: 'minimal', candidate_preset: 'coding', task: 'same task' },
    new AbortController().signal,
  )
  assert.equal(result.baseline.stopReason, 'refusal')
  assert.equal(result.candidate.stopReason, 'completed')
  assert.deepEqual(run.disposals, [0, 1])

  const noStart = harness()
  await assert.rejects(compareExperiments(
    noStart.operations,
    presets,
    normalizeConfig(),
    parent(),
    { baseline_preset: 'minimal', candidate_preset: 'missing', task: 'same task' },
    new AbortController().signal,
  ), /unknown/)
  assert.equal(noStart.creates.length, 0)
})

test('comparison stops after baseline infrastructure failure or cancellation', async () => {
  const presets = roster()
  const failed = harness({ waitRejectAt: 0 })
  await assert.rejects(compareExperiments(
    failed.operations,
    presets,
    normalizeConfig(),
    parent(),
    { baseline_preset: 'minimal', candidate_preset: 'coding', task: 'same task' },
    new AbortController().signal,
  ), /wait failed/)
  assert.equal(failed.creates.length, 1)

  const controller = new AbortController()
  const cancelled = harness({ controller, abortAfterWaitAt: 0 })
  await assert.rejects(compareExperiments(
    cancelled.operations,
    presets,
    normalizeConfig(),
    parent(),
    { baseline_preset: 'minimal', candidate_preset: 'coding', task: 'same task' },
    controller.signal,
  ), /cancelled/)
  assert.equal(cancelled.creates.length, 1)
  assert.deepEqual(cancelled.cancellations, [{ index: 0, reason: { kind: 'parent' } }])

  const preAborted = new AbortController()
  preAborted.abort(new Error('already cancelled'))
  const pre = harness()
  await assert.rejects(compareExperiments(
    pre.operations,
    presets,
    normalizeConfig(),
    parent(),
    { baseline_preset: 'minimal', candidate_preset: 'coding', task: 'same task' },
    preAborted.signal,
  ), /already cancelled/)
  assert.equal(pre.creates.length, 0)
})

test('result helpers preserve stable stop reasons and text order', () => {
  assert.equal(stopReasonOf({ kind: 'completed' }), 'completed')
  assert.equal(stopReasonOf({ kind: 'max-tokens' }), 'max-tokens')
  assert.equal(stopReasonOf({ kind: 'aborted' }), 'aborted')
  assert.equal(stopReasonOf({ kind: 'blocked' }), 'refusal')
  assert.equal(stopReasonOf({ kind: 'error' }), 'error')
  assert.equal(stopReasonOf({ kind: 'interrupted' }), 'error')
  assert.equal(stopReasonOf(undefined), 'error')
  assert.equal(stopReasonOf({ kind: 'future' }), 'error')
  assert.equal(outputText([
    { type: 'text', text: 'hello ' },
    { type: 'tool-call', id: 'x' },
    { type: 'text', text: 'world' },
  ]), 'hello world')
})

test('comparison rendering preserves symmetric stop and duration evidence', () => {
  const rendered = renderComparison({
    baseline: {
      sessionId: 'baseline-session',
      preset: 'minimal',
      stopReason: 'refusal',
      durationMs: 12,
      persisted: true,
      output: [{ type: 'text', text: 'baseline output' }],
    },
    candidate: {
      sessionId: 'candidate-session',
      preset: 'coding',
      stopReason: 'completed',
      durationMs: 34,
      persisted: false,
      output: [{ type: 'text', text: 'candidate output' }],
    },
  })[0].text
  assert.match(rendered, /Baseline \(preset=minimal, session=baseline-session, stop=refusal, persisted=true, duration=12ms\)/)
  assert.match(rendered, /Candidate \(preset=coding, session=candidate-session, stop=completed, persisted=false, duration=34ms\)/)
  assert.match(rendered, /No winner was selected/)
})
