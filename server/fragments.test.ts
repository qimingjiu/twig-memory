import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { HeadlessMuninn, type MuninnState } from './core'
import { EngineManager } from './manager'
import { createMcpServer } from './mcp-server'
import { searchFragments, listFragments, type SearchDependencies } from './services/fragments'
import { buildRetriever, tokenize, type Frag } from './retrieval'
import { embedTexts } from './embed-node'

// Never use a developer's configured provider or persistent memories during tests.
process.env.MUNINN_SEARCH_EMBED = '0'

function fixture(): MuninnState {
  const state = new HeadlessMuninn().getState()
  state.fragments = Array.from({ length: 65 }, (_, i) => ({
    id: `f${165 - i}`, day: i, dateLabel: `2026-09-${String(i % 28 + 1).padStart(2, '0')}`,
    title: `daily walk ${i}`, body: `ordinary walk in the park ${i}`,
    vad: { valence: 0, arousal: 0.3, dominance: 0.5 }, threadIds: [], tags: [],
  }))
  Object.assign(state.fragments.find((f) => f.id === 'f153')!, {
    title: '设备计划', body: '上个月说过想换电脑，预算五千。'.repeat(30) + '最终选了 ThinkPad T14。', threadIds: ['silent-thread'],
  })
  Object.assign(state.fragments.find((f) => f.id === 'f154')!, {
    title: '行程', body: '下周去北京。', correction: { note: '是去上海，取消北京行程。', at: '2026-10-23T01:00:00Z' },
  })
  state.fragments.splice(2, 0, { ...state.fragments[0], id: 'shadow', shadow: true, body: '秘密影子 电脑 上海' })
  state.fragSeq = 166
  return state
}
const offline: SearchDependencies = { available: () => false, embed: async () => { throw new Error('must not embed') } }
const decode = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text)

