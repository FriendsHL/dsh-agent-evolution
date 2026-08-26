/** Map one DSH turn-end reason to the stable vocabulary returned by this plugin. */
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

/** Concatenate text blocks for the native tool result without discarding structured blocks. */
export function outputText(blocks) {
  return blocks
    .filter(block => block !== null && typeof block === 'object'
      && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}
