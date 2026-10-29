import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const RECALL = 'mcp__cogmemai__recall_memories'
const SAVE = 'mcp__cogmemai__save_memory'
const CONTEXT = 'mcp__cogmemai__get_project_context'

const CONNECTED = [
  { name: RECALL, description: 'Search memories.', mcp: true },
  { name: SAVE, description: 'Save a memory.', mcp: true },
  { name: CONTEXT, description: 'Load project context.', mcp: true },
  { name: 'Bash', description: 'Run a command.', mcp: false },
]

/** The world beneath the plugin: what the engine would answer in a session. */
function world(on: On, options: { connected?: boolean } = {}) {
  mock.clock(on, { now: 1_761_750_000_000 })
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.list', () => ({ value: options.connected === false ? [] : CONNECTED }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('prompt.fill', () => ({ isFilled: true }))
  // What the engine draws where the plugin passes: a stand-in the tests can see.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>engine-default</Text>
  })
}

const SESSION = { cwd: 'C:\\Users\\scott\\Projects\\totalrecall', surface: 'terminal', isInteractive: true } as const

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'aitotalrecall',
  props: {
    title: 'Total Recall',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const recallAnswer = {
  memories: [
    {
      id: 140486,
      content:
        'CLAUDE CODE UI PRODUCT IDEA, RESEARCHED Oct 29 2026. Scott agreed not to build a standalone GUI. Build inside Claude Code using the mod layer.',
      subject: 'claude_code_cockpit_mod_strategy',
      importance: 8,
      scope: 'global',
    },
    {
      id: 139602,
      content: 'COGMEMAI-MCP 3.32.0 SHIPPED (Oct 10 2026): character budget for recall.',
      subject: 'cogmemai_mcp_3_32_0_recall_budget',
      importance: 8,
      scope: 'global',
    },
  ],
  total: 2,
}

const contextAnswer = {
  formatted_context: [
    '## Mandatory Rules',
    '- [built-in] (verify_every_change_landed) "Done" means observed, not intended.',
    '  - a sub-bullet inside the rule body that must not count',
    '- [#60700] [global] (never_benchmark_on_production_account) Always use a dedicated test account.',
    '## Project Memories',
    '- [#12] [project] (deploy_path) Deploys go to the maps docroot.',
  ].join('\n'),
  total_count: 3,
}

function answer(value: unknown) {
  return { result: value, text: JSON.stringify(value) }
}

test('band and pane show recalls, saves and rules on terminal and desktop', async ($, on) => {
  world(on)
  on('tool.call', { tool: RECALL }, () => answer(recallAnswer))
  on('tool.call', { tool: CONTEXT }, () => answer(contextAnswer))
  on('tool.call', { tool: SAVE }, () => answer({ memory_id: 777, stored: true }))

  await $.session.start(SESSION)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'aitotalrecall', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /0 recalled · 0 saved · 0 rules/ })).toBeDefined()
    await band.unmount()
  }

  await $.tool.call({ tool: RECALL, query: 'cockpit strategy' })
  await $.tool.call({ tool: CONTEXT })
  await $.tool.call({ tool: SAVE, content: 'Total Recall prototype built Oct 29 2026.', subject: 'totalrecall_prototype', importance: 7 })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'aitotalrecall', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /3 recalled · 1 saved · 2 rules/ })).toBeDefined()
    expect(await band.find({ key: 'open' })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({ plugin: 'aitotalrecall', surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: /TOTAL RECALL/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /claude code cockpit mod strategy/ })).toBeDefined()
    // The shouted header is skipped: the snippet opens on the plain sentence.
    expect(await pane.find({ type: 'Text', text: /^\s*Scott agreed not to build/ })).toBeDefined()

    // Expand a row: full text and the actions appear.
    await pane.press({ key: 'item-140486' })
    expect(await pane.find({ key: 'copy-140486' })).toBeDefined()
    expect(await pane.find({ key: 'ask-140486' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /#140486 · importance 8 · global/ })).toBeDefined()
    await pane.press({ key: 'copy-140486' })
    await pane.press({ key: 'ask-140486' })
    await pane.press({ key: 'item-140486' })
    expect(await pane.find({ key: 'copy-140486' })).toBeUndefined()

    await pane.press({ key: 'tab-learned' })
    expect(await pane.find({ type: 'Text', text: /totalrecall prototype/ })).toBeDefined()

    await pane.press({ key: 'tab-rules' })
    expect(await pane.find({ type: 'Text', text: /verify every change landed/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /never benchmark on production account/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /sub-bullet/ })).toBeUndefined()
    await pane.press({ key: 'rule-60700' })
    expect(await pane.find({ type: 'Text', text: /dedicated test account/ })).toBeDefined()

    await pane.press({ key: 'tab-recalled' })
    await pane.unmount()
  }
})

