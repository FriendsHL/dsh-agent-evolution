/** Fixed model-facing tool name for the reviewed development process. */
export const TOOL_NAME = 'run_reviewed_development'

/** Fixed phase order. */
export const PHASES = [
  { phase: 'planning', role: 'designer' },
  { phase: 'design_review', role: 'design_reviewer' },
  { phase: 'implementation', role: 'implementer' },
  { phase: 'code_review', role: 'code_reviewer' },
  { phase: 'qa', role: 'qa' },
]

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    severity: { type: 'string', enum: ['blocker', 'warning', 'nit'] },
    subject: { type: 'string' },
    requiredCorrection: { type: 'string' },
  },
  required: ['severity', 'subject', 'requiredCorrection'],
}

/** Structured-output schemas requested from each role. */
export const OUTPUT_SCHEMAS = {
  designer: {
    type: 'object',
    additionalProperties: false,
    properties: {
      design: { type: 'string' },
      testPlan: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            objective: { type: 'string' },
            command: { type: 'string' },
            expectedResult: { type: 'string' },
          },
          required: ['id', 'objective', 'command', 'expectedResult'],
        },
      },
      risks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            risk: { type: 'string' },
            mitigation: { type: 'string' },
          },
          required: ['risk', 'mitigation'],
        },
      },
    },
    required: ['design', 'testPlan', 'risks'],
  },
  design_reviewer: reviewSchema(),
  implementer: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      changedFiles: { type: 'array', items: { type: 'string' } },
      testsRun: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string' },
            exitCode: { type: 'integer' },
          },
          required: ['command', 'exitCode'],
        },
      },
    },
    required: ['summary', 'changedFiles', 'testsRun'],
  },
  code_reviewer: reviewSchema(),
  qa: {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED'] },
      summary: { type: 'string' },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            command: { type: 'string' },
            exitCode: { type: 'integer' },
            evidence: { type: 'string' },
          },
          required: ['id', 'command', 'exitCode', 'evidence'],
        },
      },
      findings: { type: 'array', items: FINDING_SCHEMA },
    },
    required: ['verdict', 'summary', 'checks', 'findings'],
  },
}

const PERSONAS = {
  designer: 'You are the Designer in a reviewed software-development process. Inspect the repository, then produce a decision-complete implementation design and executable test plan. Do not change production files. Do not perform or include commit, push, publish, merge, or promotion as an implementation or test step. Report only through structured_output.',
  design_reviewer: 'You are the independent Design Reviewer. Check the proposed design and test plan against the task and repository. Do not change production files or perform commit, push, publish, merge, or promotion. PASS only when another engineer can implement the plan without making material design decisions. If the design or test plan includes commit, push, publish, merge, or promotion, return BLOCKED. Report only through structured_output.',
  implementer: 'You are the Implementer. Change the workspace only as required by the approved design. Run focused checks where useful, but do not commit, push, publish, merge, promote, or approve your own work. Report only through structured_output.',
  code_reviewer: 'You are the independent Code Reviewer. Inspect the implementation for specification compliance, defects, maintainability, and test adequacy. Do not change production files or perform commit, push, publish, merge, or promotion. If the implementation report indicates commit, push, publish, merge, or promotion, return BLOCKED. Report only through structured_output.',
  qa: 'You are the independent QA Agent. Do not change production files or perform commit, push, publish, merge, or promotion. Execute every other approved test-plan command exactly as written using the shell tool, inspect every result, and report the observed exit code and concise evidence. If any test command includes or performs commit, push, publish, merge, or promotion, do not execute it and return BLOCKED. PASS only when every required check succeeds. Report only through structured_output.',
}

function reviewSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['PASS', 'CHANGES_REQUIRED', 'BLOCKED'] },
      summary: { type: 'string' },
      findings: { type: 'array', items: FINDING_SCHEMA },
    },
    required: ['verdict', 'summary', 'findings'],
  }
}

function assertNonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`reviewed-development-orchestrator: ${field} must be a non-empty string`)
  }
}

