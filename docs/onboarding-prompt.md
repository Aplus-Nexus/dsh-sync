# 给 dsh-go 智能体的接入提示词

把下面整段复制给另一台手机上的 dsh-go 智能体。它自己会完成安装、配置、验证。

---

## 你要做的事

你正在一台 dsh-go 手机上运行。用户有一台**主手机**，上面的对话是唯一事实来源。你需要把主手机上已经同步出来的对话拉到本机，并让本机后续的回复回到主手机。

**本机原有的对话必须保持原样，不改、不传、不删。** 你只处理"同步来的对话"。

用户会给你两样东西：**数据仓库地址** 和 **同步口令**。没有这两样就先向用户索要，不要猜。

## 第一步：确认环境

```sh
node -v          # 必须 >= 24.9（dsh 自带，通常已满足）
dsh -v
```

若 Node 低于 24.9，停下来告诉用户：这套插件依赖 Node 24 的 zstd 支持，不能在旧版本上工作。

## 第二步：装插件

```sh
dsh plugin --profile web add @aplus-nexus/dsh-sync
```

装完 `--dump-config` 里应能看到 `@aplus-nexus/dsh-sync` 这一项。

## 第三步：拿一个只够开这一扇门的令牌

让用户去 https://github.com/settings/personal-access-tokens/new 建一个 **Fine-grained token**：

- Repository access：**Only select repositories** → 只选 `dsh-sync-data`
- Permissions：**Contents: Read and write**（其余全部 No access）
- 有效期建议 90 天

不要用全仓库权限的经典令牌，也不要把主手机的令牌直接复制过来。把这个新令牌写进配置，不要贴在聊天里。

## 第四步：写配置

编辑当前 profile 的 patch 文件（通常会覆盖插件默认值）：

```sh
# 路径来自 dsh --profile web --dump-config 的 profile 目录
$DSH_HOME/profiles/web/cordis.patch.yml
```

在文件末尾追加（把尖括号内容换成真实值）：

```yaml
# == dsh-sync: this device
- id: dsh-sync
  config:
    enabled: true
    backend: git
    repoUrl: <用户给的仓库地址，形如 https://github.com/<用户名>/dsh-sync-data.git>
    branch: main
    token: <你刚建的那个令牌>
    passphrase: <用户给你的同步口令>
    deviceName: <这台设备的名字，见下面说明>
    intervalSec: 60
    pushOnTurnEnd: true
    importNative: true
    mirror: true
    syncSettings: false
    syncSkills: false
    pushScope: synced
```

**`pushScope: synced` 是关键**：它让这台设备只推送"从仓库同步来的对话"，本机原有对话一条都不会上传。少了这一行，本机的私人历史会被推上去。

`deviceName` 用简短、唯一、可辨认的名字，比如 `laptop`、`pad`、`second-phone`。它决定仓库里的路径，之后别再改。

## 第五步：重启引擎并验证

重启本机引擎（`设置 › 本机引擎 › 重启`，或对应命令）。然后：

```sh
npx @aplus-nexus/dsh-sync-cli status
npx @aplus-nexus/dsh-sync-cli verify
```

- `verify` 必须是「无法解密 0 块」。
- `status` 里的**密钥指纹**必须和主手机一致。不一致说明口令不同或仓库里已有别的盐值——停下，让用户核对口令，不要继续同步。

## 第六步：首次同步

在 dsh-go 里点输入框上方的「同步」胶囊，或对智能体说「同步一次」。

同步完成后应当看到：

- 面板里出现主手机上的对话，标题、条数合理；
- 这些对话在本机对话列表里**变成了原生对话**，可以点进去继续聊；
- 本机原有的对话数量和内容没有变化。

## 之后的行为约定

1. **只影响同步来的对话。** 本机原有对话永远不改、不传。
2. **不要手工操作 git。** 推送、合并、重试都由插件处理；手动 `git push` 会破坏协作约定。
3. **不要把口令写进任何文件、命令或回复里。** 口令只出现在上面那个 patch 文件的 `passphrase` 字段。
4. **不要在公开仓库里跑这套配置。** 数据仓必须是 private；若用户给了 public 仓库，停下来提醒。
5. **冲突**：如果用户同时在主手机和本机上对同一个对话发问，以**主手机**为准；本机那一次的结果会自动变成一个新的对话，标题带 `（冲突1）`、`（冲突2）`。看到这种标题不要合并、不要删，告诉用户可以继续在那个冲突副本里聊。

## 完成后向用户报告

用五句话以内说清：

- 密钥指纹（应当与主手机一致）
- 同步到了几个对话、共多少条
- 本机原有对话未被改动
- `verify` 结果
- 之后怎么继续同步（自动 / 点胶囊）

---

## 附：用户自己看的部分（不用给智能体）

**给智能体之前，先准备好三样东西：**

1. 口令：在你主手机的 `（主手机上的口令文件）` 里（我把口令单独放文件，就是为了不经过聊天记录）。
2. 仓库地址：`https://github.com/Aplus-Nexus/dsh-sync-data.git`
3. 令牌：让智能体自己引导你建，或你先建好给它。

**给智能体的方式：** 把本文件上半段（到"完成后向用户报告"为止）整段贴进那台手机的对话，再补一句：

> 仓库是 https://github.com/Aplus-Nexus/dsh-sync-data.git，口令我等下单独给你，设备名叫 xxx。
> 本机已有的对话不要动，也不要上传。

**用完记得：** 把口令从聊天里清掉（那台手机的对话本身也会留在本机，但它不会因为 `pushScope: synced` 而上传）。
