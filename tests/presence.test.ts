import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { _resetState, _setStateForTest, getPresenceState, queueEvent, flushQueue, getPresenceDiagnostics } from '../index.js'

// Helper to mock fetch globally
function mockFetchOnce(data: unknown, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => data,
  } as Response)
}
function poseResponse(persons: Array<{ confidence: number; zone?: string }>, source = 'esp32') {
  return { timestamp: Date.now() / 1000, source, total_persons: persons.length, persons: persons.map((p, i) => ({ id: i + 1, ...p })) }
}

// Registers the plugin against a mock API; exposes the heartbeat hook and RPC callers
async function registerPlugin(pluginConfig: Record<string, unknown> = {}) {
  const { default: plugin } = await import('../index.js')
  const methods = new Map<string, (opts: any) => unknown>()
  const api: any = {
    pluginConfig: { pollIntervalMs: 0, ...pluginConfig },
    logger: { info: vi.fn(), warn: vi.fn() },
    on: vi.fn(),
    registerGatewayMethod: vi.fn((name: string, handler: (opts: any) => unknown) => methods.set(name, handler)),
  }
  plugin.register(api)
  const hook = api.on.mock.calls[0][1] as () => Promise<{ prependContext?: string } | undefined>
  // Step past the poll throttle (min 1s) so every call actually polls
  const heartbeat = () => {
    vi.setSystemTime(Date.now() + 1_000)
    return hook()
  }
  async function rpc(name: string, params: Record<string, unknown> = {}) {
    const respond = vi.fn()
    await methods.get(name)!({ params, respond })
    const [ok, payload, error] = respond.mock.calls[0]
    return { ok, payload, error, calls: respond.mock.calls.length }
  }
  return { api, heartbeat, rpc }
}
function mockFetchFail() {
  global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response)
}
function mockFetchReject() {
  global.fetch = vi.fn().mockRejectedValue(new Error('network'))
}

