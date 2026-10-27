import assert from 'node:assert/strict'
import test from 'node:test'
import { createDelegatingProvider, searchWithFailover } from '../lib/index.js'

function provider(results) {
  const state = { calls: 0 }
  return {
    state,
    provider: {
      available: () => true,
      search: async () => {
        state.calls += 1
        const next = results.shift()
        if (next instanceof Error) throw next
        return next
      },
    },
  }
}

const sources = (url) => ({ sources: [{ url }], truncated: false })

test('first backend answers without trying the second', async () => {
  const first = provider([sources('https://a.example')])
  const second = provider([sources('https://b.example')])
  const result = await searchWithFailover([
    { label: 'first', provider: first.provider },
    { label: 'second', provider: second.provider },
  ], { query: 'q' })
  assert.equal(result.sources[0].url, 'https://a.example')
  assert.equal(second.state.calls, 0)
})

test('a failing backend falls through to the next', async () => {
  const first = provider([new Error('upstream 502')])
  const second = provider([sources('https://b.example')])
  const result = await searchWithFailover([
    { label: 'first', provider: first.provider },
    { label: 'second', provider: second.provider },
  ], { query: 'q' })
  assert.equal(result.sources[0].url, 'https://b.example')
  assert.equal(first.state.calls, 1)
})

test('an empty result falls through to the next', async () => {
  const first = provider([{ sources: [], truncated: false }])
  const second = provider([sources('https://b.example')])
  const result = await searchWithFailover([
    { label: 'first', provider: first.provider },
    { label: 'second', provider: second.provider },
  ], { query: 'q' })
  assert.equal(result.sources[0].url, 'https://b.example')
})

test('all-empty backends return the remembered empty result', async () => {
  const first = provider([{ sources: [], truncated: false }])
  const second = provider([{ sources: [], truncated: false }])
  const result = await searchWithFailover([
    { label: 'first', provider: first.provider },
    { label: 'second', provider: second.provider },
  ], { query: 'q' })
  assert.equal(result.sources.length, 0)
})

test('every backend failing throws the last error', async () => {
  const first = provider([new Error('first down')])
  const second = provider([new Error('second down')])
  await assert.rejects(
    searchWithFailover([
      { label: 'first', provider: first.provider },
      { label: 'second', provider: second.provider },
    ], { query: 'q' }),
    /second down/,
  )
})

test('an aborted search does not try the next backend', async () => {
  const aborted = Object.assign(new Error('aborted'), { code: 'WEB_ABORTED' })
  const first = provider([aborted])
  const second = provider([sources('https://b.example')])
  await assert.rejects(
    searchWithFailover([
      { label: 'first', provider: first.provider },
      { label: 'second', provider: second.provider },
    ], { query: 'q' }),
    /aborted/,
  )
  assert.equal(second.state.calls, 0)
})

test('an unavailable backend is skipped', async () => {
  const unavailable = { available: () => false, search: async () => { throw new Error('must not run') } }
  const second = provider([sources('https://b.example')])
  const result = await searchWithFailover([
    { label: 'off', provider: unavailable },
    { label: 'second', provider: second.provider },
  ], { query: 'q' })
  assert.equal(result.sources[0].url, 'https://b.example')
})

/** A web seam stand-in holding one registered provider under `id`. */
function seam(id, target) {
  return { searchProviders: new Map([[id, target]]) }
}

test('a delegating backend forwards the request and the signal', async () => {
  const seen = []
  const target = {
    available: () => true,
    search: async (request, signal) => {
      seen.push({ request, signal })
      return sources('https://api.example')
    },
  }
  const delegate = createDelegatingProvider(() => seam('deepseek-search-api', target), 'deepseek-search-api')
  const signal = new AbortController().signal
  const result = await delegate.search({ query: 'q', maxResults: 3 }, signal)
  assert.equal(result.sources[0].url, 'https://api.example')
  assert.deepEqual(seen[0].request, { query: 'q', maxResults: 3 })
  assert.equal(seen[0].signal, signal)
  assert.equal(delegate.id, 'delegate:deepseek-search-api')
})

test('a delegating backend reports the target availability on every call', async () => {
  let up = false
  const target = { available: () => up, search: async () => sources('https://api.example') }
  const delegate = createDelegatingProvider(() => seam('target', target), 'target')
  assert.equal(delegate.available(), false)
  up = true
  assert.equal(delegate.available(), true)
})

test('a missing delegation target is unavailable and names itself when searched', async () => {
  const delegate = createDelegatingProvider(() => seam('other', { available: () => true }), 'deepseek-search-api')
  assert.equal(delegate.available(), false)
  await assert.rejects(delegate.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_CONFIGURED_MISSING')
    assert.match(error.message, /deepseek-search-api/)
    return true
  })
})

test('a seam without a provider registry reads as no target', async () => {
  for (const web of [undefined, {}, { searchProviders: [] }]) {
    const delegate = createDelegatingProvider(() => web, 'deepseek-search-api')
    assert.equal(delegate.available(), false)
    await assert.rejects(delegate.search({ query: 'q' }), { code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  }
})

test('the seam target may register only after the delegating backend was built', async () => {
  let web
  const delegate = createDelegatingProvider(() => web, 'deepseek-search-api')
  assert.equal(delegate.available(), false)
  web = seam('deepseek-search-api', { available: () => true, search: async () => sources('https://late.example') })
  assert.equal(delegate.available(), true)
  const result = await delegate.search({ query: 'q' })
  assert.equal(result.sources[0].url, 'https://late.example')
})

test('a delegating backend at the head of the chain falls through when its target fails', async () => {
  const broken = {
    available: () => true,
    search: async () => { throw new Error('official api 401') },
  }
  const delegate = createDelegatingProvider(() => seam('deepseek-search-api', broken), 'deepseek-search-api')
  const second = provider([sources('https://gateway.example')])
  const result = await searchWithFailover([
    { label: 'provider:deepseek-search-api', provider: delegate },
    { label: 'messages', provider: second.provider },
  ], { query: 'q' })
  assert.equal(result.sources[0].url, 'https://gateway.example')
  assert.equal(second.state.calls, 1)
})

test('an unregistered delegating backend is skipped, not fatal, in the chain', async () => {
  const delegate = createDelegatingProvider(() => seam(), 'deepseek-search-api')
  const second = provider([sources('https://gateway.example')])
  const result = await searchWithFailover([
    { label: 'provider:deepseek-search-api', provider: delegate },
    { label: 'messages', provider: second.provider },
  ], { query: 'q' })
  assert.equal(result.sources[0].url, 'https://gateway.example')
})
