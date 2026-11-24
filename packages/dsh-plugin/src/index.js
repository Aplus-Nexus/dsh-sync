/**
 * dsh-sync plugin entry.
 *
 * Two hosts load this same file:
 *  - the dsh-go phone app (native capsules, panels, status strip);
 *  - the desktop DSH web app (settings page, tool, commands).
 *
 * The native parts are declared in `package.json` → `dshGo` and are simply not
 * rendered by a host without the bridge, which is why a single plugin can serve
 * both without branching on the host at import time.
 */
import { Config, resolvePaths } from './config.js'
import { SyncRuntime } from './runtime.js'

export const name = 'dsh-sync'
// Only services that always exist are required; the rest are optional so the
// plugin still mounts on a host without a command registry or native bridge.
export const inject = []
export { Config }

export function apply(ctx, config) {
  const home = ctx.get('homePaths')?.dshHome ?? process.env.DSH_HOME ?? `${process.env.HOME ?? '.'}/.dsh`
  const paths = resolvePaths(config, home)
  const runtime = new SyncRuntime(ctx, config, paths)

  if (config.enabled !== true) {
    ctx.logger?.info?.('dsh-sync: disabled by configuration')
    return
  }
  runtime.start()

  // Every host that has a bridge gets the native surface; others just get the
  // tool and the command, and the runtime still works.
  ctx.inject(['dshGo'], (nativeCtx) => {
    registerNative(nativeCtx, runtime)
  })

  registerTool(ctx, runtime)
  registerCommand(ctx, runtime)
  ctx.effect(() => () => runtime.stop(), 'dsh-sync: timer')
}

