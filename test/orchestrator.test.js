import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeConfig,
  phasePrompt,
  renderReviewedDevelopment,
  resolveRequest,
  runReviewedDevelopment,
  verifyQaEvidence,
} from '../src/orchestrator.js'

const design = {
  design: 'Change the implementation without widening scope.',
  testPlan: [{ id: 'unit', objective: 'Run unit checks', command: 'npm test', expectedResult: 'exit 0' }],
  risks: [{ risk: 'regression', mitigation: 'run tests' }],
}
const passingReview = { verdict: 'PASS', summary: 'Approved.', findings: [] }
const implementation = {
  summary: 'Implemented the approved change.',
  changedFiles: ['index.js'],
  testsRun: [{ command: 'npm test', exitCode: 0 }],
}
const passingQa = {
  verdict: 'PASS',
  summary: 'All approved checks passed.',
  checks: [{ id: 'unit', command: 'npm test', exitCode: 0, evidence: 'tests passed' }],
  findings: [],
}

function qaEvents(command = 'npm test', output = 'ok\n', options = {}) {
  const callId = options.callId ?? 'qa-call'
  return [
    {
      type: 'tool/call',
      data: {
        callId,
        name: options.toolName ?? 'bash',
        arguments: JSON.stringify({ command, ...(options.background ? { run_in_background: true } : {}) }),
      },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { callId },
          content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: output }] }],
        },
      },
    },
  ]
}

function harness(artifacts, options = {}) {
  const starts = []
  const disposals = []
  const provider = {
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
  }
  const ctx = {
    subagents: {
      getProvider: () => options.provider ?? provider,
      async start(name, request) {
        const index = starts.length
        starts.push({ name, request })
        const artifact = artifacts[index]
        if (artifact instanceof Error) throw artifact
        const id = `child-${index + 1}`
        return {
          id,
          localAgent: options.missingLocalAt === index
            ? undefined
            : { session: { events: index === 4 ? qaEvents() : [] } },
          result: options.resultRejectAt === index
            ? Promise.reject(new Error('result broke'))
            : Promise.resolve({
                output: [],
                structured: artifact,
                stopReason: options.stopAt === index ? options.stopReason : 'completed',
              }),
          async dispose() {
            disposals.push(id)
            if (options.disposeFailureAt === index) throw new Error('dispose broke')
          },
        }
      },
    },
  }
  return { ctx, starts, disposals }
}

test('configuration and request validation reject ambiguous or unsafe values', () => {
  assert.throws(() => normalizeConfig({ providerName: '' }), /providerName/)
  assert.throws(() => normalizeConfig({ maxDepth: -1 }), /maxDepth/)
  assert.throws(() => normalizeConfig({ maxTokens: 0 }), /maxTokens/)
  assert.throws(() => normalizeConfig({ shellToolName: 'zsh' }), /bash.*pwsh/)
  assert.throws(() => normalizeConfig({ designerTools: [] }), /designerTools/)
  assert.throws(() => normalizeConfig({ reviewerTools: ['read', 'read'] }), /duplicate/)
  assert.throws(() => normalizeConfig({ qaTools: ['read'] }), /shellToolName/)
  const config = normalizeConfig({ shellToolName: 'bash', qaTools: ['bash'] })
  assert.throws(() => resolveRequest({ task: '', provider: 'p', model: 'm' }, config), /task/)
  assert.throws(() => resolveRequest({ task: 'x', provider: 'p' }, config), /together/)
  assert.throws(() => resolveRequest({ task: 'x', max_tokens: 0 }, config), /max_tokens/)
})

test('phase prompts expose only the artifacts required by each role', () => {
  const artifacts = { design, implementation, codeReview: passingReview }
  assert.doesNotMatch(phasePrompt('designer', 'TASK', artifacts), /Approved design/)
  assert.match(phasePrompt('design_reviewer', 'TASK', artifacts), /Proposed design/)
  assert.doesNotMatch(phasePrompt('design_reviewer', 'TASK', artifacts), /Implementation report/)
  assert.match(phasePrompt('implementer', 'TASK', artifacts), /Approved design/)
  assert.doesNotMatch(phasePrompt('implementer', 'TASK', artifacts), /Passing code-review/)
  assert.match(phasePrompt('code_reviewer', 'TASK', artifacts), /Implementation report/)
  assert.doesNotMatch(phasePrompt('code_reviewer', 'TASK', artifacts), /Passing code-review/)
  assert.match(phasePrompt('qa', 'TASK', artifacts), /Passing code-review report/)
})