test('memory calls in the transcript draw as cards', async ($, on) => {
  world(on)
  let recallId = ''
  let saveId = ''
  on('tool.call', { tool: RECALL }, (_$, e) => {
    recallId = e.tool_use_id
    return answer(recallAnswer)
  })
  on('tool.call', { tool: SAVE }, (_$, e) => {
    saveId = e.tool_use_id
    return answer({ memory_id: 777, stored: true })
  })
  await $.session.start(SESSION)

  await $.tool.call({ tool: RECALL, query: 'cockpit strategy' })
  await $.tool.call({ tool: SAVE, content: 'Total Recall prototype built.', subject: 'totalrecall_prototype' })
  expect(recallId).not.toBe('')
  expect(saveId).not.toBe('')

  for (const surface of ['terminal', 'desktop'] as const) {
    const use = await $.ui.mount({
      plugin: 'aitotalrecall',
      surface,
      component: 'ToolUse',
      requestId: recallId,
      props: { tool_use_id: recallId, tool: RECALL, input: { query: 'cockpit strategy' }, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect(await use.find({ type: 'Text', text: /recalled/ })).toBeDefined()
    expect(await use.find({ type: 'Text', text: /2 memories for “cockpit strategy”/ })).toBeDefined()
    await use.unmount()

    const result = await $.ui.mount({
      plugin: 'aitotalrecall',
      surface,
      component: 'ToolResult',
      requestId: recallId,
      props: { tool_use_id: recallId, tool: RECALL, output: recallAnswer, isErrored: false },
    })
    expect(await result.find({ type: 'Text', text: /claude code cockpit mod strategy/ })).toBeDefined()
    await result.unmount()

    const saved = await $.ui.mount({
      plugin: 'aitotalrecall',
      surface,
      component: 'ToolUse',
      requestId: saveId,
      props: { tool_use_id: saveId, tool: SAVE, input: {}, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect(await saved.find({ type: 'Text', text: /remembered/ })).toBeDefined()
    expect(await saved.find({ type: 'Text', text: /totalrecall prototype.*#777/ })).toBeDefined()
    await saved.unmount()
  }

  // A call the plugin never saw falls through to the engine's own row.
  const unknown = await $.ui.mount({
    plugin: 'aitotalrecall',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'older',
    props: { tool_use_id: 'older', tool: RECALL, input: {}, isRunning: false, isErrored: false, isInterrupted: false },
  })
  expect(await unknown.find({ type: 'Text', text: /engine-default/ })).toBeDefined()
  await unknown.unmount()
})

test('the search box runs a recall without a model turn', async ($, on) => {
  world(on)
  let asked = ''
  on('tool.call', { tool: RECALL }, (_$, e) => {
    asked = String((e as Record<string, unknown>).query)
    return answer(recallAnswer)
  })
  await $.session.start(SESSION)

  const pane = await $.ui.mount({ plugin: 'aitotalrecall', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'recall-now' })).toBeDefined()
  await pane.input({ key: 'search', text: 'x402 billing' })
  expect(asked).toBe('x402 billing')
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: /claude code cockpit mod strategy/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /recalled 2 for “x402 billing”/ })).toBeDefined()
  await pane.unmount()
})

test('without a memory server the band and pane say so', async ($, on) => {
  world(on, { connected: false })
  await $.session.start(SESSION)

  const band = await $.ui.mount({ plugin: 'aitotalrecall', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /memory not connected/ })).toBeDefined()
  await band.unmount()

  const pane = await $.ui.mount({ plugin: 'aitotalrecall', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: /No memory server is connected/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /npx cogmemai-mcp@latest setup/ })).toBeDefined()
  await pane.press({ key: 'copy-setup' })
  await pane.unmount()
})

test('the band hides on /recall hide and returns on /recall show', async ($, on) => {
  world(on)
  await $.session.start(SESSION)

  const run = (args: string) =>
    $.command.run({ command: 'aitotalrecall', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  expect((await run('hide')).text).toMatch(/hidden/)
  const band = await $.ui.mount({ plugin: 'aitotalrecall', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /total recall/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /engine-default/ })).toBeDefined()
  await band.unmount()

  expect((await run('show')).text).toMatch(/shown/)
  const again = await $.ui.mount({ plugin: 'aitotalrecall', surface: 'terminal', ...BAND })
  expect(await again.find({ type: 'Text', text: /total recall/ })).toBeDefined()
  await again.unmount()
})

test('a correction is saved with its wrong and right approach as the text', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'mcp__cogmemai__save_correction' }, () => answer({ memory_id: 901, stored: true }))
  on('tool.call', { tool: 'mcp__cogmemai__save_rule' }, () => answer({ memory_id: 902, stored: true }))
  await $.session.start(SESSION)

  await $.tool.call({
    tool: 'mcp__cogmemai__save_correction',
    wrong_approach: 'Used npm install in the monorepo',
    right_approach: 'Always use bun add for this project',
    context: 'package management in monorepo',
  })
  await $.tool.call({
    tool: 'mcp__cogmemai__save_rule',
    content: 'NEVER pipe into crontab -',
    subject: 'crontab_safety',
    scope: 'global',
  })

  const pane = await $.ui.mount({ plugin: 'aitotalrecall', surface: 'terminal', ...PANE })
  await pane.press({ key: 'tab-learned' })
  expect(await pane.find({ type: 'Text', text: /package management in monorepo/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Wrong: Used npm install/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /crontab safety/ })).toBeDefined()
  // A saved rule is in force at once: the Rules tab shows it without a context load.
  await pane.press({ key: 'tab-rules' })
  expect(await pane.find({ type: 'Text', text: /crontab safety/ })).toBeDefined()
  await pane.unmount()

  const band = await $.ui.mount({ plugin: 'aitotalrecall', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /2 saved · 1 rules/ })).toBeDefined()
  await band.unmount()
})