/** The phone's native surface: two capsules, a status strip and a panel. */
function registerNative(ctx, runtime) {
  const go = ctx.dshGo

  go.on('sync-now', async (scope, event) => {
    const zh = !String(event.locale ?? '').startsWith('en')
    try {
      const result = await runtime.sync('button')
      const parts = []
      parts.push(zh ? `推送 ${result.pushed}` : `pushed ${result.pushed}`)
      parts.push(zh ? `拉取 ${result.pulled}` : `pulled ${result.pulled}`)
      if (result.imported > 0) parts.push(zh ? `导入 ${result.imported}` : `imported ${result.imported}`)
      return { toast: parts.join(' · ').slice(0, 40) }
    } catch (error) {
      return { toast: shortError(error, zh) }
    }
  })

  go.on('sync-open', () => ({ open: 'panel:sync' }))

  go.strip('status', (scope, emit) => {
    const paint = () => {
      const status = runtime.status()
      const result = status.lastResult
      const zh = String(scope?.locale ?? 'zh').startsWith('en') === false
      const text = result === null
        ? (zh ? '同步待命' : 'sync idle')
        : (status.running ? (zh ? '同步中…' : 'syncing…') : `${zh ? '已同步' : 'synced'} ${relativeTime(result.at, zh)}`)
      emit({ text: text.slice(0, 24), icon: status.lastError === null ? 'cloud' : 'warning', tone: status.lastError === null ? undefined : 'warn' })
    }
    paint()
    const timer = setInterval(paint, 30_000)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  go.panel('sync', {
    view: (scope, caps) => panelView(scope, caps, runtime),
    data: (scope, emit) => {
      const paint = async () => {
        try {
          const rows = await runtime.sessionRows()
          const status = runtime.status()
          emit({
            device: status.device,
            fingerprint: status.fingerprint ?? '—',
            pushed: status.totals?.pushed ?? 0,
            pulled: status.totals?.pulled ?? 0,
            bytesOut: status.totals?.bytesOut ?? '—',
            bytesIn: status.totals?.bytesIn ?? '—',
            lastText: status.lastResult === null ? '还没有同步过' : `${relativeTime(status.lastResult.at, true)} · 推送 ${status.lastResult.pushed} / 拉取 ${status.lastResult.pulled}`,
            errorLine: status.lastError === null ? '' : `⚠ ${status.lastError.message}`,
            sessions: rows.slice(0, 20).map((row) => ({
              title: row.title,
              subtitle: `${row.device} · ${row.records} 条`,
              trailing: relativeTime(row.lastTs, true),
              icon: 'chat',
            })),
          })
        } catch (error) {
          emit({ errorLine: error.message })
        }
      }
      void paint()
      const timer = setInterval(() => void paint(), 20_000)
      timer.unref?.()
      return () => clearInterval(timer)
    },
    actions: {
      'sync-now': async () => {
        try {
          const result = await runtime.sync('panel')
          return { patch: { lastText: `刚刚 · 推送 ${result.pushed} / 拉取 ${result.pulled}` }, toast: '同步完成' }
        } catch (error) {
          return { toast: shortError(error, true) }
        }
      },
      'copy-status': () => {
        const status = runtime.status()
        const lines = [
          `设备：${status.device}`,
          `密钥指纹：${status.fingerprint ?? '—'}`,
          `后端：${status.backend}`,
          `推送 ${status.totals?.pushed ?? 0} 条 / 拉取 ${status.totals?.pulled ?? 0} 条`,
          status.lastError === null ? '状态正常' : `错误：${status.lastError.message}`,
        ]
        return { copy: lines.join('\n'), toast: '已复制同步状态' }
      },
    },
  })
}

function panelView(scope, caps, runtime) {
  const zh = !String(caps?.locale ?? '').startsWith('en')
  const has = (surface) => Array.isArray(caps?.surfaces) && caps.surfaces.includes(surface)
  return {
    v: 2,
    type: 'stack',
    title: zh ? '消息云同步' : 'Message sync',
    children: [
      // Bound to an empty string when there is no error, so the row collapses to nothing.
      { type: 'text', text: { $: 'data.errorLine' }, tone: 'muted' },
      {
        type: 'row',
        children: [
          { type: 'metric', label: zh ? '已推送' : 'Pushed', value: { $: 'data.pushed' }, caption: { $: 'data.bytesOut' } },
          { type: 'metric', label: zh ? '已拉取' : 'Pulled', value: { $: 'data.pulled' }, caption: { $: 'data.bytesIn' } },
        ],
      },
      {
        type: 'keyValue',
        items: [
          [zh ? '本机设备' : 'This device', { $: 'data.device' }],
          [zh ? '密钥指纹' : 'Key fingerprint', { $: 'data.fingerprint' }],
          [zh ? '上次同步' : 'Last sync', { $: 'data.lastText' }],
        ],
      },
      { type: 'text', text: zh ? '最近的对话（最多 20 条）' : 'Recent conversations (top 20)', style: { weight: 'bold' } },
      { type: 'list', items: { $: 'data.sessions' } },
      {
        type: 'actions',
        items: [
          { label: zh ? '立即同步' : 'Sync now', action: 'sync-now', icon: 'refresh' },
          { label: zh ? '复制状态' : 'Copy status', action: 'copy-status', icon: 'copy' },
        ],
      },
      ...(has('chat.panel')
        ? [{ type: 'text', text: zh ? '关闭面板后仍会在后台自动同步。' : 'Automatic sync continues after this panel closes.', tone: 'muted' }]
        : []),
    ],
  }
}

function registerTool(ctx, runtime) {
  if (ctx.get('tools') === undefined) return
  const tools = ctx.get('tools')
  ctx.effect(() => tools.register({
    name: 'sync_now',
    description: "Push this device's new DSH messages to the private repository and pull messages from the other devices. Returns message counts.",
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pushed: { type: 'integer', required: true, description: 'Messages sent from this device.' },
          pulled: { type: 'integer', required: true, description: 'Messages received from other devices.' },
          imported: { type: 'integer', required: true, description: 'Conversations imported as native DSH sessions.' },
          skipped: { type: 'integer', required: true, description: 'Chunks that could not be decrypted.' },
          message: { type: 'string', required: true, description: 'One-line human summary.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: async () => {
      const result = await runtime.sync('tool')
      const skipped = result.skipped > 0 ? `, skipped ${result.skipped}` : ''
      return {
        pushed: result.pushed,
        pulled: result.pulled,
        imported: result.imported,
        skipped: result.skipped,
        message: `pushed ${result.pushed}, pulled ${result.pulled}, imported ${result.imported}${skipped}`,
      }
    },
  }), 'dsh-sync: tool')
}

function registerCommand(ctx, runtime) {
  const commands = ctx.get('commands')
  if (commands === undefined) return
  ctx.effect(() => commands.register({
    definitionId: '@aplus-nexus/dsh-sync',
    name: 'sync',
    description: 'Sync DSH messages with your other devices',
    // No `input`: `/sync` takes no argument, and a present-but-empty hint is rejected.
    recordInput: false,
    handler: async () => {
      try {
        const result = await runtime.sync('command')
        return { kind: 'success', text: `已同步：推送 ${result.pushed}，拉取 ${result.pulled}，导入 ${result.imported}` }
      } catch (error) {
        return { kind: 'error', text: shortError(error, true) }
      }
    },
  }), 'dsh-sync: command')
}

function relativeTime(ms, zh) {
  if (!Number.isFinite(ms)) return zh ? '—' : '—'
  const delta = Math.max(0, Date.now() - ms)
  if (delta < 60_000) return zh ? '刚刚' : 'just now'
  if (delta < 3_600_000) return zh ? `${Math.floor(delta / 60_000)} 分钟前` : `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return zh ? `${Math.floor(delta / 3_600_000)} 小时前` : `${Math.floor(delta / 3_600_000)}h ago`
  return zh ? `${Math.floor(delta / 86_400_000)} 天前` : `${Math.floor(delta / 86_400_000)}d ago`
}

/** Errors are shown to a person on a 6-inch screen, so they must be short and calm. */
function shortError(error, zh) {
  const message = String(error?.message ?? error ?? '')
  if (/could not read Username|Authentication failed|403/.test(message)) return zh ? '仓库拒绝访问，检查令牌' : 'repository rejected the token'
  if (/ENOTFOUND|EAI_AGAIN|Could not resolve|unable to access/.test(message)) return zh ? '连不上仓库，检查网络' : 'cannot reach the repository'
  if (/passphrase|口令/.test(message)) return zh ? '同步口令不对' : 'wrong passphrase'
  return (zh ? '同步失败：' : 'sync failed: ') + message.slice(0, 30)
}
