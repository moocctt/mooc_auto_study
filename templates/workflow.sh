#!/usr/bin/env bash
# 烟草网络学院 · 端到端工作流模板
#
# 用法（在 Git Bash / bash 下）：
#   bash templates/workflow.sh [输出目录]
#   PY=/path/to/python bash templates/workflow.sh ./out
#
# 步骤：判断凭据 → 确认在职工作状态 → 同步任务 → 按工作日/周末排期 → 导出清单
# 仅做登录、读取、排期与记录；不自动播放课程、不代考、不刷课。
set -euo pipefail

PY="${PY:-python}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$SKILL_DIR/out}"
mkdir -p "$OUT_DIR"

echo "== 1/5 判断凭据是否有效（必要时账密登录） =="
STATUS="$("$PY" "$SKILL_DIR/scripts/mooc_tasks.py" status --json || true)"
echo "$STATUS"
if ! grep -q '"valid": true' <<<"$STATUS"; then
  if [[ -n "${MOOC_USER:-}" && -n "${MOOC_PWD:-}" ]]; then
    echo "凭据无效，走方式三账密登录…"
    printf '%s' "$MOOC_PWD" | "$PY" "$SKILL_DIR/scripts/mooc_tasks.py" \
      login-password --username "$MOOC_USER" --password-stdin
  else
    echo "凭据无效且未提供 MOOC_USER/MOOC_PWD：" >&2
    echo "  方式三：MOOC_USER=账号 MOOC_PWD=密码 bash templates/workflow.sh" >&2
    echo "  方式一/二：先用 dual_login.py 出码扫码（会自动保存 token）" >&2
    exit 1
  fi
fi

echo "== 2/5 当前在职工作状态与优先级策略 =="
"$PY" "$SKILL_DIR/scripts/tobacco.py" profile get

echo "== 3/5 同步当前学习任务（幂等） =="
"$PY" "$SKILL_DIR/scripts/mooc_tasks.py" sync --scope active

echo "== 4/5 生成学习计划（工作日/周末不同容量，必修与临期优先） =="
# LOGIN_LINKS=1 时生成免登录直达链接（文件含 access_token，勿外发）
PLAN_ARGS=(--days 14 --out "$OUT_DIR/plan.md")
if [[ "${LOGIN_LINKS:-0}" == "1" ]]; then
  PLAN_ARGS+=(--login-links)
  echo "   已启用 --login-links：plan.md 将含登录凭据，请勿转发。"
fi
"$PY" "$SKILL_DIR/scripts/tobacco.py" plan "${PLAN_ARGS[@]}"

echo "== 5/5 导出任务清单 =="
"$PY" "$SKILL_DIR/scripts/tobacco.py" report --format md --out "$OUT_DIR/tasks.md"
"$PY" "$SKILL_DIR/scripts/tobacco.py" report --format csv --out "$OUT_DIR/tasks.csv"

# 可选：生成年度学习报告（YEAR=2025 bash templates/workflow.sh ./out）
if [[ -n "${YEAR:-}" ]]; then
  echo "== 可选：生成 ${YEAR} 年度学习报告 =="
  RPT_ARGS=(--year "$YEAR" --out "$OUT_DIR/年度学习报告-${YEAR}.html")
  if [[ "${LOGIN_LINKS:-0}" == "1" ]]; then
    RPT_ARGS+=(--login-links)
    echo "   已启用 --login-links：报告将含登录凭据，请勿转发。"
  fi
  "$PY" "$SKILL_DIR/scripts/mooc_annual.py" "${RPT_ARGS[@]}"
fi

echo "完成：$OUT_DIR/plan.md  $OUT_DIR/tasks.md  $OUT_DIR/tasks.csv"
