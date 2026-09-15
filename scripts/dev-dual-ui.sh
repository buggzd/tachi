#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly COMPANION_URL="http://127.0.0.1:4176/"
readonly GLASSES_URL="http://127.0.0.1:4175/"
readonly HARNESS_URL="http://127.0.0.1:4177/"
readonly RUN_ID="$(date +%s)-$$"
readonly HARNESS_OPEN_URL="${HARNESS_URL}?reload=${RUN_ID}"

declare -a child_pids=()
development_config_path=""
development_config_source=""

cleanup()
{
    trap - EXIT INT TERM
    for child_pid in "${child_pids[@]}"; do
        if kill -0 "${child_pid}" 2>/dev/null; then
            kill "${child_pid}" 2>/dev/null || true
        fi
    done
    for child_pid in "${child_pids[@]}"; do
        wait "${child_pid}" 2>/dev/null || true
    done
}

trap cleanup EXIT INT TERM

wait_for_service()
{
    local url="$1"
    local process_id="$2"
    local label="$3"
    local attempt
    for attempt in {1..120}; do
        if ! kill -0 "${process_id}" 2>/dev/null; then
            wait "${process_id}" || true
            echo "${label} 启动失败。" >&2
            exit 1
        fi
        if curl --fail --silent --show-error --max-time 1 "${url}" >/dev/null 2>&1; then
            return
        fi
        sleep 0.25
    done
    echo "等待 ${label} 超时。" >&2
    exit 1
}

resolve_development_config()
{
    local configured_path="${RAYNEO_JELLYFIN_DEV_CONFIG:-}"
    local common_git_directory=""
    local primary_worktree_config=""

    if [[ -n "${configured_path}" ]]; then
        if [[ ! -f "${configured_path}" ]]; then
            echo "RAYNEO_JELLYFIN_DEV_CONFIG 指向的文件不存在。" >&2
            exit 1
        fi
        development_config_path="$(
            cd "$(dirname "${configured_path}")"
            printf '%s/%s\n' "$(pwd)" "$(basename "${configured_path}")"
        )"
        development_config_source="configured"
        return
    fi

    if [[ -f "${PROJECT_DIR}/.jellyfin-dev.json" ]]; then
        development_config_path="${PROJECT_DIR}/.jellyfin-dev.json"
        development_config_source="worktree"
        return
    fi

    if common_git_directory="$(
        git -C "${PROJECT_DIR}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null
    )"; then
        primary_worktree_config="$(dirname "${common_git_directory}")/.jellyfin-dev.json"
        if [[ -f "${primary_worktree_config}" ]]; then
            development_config_path="${primary_worktree_config}"
            development_config_source="primary-worktree"
        fi
    fi
}

cd "${PROJECT_DIR}"

resolve_development_config
if [[ -n "${development_config_path}" ]]; then
    export RAYNEO_JELLYFIN_DEV_CONFIG="${development_config_path}"
    if [[ "${development_config_source}" == "primary-worktree" ]]; then
        echo "已复用 Git 主工作区中的本地 Jellyfin 开发登录配置。"
    elif [[ "${development_config_source}" == "configured" ]]; then
        echo "已加载 RAYNEO_JELLYFIN_DEV_CONFIG 指定的本地登录配置。"
    fi
fi

if [[ ! -x "GlassesUI/node_modules/.bin/vite" \
        || ! -x "CompanionUI/node_modules/.bin/vite" ]]; then
    echo "前端依赖尚未安装，请先运行：" >&2
    echo "npm --prefix GlassesUI ci && npm --prefix CompanionUI ci" >&2
    exit 1
fi

(
    cd GlassesUI
    exec ./node_modules/.bin/vite --host 127.0.0.1 --port 4175 --strictPort --force
) &
child_pids+=("$!")
readonly GLASSES_PID="${child_pids[0]}"

(
    cd CompanionUI
    exec ./node_modules/.bin/vite --host 127.0.0.1 --port 4176 --strictPort --force
) &
child_pids+=("$!")
readonly COMPANION_PID="${child_pids[1]}"

node DevHarness/server.mjs &
child_pids+=("$!")
readonly HARNESS_PID="${child_pids[2]}"

wait_for_service "${GLASSES_URL}" "${GLASSES_PID}" "眼镜端 Vite"
wait_for_service "${COMPANION_URL}" "${COMPANION_PID}" "手机端 Vite"
wait_for_service "${HARNESS_URL}health" "${HARNESS_PID}" "双端联调页"

echo
echo "双端联调已就绪：${HARNESS_OPEN_URL}"
echo "左侧为 CompanionUI，右侧为 GlassesUI；按 Ctrl-C 同时停止三个服务。"

if [[ "${RAYNEO_DUAL_UI_NO_OPEN:-0}" != "1" ]]; then
    if command -v open >/dev/null 2>&1; then
        open "${HARNESS_OPEN_URL}"
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${HARNESS_OPEN_URL}" >/dev/null 2>&1 || true
    fi
fi

while true; do
    for child_pid in "${child_pids[@]}"; do
        if ! kill -0 "${child_pid}" 2>/dev/null; then
            wait "${child_pid}" || true
            echo "联调子进程意外退出，正在停止其余服务。" >&2
            exit 1
        fi
    done
    sleep 1
done