function validateToolList(value, field) {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`reviewed-development-orchestrator: ${field} must be a non-empty array when supplied`)
  }
  for (const tool of value) assertNonEmpty(tool, `${field} entry`)
  if (new Set(value).size !== value.length) {
    throw new Error(`reviewed-development-orchestrator: ${field} cannot contain duplicate tool names`)
  }
}

/** Validate and normalize plugin configuration. */
export function normalizeConfig(config = {}) {
  const normalized = {
    providerName: config.providerName ?? 'spawn',
    maxDepth: config.maxDepth ?? 3,
    shellToolName: config.shellToolName ?? (process.platform === 'win32' ? 'pwsh' : 'bash'),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    ...(config.designerTools === undefined ? {} : { designerTools: config.designerTools }),
    ...(config.reviewerTools === undefined ? {} : { reviewerTools: config.reviewerTools }),
    ...(config.qaTools === undefined ? {} : { qaTools: config.qaTools }),
  }
  assertNonEmpty(normalized.providerName, 'providerName')
  assertNonEmpty(normalized.shellToolName, 'shellToolName')
  if (!['bash', 'pwsh'].includes(normalized.shellToolName)) {
    throw new Error('reviewed-development-orchestrator: shellToolName must be "bash" or "pwsh"')
  }
  if (!Number.isSafeInteger(normalized.maxDepth) || normalized.maxDepth < 0) {
    throw new Error('reviewed-development-orchestrator: maxDepth must be a non-negative safe integer')
  }
  if (normalized.maxTokens !== undefined
    && (!Number.isSafeInteger(normalized.maxTokens) || normalized.maxTokens <= 0)) {
    throw new Error('reviewed-development-orchestrator: maxTokens must be a positive safe integer')
  }
  validateToolList(normalized.designerTools, 'designerTools')
  validateToolList(normalized.reviewerTools, 'reviewerTools')
  validateToolList(normalized.qaTools, 'qaTools')
  if (normalized.qaTools !== undefined && !normalized.qaTools.includes(normalized.shellToolName)) {
    throw new Error('reviewed-development-orchestrator: qaTools must include shellToolName')
  }
  return normalized
}

/** Validate model-facing arguments and resolve symmetric Agent options. */
export function resolveRequest(args, config) {
  assertNonEmpty(args.task, 'task')
  const hasProvider = args.provider !== undefined
  const hasModel = args.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('reviewed-development-orchestrator: provider and model must be supplied together')
  }
  if (hasProvider) {
    assertNonEmpty(args.provider, 'provider')
    assertNonEmpty(args.model, 'model')
  }
  if (args.max_tokens !== undefined
    && (!Number.isSafeInteger(args.max_tokens) || args.max_tokens <= 0)) {
    throw new Error('reviewed-development-orchestrator: max_tokens must be a positive safe integer')
  }
  const maxTokens = args.max_tokens ?? config.maxTokens
  return {
    task: args.task,
    agentOptions: {
      ...(hasProvider ? { provider: args.provider, model: args.model } : {}),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    },
  }
}

/** Build the standalone prompt for one phase from only its authorized artifacts. */
export function phasePrompt(role, task, artifacts) {
  const sections = [`# Development task\n${task}`]
  if (role === 'design_reviewer') {
    sections.push(`# Proposed design and test plan\n${JSON.stringify(artifacts.design)}`)
  } else if (role === 'implementer') {
    sections.push(`# Approved design and test plan\n${JSON.stringify(artifacts.design)}`)
  } else if (role === 'code_reviewer') {
    sections.push(`# Approved design and test plan\n${JSON.stringify(artifacts.design)}`)
    sections.push(`# Implementation report\n${JSON.stringify(artifacts.implementation)}`)
  } else if (role === 'qa') {
    sections.push(`# Approved design and test plan\n${JSON.stringify(artifacts.design)}`)
    sections.push(`# Implementation report\n${JSON.stringify(artifacts.implementation)}`)
    sections.push(`# Passing code-review report\n${JSON.stringify(artifacts.codeReview)}`)
  }
  return sections.join('\n\n')
}

