/**
 * Update-check engine.
 *
 * Three jobs, all deliberately dependency-free (node builtins only) so this
 * plugin cannot break the host by failing to resolve something:
 *
 *   1. discover the installed skills (the same `<root>/<name>/SKILL.md` shape
 *      the harness itself discovers);
 *   2. resolve an *update source* per skill — either the skill directory is
 *      itself a git checkout, or the user's config maps a checkout / upstream
 *      onto a set of skills;
 *   3. run the checks and cache them, because the hot path (a skill being used)
 *      must never wait on the network.
 *
 * @module src/engine.js
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** How often a source may be re-checked over the network. */
export const DEFAULT_INTERVAL_HOURS = 6
/** Ceiling for one network git call. The hot path never waits on these. */
const GIT_TIMEOUT_MS = 20_000
/** Local git reads are cheap; a hung one is still a bug, not a slow network. */
const GIT_LOCAL_TIMEOUT_MS = 8_000

/** Harness home. Mirrors `resolveDshHome()`'s default without importing it. */
export function dshHome() {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}
/** Cross-agent skills home, which the harness also scans. */
export function agentsHome() {
  return resolve(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
}
/** This plugin's own state directory. */
export function dataDir() {
  return join(dshHome(), 'skill-updates')
}
export const configPath = () => join(dataDir(), 'config.json')
export const statePath = () => join(dataDir(), 'state.json')

/** User-level skill roots, in the harness's own precedence order. */
export function skillRoots() {
  return [
    { id: 'dsh', path: join(dshHome(), 'skills') },
    { id: 'agents', path: join(agentsHome(), 'skills') },
  ]
}

/**
 * Every installed skill under the user-level roots.
 * Only `<dir>/SKILL.md` entries count, exactly as the harness discovers them.
 */
export function discoverSkills() {
  const found = []
  for (const root of skillRoots()) {
    let entries
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const dir = join(root.path, entry.name)
      if (!existsSync(join(dir, 'SKILL.md'))) continue
      found.push({ name: entry.name, dir, root: root.id })
    }
  }
  return found
}

/** The config a fresh install starts from: every switch off, sources pre-wired. */
export function defaultConfig() {
  return {
    checkIntervalHours: DEFAULT_INTERVAL_HOURS,
    /** skill name -> true. Absent means off. */
    skills: {},
    sources: [
      {
        id: 'ai-berkshire',
        label: 'AI Berkshire (xbtlin/ai-berkshire)',
        kind: 'git',
        dir: join(dshHome(), 'ai-berkshire'),
        // The 22 Agent Skills are copies of this checkout's codex-skills/*.
        skillsFrom: join(dshHome(), 'ai-berkshire', 'codex-skills'),
        note: '更新后需要把 codex-skills\\* 重新复制到技能目录。',
      },
      {
        id: 'book-to-skill',
        label: 'book-to-skill (virgiliojr94)',
        kind: 'git-tags',
        upstream: 'https://github.com/virgiliojr94/book-to-skill',
        versionFile: join(dshHome(), 'skills', 'book-to-skill', 'pyproject.toml'),
        skills: ['book-to-skill'],
        note: '本地是文件副本；用上游新版本覆盖技能目录。',
      },
    ],
  }
}

