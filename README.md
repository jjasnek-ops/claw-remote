# Claw Remote

自研的远程管控面板——把服务器上所有 tmux 会话、任务状态、服务器指标收进一个网页，手机上点一下就能切进任意会话接管。

## 架构

三个后端服务（其实是同一个 `claw-openclaw.py`，靠 `--port` / `--tmux-socket` 区分），各盯一个 tmux socket：

| 后端 | 端口 | tmux socket |
|------|------|-------------|
| Claude  | 18084 | claude-code.sock |
| Codex   | 18085 | codex-code.sock |
| Default | 18086 | default-code.sock |

前面再架一个 Caddy 门户（:8080）做统一入口，按路径分发到三个后端；外层用 Traefik 绑定正式域名（部署时把 `portal/docker-compose.yml` 里的 `your-domain.com` 换成你的域名）。

## 目录

- `backend/claw-openclaw.py` — 三合一后端（HTTP API + tmux 控制 + 内嵌前端）
- `frontend/claw-remote/` — 独立前端资源
- `portal/` — Caddyfile + docker-compose（门户容器）+ 落地页
- `scripts/` — clear-port / restore-sessions / snapshot 等配套脚本
- `deploy/systemd/` — 5 个 systemd unit（claude / codex / default / portal / restore）

## 后端 API

- GET：`/api/data`（主面板数据 + 服务器指标）、`/api/pane`（会话终端快照）、`/api/git`、`/api/prompts` …
- POST：`/api/send`（投递指令）、`/api/control`、`/api/session/create`、`/api/session/delete` …

路径带 `/claude` / `/codex` / `/default` 前缀区分后端。

## 部署

1. 前置条件：安装 `tmux`、Python 3，以及需要从面板启动的 CLI。使用 `+ Codex` 前先确认 `codex --version` 可用并完成 `codex login`；使用 `+ Claude` 前先完成 Claude Code 的安装和登录。
2. 三个后端：把 `deploy/systemd/openclaw-claw-{claude,codex,default}.service` 里的脚本路径改成你的安装路径，`systemctl enable --now` 启动。`--host` 是 docker 网桥 IP（默认 bridge 网关），按你的 docker 网络调整。
3. 门户：`cd portal && docker compose up -d`（先改 `docker-compose.yml` 里的 `your-domain.com`）。
4. 后端会读模型路由配置 `~/.claude/runtime-routing.json`（结构见 dispatch 仓库的 `config/runtime-routing.example.json`）；面板本身的会话/指标展示不依赖它。

点击 `+ Codex` 后，后端会通过登录 Shell 解析 npm/NVM 安装的 `codex`，并在返回成功前确认 Codex 进程确实在 tmux 中运行。若 CLI 未安装、未登录或启动后立即退出，界面会显示真实失败，而不会留下一个空会话。

> tmux socket 统一挂 `/tmp/clawdbot-tmux-sockets/`，三个后端 + 任何往里挂会话的脚本都要用这个目录，否则面板看不到会话。