await test('runtime fragment recall', async (t) => {
  await t.test('old Chinese facts outside the context window are reachable, read-only and complete', async () => {
    const state = fixture()
    const engine = new HeadlessMuninn(state)
    assert.deepEqual(engine.getContextPacket('alice').recentFragments.map((f) => f.id), ['f165', 'f164', 'f163', 'f162', 'f161'])
    const before = JSON.stringify(state)
    const result = await searchFragments(state.fragments, '我想换电脑', 8, offline)
    assert.equal(result.mode, 'bm25')
    assert.equal(result.hits[0].id, 'f153')
    assert.match(result.hits[0].body, /ThinkPad T14/)
    assert.deepEqual(result.hits[0].threadIds, ['silent-thread'])
    assert.equal(JSON.stringify(state), before)
    assert.equal(engine.isDirty(), false)
  })
  await t.test('IDs, dates, English, corrections and empty/no-match queries', async () => {
    const state = fixture()
    for (const query of ['f153', 'ThinkPad']) assert.equal((await searchFragments(state.fragments, query, 8, offline)).hits[0].id, 'f153')
    assert.ok((await searchFragments(state.fragments, '2026-09-01', 8, offline)).hits.some((f) => f.date === '2026-09-01'))
    const corrected = (await searchFragments(state.fragments, '上海', 8, offline)).hits[0]
    assert.equal(corrected.id, 'f154')
    assert.match(corrected.body, /本人修正：是去上海/)
    assert.equal(corrected.correction?.note, '是去上海，取消北京行程。')
    for (const query of ['zzzznothing', '火星探险', '!!!', '']) assert.deepEqual((await searchFragments(state.fragments, query, 8, offline)).hits, [])
    assert.deepEqual((await searchFragments([], '电脑', 8, offline)).hits, [])
    const engine = new HeadlessMuninn(state)
    engine.correctFragment('f153', '最终买的是 Framework laptop。')
    assert.match((await searchFragments(state.fragments, 'Framework', 8, offline)).hits[0].body, /本人修正/)
  })
  await t.test('paging filters shadows before slicing and preserves raw text + corrections', () => {
    const state = fixture()
    const first = listFragments(state.fragments, { page: 1, limit: 50, includeShadow: false })
    const second = listFragments(state.fragments, { page: 2, limit: 50, includeShadow: false })
    assert.equal(first.totalFragments, 65)
    assert.equal(first.fragments.length, 50)
    assert.equal(second.fragments.length, 15)
    assert.equal(new Set([...first.fragments, ...second.fragments].map((f) => f.id)).size, 65)
    assert.equal(first.fragments.find((f) => f.id === 'f154')!.body, '下周去北京。')
    assert.equal(listFragments(state.fragments, { page: 1, limit: 500, includeShadow: true }).totalFragments, 66)
    assert.deepEqual(listFragments(state.fragments, { page: 99, limit: 50, includeShadow: false }).fragments, [])
  })
  await t.test('hybrid RRF can retrieve a semantic-only hit; provider errors/timeouts fall back', async () => {
    const state = fixture()
    const hybrid = await searchFragments(state.fragments, 'portable workstation', 1, {
      available: () => true,
      embed: async (texts) => texts.map((text, i) => i === texts.length - 1 || text.startsWith('f153 ') ? [1, 0] : [0, 1]),
    })
    assert.equal(hybrid.mode, 'hybrid')
    assert.equal(hybrid.hits[0].id, 'f153')
    assert.ok(hybrid.hits[0].score > 0)
    const broken: SearchDependencies['embed'][] = [
      async () => { throw new Error('provider down') },
      async () => [[NaN]],
      async (_texts, _shard, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
    ]
    for (const embed of broken) {
      const result = await searchFragments(state.fragments, '电脑', 8, { available: () => true, embed, timeoutMs: 10 })
      assert.equal(result.mode, 'bm25')
      assert.equal(result.degradedReason, 'embeddings_unavailable')
      assert.equal(result.hits[0].id, 'f153')
    }
  })
  await t.test('shared extraction preserves evaluation fallback and English ordering', () => {
    const corpus: Frag[] = ['coffee beans', 'cycling trip'].map((text, i) => {
      const tokens = tokenize(text)
      return { id: String(i), date: '', text, tf: new Map(tokens.map((token) => [token, 1])), len: tokens.length }
    })
    const retrieve = buildRetriever(corpus)
    assert.equal(retrieve('cycling', 1)[0].id, '1')
    assert.deepEqual(retrieve('你好', 2), corpus)
    assert.deepEqual(retrieve('unknown', 2), corpus)
  })
})

await test('real MCP tools enforce history access and isolation', async (t) => {
  const engines = new Map([['recall-test-alice', new HeadlessMuninn(fixture())]])
  const manager = { get(userId: string) {
    if (!engines.has(userId)) engines.set(userId, new HeadlessMuninn())
    return engines.get(userId)!
  } } as EngineManager
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(manager)
  const client = new Client({ name: 'recall-test', version: '1' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })
  const tools = await client.listTools()
  assert.ok(tools.tools.some((tool) => tool.name === 'memory_search_fragments'))
  assert.match(tools.tools.find((tool) => tool.name === 'memory_context')!.description!, /非|不代表/)
  const query = (userId: string) => client.callTool({ name: 'memory_search_fragments', arguments: { userId, query: '换电脑' } })
  assert.equal(decode(await query('recall-test-alice')).hits[0].id, 'f153')
  assert.deepEqual(decode(await query('recall-test-bob')).hits, [])
  const page = decode(await client.callTool({ name: 'memory_list_fragments', arguments: { userId: 'recall-test-alice', page: 2 } }))
  assert.equal(page.fragments.length, 15)
  for (const args of [{ query: '' }, { query: '电脑', k: 21 }, { query: '电脑', k: 1.5 }, { userId: ' ', query: '电脑' }]) {
    assert.equal((await client.callTool({ name: 'memory_search_fragments', arguments: { userId: 'recall-test-alice', ...args } })).isError, true)
  }
  for (const args of [{ page: 0 }, { limit: 501 }, { includeShadow: 'false' }]) {
    assert.equal((await client.callTool({ name: 'memory_list_fragments', arguments: { userId: 'recall-test-alice', ...args } })).isError, true)
  }
})

await test('HTTP, remote MCP and stdio can retrieve persisted old memories after restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'twig-recall-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'alice.json'), JSON.stringify(fixture()))
  const env = { ...process.env, MUNINN_DATA_DIR: dir, MUNINN_AUTH_TOKEN: 'test-only', MUNINN_AUTO_REFLECT: '0', SF_API_KEY: '', SILICONFLOW_API_KEY: '', MUNINN_API_KEY: '', KIMI_API_KEY: '', MOONSHOT_API_KEY: '' }
  const portServer = createServer()
  portServer.listen(0, '127.0.0.1')
  await once(portServer, 'listening')
  const port = (portServer.address() as { port: number }).port
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/http.ts'], { cwd: resolve('.'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  const stopped = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null) child.kill(); await stopped })
  let logs = ''
  child.stderr.on('data', (data) => { logs += data })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP startup timeout: ${logs}`)), 15_000)
    child.stdout.on('data', (data) => { if (String(data).includes('HTTP ready')) { clearTimeout(timer); resolve() } })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`HTTP exit ${code}: ${logs}`)) })
  })
  const base = `http://127.0.0.1:${port}`
  const get = (path: string) => fetch(base + path, { headers: { Authorization: 'Bearer test-only' } })
  assert.equal((await fetch(base + '/v1/search?userId=alice&q=ThinkPad')).status, 401)
  assert.equal((await (await get('/v1/search?userId=alice&q=ThinkPad')).json()).hits[0].id, 'f153')
  assert.deepEqual((await (await get('/v1/search?userId=bob&q=ThinkPad')).json()).hits, [])
  assert.equal((await (await get('/v1/fragments?userId=alice&page=2')).json()).fragments.length, 15)
  assert.equal((await (await get('/v1/fragments?userId=alice&includeShadow=false')).json()).totalFragments, 65)
  assert.equal((await (await get('/v1/fragments?userId=alice&includeShadow=true')).json()).totalFragments, 66)
  for (const path of ['/v1/search?userId=alice&q=', '/v1/search?q=ThinkPad', '/v1/search?userId=alice&q=ThinkPad&k=Infinity', '/v1/search?userId=alice&q=ThinkPad&k=21', '/v1/fragments?userId=alice&page=-1', '/v1/fragments?userId=alice&limit=1.5', '/v1/fragments?userId=alice&includeShadow=garbage']) {
    assert.equal((await get(path)).status, 400, path)
  }
  const remote = new Client({ name: 'remote-test', version: '1' })
  await remote.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer test-only' } } }))
  try {
    const result = decode(await remote.callTool({ name: 'memory_search_fragments', arguments: { userId: 'alice', query: '电脑' } }))
    assert.equal(result.hits[0].id, 'f153')
    await remote.callTool({ name: 'memory_correct_fragment', arguments: { userId: 'alice', fragmentId: 'f153', note: '最后购买的是 Framework。' } })
    assert.equal(decode(await remote.callTool({ name: 'memory_search_fragments', arguments: { userId: 'alice', query: 'Framework' } })).hits[0].id, 'f153')
  } finally { await remote.close() }
  child.kill()
  await stopped
  const persisted = JSON.parse(await readFile(join(dir, 'alice.json'), 'utf8'))
  assert.match(persisted.fragments.find((f: { id: string }) => f.id === 'f153').body, /ThinkPad T14/)
  const stdio = new Client({ name: 'stdio-test', version: '1' })
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'server/mcp.ts'], cwd: resolve('.'), env: env as Record<string, string>, stderr: 'pipe' }))
  try {
    const recalled = decode(await stdio.callTool({ name: 'memory_search_fragments', arguments: { userId: 'alice', query: 'Framework' } }))
    assert.equal(recalled.hits[0].id, 'f153')
    assert.match(recalled.hits[0].body, /本人修正：最后购买的是 Framework/)
  } finally { await stdio.close() }
})

