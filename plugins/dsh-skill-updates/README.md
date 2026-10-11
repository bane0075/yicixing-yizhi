# dsh-skill-updates

Per-skill upstream update self-check for DeepSeek Harness.

一个技能一个开关。打开开关后，**使用**该技能时会先检查它的上游有没有新版本，
并把结果作为上下文告诉模型；关掉的技能永远不检查。插件只报告，**不会自动安装任何东西**——
它把确切的更新命令交给模型/你。

## 为什么是「每技能一个开关」

开关放在你真正会想的地方（技能），而不是放在文件或仓库上。新增一个需要跟踪的技能时：

1. **技能目录本身就是 git 检出**（例如上游 README 写「clone 到 skills 目录」的那种）——
   **自动识别，不用配置**，列表里直接出现并可以打开开关。
2. **否则**在 `<DSH_HOME>/skill-updates/config.json` 的 `sources` 里登记一条。

## 界面

`设置 → 技能更新`（settings section id `skill-updates`）列出所有已安装技能：

| 列 | 含义 |
|---|---|
| 开关 | 打开后使用该技能会检查上游更新；没有可检测来源的技能，开关禁用 |
| 技能 | 技能目录名 |
| 来源 | 该技能归属的上游（git 检出 / 上游版本标签） |
| 状态 | 已是最新 / 有新版本（本地 → 远端）/ 检查失败 / 尚未检查 |

顶部有「立即检查全部」按钮与上次检查时间。

## 工作方式

- 热路径是 `tools/post-execute` 上针对 `skill` 工具的监听：**只读缓存，不联网**，
  所以使用技能永远不会因为检查而变慢。缓存过期时改为在后台刷新，下次使用就有新结果。
- 后台还有一个定时刷新（按 `checkIntervalHours`，默认 6 小时），启动 5 秒后跑第一次。
- 检查结果、开关状态、配置全部留在本机 `<DSH_HOME>/skill-updates/`，不上传任何东西。
- 任何失败（离线、检出被删、git 报错）都只会显示「检查失败」，不会中断对话轮次，
  也不会让技能本身用不了。

## 配置

`<DSH_HOME>/skill-updates/config.json`（首次运行自动生成）：

```json
{
  "checkIntervalHours": 6,
  "skills": { "huashu-nuwa": true },
  "sources": [
    {
      "id": "ai-berkshire",
      "label": "AI Berkshire (xbtlin/ai-berkshire)",
      "kind": "git",
      "dir": "C:/Users/<you>/.dsh/ai-berkshire",
      "skillsFrom": "C:/Users/<you>/.dsh/ai-berkshire/codex-skills",
      "note": "更新后需要把 codex-skills\\* 重新复制到技能目录。"
    },
    {
      "id": "book-to-skill",
      "label": "book-to-skill (virgiliojr94)",
      "kind": "git-tags",
      "upstream": "https://github.com/virgiliojr94/book-to-skill",
      "versionFile": "C:/Users/<you>/.dsh/skills/book-to-skill/pyproject.toml",
      "skills": ["book-to-skill"]
    }
  ]
}
```

- `kind: "git"` — 比较检出目录的 `HEAD` 与 `origin HEAD`；落后就报「本地 → 远端」，
  并给出 `git -C "<dir>" pull --ff-only`。
- `kind: "git-tags"` — 读本地版本（`versionFile` 里的 `version = "x.y.z"`），
  与上游 `git ls-remote --tags` 里的最高版本比较。
- `skills` 显式列出覆盖的技能；`skillsFrom` 指向一个目录，目录下的**每个子目录名**都算被覆盖
  （这样上游新增技能时会自动跟上，不用改配置）。
- `skills` 里的开关由界面写入，手改也可以：`true` 表示打开。

`config.json` 每次调用都会重新读取，改完即时生效，不需要重启。

## HTTP 接口

同源 `/api/skill-updates/*`，全部先过信任围栏（有 `connection` 服务时用它自己的准入判断，
否则用结构化围栏：仅回环 Host、拒绝跨站 fetch、Origin/Referer 必须与 Host 同源）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/state` | 技能 + 来源 + 缓存结果 + 开关状态 |
| POST | `/toggle` | `{ name, enabled }` |
| POST | `/check` | 立即检查；`{ source }` 可只查一个来源 |
| GET | `/config` | 当前配置 |
| GET | `/sources` | 解析后的来源列表 |

## 结构

```
index.js           Host 半身：skill 拦截、刷新定时器、设置页 API
client.js          浏览器半身：设置分区（每个技能一个开关）
adapter/kernel.js  唯一允许 import @deepseek-ai/* 的接缝（懒加载 + 结构化兜底）
src/engine.js      技能发现、来源解析、检查与缓存（仅用 node 内置模块）
src/trust.js       插件路由的请求信任围栏
```

## 已知边界

- **插件/浏览器半身的代码改动需要重启应用**才会生效（bundle 在启动时组装）；
  `config.json` 与开关状态是实时的。
- 只扫描用户级技能根：`<DSH_HOME>/skills` 与 `<DSH_AGENTS_HOME|~/.agents>/skills`。
  工作区级 `.dsh/skills` 里的技能不出现在这个列表里。
- `git` 必须在 PATH 上；没有 git 时所有 git 来源都会显示「检查失败」，其余功能不受影响。
- 检查是「远端 HEAD 是否不同」，不是「本地文件是否落后于自己仓库的记录」：
  检出目录里有未提交改动时，`git pull --ff-only` 可能失败——这是 git 的正常行为，命令原样给出。
