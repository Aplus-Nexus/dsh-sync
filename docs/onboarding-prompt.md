# dsh-sync 接入提示词（通用版 · 可重复使用）

> **怎么用：** 把本文件从「你要做的事」到「完成后向用户报告」整段复制给任何一台新设备的智能体。
> 同一段话可以发给第 2、3、4 台设备，不需要改。每台设备只需要换一个 `DEVICE_NAME` 和一个自己的令牌。
>
> 版本：适配 dsh-sync 0.3.3 及以上。低于 0.3.1 的版本会重复上传全部对话，务必按第一步检查版本。

---

## 你要做的事

你正在一台新设备上（dsh-go 手机，或装了 DSH 的电脑）。用户有一台**主设备**，它上面的对话是唯一事实来源，已经加密同步到一个私有仓库里。

你的任务：把这批对话拉到本机、变成可以继续聊的**原生对话**，并让你后续的回复回到主设备。

**三条铁律，任何情况下都不许违反：**

1. **本机原有对话一律不动** —— 不修改、不上传、不删除。你只处理「从仓库同步来的对话」。
2. **不需要问用户要任何新信息就能开始验证** —— 仓库地址、口令、令牌的获取方式下面都写了。缺哪个就按说明去要，一次问清，不要反复追问。
3. **口令和令牌绝不写进任何聊天回复、命令输出或公开文件** —— 只写进下面指定的那一个配置文件（权限 600）。

## 开工前：确认你要用的四个值

先问用户这四样（可以一次问完）：仓库地址、口令、令牌、设备名。

| 值 | 从哪来 | 示例 |
|---|---|---|
| `REPO_URL` | 主设备上已有，问用户要 | `https://github.com/用户名/dsh-sync-main.git` |
| `PASSPHRASE` | 主设备生成，问用户要 | 一串 40 字左右的字符串 |
| `TOKEN` | 按下面第三步现建 | `github_pat_…` |
| `DEVICE_NAME` | **你自己定，必须全设备唯一** | `phone-2`、`laptop`、`pad` |

`DEVICE_NAME` 的规则：

- 小写字母、数字、连字符，别用中文和空格
- 每台设备不一样，**定了就永远别再改**（它决定仓库里的目录名，改了等于换一台新设备）
- 建议 `手机-2` → `phone-2`，`我的笔记本` → `laptop`

**先从用户那里拿到前两个值，再开始动手。** 令牌可以边做边建。

## 第一步：确认环境和版本

```sh
node -v     # 必须 >= 24.9，低于这个版本直接停下告诉用户
dsh -v
dsh plugin --profile web list 2>/dev/null | grep -i dsh-sync
```

如果已经装过 dsh-sync，确认版本 **≥ 0.3.3**。低于 0.3.1 的版本有个已知缺陷会重复上传全部对话，必须先升级：

```sh
dsh plugin --profile web add @aplus-nexus/dsh-sync@0.3.3
```

如果没装过，直接进第二步。

## 第二步：装插件

```sh
dsh plugin --profile web add @aplus-nexus/dsh-sync
```

装完验证：

```sh
dsh --profile web --dump-config | grep -A3 dsh-sync
```

能看到 `@aplus-nexus/dsh-sync` 这一项即成功。看不到就停下，把错误原文发回用户，不要自己改 profile 文件。

## 第三步：建一个只够开这一扇门的令牌

这一步必须让用户亲自做（你无法代替登录）。把下面这段话原样发给用户：

> 请打开 https://github.com/settings/personal-access-tokens/new
> 1. **Repository access** 选 **Only select repositories**，只勾 `<REPO 的仓库名>`
> 2. **Permissions** 里只把 **Contents** 设成 **Read and write**，其余全部保持 No access
> 3. 有效期选 90 天
> 4. 生成后复制令牌，直接把令牌发给我，不要发到别的地方

用户给令牌后，**只允许**写进下面第四步的配置文件。不要再 echo、不要写进任何脚本、不要写进日志。

如果用户用的是同一个 GitHub 账号的其他设备，**每台设备各建一个令牌**，方便单独吊销。

## 第四步：写配置（本步骤是整套流程的核心）

编辑当前 profile 的 patch 文件。路径固定：

```sh
$DSH_HOME/profiles/web/cordis.patch.yml
```

（`$DSH_HOME` 默认是 `~/.dsh`；不确定就 `echo $DSH_HOME`。）

在文件**末尾追加**下面这一段，把四个 `<>` 换成真实值。注意 `pushScope: synced` **绝对不能漏**：

```yaml
# == dsh-sync: this device
- id: dsh-sync
  config:
    enabled: true
    backend: git
    repoUrl: <REPO_URL>
    branch: main
    token: <TOKEN>
    passphrase: <PASSPHRASE>
    deviceName: <DEVICE_NAME>
    intervalSec: 60
    pushOnTurnEnd: true
    importNative: true
    mirror: true
    syncSettings: false
    syncSkills: false
    pushScope: synced
```

