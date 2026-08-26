import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required by the reviewed-development integration fixture')

const { installModelSelection } = await import(pathToFileURL(`${checkout}/packages/core/agent/src/index.ts`).href)
const { createUserMessage } = await import(pathToFileURL(`${checkout}/packages/llm/llm/src/index.ts`).href)
const { SessionId } = await import(pathToFileURL(`${checkout}/packages/core/session/src/index.ts`).href)

export const name = 'reviewed-development-preset-headless-runner'
export const inject = ['agentDefaultModel', 'agents', 'agentPresets', 'sessions']

function finalText(events) {
  const message = events.findLast(event => event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type === 'text'))
  return message?.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
}

export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('preset headless fixture requires appExit')
  void (async () => {
    await ctx.get('loader')?.await()
    const selection = ctx.agentDefaultModel.currentSelection()
    const handle = await ctx.agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd(), agentPreset: 'minimal' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        const selected = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
        await ctx.agentPresets.mount(agentCtx, 'minimal')
        agentCtx.agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
      },
    })
    const agent = handle.agent
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: ctx.headlessStartup.task }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      await ctx.sessions.flush(agent.session)
      process.stdout.write(`${finalText(agent.session.events)}\n`)
      const end = agent.session.events.findLast(event => event.type === 'turn/end')
      exit(end?.data.reason?.kind === 'completed' ? 0 : 1)
    } finally {
      await handle.dispose()
    }
  })().catch((error) => {
    process.stderr.write(`fixture headless runner: ${String(error)}\n`)
    exit(1)
  })
}