function readJson(path, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  try {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

/** Load the config, materializing the defaults on first run. */
export function loadConfig() {
  const existing = readJson(configPath(), null)
  if (existing === null) {
    const fresh = defaultConfig()
    writeJson(configPath(), fresh)
    return fresh
  }
  return {
    checkIntervalHours: Number.isFinite(existing.checkIntervalHours) ? existing.checkIntervalHours : DEFAULT_INTERVAL_HOURS,
    skills: existing.skills !== null && typeof existing.skills === 'object' ? existing.skills : {},
    sources: Array.isArray(existing.sources) ? existing.sources : [],
  }
}

export function saveConfig(config) {
  return writeJson(configPath(), config)
}

export function loadState() {
  const state = readJson(statePath(), {})
  return {
    checkedAt: Number.isFinite(state.checkedAt) ? state.checkedAt : 0,
    results: state.results !== null && typeof state.results === 'object' ? state.results : {},
  }
}

export function saveState(state) {
  return writeJson(statePath(), state)
}

/** Skill names a raw source covers: an explicit list plus any `skillsFrom` directory. */
function coveredSkills(raw, installed) {
  const names = new Set(Array.isArray(raw.skills) ? raw.skills.filter((n) => typeof n === 'string') : [])
  if (typeof raw.skillsFrom === 'string') {
    try {
      for (const entry of readdirSync(raw.skillsFrom, { withFileTypes: true })) if (entry.isDirectory()) names.add(entry.name)
    } catch {
      /* the checkout is gone; the source reports itself as missing instead */
    }
  }
  const known = new Set(installed.map((s) => s.name))
  return [...names].filter((n) => known.has(n))
}

/**
 * The effective source list: configured sources first, then any installed skill
 * whose own directory is a git checkout (so "clone a skill into the skills root"
 * needs no configuration at all).
 */
export function activeSources(config, installed) {
  const sources = []
  for (const raw of config.sources) {
    if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') continue
    sources.push({
      id: raw.id,
      label: typeof raw.label === 'string' ? raw.label : raw.id,
      kind: raw.kind === 'git-tags' ? 'git-tags' : 'git',
      dir: typeof raw.dir === 'string' ? raw.dir : undefined,
      upstream: typeof raw.upstream === 'string' ? raw.upstream : undefined,
      versionFile: typeof raw.versionFile === 'string' ? raw.versionFile : undefined,
      note: typeof raw.note === 'string' ? raw.note : undefined,
      skills: coveredSkills(raw, installed),
      configured: true,
    })
  }
  const covered = new Set(sources.flatMap((s) => s.skills))
  for (const skill of installed) {
    if (covered.has(skill.name)) continue
    if (!existsSync(join(skill.dir, '.git'))) continue
    sources.push({
      id: skill.name,
      label: `${skill.name}（技能目录本身就是 git 检出）`,
      kind: 'git',
      dir: skill.dir,
      note: undefined,
      skills: [skill.name],
      configured: false,
    })
  }
  for (const source of sources) {
    if (source.kind === 'git') source.target = source.dir ?? ''
    else source.target = source.upstream ?? ''
  }
  return sources
}

/** Run git synchronously with a hard timeout. Never throws. */
function git(args, timeout) {
  try {
    const result = spawnSync('git', args, {
      timeout,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error !== undefined && result.error !== null) return { ok: false, error: String(result.error.message ?? result.error) }
    if (result.status !== 0) {
      const err = String(result.stderr ?? '').trim().split('\n').slice(-1)[0] ?? ''
      return { ok: false, error: err === '' ? `git exited ${String(result.status)}` : err }
    }
    return { ok: true, out: String(result.stdout ?? '').trim() }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** Compare dotted numeric versions; non-numeric segments compare as strings. */
function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/)
  const pb = String(b).split(/[.+-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0)
    const nb = Number(pb[i] ?? 0)
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb
    } else {
      const sa = String(pa[i] ?? '')
      const sb = String(pb[i] ?? '')
      if (sa !== sb) return sa < sb ? -1 : 1
    }
  }
  return 0
}

/** The local version a `git-tags` source compares against. */
function readVersionFile(path) {
  try {
    const text = readFileSync(path, 'utf8')
    const quoted = /^\s*version\s*[:=]\s*["']([^"']+)["']/m.exec(text)
    if (quoted !== null) return quoted[1]
    const bare = /^\s*version\s*[:=]\s*([^\s#]+)/m.exec(text)
    if (bare !== null) return bare[1].trim()
    const json = JSON.parse(text)
    if (typeof json.version === 'string') return json.version
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Check one source. Never throws; a failure is a result, not an exception, so a
 * missing checkout or an offline machine degrades to "unknown" instead of
 * breaking either the settings page or the agent's turn.
 */
export function checkSource(source) {
  if (source.kind === 'git') {
    const dir = source.dir
    if (typeof dir !== 'string' || dir === '') return { ok: false, detail: '未配置目录' }
    if (!existsSync(join(dir, '.git'))) return { ok: false, detail: `不是 git 检出：${dir}` }
    const local = git(['-C', dir, 'rev-parse', 'HEAD'], GIT_LOCAL_TIMEOUT_MS)
    if (!local.ok) return { ok: false, detail: `读取本地版本失败：${local.error}` }
    const remote = git(['-C', dir, 'ls-remote', 'origin', 'HEAD'], GIT_TIMEOUT_MS)
    if (!remote.ok) return { ok: false, detail: `查询远端失败：${remote.error}`, local: local.out.slice(0, 10) }
    const head = remote.out.split(/\s+/)[0] ?? ''
    if (head === '') return { ok: false, detail: '远端没有返回 HEAD', local: local.out.slice(0, 10) }
    return {
      ok: true,
      behind: head !== local.out,
      local: local.out.slice(0, 10),
      remote: head.slice(0, 10),
      detail: head === local.out ? '已是最新' : '落后于远端',
    }
  }

  if (source.kind === 'git-tags') {
    if (typeof source.upstream !== 'string' || source.upstream === '') return { ok: false, detail: '未配置上游地址' }
    const localVersion = typeof source.versionFile === 'string' ? readVersionFile(source.versionFile) : undefined
    const remote = git(['ls-remote', '--tags', '--refs', source.upstream], GIT_TIMEOUT_MS)
    if (!remote.ok) return { ok: false, detail: `查询上游标签失败：${remote.error}`, local: localVersion }
    const tags = remote.out
      .split('\n')
      .map((line) => line.split('refs/tags/')[1])
      .filter((tag) => typeof tag === 'string' && tag !== '')
      .map((tag) => tag.replace(/^v/, ''))
    if (tags.length === 0) return { ok: false, detail: '上游没有版本标签', local: localVersion }
    const latest = tags.sort(compareVersions).slice(-1)[0]
    if (localVersion === undefined) return { ok: false, detail: '读不到本地版本', remote: latest }
    return {
      ok: true,
      behind: compareVersions(latest, localVersion) > 0,
      local: localVersion,
      remote: latest,
      detail: compareVersions(latest, localVersion) > 0 ? '上游有新版本' : '已是最新',
    }
  }

  return { ok: false, detail: `未知来源类型：${String(source.kind)}` }
}

/**
 * Re-check every source and persist the result. `only` restricts the round to
 * one source id (used by the per-row refresh in the settings page).
 */
export function refresh(config, installed, { only } = {}) {
  const state = loadState()
  const sources = activeSources(config, installed)
  const results = { ...state.results }
  for (const source of sources) {
    if (only !== undefined && source.id !== only) continue
    results[source.id] = { ...checkSource(source), at: Date.now() }
  }
  const next = { checkedAt: Date.now(), results }
  saveState(next)
  return next
}

/** Whether the cache is older than the configured interval. */
export function isStale(state, intervalHours) {
  const hours = Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : DEFAULT_INTERVAL_HOURS
  return Date.now() - state.checkedAt > hours * 3_600_000
}

/**
 * One source's staleness for one skill, plus the exact command that fixes it.
 * Returns undefined when the skill has no source, its switch is off, the cache
 * says it is current, or the last check failed.
 */
export function pendingUpdateFor(skillName, config, installed) {
  if (config.skills?.[skillName] !== true) return undefined
  const source = activeSources(config, installed).find((s) => s.skills.includes(skillName))
  if (source === undefined) return undefined
  const result = loadState().results[source.id]
  if (result === undefined || result.ok !== true || result.behind !== true) return undefined
  return {
    sourceId: source.id,
    label: source.label,
    note: source.note,
    local: result.local,
    remote: result.remote,
    command:
      source.kind === 'git'
        ? `git -C "${source.dir}" pull --ff-only`
        : `从 ${String(source.upstream)} 取新版本覆盖技能目录`,
  }
}

/** The whole picture for the settings page. */
export function snapshot(config, installed) {
  const state = loadState()
  const sources = activeSources(config, installed)
  return {
    checkedAt: state.checkedAt,
    intervalHours: Number.isFinite(config.checkIntervalHours) ? config.checkIntervalHours : DEFAULT_INTERVAL_HOURS,
    stale: isStale(state, config.checkIntervalHours),
    skills: installed.map((skill) => {
      const source = sources.find((s) => s.skills.includes(skill.name))
      const result = source === undefined ? undefined : state.results[source.id]
      return {
        name: skill.name,
        enabled: config.skills?.[skill.name] === true,
        source: source === undefined ? null : { id: source.id, label: source.label, kind: source.kind, target: source.target },
        result: result === undefined ? null : { ...result, at: result.at ?? 0 },
      }
    }),
    sources: sources.map((source) => ({
      id: source.id,
      label: source.label,
      kind: source.kind,
      target: source.target,
      note: source.note ?? null,
      configured: source.configured,
      skills: source.skills,
    })),
  }
}
