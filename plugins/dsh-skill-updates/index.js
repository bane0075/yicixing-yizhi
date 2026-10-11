/**
 * dsh-skill-updates — host half.
 *
 * One switch per installed skill. When a switch is on, *using* that skill first
 * checks whether its upstream has moved and tells the agent, in-conversation,
 * when it is behind. Nothing is auto-installed: the plugin reports and hands
 * over the exact command.
 *
 * Three surfaces:
 *   1. the `tools/post-execute` seam for the `skill` tool — the hot path. It
 *      reads the cache only, so it never makes a skill call wait on the network;
 *      a stale cache schedules a background refresh instead.
 *   2. a periodic refresh so the settings page is current without being opened.
 *   3. the settings page's own `/api/skill-updates/*` routes, behind the same
 *      request fence the kernel applies to `/api`.
 *
 * Why per-skill rather than per-file: the switch lives next to the thing the
 * user thinks about (a skill). A new skill that needs tracking is either a git
 * checkout dropped into the skills root — discovered automatically — or one
 * entry in `<DSH_HOME>/skill-updates/config.json`.
 *
 * @module index.js
 */
import { contextMessage } from './adapter/kernel.js'
import { activeSources, discoverSkills, isStale, loadConfig, loadState, pendingUpdateFor, refresh, saveConfig, snapshot } from './src/engine.js'
import { rejectionFor } from './src/trust.js'

export const name = 'skill-updates'

/** No required service: `webServer` is reached through `ctx.inject` below. */
export const inject = []

/** The most a settings request body may weigh. */
const MAX_API_BODY_BYTES = 1024 * 1024
/** Delay before the first refresh so a network round never delays app startup. */
const FIRST_REFRESH_DELAY_MS = 5_000
/** How often the periodic refresh re-reads the interval from config. */
const PERIODIC_TICK_MS = 15 * 60 * 1000

/** The text the agent sees when a skill it is using has a pending upstream update. */
function renderNotice(pending) {
  const lines = [
    `[skill-updates] 「${pending.label}」有上游更新：本地 ${pending.local} → 远端 ${pending.remote}。`,
    `更新命令：${pending.command}`,
  ]
  if (typeof pending.note === 'string' && pending.note !== '') lines.push(pending.note)
  lines.push('（由 skill-updates 插件的「技能更新」开关触发；如暂不更新，忽略本条即可。）')
  return lines.join('\n')
}

/**
 * Mount the plugin.
 * @param {object} ctx - the plugin context
 */
export function apply(ctx) {
  const logger = ctx.logger
  const warn = (message) => {
    try {
      logger?.warn?.(`skill-updates: ${message}`)
    } catch {
      /* a logger that throws must not take the host down */
    }
  }
  /** The `connection` service, looked up per request: it may not exist yet. */
  const connectionFor = () => ctx.get('connection')

  /** Re-read everything on demand: skill roots and the config are both live state. */
  const current = () => {
    const config = loadConfig()
    return { config, installed: discoverSkills() }
  }

  /** Run a refresh, swallowing every failure: a check must never break a turn. */
  const refreshQuietly = (only) => {
    try {
      return refresh(loadConfig(), discoverSkills(), only === undefined ? {} : { only })
    } catch (error) {
      warn(`refresh failed (${String(error?.message ?? error)})`)
      return undefined
    }
  }

  // ── 1. the hot path: a skill is being used ──────────────────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    try {
      if (exec?.name !== 'skill') return downstream
      const skillName = exec.arguments?.name
      if (typeof skillName !== 'string' || skillName === '') return downstream
      const { config, installed } = current()
      const pending = pendingUpdateFor(skillName, config, installed)
      // Keep the cache warm without ever making the caller wait on the network.
      if (isStale(loadState(), config.checkIntervalHours)) {
        setTimeout(() => refreshQuietly(), 0).unref?.()
      }
      if (pending === undefined) return downstream
      const message = await contextMessage(renderNotice(pending))
      return { ...downstream, additionalContexts: [message, ...(downstream?.additionalContexts ?? [])] }
    } catch (error) {
      warn(`skill check failed (${String(error?.message ?? error)})`)
      return downstream
    }
  })

  // ── 2. keep the cache warm ──────────────────────────────────────────────
  ctx.effect(() => {
    let lastRun = 0
    const tick = () => {
      const { config } = current()
      const intervalMs = Math.max(1, config.checkIntervalHours) * 3_600_000
      if (Date.now() - lastRun < intervalMs) return
      lastRun = Date.now()
      refreshQuietly()
    }
    const first = setTimeout(tick, FIRST_REFRESH_DELAY_MS)
    const timer = setInterval(tick, PERIODIC_TICK_MS)
    first.unref?.()
    timer.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, 'skill-updates: refresh timer')

  // ── 3. the settings page's HTTP surface ─────────────────────────────────
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: '/api/skill-updates', handler: createApiRoutes({ connectionFor, current, refreshQuietly, warn }) }),
      'skill-updates: api routes',
    )
  })
}

/** Read and parse one JSON request body, refusing oversized and non-JSON bodies. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_API_BODY_BYTES) {
      const error = new Error('request body too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    const failure = new Error(`invalid JSON body (${error?.message ?? error})`)
    failure.status = 400
    throw failure
  }
}

/**
 * The `/api/skill-updates/*` handler.
 *
 * Every route runs the trust fence first: this plugin's prefix outranks `/api`
 * in webServer's longest-prefix dispatch, so without the fence these routes
 * would answer callers the application itself refuses.
 */
function createApiRoutes(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/skill-updates/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    const rejection = rejectionFor(req, deps.connectionFor())
    if (rejection !== undefined) return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    try {
      if (method === 'GET' && routePath === '/state') {
        const { config, installed } = deps.current()
        return send(200, snapshot(config, installed))
      }
      if (method === 'POST' && routePath === '/toggle') {
        const body = await readJson(req)
        const skill = typeof body?.name === 'string' ? body.name : ''
        if (skill === '') return send(400, { error: 'name is required' })
        const { config, installed } = deps.current()
        if (!installed.some((s) => s.name === skill)) return send(404, { error: `unknown skill ${JSON.stringify(skill)}` })
        config.skills = { ...config.skills, [skill]: body.enabled === true }
        saveConfig(config)
        // Turning a switch on with a cold cache should answer immediately, so the
        // first check runs in the background; the page refreshes on demand.
        if (body.enabled === true) setTimeout(() => deps.refreshQuietly(), 0).unref?.()
        return send(200, snapshot(config, installed))
      }
      if (method === 'POST' && routePath === '/check') {
        const body = await readJson(req)
        const only = typeof body?.source === 'string' && body.source !== '' ? body.source : undefined
        deps.refreshQuietly(only)
        const { config, installed } = deps.current()
        return send(200, snapshot(config, installed))
      }
      if (method === 'GET' && routePath === '/config') {
        return send(200, loadConfig())
      }
      if (method === 'GET' && routePath === '/sources') {
        const { config, installed } = deps.current()
        return send(200, { sources: activeSources(config, installed) })
      }
      return send(404, { error: `no route for ${method} ${routePath}` })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      return send(status, { error: String(error?.message ?? error) })
    }
  }
}
