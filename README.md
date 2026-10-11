# DSH 移植包（公开最小版）

另一套 DSH 用的移植包：2 个插件 + 2 个技能。不含任何个人 token，新机器的登录态需自己重登一次。

## 内容

- `plugins/dsh-our-free-model/` — 免费模型插件源码（v2.0.0）
- `plugins/dsh-skill-updates/` — 技能更新插件源码（v1.0.0，我自己写的）
- `skills/book-to-skill/` — book-to-skill 技能全量（22 文件，上游 virgiliojr94/book-to-skill，本地 1.4.0）
- `skills/huashu-nuwa/` — 女娲技能工作文件全量（9 文件，不含 `.git`；上游 alchaincyf/nuwa-skill，恢复时按 SHA 拉取）
- `restore/restore.sh` — 新机器一键恢复脚本

## 上游版本 pin

- huashu-nuwa：https://github.com/alchaincyf/nuwa-skill @ `fe0374687037c4cc51a65c1e0c145afe2981dc69`
- book-to-skill：https://github.com/virgiliojr94/book-to-skill，本地 pyproject 1.4.0

## 恢复（新机器 DSH 智能体执行）

```bash
git clone https://github.com/bane0075/yicixing-yizhi
cd yicixing-yizhi
bash restore/restore.sh
```

脚本会：装插件到 profile、合并 package.json 的依赖与 bundles、装 2 个技能（女娲走 git clone 到 pin 的 SHA）、按本机路径写 skill-updates config、最后校验。完成后重启 DSH 应用。
