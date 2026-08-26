/**
 * Preset-aware child Agent runs for DeepSeek Harness.
 *
 * @module dsh-agent-factory
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { outputText, stopReasonOf } from './src/result.js'

export const name = 'agent-factory'
export const inject = ['agents', 'agentPresets', 'systemPrompt', 'tools']

const DELEGATION_CONTEXT
  = 'You are an Agent Factory worker running an explicitly selected DSH preset. '
    + 'Complete the assigned task within the permission scope fixed at startup. '
    + 'If an operation requires unavailable approval, report the limitation instead of retrying it.'

/** Runtime configuration for the tools contributed by this plugin. */
export const Config = z.object({
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER).default(3),
  runToolName: z.string().default('agent_run'),
  compareToolName: z.string().default('agent_compare'),
  listToolName: z.string().default('agent_presets'),
  allowedPresets: z.array(z.string()).default(undefined),
})

function assertPresetAllowed(config, preset) {
  if (preset.length === 0) throw new Error('agent-factory: preset cannot be empty')
  if (config.allowedPresets !== undefined && !config.allowedPresets.includes(preset)) {
    throw new Error(`agent-factory: preset "${preset}" is not in allowedPresets`)
  }
}

function requestedAgentOptions(args) {
  if (args.max_tokens !== undefined
    && (!Number.isSafeInteger(args.max_tokens) || args.max_tokens <= 0)) {
    throw new Error('agent-factory: max_tokens must be a positive safe integer')
  }
  return {
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.max_tokens === undefined ? {} : { maxTokens: args.max_tokens }),
  }
}

function runOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      sessionId: { type: 'string', required: true },
      preset: { type: 'string', required: true },
      stopReason: { type: 'string', required: true },
      durationMs: { type: 'number', required: true },
      output: { type: 'array', required: true, items: { type: 'json' } },
    },
  }
}

function renderRun(result) {
  const text = outputText(result.output)
  const suffix = `\n\n[agent-factory: preset=${result.preset}, session=${result.sessionId}, stop=${result.stopReason}, duration=${result.durationMs}ms]`
  return [{ type: 'text', text: `${text}${suffix}` }]
}

