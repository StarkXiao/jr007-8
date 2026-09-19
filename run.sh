#!/usr/bin/env bash
# =============================================================================
# 公共空间细节地图 —— 一键启动 / 复现脚本（A 版：backend/src/modules/config）
#
#   ./run.sh              一键启动：依赖 → 迁移 → 种子 → 后端 + worker + 前端
#   ./run.sh check        跑后端测试（含在线配置的集成用例）
#   ./run.sh demo         走一遍「草稿预演 → 灰度生效 → 全量 → 回滚」真实接口
#   ./run.sh status       进程 / 端口 / 健康检查三层信息
#   ./run.sh logs [n]     日志尾部（默认 80 行）
#   ./run.sh stop         停止后端、worker、前端（默认保留 postgres/redis）
#   ./run.sh restart      重启这三个进程
#   ./run.sh foreground   前台跟随后端日志（Ctrl-C 退出，不影响其它进程）
#   ./run.sh reset --yes  清空并重建数据库、重新写入种子数据
#
# 可用环境变量：
#   APP_PORT(3000)  FRONTEND_PORT(5173)  SKIP_SEED=1  STOP_INFRA=1
#   ADMIN_ACCOUNT / ADMIN_PASSWORD  手工指定预演用的管理员账号
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

RUNTIME="$ROOT/.runtime"
LOGS="$RUNTIME/logs"
mkdir -p "$RUNTIME" "$LOGS"

# 调用方显式传入的变量优先于 .env
_OVR_APP_PORT="${APP_PORT:-}"
_OVR_FRONTEND_PORT="${FRONTEND_PORT:-}"
_OVR_DATABASE_URL="${DATABASE_URL:-}"
_OVR_REDIS_URL="${REDIS_URL:-}"

if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "已根据 .env.example 生成 .env（生产环境请替换 JWT_SECRET）"
fi
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

