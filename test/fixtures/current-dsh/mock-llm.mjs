import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required by the Agent Evolution integration fixture')

const {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
} = await import(pathToFileURL(`${checkout}/packages/llm/llm/src/index.ts`).href)

const OFF = ReasoningEffortId('off')

function messageText(messages) {
  return messages.flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function toolCalls(messages) {
  return messages.flatMap(message => message.content)
    .filter(block => block.type === 'tool-call')
}

function toolResults(messages) {
  return messages.flatMap(message => message.content)
    .filter(block => block.type === 'tool-result')
}

function resultText(result) {
  return result?.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
}

async function persistedSession(id) {
  const root = join(process.env.DSH_HOME, 'sessions')
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const content = await readFile(join(entry.parentPath, entry.name), 'utf8')
    const header = JSON.parse(content.split(/\r?\n/, 1)[0])
    if (header.id === id) return content
  }
  throw new Error(`session ${id} was not durable when its tool result became model-visible`)
}

async function* emitToolCall(id, name, args) {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: CallId(id), name, argumentsDelta: argumentsText }
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: CallId(id), name, arguments: argumentsText },
  }
  yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function* emitText(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

class AgentEvolutionMockAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: OFF, name: 'Off' }],
        defaultEffort: OFF,
      },
    }
  }

  async* stream(options) {
    const text = messageText(options.messages)
    if (text.includes('EXPERIMENT_SINGLE_TASK')) {
      yield* emitText('EXPERIMENT_SINGLE_OK')
      return
    }
    if (text.includes('EXPERIMENT_COMPARE_TASK')) {
      yield* emitText('EXPERIMENT_COMPARE_OK')
      return
    }

    const calls = toolCalls(options.messages)
    const results = toolResults(options.messages)
    if (!calls.some(call => call.name === 'agent_experiment_list_presets')) {
      yield* emitToolCall('experiment-list', 'agent_experiment_list_presets', {})
      return
    }
    if (!calls.some(call => call.name === 'agent_experiment_run')) {
      const listed = resultText(results.at(-1))
      if (!listed.includes('minimal')) {
        yield* emitText(`EXPERIMENT_PROBE_FAILED: minimal preset missing: ${listed}`)
        return
      }
      yield* emitToolCall('experiment-run', 'agent_experiment_run', {
        preset: 'minimal',
        task: 'EXPERIMENT_SINGLE_TASK',
      })
      return
    }
    if (!calls.some(call => call.name === 'agent_experiment_compare')) {
      const runResult = resultText(results.at(-1))
      const sessionId = runResult.match(/session=([^,]+),/)?.[1]
      if (!runResult.includes('EXPERIMENT_SINGLE_OK')
        || !runResult.includes('persisted=true')
        || sessionId === undefined) {
        yield* emitText(`EXPERIMENT_PROBE_FAILED: invalid run evidence: ${runResult}`)
        return
      }
      const durable = await persistedSession(sessionId)
      if (!durable.includes('EXPERIMENT_SINGLE_OK')) {
        yield* emitText(`EXPERIMENT_PROBE_FAILED: incomplete durable run ${sessionId}`)
        return
      }
      yield* emitToolCall('experiment-compare', 'agent_experiment_compare', {
        baseline_preset: 'minimal',
        candidate_preset: 'minimal',
        task: 'EXPERIMENT_COMPARE_TASK',
      })
      return
    }

    const comparison = resultText(results.at(-1))
    const sessionIds = [...comparison.matchAll(/session=([^,]+), stop=completed, persisted=true/g)]
      .map(match => match[1])
    if (sessionIds.length !== 2 || new Set(sessionIds).size !== 2
      || !comparison.includes('No winner was selected')
      || (comparison.match(/stop=completed/g) ?? []).length !== 2) {
      yield* emitText(`EXPERIMENT_PROBE_FAILED: invalid comparison evidence: ${comparison}`)
      return
    }
    for (const sessionId of sessionIds) {
      const durable = await persistedSession(sessionId)
      if (!durable.includes('EXPERIMENT_COMPARE_OK')) {
        yield* emitText(`EXPERIMENT_PROBE_FAILED: incomplete durable comparison ${sessionId}`)
        return
      }
    }
    yield* emitText('AGENT_EVOLUTION_PARENT_OK')
  }
}

export const name = 'agent-evolution-integration-mock-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['agent-evolution-mock'], new AgentEvolutionMockAdapter())
}
