/**
 * Failover web search: try the configured backends in priority order and fall
 * back to the next one when a backend throws or returns no sources.
 *
 * A backend is either a Messages model (the original shape: `model` plus the
 * endpoint and credential it uses) or a delegation to a provider already
 * registered on the web seam (`provider: <id>`). Delegation is what lets a
 * client-side provider such as the stock `deepseek-search-api` sit at the head
 * of the chain without copying its implementation here.
 * @module dsh-web-search-failover
 */
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { WebError } from '@deepseek-ai/dsh-web'
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-failover'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * One search backend, in one of two shapes:
 *
 * - `provider`: id of a provider registered on the web seam (`ctx.web`); this
 *   backend delegates to it, client-side or not.
 * - `model` + `baseURL` + `apiKeyEnv`: a Messages model searched through the
 *   server-side `web_search` tool, as in earlier versions.
 *
 * Exactly one shape must be used per backend; `apply()` rejects a backend that
 * mixes them or sets neither.
 */
const Backend = z.object({
  provider: z.string(),
  model: z.string(),
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
})

/** Plugin config. `backends` is ordered: index 0 wins, the rest are fallbacks. */
export const Config = z.object({
  providerId: z.string().default('deepseek-failover'),
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
  baseURL: z.string().default('https://api.deepseek.com/anthropic/v1').volatile(),
  apiVersion: z.string().default('2023-06-01').volatile(),
  maxTokens: z.number().step(1).min(1).default(4096).volatile(),
  maxUses: z.number().step(1).min(1).default(5).volatile(),
  backends: z.array(Backend),
})

/**
 * Run one search down the backend list. A backend that throws is skipped; an
 * empty successful result is remembered but still allows a later backend to
 * answer. Aborts propagate immediately instead of trying the next backend.
 * @param entries - ordered backends with their providers.
 * @param request - the caller's search request.
 * @param signal - optional cancellation signal.
 * @returns the first non-empty result, else the last empty successful result.
 * @throws when every backend failed.
 */
export async function searchWithFailover(entries, request, signal) {
  let lastError
  let emptyResult
  for (const entry of entries) {
    if (!entry.provider.available()) {
      lastError ??= new WebError(`search backend ${entry.label} is unavailable`, 'WEB_PROVIDER_UNAVAILABLE')
      continue
    }
    try {
      const result = await entry.provider.search(request, signal)
      if (result.sources.length > 0) return result
      emptyResult = result
    } catch (error) {
      if (error?.code === 'WEB_ABORTED' || signal?.aborted === true) throw error
      lastError = error
    }
  }
  if (emptyResult !== undefined) return emptyResult
  throw lastError ?? new WebError('no search backend is configured', 'WEB_PROVIDER_UNAVAILABLE')
}

/**
 * Build the provider facade the seam registers.
 * @param id - provider id the seam selects by name.
 * @param entries - ordered backends with their providers.
 * @returns a web search provider that fails over down the backend list.
 */
export function createFailoverProvider(id, entries) {
  return {
    id,
    available: () => entries.some((entry) => entry.provider.available()),
    search: (request, signal) => searchWithFailover(entries, request, signal),
  }
}

/**
 * Look up a search provider registered on the web seam. The registry is read at
 * call time, so the target is allowed to register after this plugin. A seam
 * without that registry (or with one that is not a map) reads as "no target"
 * rather than throwing: a backend we cannot resolve is simply unavailable.
 * @param web - the web seam (`ctx.web`).
 * @param id - provider id to find.
 * @returns the registered provider, or undefined when the seam has no such id.
 */
export function registeredSearchProvider(web, id) {
  const registry = web?.searchProviders
  if (typeof registry?.get !== 'function') return undefined
  return registry.get(id)
}

/**
 * Wrap another registered search provider so it can act as one backend in the
 * failover chain. Availability is re-read on every call, because the target may
 * appear, disappear, or lose its credential between searches.
 * @param getWeb - late accessor for the web seam.
 * @param id - id of the provider to delegate to.
 * @returns a web search provider that forwards to the registered one.
 */
export function createDelegatingProvider(getWeb, id) {
  const resolve = () => registeredSearchProvider(getWeb(), id)
  return {
    id: `delegate:${id}`,
    available: () => resolve()?.available() === true,
    search: async (request, signal) => {
      const target = resolve()
      if (target === undefined) {
        throw new WebError(
          `delegated search provider "${id}" is not registered on the web seam`,
          'WEB_PROVIDER_CONFIGURED_MISSING',
        )
      }
      return target.search(request, signal)
    },
  }
}

/**
 * Project one resolved backend into the options the stock DeepSeek provider
 * serves its next search with.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the resolved backend values.
 * @returns provider options for one search.
 */
function resolveOptions(ctx, config) {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL,
    model: config.model,
    apiVersion: config.apiVersion,
    maxTokens: config.maxTokens,
    maxUses: config.maxUses,
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append('web/deepseek-search-llm-request', request)
    },
  }
}

/**
 * Turn one config entry into a chain entry: a delegating provider when the
 * entry names another provider, else a Messages-model provider.
 * @param ctx - plugin context with the web seam mounted.
 * @param config - the plugin config.
 * @param backend - one entry of `backends`.
 * @returns the labelled provider entry the chain iterates over.
 * @throws when the entry mixes both shapes or sets neither.
 */
function resolveEntry(ctx, config, backend) {
  const delegateId = backend.provider
  if (delegateId !== undefined && backend.model !== undefined) {
    throw new Error(`web-search-failover: backend "${delegateId}" sets both "provider" and "model"; set exactly one`)
  }
  if (delegateId !== undefined) {
    return {
      label: `provider:${delegateId}`,
      provider: createDelegatingProvider(() => ctx.web, delegateId),
    }
  }
  if (backend.model === undefined) {
    throw new Error('web-search-failover: every backend needs either "provider" or "model"')
  }
  return {
    label: `${backend.model} @ ${backend.baseURL ?? config.baseURL.get()}`,
    provider: new DeepSeekSearchProvider(() => resolveOptions(ctx, {
      apiKey: config.apiKey.get(),
      apiKeyEnv: backend.apiKeyEnv ?? config.apiKeyEnv.get(),
      baseURL: backend.baseURL ?? config.baseURL.get(),
      model: backend.model,
      apiVersion: config.apiVersion.get(),
      maxTokens: config.maxTokens.get(),
      maxUses: config.maxUses.get(),
    })),
  }
}

/**
 * Register the failover provider with `ctx.web`.
 * @param ctx - plugin context with the web seam mounted.
 * @param config - the plugin config.
 */
export function apply(ctx, config) {
  if (config.backends.length === 0) {
    throw new Error('web-search-failover: backends must list at least one backend')
  }
  const entries = config.backends.map((backend) => resolveEntry(ctx, config, backend))
  ctx.web.registerSearchProvider(createFailoverProvider(config.providerId, entries))
}
