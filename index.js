/** Preset-composed Agent experiment tools for DeepSeek Harness. */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  compareExperiments,
  listAuthorizedPresets,
  normalizeConfig,
  preflightAllowedPresets,
  resolveAuthorizedPreset,
  resolveRequest,
  runPreparedExperiment,
} from './src/experiment.js'
import { renderComparison, renderRun, stopReasonOf } from './src/result.js'

export const name = 'agent-experiment-runner'
export const inject = ['agents', 'agentPresets', 'sessions', 'systemPrompt', 'tools']

/** Runtime configuration for preset authorization and experiment execution. */
export const Config = z.object({
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER).default(3),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  runToolName: z.string().default('agent_experiment_run'),
  compareToolName: z.string().default('agent_experiment_compare'),
  listToolName: z.string().default('agent_experiment_list_presets'),
  allowedPresets: z.array(z.string()).default(undefined),
})

const DELEGATION_CONTEXT
  = 'You are running one isolated Agent experiment under a preset selected before startup. '
    + 'Your permission scope cannot be widened from this session. Report unavailable access instead of retrying it.'

function runOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      sessionId: { type: 'string', required: true },
      preset: { type: 'string', required: true },
      stopReason: {
        type: 'string',
        required: true,
        enum: ['completed', 'max-tokens', 'aborted', 'refusal', 'error'],
      },
      durationMs: { type: 'number', required: true },
      persisted: { type: 'boolean', required: true },
      output: { type: 'array', required: true, items: { type: 'json' } },
    },
  }
}

const runParameters = {
  preset: {
    type: 'string',
    required: true,
    description: 'Authorized DSH Agent preset id for this isolated experiment.',
  },
  task: {
    type: 'string',
    required: true,
    description: 'Complete standalone task for the selected Agent preset.',
  },
  provider: { type: 'string', description: 'Optional provider override; model is required with it.' },
  model: { type: 'string', description: 'Optional model override; provider is required with it.' },
  max_tokens: { type: 'number', description: 'Optional positive output-token limit.' },
}

function createOperations(ctx) {
  return {
    resolveDepth: resolveChildDepth,
    resolveAgentOptions: resolveChildAgentOptions,
    capturePolicy: captureDelegatedPolicyOverrides,
    async create(options) {
      return await options.parent.ctx.agents.create({
        sessionId: SessionId(randomUUID()),
        meta: options.meta,
        agentOptions: options.agentOptions,
        signal: options.signal,
        setup: async (childCtx) => {
          appendDelegatedPolicyOverrides(childCtx.agent.session, options.policy)
          await ctx.agentPresets.mount(childCtx, options.preset.id)
          childCtx.systemPrompt.context({
            name: 'agent-experiment-runner:delegation',
            order: 120,
            text: DELEGATION_CONTEXT,
          })
          childCtx.tools.restrict({ deny: options.deniedTools })
        },
      })
    },
    followup(child, task) {
      child.followup(createUserMessage({
        content: [{ type: 'text', text: task }],
        source: { kind: 'user' },
      }))
    },
    result(events) {
      const end = foldConsumedWork(events).end
      return {
        stopReason: stopReasonOf(end?.data.reason),
        output: finalAssistantOutput(events) ?? [],
      }
    },
    async flush(session) {
      return await ctx.sessions.flush(session)
    },
  }
}

/** Register preset discovery, isolated execution, and baseline/candidate comparison tools. */
export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  await preflightAllowedPresets(ctx.agentPresets, config)
  const operations = createOperations(ctx)

  ctx.tools.register(defineTool({
    name: config.listToolName,
    description: 'List the DSH Agent presets authorized for isolated experiments.',
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
            trust: { type: 'string', required: true, enum: ['system', 'user'] },
            broken: { type: 'string' },
          },
        },
      },
      render: (_args, presets) => [{
        type: 'text',
        text: presets.length === 0
          ? 'No Agent presets are authorized for experiments.'
          : presets.map(preset => `- ${preset.id}${preset.description ? `: ${preset.description}` : ''}${preset.broken ? ` [broken: ${preset.broken}]` : ''}`).join('\n'),
      }],
    },
    presentCall: () => ({ card: 'generic', title: 'List experiment presets', kind: 'search' }),
    async execute() {
      return (await listAuthorizedPresets(ctx.agentPresets, config)).map(preset => ({
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
    description: 'Run one complete task in a fresh Agent composed from an authorized DSH preset. Returns raw output and durable-session evidence without scoring it.',
    parameters: runParameters,
    output: {
      schema: runOutputSchema(),
      render: (_args, result) => renderRun(result),
    },
    presentCall: args => ({ card: 'generic', title: `Run experiment with ${args.preset}` }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error('agent-experiment-runner: agent_experiment_run requires an initiating Agent')
      }
      const request = resolveRequest(args, config)
      const preset = await resolveAuthorizedPreset(ctx.agentPresets, config, args.preset)
      return await runPreparedExperiment(
        operations, config, exec.agent, request, preset, exec.signal,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: config.compareToolName,
    description: 'Run the same task sequentially with authorized baseline and candidate presets. Returns both evidence records without scoring or selecting a winner.',
    parameters: {
      baseline_preset: { type: 'string', required: true, description: 'Authorized control preset id.' },
      candidate_preset: { type: 'string', required: true, description: 'Authorized candidate preset id.' },
      task: runParameters.task,
      provider: runParameters.provider,
      model: runParameters.model,
      max_tokens: runParameters.max_tokens,
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
      render: (_args, result) => renderComparison(result),
    },
    presentCall: args => ({
      card: 'generic',
      title: `Compare ${args.baseline_preset} with ${args.candidate_preset}`,
    }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error('agent-experiment-runner: agent_experiment_compare requires an initiating Agent')
      }
      return await compareExperiments(
        operations, ctx.agentPresets, config, exec.agent, args, exec.signal,
      )
    },
  }))
}
