import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { _resetState, _setStateForTest, getPresenceState, queueEvent, flushQueue, getPresenceDiagnostics } from '../index.js'

// Helper to mock fetch globally
function mockFetchOnce(data: unknown, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => data,
  } as Response)
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
  })
  afterEach(() => vi.restoreAllMocks())

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
})
