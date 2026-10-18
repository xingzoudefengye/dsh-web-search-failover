/**
 * Failover web search: try the configured backends in priority order and fall
 * back to the next one when a backend throws or returns no sources.
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

/** One search backend: a Messages model plus the endpoint and credential it uses. */
const Backend = z.object({
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
 * Register the failover provider with `ctx.web`.
 * @param ctx - plugin context with the web seam mounted.
 * @param config - the plugin config.
 */
export function apply(ctx, config) {
  if (config.backends.length === 0) throw new Error('web-search-failover: backends must list at least one model')
  const entries = config.backends.map((backend) => ({
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
  }))
  ctx.web.registerSearchProvider(createFailoverProvider(config.providerId, entries))
}
