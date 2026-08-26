import { pathToFileURL } from 'node:url'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required by the Agent Factory integration fixture')

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

class AgentFactoryMockAdapter extends LlmAdapter {
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
    if (text.includes('FACTORY_CHILD_TASK')) {
      yield* emitText('FACTORY_CHILD_OK')
      return
    }

    const calls = toolCalls(options.messages)
    const results = toolResults(options.messages)
    if (!calls.some(call => call.name === 'agent_presets')) {
      yield* emitToolCall('factory-list', 'agent_presets', {})
      return
    }
    if (!calls.some(call => call.name === 'agent_run')) {
      const presetResult = results.at(-1)
      const presetText = presetResult?.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('') ?? ''
      if (!presetText.includes('minimal')) {
        yield* emitText(`FACTORY_PROBE_FAILED: minimal preset missing: ${presetText}`)
        return
      }
      yield* emitToolCall('factory-run', 'agent_run', {
        preset: 'minimal',
        task: 'FACTORY_CHILD_TASK',
      })
      return
    }

    const runResult = results.at(-1)
    const runText = runResult?.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('') ?? ''
    yield* emitText(runText.includes('FACTORY_CHILD_OK')
      ? 'FACTORY_PARENT_OK'
      : `FACTORY_PROBE_FAILED: child output missing: ${runText}`)
  }
}

export const name = 'agent-factory-integration-mock-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['agent-factory-mock'], new AgentFactoryMockAdapter())
}
