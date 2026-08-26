/** Map one DSH turn-end reason to the stable value returned by experiment tools. */
export function stopReasonOf(reason) {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    case 'blocked':
      return 'refusal'
    case 'error':
    case 'interrupted':
    case undefined:
      return 'error'
    default:
      return 'error'
  }
}

/** Concatenate text blocks for native rendering without discarding structured output. */
export function outputText(blocks) {
  return blocks
    .filter(block => block !== null && typeof block === 'object'
      && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Render one run without dropping its structured assistant blocks or evidence metadata. */
export function renderRun(result) {
  const text = outputText(result.output)
  const suffix = `\n\n[agent-experiment-runner: preset=${result.preset}, session=${result.sessionId}, stop=${result.stopReason}, persisted=${result.persisted}, duration=${result.durationMs}ms]`
  return [{ type: 'text', text: `${text}${suffix}` }]
}

/** Render both comparison records symmetrically without deriving a winner. */
export function renderComparison(result) {
  return [{
    type: 'text',
    text: [
      `Baseline (preset=${result.baseline.preset}, session=${result.baseline.sessionId}, stop=${result.baseline.stopReason}, persisted=${result.baseline.persisted}, duration=${result.baseline.durationMs}ms):`,
      outputText(result.baseline.output),
      '',
      `Candidate (preset=${result.candidate.preset}, session=${result.candidate.sessionId}, stop=${result.candidate.stopReason}, persisted=${result.candidate.persisted}, duration=${result.candidate.durationMs}ms):`,
      outputText(result.candidate.output),
      '',
      'No winner was selected; evaluate both records against the same rubric.',
    ].join('\n'),
  }]
}