function toolFilter(role, config) {
  const allowed = role === 'designer'
    ? config.designerTools
    : role === 'design_reviewer' || role === 'code_reviewer'
      ? config.reviewerTools
      : role === 'qa'
        ? config.qaTools
        : undefined
  return {
    ...(allowed === undefined ? {} : { allow: allowed }),
    deny: [TOOL_NAME],
  }
}

function phaseSummary(role, artifact) {
  if (role === 'designer') {
    return `Design prepared with ${artifact.testPlan.length} test case(s) and ${artifact.risks.length} risk(s).`
  }
  return artifact.summary
}

function terminalStatus(stopReason) {
  switch (stopReason) {
    case 'aborted': return 'cancelled'
    case 'refusal': return 'blocked'
    case 'completed': return undefined
    case 'error':
    case 'max-tokens':
    default: return 'error'
  }
}

function verdictStatus(role, artifact) {
  if (role === 'design_reviewer' || role === 'code_reviewer') {
    if (artifact.verdict === 'PASS') return undefined
    if (artifact.verdict === 'CHANGES_REQUIRED') return 'changes_required'
    return 'blocked'
  }
  if (role === 'qa') {
    if (artifact.verdict === 'PASS') return undefined
    if (artifact.verdict === 'FAIL') return 'failed'
    return 'blocked'
  }
  return undefined
}

