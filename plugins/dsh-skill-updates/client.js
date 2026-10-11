/**
 * dsh-skill-updates — browser half.
 *
 * Adds one settings section (`settings.section` id `skill-updates`): every
 * installed skill, its update source, its last check result, and one switch.
 * With the switch on, using that skill checks its upstream and tells the agent
 * when it is behind; with it off, the skill is never checked.
 *
 * Data is read over the plugin's own same-origin `/api/skill-updates/*` routes,
 * which the host half serves behind the app's own request fence. Hand-written
 * ModuleLoader bundle: no build step, no dependency beyond the `react` the shell
 * already provides. Colours are inherited and borders are a mid grey so the page
 * survives a light/dark switch without knowing the theme's variable names.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-updates',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const API = '/api/skill-updates'
    const NS = 'settings.skillUpdates'
    const inject = ['slots', 'locale']

    /** Only the navigation label is translated; the page body is Chinese-only. */
    const DICT = {
      zh: { nav: '技能更新' },
      en: { nav: 'Skill updates' },
    }

    /** The section's own translator, resolved from the registered dictionary. */
    function translator(ctx) {
      const locale = ctx.locale
      const tag = (() => {
        try {
          return locale?.preference === 'en' ? 'en' : 'zh'
        } catch {
          return 'zh'
        }
      })()
      return key => DICT[tag]?.[key] ?? DICT.zh[key] ?? key
    }

    /** Same-origin JSON call against this plugin's own routes. */
    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    /** A short, human, local timestamp. */
    function when(at) {
      if (typeof at !== 'number' || at <= 0) return '从未检查'
      const elapsed = Date.now() - at
      if (elapsed < 60_000) return '刚刚'
      if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
      if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
      return new Date(at).toLocaleString()
    }

    const cell = { padding: '7px 10px', borderBottom: '1px solid rgba(128,128,128,0.25)', textAlign: 'left', verticalAlign: 'top' }
    const headCell = { ...cell, fontWeight: 600, whiteSpace: 'nowrap' }
    const muted = { opacity: 0.65, fontSize: '12px' }

    /** One row's status text, derived from the cached check result. */
    function statusOf(row) {
      if (row.source === null) return { text: '无上游来源，无法检测', tone: 'muted' }
      const result = row.result
      if (result === null) return { text: '尚未检查', tone: 'muted' }
      if (result.ok !== true) return { text: `检查失败：${result.detail ?? '未知原因'}`, tone: 'warn' }
      if (result.behind === true) return { text: `有新版本：${result.local} → ${result.remote}`, tone: 'stale' }
      return { text: `已是最新（${result.local}）`, tone: 'ok' }
    }

    const toneColour = {
      ok: 'inherit',
      muted: 'inherit',
      warn: '#b45309',
      stale: '#b45309',
    }

    function Page() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          setState(await api('/state'))
          setError(null)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const run = useCallback(
        async (work) => {
          setBusy(true)
          try {
            await work()
            setError(null)
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            setBusy(false)
          }
        },
        [],
      )

      const toggle = useCallback(
        (name, enabled) => {
          // Optimistic: a switch that lags behind the click feels broken.
          setState(current =>
            current === null
              ? current
              : { ...current, skills: current.skills.map(row => (row.name === name ? { ...row, enabled } : row)) },
          )
          void run(async () => {
            setState(await api('/toggle', { method: 'POST', body: JSON.stringify({ name, enabled }) }))
          })
        },
        [run],
      )

      const check = useCallback(() => {
        void run(async () => {
          setState(await api('/check', { method: 'POST', body: JSON.stringify({}) }))
        })
      }, [run])

      if (error !== null && state === null) {
        return h('div', { style: { padding: '16px' } }, [
          h('p', { key: 'e', style: { color: '#b45309' } }, `无法连接插件后端：${error}`),
          h('button', { key: 'r', type: 'button', onClick: () => void load() }, '重试'),
        ])
      }
      if (state === null) return h('div', { style: { padding: '16px' } }, '正在读取…')

      const enabledCount = state.skills.filter(row => row.enabled).length
      const staleCount = state.skills.filter(row => row.enabled && row.result?.behind === true).length

      return h('div', { style: { padding: '16px', display: 'grid', gap: '12px' } }, [
        h('div', { key: 'head', style: { display: 'grid', gap: '4px' } }, [
          h('h2', { key: 't', style: { margin: 0, fontSize: '16px' } }, '技能更新'),
          h(
            'p',
            { key: 'd', style: { margin: 0, ...muted } },
            `打开某个技能的开关后，使用该技能时会先检查上游有没有新版本，并把结果告诉模型。已开启 ${enabledCount} 个，其中 ${staleCount} 个落后。`,
          ),
        ]),
        h('div', { key: 'bar', style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
          h(
            'button',
            { key: 'c', type: 'button', disabled: busy, onClick: check, style: { padding: '5px 12px' } },
            busy ? '检查中…' : '立即检查全部',
          ),
          h('span', { key: 'w', style: muted }, `上次检查：${when(state.checkedAt)}${state.stale ? '（已过期，将自动重查）' : ''}｜间隔 ${state.intervalHours} 小时`),
        ]),
        error !== null ? h('p', { key: 'err', style: { margin: 0, color: '#b45309', ...muted } }, error) : null,
        h(
          'table',
          { key: 'table', style: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' } },
          [
            h('thead', { key: 'thead' }, [
              h('tr', { key: 'hr' }, [
                h('th', { key: 's', style: headCell }, '开关'),
                h('th', { key: 'n', style: headCell }, '技能'),
                h('th', { key: 'src', style: headCell }, '来源'),
                h('th', { key: 'st', style: headCell }, '状态'),
              ]),
            ]),
            h(
              'tbody',
              { key: 'tbody' },
              state.skills.map(row => {
                const status = statusOf(row)
                return h('tr', { key: row.name }, [
                  h(
                    'td',
                    { key: 't', style: cell },
                    h('input', {
                      type: 'checkbox',
                      checked: row.enabled,
                      disabled: row.source === null || busy,
                      title: row.source === null ? '该技能没有可检测的上游来源' : '开启后使用该技能会检查上游更新',
                      onChange: event => toggle(row.name, event.target.checked),
                    }),
                  ),
                  h('td', { key: 'n', style: cell }, row.name),
                  h(
                    'td',
                    { key: 'src', style: { ...cell, ...muted } },
                    row.source === null ? '—' : [h('div', { key: 'l' }, row.source.label), h('div', { key: 'k' }, row.source.kind === 'git' ? 'git 检出' : '上游版本标签')],
                  ),
                  h(
                    'td',
                    { key: 'st', style: { ...cell, color: toneColour[status.tone] ?? 'inherit' } },
                    [h('div', { key: 's' }, status.text), row.result?.at ? h('div', { key: 'a', style: muted }, when(row.result.at)) : null],
                  ),
                ])
              }),
            ),
          ],
        ),
        h(
          'p',
          { key: 'foot', style: { margin: 0, ...muted } },
          '新技能只要满足其一就会被自动识别：技能目录本身就是 git 检出；或在 config.json 的 sources 里登记。开关状态与检查结果都留在本机。',
        ),
      ])
    }

    function apply(ctx) {
      const t = translator(ctx)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'skill-updates: dictionary')
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'skill-updates',
            order: 36,
            label: () => t('nav'),
            locale: NS,
          },
          () => h(Page),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'skill-updates'
    return module.exports
  },
})