test('the fixed five-stage process passes artifacts, uses spawn capabilities, and disposes every run', async () => {
  const { ctx, starts, disposals } = harness([
    design, passingReview, implementation, passingReview, passingQa,
  ])
  const result = await runReviewedDevelopment(
    ctx,
    normalizeConfig({ shellToolName: 'bash', qaTools: ['bash'] }),
    { session: { id: 'parent' } },
    { task: 'Implement TASK', provider: 'mock', model: 'mock', max_tokens: 1000 },
    new AbortController().signal,
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.phases.map(phase => phase.role), [
    'designer', 'design_reviewer', 'implementer', 'code_reviewer', 'qa',
  ])
  assert.deepEqual(disposals, ['child-1', 'child-2', 'child-3', 'child-4', 'child-5'])
  assert.ok(starts.every(start => start.name === 'spawn'))
  assert.ok(starts.every(start => start.request.maxDepth === 3))
  assert.ok(starts.every(start => start.request.agentOptions.maxTokens === 1000))
  assert.ok(starts.every(start => start.request.toolFilter.deny.includes('run_reviewed_development')))
  assert.ok(starts.every(start => /commit.*push.*publish.*merge.*promot/i.test(start.request.persona)))
  assert.match(starts[0].request.persona, /Do not perform or include/)
  assert.match(starts[1].request.persona, /design or test plan includes.*return BLOCKED/i)
  assert.match(starts[2].request.persona, /do not commit.*push.*publish.*merge.*promote/i)
  assert.match(starts[3].request.persona, /implementation report indicates.*return BLOCKED/i)
  assert.match(starts[4].request.persona, /test command includes or performs.*do not execute it and return BLOCKED/i)
  assert.match(starts[2].request.prompt[0].text, /Change the implementation/)
  assert.match(starts[4].request.prompt[0].text, /Implemented the approved change/)
  assert.equal(renderReviewedDevelopment(result)[0].text.includes('session=child-5'), true)
})

test('a failed design review stops before implementation', async () => {
  const review = { verdict: 'CHANGES_REQUIRED', summary: 'Revise it.', findings: [] }
  const { ctx, starts, disposals } = harness([design, review])
  const result = await runReviewedDevelopment(
    ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
  )
  assert.equal(result.status, 'changes_required')
  assert.equal(result.stoppedPhase, 'design_review')
  assert.equal(starts.length, 2)
  assert.equal(disposals.length, 2)
})

test('a failed code review stops before QA', async () => {
  const review = { verdict: 'BLOCKED', summary: 'Unsafe.', findings: [] }
  const { ctx, starts } = harness([design, passingReview, implementation, review])
  const result = await runReviewedDevelopment(
    ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
  )
  assert.equal(result.status, 'blocked')
  assert.equal(result.stoppedPhase, 'code_review')
  assert.equal(starts.length, 4)
})

test('role-incompatible structured output and missing localAgent fail closed', async () => {
  const malformed = { verdict: 'FAIL', summary: 'wrong protocol', findings: [] }
  const first = harness([design, malformed])
  const malformedResult = await runReviewedDevelopment(
    first.ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
  )
  assert.equal(malformedResult.status, 'error')
  assert.match(malformedResult.phases.at(-1).summary, /malformed/)

  const second = harness([design], { missingLocalAt: 0 })
  const localResult = await runReviewedDevelopment(
    second.ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
  )
  assert.equal(localResult.status, 'error')
  assert.match(localResult.phases[0].summary, /no localAgent/)
  assert.deepEqual(second.disposals, ['child-1'])
})

test('QA PASS requires exact successful shell evidence for every approved case', () => {
  assert.doesNotThrow(() => verifyQaEvidence(design.testPlan, passingQa, qaEvents(), 'bash'))
  assert.throws(
    () => verifyQaEvidence(design.testPlan, passingQa, qaEvents('npm run other'), 'bash'),
    /no bash call/,
  )
  assert.throws(
    () => verifyQaEvidence(design.testPlan, passingQa, qaEvents('npm test', '[exit code: 9]'), 'bash'),
    /unsuccessful/,
  )
  assert.throws(
    () => verifyQaEvidence(design.testPlan, { ...passingQa, checks: [] }, qaEvents(), 'bash'),
    /every approved/,
  )
  assert.throws(
    () => verifyQaEvidence(design.testPlan, passingQa, qaEvents('npm test', 'started background job bash-1', { background: true }), 'bash'),
    /run_in_background:true/,
  )

  const repeatedPlan = [
    design.testPlan[0],
    { ...design.testPlan[0], id: 'unit-again' },
  ]
  const repeatedReport = {
    ...passingQa,
    checks: [passingQa.checks[0], { ...passingQa.checks[0], id: 'unit-again' }],
  }
  assert.throws(
    () => verifyQaEvidence(repeatedPlan, repeatedReport, qaEvents(), 'bash'),
    /no bash call/,
  )
  assert.doesNotThrow(() => verifyQaEvidence(
    repeatedPlan,
    repeatedReport,
    [...qaEvents(), ...qaEvents('npm test', 'ok again\n', { callId: 'qa-call-2' })],
    'bash',
  ))
})

