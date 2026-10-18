import assert from 'node:assert/strict'
import test from 'node:test'
import { searchWithFailover } from '../lib/index.js'

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
