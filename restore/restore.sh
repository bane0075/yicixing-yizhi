#!/usr/bin/env bash
# restore.sh — 在另一台机器的 DSH 上恢复 2 个插件 + 2 个技能
# 用法：bash restore/restore.sh
# 环境变量：DSH_HOME（默认 ~/.dsh）、DSH_PROFILE_DIR（默认 $DSH_HOME/profiles/desktop）
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$DSH_HOME/profiles/desktop}"

echo "== repo: $REPO_DIR"
echo "== DSH_HOME: $DSH_HOME"
echo "== PROFILE: $PROFILE_DIR"
mkdir -p "$DSH_HOME/skills" "$PROFILE_DIR/node_modules"

echo "== 1/5 安装插件到 profile"
rm -rf "$PROFILE_DIR/node_modules/dsh-our-free-model" "$PROFILE_DIR/node_modules/dsh-skill-updates"
cp -a "$REPO_DIR/plugins/dsh-our-free-model" "$PROFILE_DIR/node_modules/"
cp -a "$REPO_DIR/plugins/dsh-skill-updates" "$PROFILE_DIR/node_modules/"

echo "== 2/5 合并 profile/package.json（依赖 + bundles）"
if [ -f "$PROFILE_DIR/package.json" ]; then cp -a "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak-$(date +%Y%m%d%H%M%S)"; fi
python3 - "$PROFILE_DIR/package.json" <<'PY'
import json, sys, os
p = sys.argv[1]
d = {"name": "dsh-profile-desktop", "private": True, "dependencies": {}, "dsh": {"profile": {"bundles": []}}}
if os.path.exists(p):
    d = json.load(open(p, encoding='utf-8'))
d.setdefault("dependencies", {})
d["dependencies"]["dsh-our-free-model"] = "1.3.2"
d["dependencies"]["dsh-skill-updates"] = "1.0.0"
d.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
for b in ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-our-free-model", "dsh-skill-updates"]:
    if b not in d["dsh"]["profile"]["bundles"]:
        d["dsh"]["profile"]["bundles"].append(b)
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print("merged:", p)
PY

echo "== 3/5 安装技能"
rm -rf "$DSH_HOME/skills/book-to-skill"
cp -a "$REPO_DIR/skills/book-to-skill" "$DSH_HOME/skills/"
if command -v git >/dev/null 2>&1; then
  rm -rf "$DSH_HOME/skills/huashu-nuwa"
  git clone -q https://github.com/alchaincyf/nuwa-skill "$DSH_HOME/skills/huashu-nuwa"
  git -C "$DSH_HOME/skills/huashu-nuwa" checkout -q fe0374687037c4cc51a65c1e0c145afe2981dc69
  echo "huashu-nuwa: cloned @ fe03746"
else
  rm -rf "$DSH_HOME/skills/huashu-nuwa"
  cp -a "$REPO_DIR/skills/huashu-nuwa" "$DSH_HOME/skills/"
  echo "huashu-nuwa: copied static files (no git on PATH)"
fi

echo "== 4/5 写 skill-updates/config.json（路径按本机 DSH_HOME 生成）"
mkdir -p "$DSH_HOME/skill-updates"
[ -f "$DSH_HOME/skill-updates/config.json" ] && cp -a "$DSH_HOME/skill-updates/config.json" "$DSH_HOME/skill-updates/config.json.bak-$(date +%Y%m%d%H%M%S)" || true
python3 - "$DSH_HOME/skill-updates/config.json" "$DSH_HOME" <<'PY'
import json, sys
p, home = sys.argv[1], sys.argv[2]
d = {
  "checkIntervalHours": 6,
  "skills": {"book-to-skill": True, "huashu-nuwa": True},
  "sources": [
    {"id": "book-to-skill", "label": "book-to-skill (virgiliojr94)", "kind": "git-tags",
     "upstream": "https://github.com/virgiliojr94/book-to-skill",
     "versionFile": home + "/skills/book-to-skill/pyproject.toml",
     "skills": ["book-to-skill"]},
    {"id": "huashu-nuwa", "label": "huashu-nuwa (alchaincyf/nuwa-skill)", "kind": "git",
     "dir": home + "/skills/huashu-nuwa"}
  ]
}
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print("wrote:", p)
PY

echo "== 5/5 校验"
echo "plugins: $(ls "$PROFILE_DIR/node_modules" | grep -E 'dsh-our-free-model|dsh-skill-updates' | tr '\n' ' ')"
echo "skills/book-to-skill files: $(find "$DSH_HOME/skills/book-to-skill" -type f | wc -l) (expect 22)"
echo "skills/huashu-nuwa files(excl .git): $(find "$DSH_HOME/skills/huashu-nuwa" -type f -not -path '*/.git/*' | wc -l) (expect 9)"
git -C "$DSH_HOME/skills/huashu-nuwa" log --oneline -1 2>/dev/null || true
echo "DONE. 重启 DSH 应用使插件生效；our-free-model 的 EAC 渠道需在本机重新登录一次。"
