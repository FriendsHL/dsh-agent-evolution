/** Reviewed software-development orchestration for DeepSeek Harness. */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  normalizeConfig,
  renderReviewedDevelopment,
  runReviewedDevelopment,
  TOOL_NAME,
} from './src/orchestrator.js'

export const name = 'reviewed-development-orchestrator'
export const inject = ['subagents', 'tools']

/** Runtime configuration for reviewed development runs. */
export const Config = z.object({
  providerName: z.string().default('spawn'),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER).default(3),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  shellToolName: z.string().default(process.platform === 'win32' ? 'pwsh' : 'bash'),
  designerTools: z.array(z.string()).default(undefined),
  reviewerTools: z.array(z.string()).default(undefined),
  qaTools: z.array(z.string()).default(undefined),
})

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { type: 'string', required: true },
    status: {
      type: 'string',
      required: true,
      enum: ['completed', 'changes_required', 'failed', 'blocked', 'cancelled', 'error'],
    },
    stoppedPhase: { type: 'string' },
    phases: { type: 'array', required: true, items: { type: 'json' } },
  },
}

/** Register the fixed reviewed-development orchestration tool. */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: 'Run a software-development task through isolated Designer, Design Reviewer, Implementer, Code Reviewer, and QA SubAgents. Review gates and recorded QA command evidence are mandatory. This orchestrator has no direct publishing operation, but inherited shell tools retain the authority granted by the deployment sandbox.',
    parameters: {
      task: { type: 'string', required: true, description: 'A non-empty, standalone software-development request.' },
      provider: { type: 'string', description: 'Optional LLM provider override; model is required with it.' },
      model: { type: 'string', description: 'Optional LLM model override; provider is required with it.' },
      max_tokens: { type: 'number', description: 'Optional positive output-token limit applied to every role.' },
    },
    output: {
      schema: outputSchema,
      render: (_args, result) => renderReviewedDevelopment(result),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error('reviewed-development-orchestrator: run_reviewed_development requires an initiating Agent')
      }
      return await runReviewedDevelopment(ctx, config, exec.agent, args, exec.signal)
    },
  }))
}
