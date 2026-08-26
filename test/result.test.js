import assert from 'node:assert/strict'
import test from 'node:test'
import { outputText, stopReasonOf } from '../src/result.js'

test('stopReasonOf maps every built-in terminal reason', () => {
  assert.equal(stopReasonOf({ kind: 'completed' }), 'completed')
  assert.equal(stopReasonOf({ kind: 'max-tokens' }), 'max-tokens')
  assert.equal(stopReasonOf({ kind: 'aborted' }), 'aborted')
  assert.equal(stopReasonOf({ kind: 'blocked' }), 'refusal')
  assert.equal(stopReasonOf({ kind: 'error' }), 'error')
  assert.equal(stopReasonOf({ kind: 'interrupted' }), 'error')
  assert.equal(stopReasonOf(undefined), 'error')
  assert.equal(stopReasonOf({ kind: 'future-reason' }), 'error')
})

test('outputText keeps text order and ignores structured blocks', () => {
  assert.equal(outputText([
    { type: 'text', text: 'hello ' },
    { type: 'tool_use', id: '1', name: 'noop', input: {} },
    { type: 'text', text: 'world' },
  ]), 'hello world')
})