test('designer artifacts require a non-empty executable plan with unique ids', async () => {
  const invalid = [
    { ...design, testPlan: [] },
    { ...design, testPlan: [{ ...design.testPlan[0], id: '' }] },
    { ...design, testPlan: [{ ...design.testPlan[0], command: '   ' }] },
    { ...design, testPlan: [design.testPlan[0], { ...design.testPlan[0] }] },
  ]
  for (const artifact of invalid) {
    const { ctx, starts, disposals } = harness([artifact])
    const result = await runReviewedDevelopment(
      ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
    )
    assert.equal(result.status, 'error')
    assert.equal(starts.length, 1)
    assert.equal(disposals.length, 1)
  }
})

test('every built-in child stop reason maps to the declared terminal status and disposes', async () => {
  const expected = new Map([
    ['aborted', 'cancelled'],
    ['refusal', 'blocked'],
    ['error', 'error'],
    ['max-tokens', 'error'],
  ])
  for (const [stopReason, status] of expected) {
    const { ctx, disposals } = harness([design], { stopAt: 0, stopReason })
    const result = await runReviewedDevelopment(
      ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
    )
    assert.equal(result.status, status)
    assert.equal(result.phases[0].stopReason, stopReason)
    assert.deepEqual(disposals, ['child-1'])
  }
})

test('review and QA verdict matrix stops at the correct gate', async () => {
  const blockedDesign = { verdict: 'BLOCKED', summary: 'Cannot approve.', findings: [] }
  const designGate = harness([design, blockedDesign])
  const designResult = await runReviewedDevelopment(
    designGate.ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
  )
  assert.equal(designResult.status, 'blocked')
  assert.equal(designResult.stoppedPhase, 'design_review')
  assert.equal(designGate.starts.length, 2)

  for (const [verdict, status] of [['CHANGES_REQUIRED', 'changes_required'], ['BLOCKED', 'blocked']]) {
    const review = { verdict, summary: 'Stop.', findings: [] }
    const { ctx, starts } = harness([design, passingReview, implementation, review])
    const result = await runReviewedDevelopment(
      ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
    )
    assert.equal(result.status, status)
    assert.equal(result.stoppedPhase, 'code_review')
    assert.equal(starts.length, 4)
  }
  for (const [verdict, status] of [['FAIL', 'failed'], ['BLOCKED', 'blocked']]) {
    const qa = { ...passingQa, verdict }
    const { ctx, starts } = harness([design, passingReview, implementation, passingReview, qa])
    const result = await runReviewedDevelopment(
      ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
    )
    assert.equal(result.status, status)
    assert.equal(result.stoppedPhase, 'qa')
    assert.equal(starts.length, 5)
  }
})

test('pre-start and active aborts stop admission or propagate the exact signal', async () => {
  const pre = harness([])
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  const preResult = await runReviewedDevelopment(
    pre.ctx, normalizeConfig(), {}, { task: 'TASK' }, alreadyAborted.signal,
  )
  assert.equal(preResult.status, 'cancelled')
  assert.equal(pre.starts.length, 0)

  const controller = new AbortController()
  const seenSignals = []
  const active = harness([design], { stopAt: 0, stopReason: 'aborted' })
  const originalStart = active.ctx.subagents.start
  active.ctx.subagents.start = async (name, request) => {
    seenSignals.push(request.signal)
    const run = await originalStart(name, request)
    controller.abort()
    return run
  }
  const activeResult = await runReviewedDevelopment(
    active.ctx, normalizeConfig(), {}, { task: 'TASK' }, controller.signal,
  )
  assert.equal(activeResult.status, 'cancelled')
  assert.equal(seenSignals[0], controller.signal)
  assert.deepEqual(active.disposals, ['child-1'])
})

test('result rejection and missing structured capture fail closed and dispose', async () => {
  for (const options of [{ resultRejectAt: 0 }, {}]) {
    const artifacts = options.resultRejectAt === 0 ? [design] : [undefined]
    const { ctx, disposals } = harness(artifacts, options)
    const result = await runReviewedDevelopment(
      ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
    )
    assert.equal(result.status, 'error')
    assert.deepEqual(disposals, ['child-1'])
  }
})

test('disposal failure is reported without hiding the completed child result', async () => {
  const { ctx } = harness([design], { disposeFailureAt: 0 })
  const result = await runReviewedDevelopment(
    ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
  )
  assert.equal(result.status, 'error')
  assert.match(result.phases[0].summary, /cleanup also failed: Error: dispose broke/)
})

test('provider capability preflight rejects before starting a child', async () => {
  const weak = {
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: false, persona: true },
    inheritsParentContext: false,
  }
  const { ctx, starts } = harness([], { provider: weak })
  const result = await runReviewedDevelopment(
    ctx, normalizeConfig(), {}, { task: 'TASK' }, new AbortController().signal,
  )
  assert.equal(result.status, 'error')
  assert.equal(starts.length, 0)
  assert.match(result.phases[0].summary, /lacks toolFilter/)
})