async function runAgent(ctx, config, parent, args, signal) {
  if (args.task.length === 0) throw new Error('agent-factory: task cannot be empty')
  assertPresetAllowed(config, args.preset)
  const preset = await ctx.agentPresets.resolve(args.preset)
  if (preset.broken !== undefined) {
    throw new Error(`agent-factory: preset "${preset.id}" is broken: ${preset.broken}`)
  }

  const depth = resolveChildDepth(parent, config.maxDepth)
  const inheritedPolicy = captureDelegatedPolicyOverrides(parent)
  const startedAt = Date.now()
  const sessionId = SessionId(randomUUID())

  const handle = await parent.ctx.agents.create({
    sessionId,
    meta: {
      ...childSessionMeta(parent, depth, 0),
      agentPreset: preset.id,
    },
    agentOptions: resolveChildAgentOptions(parent, requestedAgentOptions(args), depth),
    signal,
    setup: async (childCtx) => {
      appendDelegatedPolicyOverrides(childCtx.agent.session, inheritedPolicy)
      await ctx.agentPresets.mount(childCtx, preset.id)
      childCtx.systemPrompt.context({
        name: 'agent-factory:delegation',
        order: 120,
        text: DELEGATION_CONTEXT,
      })
    },
  })

  const child = handle.agent
  const onAbort = () => child.cancel({ kind: 'parent' })
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()

  try {
    if (!signal.aborted) {
      child.followup(createUserMessage({
        content: [{ type: 'text', text: args.task }],
        source: { kind: 'user' },
      }))
      await child.whenIdle()
    }
    const events = child.session.events
    const end = foldConsumedWork(events).end
    return {
      sessionId,
      preset: preset.id,
      stopReason: stopReasonOf(end?.data.reason),
      durationMs: Date.now() - startedAt,
      output: finalAssistantOutput(events) ?? [],
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    await handle.dispose()
  }
}

const runParameters = {
  preset: {
    type: 'string',
    required: true,
    description: 'The DSH Agent preset id to compose for this isolated run.',
  },
  task: {
    type: 'string',
    required: true,
    description: 'A complete, standalone task for the selected Agent preset.',
  },
  provider: { type: 'string', description: 'Optional LLM provider override.' },
  model: { type: 'string', description: 'Optional model override.' },
  max_tokens: {
    type: 'number',
    description: 'Optional positive output-token limit for each model request.',
  },
}

/** Register preset discovery, isolated Agent execution, and baseline/candidate comparison tools. */
export function apply(ctx, config) {
  if (!Number.isSafeInteger(config.maxDepth) || config.maxDepth < 0) {
    throw new Error('agent-factory: maxDepth must be a non-negative safe integer')
  }
  if (config.allowedPresets?.length === 0) {
    throw new Error('agent-factory: allowedPresets cannot be empty; omit it to allow the full roster')
  }
  for (const [field, value] of [
    ['runToolName', config.runToolName],
    ['compareToolName', config.compareToolName],
    ['listToolName', config.listToolName],
  ]) {
    if (value.length === 0) throw new Error(`agent-factory: ${field} cannot be empty`)
  }
  if (new Set([config.runToolName, config.compareToolName, config.listToolName]).size !== 3) {
    throw new Error('agent-factory: tool names must be distinct')
  }
  for (const preset of config.allowedPresets ?? []) {
    if (preset.length === 0) throw new Error('agent-factory: allowedPresets cannot contain an empty id')
  }

  ctx.tools.register(defineTool({
    name: config.listToolName,
    description: 'List the DSH Agent presets that Agent Factory can compose for isolated runs.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            name: { type: 'string' },
            description: { type: 'string' },
            trust: { type: 'string', required: true },
            broken: { type: 'string' },
          },
        },
      },
      render: (_args, presets) => [{
        type: 'text',
        text: presets.length === 0
          ? 'No Agent presets are available.'
          : presets.map(preset => `- ${preset.id}${preset.description ? `: ${preset.description}` : ''}${preset.broken ? ` [broken: ${preset.broken}]` : ''}`).join('\n'),
      }],
    },
    async execute() {
      const presets = await ctx.agentPresets.list()
      return presets
        .filter(preset => config.allowedPresets === undefined || config.allowedPresets.includes(preset.id))
        .map(preset => ({
          id: preset.id,
          ...(preset.name === undefined ? {} : { name: preset.name }),
          ...(preset.description === undefined ? {} : { description: preset.description }),
          trust: preset.trust,
          ...(preset.broken === undefined ? {} : { broken: preset.broken }),
        }))
    },
  }))

  ctx.tools.register(defineTool({
    name: config.runToolName,
    description: 'Run a complete task in a fresh child Agent composed from an explicit DSH preset. The child has its own context and durable session; use this to select a purpose-built Agent instead of doing the work in the current context.',
    parameters: runParameters,
    output: {
      schema: runOutputSchema(),
      render: (_args, result) => renderRun(result),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('agent-factory: agent_run requires an initiating Agent')
      return await runAgent(ctx, config, exec.agent, args, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: config.compareToolName,
    description: 'Run the same standalone task through a baseline preset and a candidate preset. Returns both raw Agent outputs and session ids for human or evaluator review; it does not claim an automatic winner.',
    parameters: {
      baseline_preset: { type: 'string', required: true, description: 'The current or control preset id.' },
      candidate_preset: { type: 'string', required: true, description: 'The proposed preset id.' },
      task: { type: 'string', required: true, description: 'The same complete task sent to both Agents.' },
      provider: { type: 'string', description: 'Optional LLM provider override for both runs.' },
      model: { type: 'string', description: 'Optional model override for both runs.' },
      max_tokens: { type: 'number', description: 'Optional positive output-token limit for both runs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          baseline: { ...runOutputSchema(), required: true },
          candidate: { ...runOutputSchema(), required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: [
          `Baseline (${result.baseline.preset}, session ${result.baseline.sessionId}):`,
          outputText(result.baseline.output),
          '',
          `Candidate (${result.candidate.preset}, session ${result.candidate.sessionId}):`,
          outputText(result.candidate.output),
          '',
          'No winner was selected automatically; evaluate both outputs against the same rubric.',
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('agent-factory: agent_compare requires an initiating Agent')
      const common = {
        task: args.task,
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.max_tokens === undefined ? {} : { max_tokens: args.max_tokens }),
      }
      const baseline = await runAgent(ctx, config, exec.agent, {
        ...common,
        preset: args.baseline_preset,
      }, exec.signal)
      const candidate = await runAgent(ctx, config, exec.agent, {
        ...common,
        preset: args.candidate_preset,
      }, exec.signal)
      return { baseline, candidate }
    },
  }))
}
