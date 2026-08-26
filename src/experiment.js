const PREFIX = 'agent-experiment-runner'

export const DEFAULT_TOOL_NAMES = Object.freeze({
  list: 'agent_experiment_list_presets',
  run: 'agent_experiment_run',
  compare: 'agent_experiment_compare',
})

function assertNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${PREFIX}: ${field} must be a non-empty string`)
  }
}

function assertPositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${PREFIX}: ${field} must be a positive safe integer`)
  }
}

/** Validate and normalize the plugin configuration. */
export function normalizeConfig(config = {}) {
  const normalized = {
    maxDepth: config.maxDepth ?? 3,
    listToolName: config.listToolName ?? DEFAULT_TOOL_NAMES.list,
    runToolName: config.runToolName ?? DEFAULT_TOOL_NAMES.run,
    compareToolName: config.compareToolName ?? DEFAULT_TOOL_NAMES.compare,
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    ...(config.allowedPresets === undefined ? {} : { allowedPresets: [...config.allowedPresets] }),
  }
  if (!Number.isSafeInteger(normalized.maxDepth) || normalized.maxDepth < 0) {
    throw new Error(`${PREFIX}: maxDepth must be a non-negative safe integer`)
  }
  if (normalized.maxTokens !== undefined) {
    assertPositiveSafeInteger(normalized.maxTokens, 'maxTokens')
  }
  for (const [field, value] of [
    ['listToolName', normalized.listToolName],
    ['runToolName', normalized.runToolName],
    ['compareToolName', normalized.compareToolName],
  ]) {
    assertNonEmpty(value, field)
  }
  if (new Set([
    normalized.listToolName,
    normalized.runToolName,
    normalized.compareToolName,
  ]).size !== 3) {
    throw new Error(`${PREFIX}: tool names must be distinct`)
  }
  if (normalized.allowedPresets !== undefined) {
    if (normalized.allowedPresets.length === 0) {
      throw new Error(`${PREFIX}: allowedPresets must be non-empty when supplied`)
    }
    for (const preset of normalized.allowedPresets) assertNonEmpty(preset, 'allowedPresets entry')
    if (new Set(normalized.allowedPresets).size !== normalized.allowedPresets.length) {
      throw new Error(`${PREFIX}: allowedPresets cannot contain duplicate ids`)
    }
  }
  return normalized
}

/** Validate one tool request and resolve its symmetric model overrides. */
export function resolveRequest(args, config) {
  assertNonEmpty(args.task, 'task')
  const hasProvider = args.provider !== undefined
  const hasModel = args.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error(`${PREFIX}: provider and model must be supplied together`)
  }
  if (hasProvider) {
    assertNonEmpty(args.provider, 'provider')
    assertNonEmpty(args.model, 'model')
  }
  if (args.max_tokens !== undefined) assertPositiveSafeInteger(args.max_tokens, 'max_tokens')
  const maxTokens = args.max_tokens ?? config.maxTokens
  return {
    task: args.task,
    agentOptions: {
      ...(hasProvider ? { provider: args.provider, model: args.model } : {}),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    },
  }
}

function rejectBrokenPreset(preset) {
  if (preset.broken !== undefined) {
    throw new Error(`${PREFIX}: preset "${preset.id}" is broken: ${preset.broken}`)
  }
  return preset
}

/** Resolve one preset and enforce the configured trust policy. */
export async function resolveAuthorizedPreset(agentPresets, config, id) {
  assertNonEmpty(id, 'preset')
  if (config.allowedPresets !== undefined && !config.allowedPresets.includes(id)) {
    throw new Error(`${PREFIX}: preset "${id}" is not in allowedPresets`)
  }
  const preset = await agentPresets.resolve(id)
  if (config.allowedPresets === undefined && preset.trust !== 'system') {
    throw new Error(`${PREFIX}: preset "${id}" is not a system-trust preset`)
  }
  return rejectBrokenPreset(preset)
}

/** Resolve every explicit allowlist entry before the plugin registers tools. */
export async function preflightAllowedPresets(agentPresets, config) {
  if (config.allowedPresets === undefined) return
  await Promise.all(config.allowedPresets.map(async id => {
    rejectBrokenPreset(await agentPresets.resolve(id))
  }))
}

/** List only presets admitted by the configured trust policy. */
export async function listAuthorizedPresets(agentPresets, config) {
  const presets = await agentPresets.list()
  return presets.filter(preset => config.allowedPresets === undefined
    ? preset.trust === 'system'
    : config.allowedPresets.includes(preset.id))
}

/** Build lineage metadata for an experiment Agent without classifying it as a SubAgent. */
export function experimentChildMeta(parent, presetId, depth) {
  const header = parent.session.header
  return {
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    parentSession: header.id,
    delegationDepth: depth,
    agentPreset: presetId,
  }
}

function abortError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${PREFIX}: experiment cancelled`)
}

function throwIfAborted(signal) {
  if (signal.aborted) throw abortError(signal)
}

async function disposeWithFailure(handle, failure) {
  try {
    await handle.dispose()
  } catch (disposeError) {
    if (failure !== undefined) {
      return new AggregateError([failure, disposeError], `${PREFIX}: experiment failed and cleanup also failed`)
    }
    return disposeError
  }
  return failure
}

/**
 * Run one already-authorized preset and checkpoint its complete child log before disposal.
 * @returns evidence for a settled run; `persisted` is false when no durability listener participated.
 * @throws for creation, execution, flush, or cleanup failures after disposing every acquired handle.
 */
export async function runPreparedExperiment(operations, config, parent, request, preset, signal) {
  throwIfAborted(signal)
  const depth = operations.resolveDepth(parent, config.maxDepth)
  const policy = operations.capturePolicy(parent)
  const startedAt = Date.now()
  const handle = await operations.create({
    parent,
    preset,
    meta: experimentChildMeta(parent, preset.id, depth),
    agentOptions: operations.resolveAgentOptions(parent, request.agentOptions, depth),
    policy,
    signal,
    deniedTools: [config.listToolName, config.runToolName, config.compareToolName],
  })
  const child = handle.agent
  const onAbort = () => child.cancel({ kind: 'parent' })
  signal.addEventListener('abort', onAbort, { once: true })
  let result
  let failure
  try {
    if (signal.aborted) throw abortError(signal)
    operations.followup(child, request.task)
    await child.whenIdle()
    const evidence = operations.result(child.session.events)
    const persisted = await operations.flush(child.session)
    result = {
      sessionId: child.session.header.id,
      preset: preset.id,
      stopReason: evidence.stopReason,
      durationMs: Date.now() - startedAt,
      persisted,
      output: evidence.output,
    }
  } catch (error) {
    failure = error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  failure = await disposeWithFailure(handle, failure)
  if (failure !== undefined) throw failure
  return result
}

/** Resolve both sides before executing a sequential baseline/candidate experiment. */
export async function compareExperiments(operations, agentPresets, config, parent, args, signal) {
  const request = resolveRequest(args, config)
  const [baselinePreset, candidatePreset] = await Promise.all([
    resolveAuthorizedPreset(agentPresets, config, args.baseline_preset),
    resolveAuthorizedPreset(agentPresets, config, args.candidate_preset),
  ])
  throwIfAborted(signal)
  const baseline = await runPreparedExperiment(
    operations, config, parent, request, baselinePreset, signal,
  )
  throwIfAborted(signal)
  const candidate = await runPreparedExperiment(
    operations, config, parent, request, candidatePreset, signal,
  )
  return { baseline, candidate }
}