await test('embedding transport uses disk cache, honors abort and keeps stdout clean', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'twig-embed-'))
  const oldKey = process.env.SF_API_KEY, oldCache = process.env.MUNINN_EMBED_CACHE
  process.env.SF_API_KEY = 'test-key'
  process.env.MUNINN_EMBED_CACHE = join(dir, 'cache.json')
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  let calls = 0, stdoutCalls = 0
  console.log = () => { stdoutCalls++ }
  globalThis.fetch = async (_input, init) => {
    calls++
    const input = JSON.parse(init!.body as string).input as string[]
    return new Response(JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 0] })) }), { status: 200 })
  }
  t.after(async () => {
    globalThis.fetch = originalFetch; console.log = originalLog
    if (oldKey === undefined) delete process.env.SF_API_KEY; else process.env.SF_API_KEY = oldKey
    if (oldCache === undefined) delete process.env.MUNINN_EMBED_CACHE; else process.env.MUNINN_EMBED_CACHE = oldCache
    await rm(dir, { recursive: true, force: true })
  })
  const texts = ['runtime cache fixture', 'runtime cache question']
  await embedTexts(texts, undefined, { maxRetries: 0 })
  await embedTexts(texts, undefined, { maxRetries: 0 })
  assert.equal(calls, 1)
  assert.equal(stdoutCalls, 0)
  assert.equal(Object.keys(JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8'))).length, 2)
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  await assert.rejects(embedTexts(['timeout fixture'], undefined, { signal: AbortSignal.timeout(10), maxRetries: 0 }), /aborted/)
})