function resultText(event) {
  if (event?.type !== 'tool/result') return ''
  const blocks = event.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.flatMap(block => Array.isArray(block?.content) ? block.content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Require QA's PASS report to agree with recorded successful shell execution. */
export function verifyQaEvidence(testPlan, report, events, shellToolName) {
  const planById = new Map()
  for (const testCase of testPlan) {
    if (planById.has(testCase.id)) throw new Error(`duplicate test-plan id: ${testCase.id}`)
    planById.set(testCase.id, testCase)
  }
  const checksById = new Map()
  for (const check of report.checks) {
    if (checksById.has(check.id)) throw new Error(`QA reported duplicate test-plan id: ${check.id}`)
    checksById.set(check.id, check)
  }
  if (checksById.size !== planById.size) {
    throw new Error('QA PASS does not report every approved test-plan case exactly once')
  }

  const calls = events.filter(event => event?.type === 'tool/call' && event.data?.name === shellToolName)
  const results = events.filter(event => event?.type === 'tool/result')
  const consumedCallIds = new Set()
  const consumedResults = new Set()
  for (const [id, testCase] of planById) {
    const check = checksById.get(id)
    if (check === undefined) throw new Error(`QA PASS is missing test-plan case ${id}`)
    if (check.command !== testCase.command) throw new Error(`QA command mismatch for test-plan case ${id}`)
    if (check.exitCode !== 0) throw new Error(`QA reported non-zero exit code for test-plan case ${id}`)

    const matchingCalls = calls.flatMap((event) => {
      try {
        const args = JSON.parse(event.data.arguments)
        return args?.command === testCase.command ? [{ event, args }] : []
      } catch {
        return []
      }
    })
    if (matchingCalls.some(({ args }) => args.run_in_background === true)) {
      throw new Error(`QA shell call for test-plan case ${id} used run_in_background:true`)
    }
    const matchingCall = matchingCalls.find(({ event }) => !consumedCallIds.has(event.data.callId))?.event
    if (matchingCall === undefined) throw new Error(`QA session has no ${shellToolName} call for test-plan case ${id}`)
    const matchingResult = results.find(event => !consumedResults.has(event)
      && event.data?.message?.source?.callId === matchingCall.data.callId)
    const toolResult = matchingResult?.data?.message?.content?.[0]
    if (matchingResult === undefined) {
      throw new Error(`QA session has no shell result paired to test-plan case ${id}`)
    }
    if (toolResult?.isError !== false) {
      const detail = resultText(matchingResult).trim()
      throw new Error(`QA session shell result is marked as an error for test-plan case ${id}${detail.length === 0 ? '' : `: ${detail}`}`)
    }
    const text = resultText(matchingResult)
    if (/\[exit code:\s*(?!0\])\d+\]/.test(text)
      || text.includes('[killed by signal:') || text.includes('[timed out after')) {
      throw new Error(`QA session recorded an unsuccessful shell outcome for test-plan case ${id}`)
    }
    consumedCallIds.add(matchingCall.data.callId)
    consumedResults.add(matchingResult)
  }
}

function validateDesignerArtifact(value) {
  assertNonEmpty(value.design, 'designer design')
  if (!Array.isArray(value.testPlan) || value.testPlan.length === 0 || !Array.isArray(value.risks)) {
    throw new Error('designer returned malformed structured output: testPlan must be non-empty')
  }
  const ids = new Set()
  for (const testCase of value.testPlan) {
    if (typeof testCase !== 'object' || testCase === null || Array.isArray(testCase)) {
      throw new Error('designer returned malformed test-plan case')
    }
    for (const field of ['id', 'objective', 'command', 'expectedResult']) {
      assertNonEmpty(testCase[field], `testPlan ${field}`)
    }
    if (ids.has(testCase.id)) throw new Error(`designer returned duplicate test-plan id: ${testCase.id}`)
    ids.add(testCase.id)
  }
}

function validateStructured(role, value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${role} returned no structured object`)
  }
  if (role === 'designer') {
    validateDesignerArtifact(value)
  } else if (role === 'implementer') {
    if (typeof value.summary !== 'string' || !Array.isArray(value.changedFiles) || !Array.isArray(value.testsRun)) {
      throw new Error('implementer returned malformed structured output')
    }
  } else {
    const verdicts = role === 'qa'
      ? ['PASS', 'FAIL', 'BLOCKED']
      : ['PASS', 'CHANGES_REQUIRED', 'BLOCKED']
    if (!verdicts.includes(value.verdict)
      || typeof value.summary !== 'string'
      || !Array.isArray(value.findings)
      || role === 'qa' && !Array.isArray(value.checks)) {
      throw new Error(`${role} returned malformed structured output`)
    }
    assertNonEmpty(value.summary, `${role} summary`)
    if (role === 'qa') {
      for (const check of value.checks) {
        if (typeof check !== 'object' || check === null || Array.isArray(check)) {
          throw new Error('qa returned malformed check')
        }
        assertNonEmpty(check.id, 'qa check id')
        assertNonEmpty(check.command, 'qa check command')
        assertNonEmpty(check.evidence, 'qa check evidence')
        if (!Number.isSafeInteger(check.exitCode)) throw new Error('qa check exitCode must be an integer')
      }
    }
  }
  return value
}

async function runPhase(ctx, config, parent, signal, spec, task, artifacts, agentOptions) {
  const startedAt = Date.now()
  let run
  let outcome
  try {
    run = await ctx.subagents.start(config.providerName, {
      label: spec.role,
      prompt: [{ type: 'text', text: phasePrompt(spec.role, task, artifacts) }],
      parent,
      signal,
      ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
      outputSchema: OUTPUT_SCHEMAS[spec.role],
      maxDepth: config.maxDepth,
      toolFilter: toolFilter(spec.role, config),
      persona: PERSONAS[spec.role],
    })
    if (run.localAgent === undefined) {
      throw new Error(`provider ${config.providerName} returned no localAgent`)
    }
    const result = await run.result
    const status = terminalStatus(result.stopReason)
    if (status !== undefined) {
      outcome = {
        status,
        record: {
          phase: spec.phase,
          role: spec.role,
          sessionId: run.id,
          stopReason: result.stopReason,
          durationMs: Date.now() - startedAt,
          summary: result.diagnostic ?? `SubAgent stopped with ${result.stopReason}.`,
        },
      }
    } else {
      const artifact = validateStructured(spec.role, result.structured)
      if (spec.role === 'qa' && artifact.verdict === 'PASS') {
        verifyQaEvidence(artifacts.design.testPlan, artifact, run.localAgent.session.events, config.shellToolName)
      }
      outcome = {
        status: verdictStatus(spec.role, artifact),
        artifact,
        record: {
          phase: spec.phase,
          role: spec.role,
          sessionId: run.id,
          stopReason: result.stopReason,
          durationMs: Date.now() - startedAt,
          ...(artifact.verdict === undefined ? {} : { verdict: artifact.verdict }),
          summary: phaseSummary(spec.role, artifact),
          structured: artifact,
        },
      }
    }
  } catch (error) {
    outcome = {
      status: signal.aborted ? 'cancelled' : 'error',
      record: {
        phase: spec.phase,
        role: spec.role,
        ...(run === undefined ? {} : { sessionId: run.id }),
        stopReason: signal.aborted ? 'aborted' : 'error',
        durationMs: Date.now() - startedAt,
        summary: String(error),
      },
    }
  } finally {
    if (run !== undefined) {
      try {
        await run.dispose()
      } catch (disposeError) {
        const primary = outcome?.record.summary
        outcome = {
          status: 'error',
          record: {
            ...(outcome?.record ?? {
              phase: spec.phase,
              role: spec.role,
              sessionId: run.id,
              stopReason: 'error',
              durationMs: Date.now() - startedAt,
            }),
            stopReason: 'error',
            summary: primary === undefined
              ? `SubAgent disposal failed: ${String(disposeError)}`
              : `${primary}; cleanup also failed: ${String(disposeError)}`,
          },
        }
      }
    }
  }
  return outcome
}

/** Execute the fixed reviewed-development state machine. */
export async function runReviewedDevelopment(ctx, config, parent, args, signal) {
  const request = resolveRequest(args, config)
  const provider = ctx.subagents.getProvider(config.providerName)
  if (provider === undefined) {
    return failureResult(request.task, 'planning', 'error', `No SubAgent provider is registered for ${config.providerName}.`)
  }
  for (const capability of ['outputSchema', 'depthLimit', 'toolFilter', 'persona']) {
    if (provider.capabilities?.[capability] !== true) {
      return failureResult(request.task, 'planning', 'error', `SubAgent provider ${config.providerName} lacks ${capability}.`)
    }
  }
  if (provider.inheritsParentContext !== false) {
    return failureResult(request.task, 'planning', 'error', `SubAgent provider ${config.providerName} is not a fresh in-process spawn provider.`)
  }

  const phases = []
  const artifacts = {}
  for (const spec of PHASES) {
    if (signal.aborted) return { task: request.task, status: 'cancelled', stoppedPhase: spec.phase, phases }
    const outcome = await runPhase(ctx, config, parent, signal, spec, request.task, artifacts, request.agentOptions)
    phases.push(outcome.record)
    if (outcome.status !== undefined) {
      return { task: request.task, status: outcome.status, stoppedPhase: spec.phase, phases }
    }
    if (spec.role === 'designer') artifacts.design = outcome.artifact
    if (spec.role === 'implementer') artifacts.implementation = outcome.artifact
    if (spec.role === 'code_reviewer') artifacts.codeReview = outcome.artifact
  }
  return { task: request.task, status: 'completed', phases }
}

function failureResult(task, phase, status, summary) {
  return {
    task,
    status,
    stoppedPhase: phase,
    phases: [{ phase, role: 'designer', stopReason: 'error', durationMs: 0, summary }],
  }
}

/** Render one compact parent-session result with child-session evidence pointers. */
export function renderReviewedDevelopment(result) {
  const lines = [`Reviewed development: ${result.status}`]
  for (const phase of result.phases) {
    lines.push(`- ${phase.phase} (${phase.role}): ${phase.verdict ?? phase.stopReason}; session=${phase.sessionId ?? 'not-started'}; ${phase.summary}`)
  }
  if (result.stoppedPhase !== undefined) lines.push(`Stopped at: ${result.stoppedPhase}`)
  lines.push('Inspect the listed child sessions for complete prompts, tool calls, results, and structured evidence.')
  return [{ type: 'text', text: lines.join('\n') }]
}
