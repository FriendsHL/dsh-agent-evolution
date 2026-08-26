import { pathToFileURL } from 'node:url'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required by the reviewed-development integration fixture')

const {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
} = await import(pathToFileURL(`${checkout}/packages/llm/llm/src/index.ts`).href)

const OFF = ReasoningEffortId('off')
const QA_COMMAND = "printf 'QA_OK\\n'"
const IMPLEMENT_MARKER = `${process.env.DSH_HOME}/reviewed-development-implementer.marker`
const IMPLEMENT_COMMAND = `printf 'implemented\\n' > ${JSON.stringify(IMPLEMENT_MARKER)}`

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

function designerArtifact() {
  return {
    design: 'Use the approved fixture-only implementation path.',
    testPlan: [{ id: 'qa-shell', objective: 'Prove QA executes a real shell command.', command: QA_COMMAND, expectedResult: 'QA_OK and exit 0' }],
    risks: [{ risk: 'false positive', mitigation: 'verify the persisted shell call and result' }],
  }
}

class ReviewedDevelopmentMockAdapter extends LlmAdapter {
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
    const calls = toolCalls(options.messages)
    const results = toolResults(options.messages)

    if (text.includes('# Passing code-review report')) {
      if (!calls.some(call => call.name === 'bash')) {
        yield* emitToolCall('qa-shell-call', 'bash', { command: QA_COMMAND, description: 'run the approved QA probe' })
        return
      }
      yield* emitToolCall('qa-output', 'structured_output', {
        verdict: 'PASS',
        summary: 'The approved command passed.',
        checks: [{ id: 'qa-shell', command: QA_COMMAND, exitCode: 0, evidence: 'QA_OK' }],
        findings: [],
      })
      return
    }

    if (text.includes('# Implementation report')) {
      yield* emitToolCall('code-review-output', 'structured_output', {
        verdict: 'PASS',
        summary: 'Implementation matches the approved design.',
        findings: [],
      })
      return
    }

    if (text.includes('# Approved design and test plan')) {
      if (!calls.some(call => call.name === 'bash')) {
        yield* emitToolCall('implementation-shell', 'bash', {
          command: IMPLEMENT_COMMAND,
          description: 'write the integration implementation marker',
        })
        return
      }
      yield* emitToolCall('implementation-output', 'structured_output', {
        summary: 'Created the integration implementation marker.',
        changedFiles: ['$DSH_HOME/reviewed-development-implementer.marker'],
        testsRun: [{ command: IMPLEMENT_COMMAND, exitCode: 0 }],
      })
      return
    }

    if (text.includes('# Proposed design and test plan')) {
      yield* emitToolCall('design-review-output', 'structured_output', text.includes('REJECT_DESIGN')
        ? { verdict: 'CHANGES_REQUIRED', summary: 'The rejection branch was requested.', findings: [{ severity: 'blocker', subject: 'probe', requiredCorrection: 'Use an approvable task.' }] }
        : { verdict: 'PASS', summary: 'The design and test plan are executable.', findings: [] })
      return
    }

    if (text.includes('# Development task')) {
      yield* emitToolCall('designer-output', 'structured_output', designerArtifact())
      return
    }

    if (!calls.some(call => call.name === 'run_reviewed_development')) {
      const task = text.includes('REJECT_DESIGN')
        ? 'REJECT_DESIGN integration task'
        : 'Complete the reviewed development integration task.'
      yield* emitToolCall('orchestrator-run', 'run_reviewed_development', { task })
      return
    }

    const resultText = results.at(-1)?.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('') ?? ''
    if (text.includes('REJECT_DESIGN')) {
      yield* emitText(resultText.includes('changes_required') && resultText.includes('design_review')
        ? 'ORCHESTRATOR_REJECT_OK'
        : `ORCHESTRATOR_REJECT_FAILED: ${resultText}`)
      return
    }
    yield* emitText(resultText.includes('Reviewed development: completed') && resultText.includes('session=')
      ? 'ORCHESTRATOR_PARENT_OK'
      : `ORCHESTRATOR_PROBE_FAILED: ${resultText}`)
  }
}

export const name = 'reviewed-development-integration-mock-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['reviewed-development-mock'], new ReviewedDevelopmentMockAdapter())
}