describe('ruview-presence', () => {
  beforeEach(() => {
    _resetState()
    vi.restoreAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('getPresenceState returns defaults', () => {
    const s = getPresenceState()
    expect(s.state).toBe('present')
    expect(s.queuedEvents).toBe(0)
    expect(s.detectedPersons).toBe(0)
  })

  it('queueEvent only queues when away', () => {
    // present => not queued
    expect(queueEvent({ type: 'message', summary: 'hi' })).toBe(false)
    expect(getPresenceState().queuedEvents).toBe(0)

    // away => queued
    _setStateForTest({ currentState: 'away' })
    expect(queueEvent({ type: 'message', summary: 'hi', channel: 'test' })).toBe(true)
    expect(getPresenceState().queuedEvents).toBe(1)
  })

  it('queue caps at max size and drops oldest non-urgent', () => {
    _setStateForTest({ currentState: 'away' })
    for (let i = 0; i < 150; i++) {
      queueEvent({ type: 'message', summary: `msg ${i}` })
    }
    expect(getPresenceState().queuedEvents).toBe(100)
  })

  it('flushQueue returns and clears', () => {
    _setStateForTest({ currentState: 'away' })
    queueEvent({ type: 'message', summary: 'a' })
    queueEvent({ type: 'task', summary: 'b' })
    const flushed = flushQueue()
    expect(flushed).toHaveLength(2)
    expect(getPresenceState().queuedEvents).toBe(0)
  })

  it('getPresenceDiagnostics exposes isLive', () => {
    let d = getPresenceDiagnostics()
    expect(d.isLive).toBe(false)
    // simulate live source would need internal lastSource — we test via _resetState then direct check
    // isLive false for simulated
  })

  it('fetch auth: calls with Bearer header when apiKey set (integration via register)', async () => {
    // This is a smoke test that fetchJson builds headers — we test via direct fetch mock
    const headers: Record<string, string> = {}
    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      Object.assign(headers, (opts as { headers: Record<string, string> }).headers)
      return { ok: true, json: async () => ({ persons: [], total_persons: 0, source: 'simulate', timestamp: Date.now()/1000 }) } as Response
    })
    // We can't easily call checkPresence directly (not exported), but we can verify plugin register handles auth
    // Instead verify headers logic via manual call
    const { default: plugin } = await import('../index.js')
    const mockApi: any = {
      pluginConfig: { ruviewUrl: 'http://localhost:3001', apiKey: 'secret123', pollIntervalMs: 10000 },
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn((event: string, cb: () => Promise<void>) => { /* store cb */ }),
      registerGatewayMethod: vi.fn(),
    }
    plugin.register(mockApi)
    const handler = mockApi.on.mock.calls[0][1]
    await handler()
    expect(global.fetch).toHaveBeenCalled()
    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const opts = call[1] as RequestInit
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer secret123')
  })

  it('unreachable keeps state (does not transition to away)', async () => {
    mockFetchFail()
    const { default: plugin } = await import('../index.js')
    _resetState()
    // need fresh register to reset poll throttle
    const mockApi: any = {
      pluginConfig: { ruviewUrl: 'http://badhost:9999', pollIntervalMs: 0 },
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn(),
      registerGatewayMethod: vi.fn(),
    }
    plugin.register(mockApi)
    const cb = mockApi.on.mock.calls[0][1]
    await cb()
    // state should remain present, not away
    expect(getPresenceState().state).toBe('present')
    expect(getPresenceDiagnostics().consecutiveErrors).toBe(1)
  })

  it('gateway methods reply via respond() with read/write scopes', async () => {
    const { api, rpc } = await registerPlugin()
    const scopes = Object.fromEntries(api.registerGatewayMethod.mock.calls.map((c: any[]) => [c[0], c[2]?.scope]))
    expect(scopes).toEqual({
      'ruview.presence': 'operator.read',
      'ruview.diagnostics': 'operator.read',
      'ruview.health': 'operator.read',
      'ruview.queueEvent': 'operator.write',
    })

    const presence = await rpc('ruview.presence')
    expect(presence.ok).toBe(true)
    expect(presence.payload.state).toBe('present')
    expect(presence.calls).toBe(1)
  })

  it('ruview.queueEvent reads the event from params and validates it', async () => {
    const { rpc } = await registerPlugin()
    _setStateForTest({ currentState: 'away' })

    const ok = await rpc('ruview.queueEvent', { type: 'message', summary: 'build finished', channel: 'slack' })
    expect(ok).toMatchObject({ ok: true, payload: { queued: true, total: 1 } })

    const bad = await rpc('ruview.queueEvent', { type: 'spam', summary: 'x' })
    expect(bad.ok).toBe(false)
    expect(bad.error.code).toBe('INVALID_REQUEST')

    const empty = await rpc('ruview.queueEvent', { type: 'message', summary: '  ' })
    expect(empty.ok).toBe(false)
    expect(getPresenceState().queuedEvents).toBe(1)
  })

  it('ruview.health reports UNAVAILABLE when RuView is down', async () => {
    const { rpc } = await registerPlugin()
    mockFetchReject()
    const res = await rpc('ruview.health')
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('UNAVAILABLE')
  })

  it('honors maxQueueSize from config', async () => {
    await registerPlugin({ maxQueueSize: 5 })
    _setStateForTest({ currentState: 'away' })
    for (let i = 0; i < 20; i++) queueEvent({ type: 'message', summary: `msg ${i}` })
    expect(getPresenceState().queuedEvents).toBe(5)
    expect(flushQueue().map((e) => e.summary)).toEqual(['msg 15', 'msg 16', 'msg 17', 'msg 18', 'msg 19'])
  })

  it('urgent events are delivered immediately but recorded for the digest', () => {
    _setStateForTest({ currentState: 'away' })
    expect(queueEvent({ type: 'message', summary: 'server down', priority: 'urgent' })).toBe(false)
    expect(getPresenceState().queuedEvents).toBe(1)
  })

  it('goes away after debounce and injects a digest on return', async () => {
    const { heartbeat } = await registerPlugin({ debounceCount: 2 })

    mockFetchOnce(poseResponse([]))
    await heartbeat()
    expect(getPresenceState().state).toBe('present')
    await heartbeat()
    expect(getPresenceState().state).toBe('away')

    queueEvent({ type: 'message', summary: 'PR #12 approved', channel: 'github' })
    queueEvent({ type: 'message', summary: 'prod alert', priority: 'urgent' })

    mockFetchOnce(poseResponse([{ confidence: 0.9, zone: 'office' }]))
    const result = await heartbeat()
    expect(result?.prependContext).toContain('Welcome back!')
    expect(result?.prependContext).toContain('PR #12 approved')
    expect(result?.prependContext).toContain('1 urgent item(s) were sent immediately')
    expect(result?.prependContext).toContain('- 1 message(s) queued (github: 1)')
    expect(result?.prependContext).not.toContain('prod alert')
    expect(getPresenceState()).toMatchObject({ state: 'present', queuedEvents: 0, zone: 'office' })
  })

  it('clears the queue on return even when the digest is disabled', async () => {
    const { heartbeat } = await registerPlugin({ enableDigest: false, debounceCount: 1 })
    mockFetchOnce(poseResponse([]))
    await heartbeat()
    queueEvent({ type: 'task', summary: 'done' })

    mockFetchOnce(poseResponse([{ confidence: 0.9 }]))
    expect(await heartbeat()).toBeUndefined()
    expect(getPresenceState().queuedEvents).toBe(0)
  })

  it('ignores low-confidence detections', async () => {
    const { heartbeat } = await registerPlugin({ debounceCount: 1, confidenceThreshold: 0.5 })
    mockFetchOnce(poseResponse([{ confidence: 0.2 }]))
    await heartbeat()
    expect(getPresenceState().state).toBe('away')
  })

  it('stores zone summary when zone awareness is enabled', async () => {
    const { heartbeat } = await registerPlugin({ enableZoneAwareness: true })
    global.fetch = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/zones/summary')
        ? { zones: { office: { person_count: 1, status: 'monitored' } } }
        : poseResponse([{ confidence: 0.9, zone: 'office' }]),
    }))
    await heartbeat()
    expect(getPresenceState().zones).toEqual({ office: { person_count: 1, status: 'monitored' } })

    // An empty read still refreshes zones, so they don't keep showing the old occupant
    global.fetch = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/zones/summary')
        ? { zones: { office: { person_count: 0, status: 'clear' } } }
        : poseResponse([]),
    }))
    await heartbeat()
    expect(getPresenceState().zones).toEqual({ office: { person_count: 0, status: 'clear' } })
  })

  it('reports data age and warns once when RuView data is stale', async () => {
    const { api, heartbeat } = await registerPlugin()
    mockFetchOnce({ ...poseResponse([{ confidence: 0.9 }]), timestamp: Date.now() / 1000 - 120 })
    await heartbeat()
    await heartbeat()
    expect(getPresenceDiagnostics().lastDataAgeMs).toBeGreaterThan(100_000)
    const staleWarnings = api.logger.warn.mock.calls.filter((c: string[]) => c[0].includes('stale'))
    expect(staleWarnings).toHaveLength(1)
  })
})