**为什么是 `pushScope: synced`，不是 `all`：**
这一行让本机只上传「从仓库同步来的对话」。如果写成 `all` 或者漏掉，本机原有的私人对话会被全部推到仓库，所有人的设备都能看到。**这是唯一一条会造成隐私事故的配置**，写完请回读一遍确认。

写完后立刻收紧权限：

```sh
chmod 600 $DSH_HOME/profiles/web/cordis.patch.yml
```

然后确认配置被正确解析：

```sh
dsh --profile web --dump-config | grep -A16 "id: dsh-sync"
```

检查三件事：`repoUrl` 是你要的仓库、`deviceName` 是你定的名字、`pushScope` 是 `synced`。

## 第五步：重启引擎并验证密钥

本机引擎要重启才会读新配置。**没有命令行开关可以重启它**，必须走 App：

- dsh-go 手机：`设置 › 本机引擎 › 重启`（会中断进行中的回复，先和用户确认）
- 电脑上的 DSH：在那个终端里 `Ctrl+C` 停掉，再重新 `dsh web`

不要用 `kill` 猜进程号，也不要试图用 `dsh --restart` 之类的参数——它不存在。

重启后跑健康检查：

```sh
npx @aplus-nexus/dsh-sync-cli verify
```

看输出里的**密钥指纹**（12 位短字符串）：

- 和主设备一致 → 继续
- 不一致 → **立刻停下**，告诉用户「口令不一致」，不要继续同步、不要删任何文件
- 出现「无法解密 N 块」→ 把 N 和指纹发回用户，停下

## 第六步：首次同步

对用户说一声「开始首次同步」，然后：

```sh
npx @aplus-nexus/dsh-sync-cli pull
npx @aplus-nexus/dsh-sync-cli sessions
```

预期结果：

- `sessions` 列出主设备上的对话标题和条数
- 这些对话在本机的**对话列表里能点开**
- **本机原有对话数量和内容一个都没变**

首次同步耗时取决于仓库大小和网络，几分钟都正常，不要中途打断。如果超过 15 分钟没动静，检查网络后重试一次，仍失败就把错误原文发回用户。

## 第七步：确认本机历史没被上传

这一步是给用户看的最后一道保险：

```sh
npx @aplus-nexus/dsh-sync-cli status
```

`pushed` 数字应该很小（只包含同步来的对话的新增）。然后请用户自己打开仓库看一眼：`data/` 下面**不应该出现你不认识的对话目录**。

## 完成后的行为约定

1. 只在同步来的对话里继续聊；本机原有对话保持原样。
2. 不要手工操作 git。推送、合并、重试都由插件处理；手动 `git push` 会破坏协作约定。
3. 不要修改 `deviceName`。改了就等于新设备，旧目录会变成孤儿。
4. 万一两个设备同时对**同一个**同步来的对话发问：以主设备那一路为准，你这台的结果会自动变成一个新对话，标题带 `（冲突1）`、`（冲突2）`。**看到这种标题不要合并、不要删**，告诉用户可以在那个副本里继续聊。
5. 令牌过期了就按第三步重建一个，只换配置文件里的 `token` 一行。

## 完成后向用户报告

用五句话以内说清，不要长篇：

1. 设备名和密钥指纹（指纹必须与主设备一致）
2. 同步到了几个对话、共多少条
3. 本机原有对话未被改动（`pushed` 数字为证）
4. `verify` 结果：0 块失败
5. 之后的同步方式：自动（每 60 秒）或点 App 里的「同步」胶囊

---

## 附：用户自己看的部分（不要发给智能体）

**同一段提示词可以重复用。** 每台新设备只需要你准备三样，然后把上面整段发过去：

1. **口令** —— 在 `口令文件`，全设备同一个，不要改
2. **仓库地址** —— `https://github.com/Aplus-Nexus/dsh-sync-main.git`
3. **这台设备的唯一名字** —— 比如第二台叫 `phone-2`，电脑叫 `laptop`

**每台设备各建一个 GitHub 令牌**，不要共用，方便单独吊销。

**发过去时可以补一句：**

> 仓库是 https://github.com/Aplus-Nexus/dsh-sync-main.git，口令我单独发给你，设备名你自己定一个全设备唯一的（比如 phone-2）。
> 本机已有的对话不要动，也不要上传；配置里 pushScope 必须是 synced。

**用在非 dsh-go 的 agent（比如 Codex、Claude Code）时：** 上面的流程它做不了 `dsh plugin` 那步。让它先问你要 `npm i -g @aplus-nexus/dsh-sync-mcp` 的安装方式，然后按它的 MCP 配置说明接入；同步对话仍然走同一个仓库和同一个口令。

**注意：** 第三个、第四个设备不要用同一个 `DEVICE_NAME`。两台的目录会撞在一起，后推的会覆盖前推的。