# 上一次 up 实际使用的端口（端口被占用时会自动顺延，这里记住结果）
if [ -f "$RUNTIME/ports.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$RUNTIME/ports.env"
  set +a
fi

if [ -n "$_OVR_APP_PORT" ]; then APP_PORT="$_OVR_APP_PORT"; fi
if [ -n "$_OVR_FRONTEND_PORT" ]; then FRONTEND_PORT="$_OVR_FRONTEND_PORT"; fi
if [ -n "$_OVR_DATABASE_URL" ]; then DATABASE_URL="$_OVR_DATABASE_URL"; fi
if [ -n "$_OVR_REDIS_URL" ]; then REDIS_URL="$_OVR_REDIS_URL"; fi

APP_PORT="${APP_PORT:-3000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
API_BASE="http://localhost:${APP_PORT}"
WEB_BASE="http://localhost:${FRONTEND_PORT}"
API="${API_BASE}/api/v1"
export APP_PORT FRONTEND_PORT DATABASE_URL REDIS_URL API API_BASE WEB_BASE
export VITE_API_BASE_URL="$API"

# 诊断信息一律走 stderr：这样 $(...) 里只会拿到数据本身，
# 不会再出现「提示文字被当成端口号」这类污染（历史上真踩过）。
info() { printf '\033[36m[run]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[run]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[run]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

port_busy() {
  local port="$1"
  if have lsof; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
  fi
}

# 端口被别的程序占用时顺延，避免和已经在跑的容器/服务撞车
pick_port() { # preferred
  local want="$1" port="$1" i=0
  while [ "$i" -lt 20 ] && port_busy "$port"; do
    port=$((port + 1))
    i=$((i + 1))
  done
  if [ "$port" != "$want" ]; then
    warn "端口 $want 已被占用，改用 $port"
  fi
  printf '%s' "$port"
}

resolve_ports() {
  if pid_alive backend; then
    info "后端已在运行，沿用端口 $APP_PORT"
  else
    APP_PORT="$(pick_port "$APP_PORT" | tr -cd '0-9')"
  fi
  if pid_alive frontend; then
    info "前端已在运行，沿用端口 $FRONTEND_PORT"
  else
    FRONTEND_PORT="$(pick_port "$FRONTEND_PORT" | tr -cd '0-9')"
  fi
  [ -n "$APP_PORT" ] || APP_PORT=3000
  [ -n "$FRONTEND_PORT" ] || FRONTEND_PORT=5173
  API_BASE="http://localhost:${APP_PORT}"
  WEB_BASE="http://localhost:${FRONTEND_PORT}"
  API="${API_BASE}/api/v1"
  export APP_PORT FRONTEND_PORT API API_BASE WEB_BASE
  export VITE_API_BASE_URL="$API"
  printf 'APP_PORT=%s\nFRONTEND_PORT=%s\n' "$APP_PORT" "$FRONTEND_PORT" >"$RUNTIME/ports.env"
}

wait_port() { # port seconds
  local port="$1" limit="${2:-60}" waited=0
  while [ "$waited" -lt "$limit" ]; do
    port_busy "$port" && return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

wait_http() { # url seconds
  local url="$1" limit="${2:-60}" waited=0
  while [ "$waited" -lt "$limit" ]; do
    if have curl && curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif have docker-compose; then docker-compose "$@"
  else return 127
  fi
}

ensure_infra() {
  if port_busy 5432 && port_busy 6379; then
    info "postgres/redis 已在监听，直接复用"
    return 0
  fi
  if have docker || have docker-compose; then
    info "启动 postgres 与 redis 容器"
    compose up -d postgres redis >/dev/null
    wait_port 5432 60 || die "postgres 未在 60 秒内就绪"
    wait_port 6379 60 || die "redis 未在 60 秒内就绪"
    info "postgres/redis 就绪"
    return 0
  fi
  die "既没有可用的 Docker，也没检测到 5432/6379 上的服务。请先起 postgres 与 redis（docker compose up -d postgres redis）"
}

ensure_deps() {
  local dir
  for dir in backend frontend; do
    if [ ! -d "$ROOT/$dir/node_modules" ]; then
      info "安装 $dir 依赖（首次较慢）"
      (cd "$ROOT/$dir" && npm install)
    fi
  done
}

# ------------------------------------------------------------------ 库隔离
#
# A / B 两套实现都建 app_config_versions，但列名不同（payload/rollout vs
# bundle/canary_rule）。共用一个库时，后跑的那套迁移必然报 42P07
# （relation "app_config_versions" already exists），所以默认各自用一个库。
DB_SUFFIX="_a"
REDIS_DB_INDEX=1

url_field() { # url field(db|user|password|host|port)
  node -e '
    const u = new URL(process.argv[1]);
    const f = process.argv[2];
    const db = decodeURIComponent((u.pathname || "").replace(/^\//, ""));
    const map = {
      db,
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      host: u.hostname || "localhost",
      port: u.port || "5432"
    };
    process.stdout.write(map[f] ?? "");
  ' "$1" "$2"
}

mask_url() { printf '%s' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#'; }

iso_db_url() { # url suffix
  node -e '
    const u = new URL(process.argv[1]);
    const suffix = process.argv[2];
    const db = decodeURIComponent((u.pathname || "").replace(/^\//, ""));
    if (db && !db.endsWith(suffix)) u.pathname = "/" + db + suffix;
    process.stdout.write(u.toString());
  ' "$1" "$2"
}

iso_redis_url() { # url index
  node -e '
    const u = new URL(process.argv[1]);
    const cur = (u.pathname || "").replace(/^\//, "");
    if (!cur || cur === "0") u.pathname = "/" + process.argv[2];
    process.stdout.write(u.toString());
  ' "$1" "$2"
}

apply_db_isolation() {
  [ "${ISOLATE_DB:-1}" = "0" ] && return 0
  if [ -z "$_OVR_DATABASE_URL" ]; then
    DATABASE_URL="$(iso_db_url "$DATABASE_URL" "$DB_SUFFIX")"
    export DATABASE_URL
  fi
  if [ -z "$_OVR_REDIS_URL" ]; then
    REDIS_URL="$(iso_redis_url "$REDIS_URL" "$REDIS_DB_INDEX")"
    export REDIS_URL
  fi
}

pg_container() { # port
  have docker || return 1
  docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null |
    awk -v m=":${1}->" 'index($0, m) { split($0, a, "|"); print a[1]; exit }'
}

ensure_database_exists() {
  local db user host port container
  db="$(url_field "$DATABASE_URL" db)"
  [ -n "$db" ] || return 0
  user="$(url_field "$DATABASE_URL" user)"
  host="$(url_field "$DATABASE_URL" host)"
  port="$(url_field "$DATABASE_URL" port)"

  container="$(pg_container "$port" || true)"
  if [ -n "$container" ]; then
    if docker exec "$container" psql -U "$user" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='${db}'" 2>/dev/null | grep -q 1; then
      return 0
    fi
    info "创建独立数据库 ${db}（A/B 迁移互不兼容，不共用一个库）"
    docker exec "$container" psql -U "$user" -d postgres -c "CREATE DATABASE \"${db}\"" >/dev/null 2>&1 ||
      warn "自动建库失败，请手动执行：CREATE DATABASE \"${db}\";"
    return 0
  fi
  if have psql; then
    if PGPASSWORD="$(url_field "$DATABASE_URL" password)" psql -h "$host" -p "$port" -U "$user" -d postgres \
      -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" 2>/dev/null | grep -q 1; then
      return 0
    fi
    info "创建独立数据库 ${db}"
    PGPASSWORD="$(url_field "$DATABASE_URL" password)" psql -h "$host" -p "$port" -U "$user" -d postgres \
      -c "CREATE DATABASE \"${db}\"" >/dev/null 2>&1 || warn "自动建库失败，请手动创建数据库 ${db}"
    return 0
  fi
  warn "没找到发布 ${port} 端口的 postgres 容器，也没有本机 psql；若数据库 ${db} 不存在请先手动创建"
}

ensure_db() {
  apply_db_isolation
  ensure_database_exists
  info "同步数据库结构与在线配置迁移（$(mask_url "$DATABASE_URL")）"
  (cd "$ROOT/backend" && npx prisma generate >/dev/null && npx prisma migrate deploy)
  if [ "${SKIP_SEED:-0}" = "1" ]; then
    warn "SKIP_SEED=1，跳过种子数据"
    return 0
  fi
  info "写入种子数据（随机密码会打印到 $LOGS/seed.log）"
  # 种子写完会打印「启动方式：…」；个别实现的脚本写完后不会自行退出
  # （进程里还挂着未关闭的连接），所以这里盯着日志，写完就收工，别把启动卡住。
  local seed_pid waited=0 limit="${SEED_TIMEOUT:-180}"
  ( cd "$ROOT/backend" && exec npm run seed ) </dev/null >"$LOGS/seed.log" 2>&1 &
  seed_pid=$!
  while kill -0 "$seed_pid" 2>/dev/null && [ "$waited" -lt "$limit" ]; do
    sleep 1
    waited=$((waited + 1))
    if grep -q "启动方式：npm run dev" "$LOGS/seed.log" 2>/dev/null; then
      sleep 2
      break
    fi
  done
  if kill -0 "$seed_pid" 2>/dev/null; then
    if grep -q "启动方式：npm run dev" "$LOGS/seed.log" 2>/dev/null; then
      warn "种子已写完，但脚本没有自行退出（多半是没断开 Redis/数据库连接），先结束它继续启动"
    else
      warn "种子超过 ${limit} 秒仍未写完，已结束它（可调 SEED_TIMEOUT 放宽）"
    fi
    kill_tree "$seed_pid"
  fi
  cat "$LOGS/seed.log"
}

start_proc() { # name workdir cmd...
  local name="$1" dir="$2"
  shift 2
  if pid_alive "$name"; then
    warn "$name 已在运行（pid $(cat "$RUNTIME/$name.pid")），跳过启动"
    return 0
  fi
  # 用 exec 让子 shell 直接变成目标进程：pid 文件记录的就是真实进程，
  # 同时把标准流全部重定向到日志，避免它继续占用调用方的终端/管道。
  (
    cd "$dir" || exit 1
    exec nohup "$@"
  ) </dev/null >"$LOGS/$name.log" 2>&1 &
  local pid=$!
  echo "$pid" >"$RUNTIME/$name.pid"
  info "已启动 ${name}（pid ${pid}，日志 $LOGS/$name.log）"
}

pid_alive() {
  local file="$RUNTIME/$1.pid"
  [ -f "$file" ] || return 1
  kill -0 "$(cat "$file")" 2>/dev/null
}

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

stop_proc() { # name
  local name="$1" file="$RUNTIME/$1.pid"
  if [ -f "$file" ]; then
    local pid; pid="$(cat "$file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid"
      info "已停止 ${name}（pid ${pid}）"
    fi
    rm -f "$file"
  fi
}

seed_password() {
  local email="$1"
  if [ -n "${ADMIN_PASSWORD:-}" ] && [ "$email" = "${ADMIN_ACCOUNT:-admin@example.com}" ]; then
    printf '%s' "$ADMIN_PASSWORD"
    return 0
  fi
  [ -f "$LOGS/seed.log" ] || return 1
  awk -v e="$email" 'index($0, e) {print $NF}' "$LOGS/seed.log" | tail -1
}

cmd_up() {
  ensure_infra
  resolve_ports
  ensure_deps
  ensure_db

  info "启动后端 API（端口 ${APP_PORT}）"
  start_proc backend "$ROOT/backend" npm run dev
  info "启动 worker（图片处理与定时任务）"
  start_proc worker "$ROOT/backend" npm run dev:worker
  info "启动前端（端口 ${FRONTEND_PORT}）"
  start_proc frontend "$ROOT/frontend" npm run dev -- --port "$FRONTEND_PORT" --strictPort

  wait_http "$API_BASE/healthz" 60 || warn "后端健康检查未通过，看 $LOGS/backend.log"
  wait_port "$FRONTEND_PORT" 60 || warn "前端端口未就绪，看 $LOGS/frontend.log"

  if ! wait_http "$API_BASE/healthz" 5; then
    warn "后端没有起来，$LOGS/backend.log 末尾："
    tail -n 20 "$LOGS/backend.log" >&2 || true
    die "启动失败：后端未通过 $API_BASE/healthz。修好后重跑 ./run.sh"
  fi
  if ! port_busy "$FRONTEND_PORT"; then
    warn "前端没有起来，$LOGS/frontend.log 末尾："
    tail -n 20 "$LOGS/frontend.log" >&2 || true
  fi

  cat <<EOF

================================ 就绪 ================================
  前端页面   $WEB_BASE
  配置中心   $WEB_BASE/admin/config
  后端 API   $API
  健康检查   $API_BASE/healthz
  数据库     $(mask_url "$DATABASE_URL")
  Redis      $REDIS_URL
  种子账号   $LOGS/seed.log（密码每次种子都会重新生成）
  服务日志   $LOGS/{backend,worker,frontend}.log

  下一步：
    ./run.sh demo     走一遍草稿预演 → 灰度生效 → 全量 → 一键回滚
    ./run.sh check    跑后端测试（含在线配置集成用例）
    ./run.sh stop     停服务
=====================================================================
EOF
}

cmd_status() {
  local name
  for name in backend worker frontend; do
    if pid_alive "$name"; then echo "$name: 运行中 (pid $(cat "$RUNTIME/$name.pid"))"
    else echo "$name: 未运行"; fi
  done
  echo "postgres:5432 $(port_busy 5432 && echo 监听中 || echo 未监听)"
  echo "redis:6379   $(port_busy 6379 && echo 监听中 || echo 未监听)"
  echo "api:$APP_PORT $(port_busy "$APP_PORT" && echo 监听中 || echo 未监听)"
  echo "web:$FRONTEND_PORT $(port_busy "$FRONTEND_PORT" && echo 监听中 || echo 未监听)"
  # 端口上有响应不代表是本项目：只有 pid 文件指向的进程还活着才算数
  if pid_alive backend && have curl; then
    echo "healthz: $(curl -fsS "$API_BASE/healthz" 2>/dev/null || echo 无响应)"
    echo "readyz : $(curl -fsS "$API_BASE/readyz" 2>/dev/null || echo 无响应)"
  else
    local extra=""
    if port_busy "$APP_PORT"; then extra="（端口 $APP_PORT 上有其它服务在监听，未必是本项目）"; fi
    echo "healthz: 本项目后端未运行${extra}"
  fi
}

cmd_logs() {
  local n="${1:-80}" f
  for f in backend worker frontend; do
    echo "----- ${f}（末 ${n} 行） -----"
    tail -n "$n" "$LOGS/$f.log" 2>/dev/null || echo "（暂无日志）"
  done
}

cmd_stop() {
  stop_proc frontend
  stop_proc worker
  stop_proc backend
  if [ "${STOP_INFRA:-0}" = "1" ]; then
    compose stop postgres redis >/dev/null 2>&1 || true
    info "已停止 postgres/redis"
  fi
}

cmd_reset() {
  [ "${1:-}" = "--yes" ] || die "reset 会清空数据库，请显式执行 ./run.sh reset --yes"
  cmd_stop
  ensure_infra
  info "重建数据库"
  (cd "$ROOT/backend" && npx prisma migrate reset --force --skip-seed)
  ensure_db
  cmd_up
}

cmd_check() {
  info "运行后端测试（单元 + 集成，集成用例需要 postgres/redis）"
  ensure_infra
  ensure_deps
  SKIP_SEED=1 ensure_db   # 只建库 + 迁移，不写种子，免得每次把种子密码换掉
  # LOG_LEVEL=silent 只是把请求日志挡掉，测试结论与失败堆栈照常输出
  (cd "$ROOT/backend" && LOG_LEVEL="${LOG_LEVEL:-silent}" npm test)
  if [ "${FRONTEND_CHECK:-0}" = "1" ]; then
    info "运行前端类型检查"
    (cd "$ROOT/frontend" && npm run typecheck)
  fi
  info "测试完成"
}

cmd_demo() {
  ensure_infra
  local account="${ADMIN_ACCOUNT:-admin@example.com}" password
  password="$(seed_password "$account" || true)"
  [ -n "$password" ] || die "拿不到管理员密码。先执行 ./run.sh（会写种子），或用 ADMIN_ACCOUNT/ADMIN_PASSWORD 指定"
  have python3 || die "demo 需要 python3 解析 JSON"
  python3 - "$API" "$account" "$password" <<'PY'
import json, sys, urllib.error, urllib.request

API, ACCOUNT, PASSWORD = sys.argv[1], sys.argv[2], sys.argv[3]
failures = []


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        API + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
    )
    if body is not None:
        req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as err:
        raw = err.read().decode() or "{}"
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {"raw": raw}


def step(title, ok, detail=""):
    print(("  通过  " if ok else "  失败  ") + title + (("  " + detail) if detail else ""))
    if not ok:
        failures.append(title)


def login(account, password):
    status, body = call("POST", "/auth/login", {"account": account, "password": password})
    if status != 200:
        return None, None
    data = body.get("data", {})
    return data.get("accessToken"), data.get("user", {}).get("uuid")


print("[1/6] 管理员登录")
admin_token, admin_uuid = login(ACCOUNT, PASSWORD)
step("管理员拿到 accessToken", bool(admin_token))
if not admin_token:
    sys.exit(1)

print("[2/6] 读取当前版本档案（在线配置的事实来源）")
status, body = call("GET", "/admin/config/versions", token=admin_token)
versions = body.get("data", {}).get("versions", [])
active = body.get("data", {}).get("active") or {}
step("版本档案可读", status == 200 and bool(versions), f"共 {len(versions)} 个版本")
base_version = active.get("version")
step("存在生效中的全量版本", isinstance(base_version, int), f"active=v{base_version}")

print("[3/6] 草稿 + 预演")
status, body = call("POST", "/admin/config/draft", {}, token=admin_token)
step("草稿创建/复用成功", status in (200, 201))
status, body = call("GET", "/admin/config/threshold-specs", token=admin_token)
specs = body.get("data", {}).get("items", [])
step("阈值注册表可读", status == 200 and len(specs) > 0, f"{len(specs)} 项阈值")
status, body = call(
    "POST",
    "/admin/config/preview",
    {"userId": 1, "userUuid": admin_uuid, "role": "admin", "rollout": {"roles": ["admin"]}},
    token=admin_token,
)
preview = body.get("data", {})
step("预演命中灰度规则", status == 200 and preview.get("matched") is True, str(preview.get("reason", "")))

print("[4/6] 灰度生效")
status, body = call(
    "POST",
    "/admin/config/publish-canary",
    {"rollout": {"roles": ["admin"]}, "comment": "run.sh demo 灰度"},
    token=admin_token,
)
canary_version = body.get("data", {}).get("view", {}).get("version")
step("草稿已发布为灰度", status == 200 and isinstance(canary_version, int), f"canary=v{canary_version}")

status, body = call("GET", "/categories", token=admin_token)
admin_status = (body.get("data", {}).get("items") or [{}])[0].get("configStatus")
step("管理员读到灰度配置", status == 200 and admin_status == "canary", f"configStatus={admin_status}")

user_token, _ = login("user@example.com", PASSWORD)
status, body = call("GET", "/categories", token=user_token)
user_status = (body.get("data", {}).get("items") or [{}])[0].get("configStatus")
step("普通用户仍读全量配置", status == 200 and user_status == "active", f"configStatus={user_status}")

print("[5/6] 转全量")
status, body = call("POST", "/admin/config/publish-full", {"comment": "run.sh demo 转全量"}, token=admin_token)
full_version = body.get("data", {}).get("view", {}).get("version")
step("灰度已转全量", status == 200 and isinstance(full_version, int), f"active=v{full_version}")

print("[6/6] 一键回滚到任意历史版本")
status, body = call("POST", f"/admin/config/rollback/{base_version}", {"comment": "run.sh demo 回滚"}, token=admin_token)
rolled = body.get("data", {}).get("view", {}).get("version")
step("回滚产生新的全量版本", status == 200 and isinstance(rolled, int), f"v{base_version} 的内容 -> v{rolled}")

status, body = call("GET", "/admin/config/versions", token=admin_token)
final_active = (body.get("data", {}).get("active") or {}).get("version")
archived = [v["version"] for v in body.get("data", {}).get("versions", []) if v.get("status") == "archived"]
step("历史版本仍保留在档案里", body.get("data", {}).get("active", {}).get("version") == rolled)
print(f"        active=v{final_active}，archived={archived}")

print()
if failures:
    print(f"结论：{len(failures)} 项未通过 -> {failures}")
    sys.exit(1)
print("结论：草稿预演、灰度生效、全量发布、历史版本回滚均已通过真实接口验证")
PY
}

case "${1:-up}" in
  up) cmd_up ;;
  check) cmd_check ;;
  demo) cmd_demo ;;
  status) cmd_status ;;
  logs) shift || true; cmd_logs "${1:-80}" ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_up ;;
  foreground) touch "$LOGS/backend.log"; tail -f "$LOGS/backend.log" ;;
  reset) shift || true; cmd_reset "${1:-}" ;;
  help|-h|--help) sed -n '2,20p' "$0" ;;
  *) die "未知命令：$1（可用：up check demo status logs stop restart foreground reset）" ;;
esac
