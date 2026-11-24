/**
 * Config for the DSH plugin. Kept apart from the plugin entry so the CLI and
 * the MCP server can validate the same shape.
 */
import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  /** Turn the whole plugin off without uninstalling it. */
  enabled: Schema.boolean().default(true).description('开启同步'),
  /** `git` keeps the repository as the only transport. */
  backend: Schema.union([Schema.const('git'), Schema.const('folder')]).default('git').description('传输方式'),
  /** HTTPS URL of the private data repository, e.g. https://github.com/you/dsh-sync-data.git */
  repoUrl: Schema.string().default('').description('数据仓库地址'),
  /** Branch to use. */
  branch: Schema.string().default('main').description('分支'),
  /** Personal access token with `repo` scope on the data repository. */
  token: Schema.string().role('secret').description('访问令牌'),
  /** Local clone; defaults to <dsh home>/dsh-sync/repo. */
  workdir: Schema.string().default('').description('本地克隆目录'),
  /** Folder backend root, used when backend is `folder`. */
  folder: Schema.string().default('').description('同步文件夹'),
  /** End-to-end encryption passphrase. Losing it means losing the old data. */
  passphrase: Schema.string().role('secret').default('').description('同步口令'),
  /** Name this device shows to the others; the device id is derived from it. */
  deviceName: Schema.string().default('').description('设备名称'),
  /** Seconds between automatic syncs; 0 turns automatic sync off. */
  intervalSec: Schema.number().default(60).description('自动同步间隔（秒）'),
  /** Push a commit right after a turn ends, instead of waiting for the timer. */
  pushOnTurnEnd: Schema.boolean().default(true).description('每轮结束立即推送'),
  /** Import foreign sessions as native DSH conversations. */
  importNative: Schema.boolean().default(true).description('把其他设备的对话导入为原生对话'),
  /** Keep a plaintext JSONL mirror other agents can read. */
  mirror: Schema.boolean().default(true).description('保留可读镜像'),
  /** Also sync non-secret settings (model routes without keys). */
  syncSettings: Schema.boolean().default(false).description('同步设置与模型渠道'),
  /** Also sync skills, AGENTS.md and the dsh-go ui.json. */
  syncSkills: Schema.boolean().default(false).description('同步技能与界面配置'),
})

export function resolvePaths(config, home) {
  const workdir = config.workdir !== '' ? config.workdir : `${home}/dsh-sync/repo`
  return {
    workdir,
    home,
    statePath: `${home}/dsh-sync/state.json`,
    mirrorDir: `${home}/dsh-sync/mirror`,
    exportDir: `${home}/dsh-sync/export`,
  }
}