test('a context load with rules only draws a rules card, and an error is marked', async ($, on) => {
  world(on)
  const rulesOnly = { formatted_context: '## Mandatory Rules\n- [built-in] (verify_every_change_landed) Done means observed.', total_count: 0 }
  let contextId = ''
  on('tool.call', { tool: CONTEXT }, (_$, e) => {
    contextId = e.tool_use_id
    return answer(rulesOnly)
  })
  let recallId = ''
  on('tool.call', { tool: RECALL }, (_$, e) => {
    recallId = e.tool_use_id
    return { result: { error: 'down' }, text: 'Error: server down', isError: true }
  })
  await $.session.start(SESSION)
  await $.tool.call({ tool: CONTEXT })
  await $.tool.call({ tool: RECALL, query: 'anything' })

  const card = await $.ui.mount({
    plugin: 'aitotalrecall',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: contextId,
    props: { tool_use_id: contextId, tool: CONTEXT, output: rulesOnly, isErrored: false },
  })
  expect(await card.find({ type: 'Text', text: /1 rules in force/ })).toBeDefined()
  await card.unmount()

  const failed = await $.ui.mount({
    plugin: 'aitotalrecall',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: recallId,
    props: { tool_use_id: recallId, tool: RECALL, input: {}, isRunning: false, isErrored: true, isInterrupted: false },
  })
  expect(await failed.find({ type: 'Text', text: /^error$/ })).toBeDefined()
  await failed.unmount()

  // The band is not left busy after an error.
  const band = await $.ui.mount({ plugin: 'aitotalrecall', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /recalling…/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /memory server error/ })).toBeDefined()
  await band.unmount()
})

test('an aborted memory call does not leave the band busy', async ($, on) => {
  world(on)
  on('tool.call', { tool: RECALL }, () => {
    throw new Error('aborted')
  })
  await $.session.start(SESSION)
  await expect($.tool.call({ tool: RECALL, query: 'anything' })).rejects.toThrow()

  const band = await $.ui.mount({ plugin: 'aitotalrecall', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /recalling…/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /interrupted/ })).toBeDefined()
  await band.unmount()
})

test('the band never exceeds its width', async ($, on) => {
  world(on)
  on('tool.call', { tool: RECALL }, () => answer(recallAnswer))
  await $.session.start(SESSION)
  await $.tool.call({ tool: RECALL, query: 'a very long query about x402 billing and settlement on base mainnet' })

  const textOf = (node: unknown): string => {
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(textOf).join('')
    const n = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
    if (!n || typeof n !== 'object') return ''
    // The terminal draws a plain Button as its bare label, any other as [ label ].
    if (n.type === 'Button') return n.props?.plain ? String(n.props?.label ?? '') : `[ ${String(n.props?.label ?? '')} ]`
    return (n.children ?? []).map(textOf).join('')
  }
  for (const bodyColumns of [60, 72, 80, 96, 120, 160]) {
    const band = await $.ui.mount({
      plugin: 'aitotalrecall',
      surface: 'terminal',
      ...BAND,
      props: { ...BAND.props, bodyColumns },
    })
    const tree = (await band.drawn()) as { children?: unknown[] }
    // Each child is one gap apart; count cells the way the row lays them out.
    const parts = (tree.children ?? []).map(textOf).filter(t => t.length > 0)
    const cells = parts.reduce((n, t) => n + t.length, 0) + (parts.length - 1)
    expect(cells).toBeLessThanOrEqual(bodyColumns)
    await band.unmount()
  }
})

test('a failed save is not counted as learned', async ($, on) => {
  world(on)
  on('tool.call', { tool: SAVE }, () => ({ result: { error: 'nope' }, text: 'Error: nope', isError: true }))
  await $.session.start(SESSION)

  await $.tool.call({ tool: SAVE, content: 'will not land', subject: 'nope' })

  const band = await $.ui.mount({ plugin: 'aitotalrecall', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /0 saved/ })).toBeDefined()
  await band.unmount()
})
