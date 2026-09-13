# dsh-proxy

本项目用 Nginx 为未经修改的 DeepSeek Harness Web 提供单用户远程反向代理：

```text
浏览器 → Nginx :3000 → dsh web :3081 (loopback)
                    ↘ auth_request :3082 (loopback)
```

Nginx Cookie 登录保护页面、API、流式响应和 WebSocket；Harness 自己的启动 token 与签名 Cookie 仍是最终鉴权。项目不依赖 `--trust-proxy-auth`，不修改或重新构建 Harness 源码。

## 准备与启动

要求 Node.js `^22.19` 或 `>=24`、Nginx，以及 PATH 中可执行的 `dsh`。项目没有 npm 依赖。

```sh
cp .env.example .env
openssl rand -hex 32
chmod 600 .env
```

编辑 `.env` 中的 `PUBLIC_ORIGIN`、`AUTH_USER`、`AUTH_PASS` 和 `SESSION_SECRET`，然后启动：

```sh
./start.sh
```

启动器会先执行 `nginx -t`，等待原版 Harness 就绪后启动认证服务和前台 Nginx。启动器会在内部接收 Harness 的启动 token，并输出一条诊断用的公网形式 URL：

```text
dsh-proxy: open https://dsh.example.com/?token=...
```

首次打开根地址会进入代理登录页。用户名和密码验证成功后，反代会自动把浏览器带到一次性 token 交换地址，由 Harness 签发自己的 Cookie，再自动跳转到干净的 Web UI；用户不需要复制、保存或输入 token。打印的 token URL 仅用于故障排查。

## 使用源码仓库中的 dsh

未全局安装 `dsh` 时，在 `.env` 中配置：

```dotenv
DSH_BIN=pnpm
DSH_ARGS_JSON=["--dir","/workspace/github/deepseek-harness","dsh","web"]
```

启动器会在这些参数后追加 `--no-open --host 127.0.0.1 --port 3081 --trusted-host <PUBLIC_ORIGIN authority>`。

## HTTPS

仓库配置在 `0.0.0.0:3000` 提供 HTTP，以匹配容器开放端口；它适合在 Cloudflare Tunnel、云负载均衡器或另一层 Nginx 后运行。公网入口必须终止 HTTPS，并保留原始 `Host` 和 `Origin`。

若由本项目的 Nginx 直接终止 TLS，请在 `nginx/dsh-web.conf` 中把监听器改为：

```nginx
listen 443 ssl;
server_name dsh.example.com;
ssl_certificate /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;
```

## 外部管理 DSH

若 systemd 或 Docker 已启动 DSH，设置 `MANAGE_DSH=0`。外部命令必须等价于：

```sh
dsh web --no-open --host 127.0.0.1 --port 3081 --trusted-host dsh.example.com
```

此时启动器无法从外部进程读取启动 token。若希望登录后仍自动完成 Harness 首次授权，在 `.env` 中额外设置外部 DSH 当前进程的 `DSH_LAUNCH_TOKEN`；否则需要使用 DSH 输出的 token URL 完成首次授权。

## 安全说明

- 3081 与 3082 始终只应绑定 loopback。
- Nginx 不伪造本机来源或绕过 Harness 鉴权，而是保留公网 Host/Origin，通过官方 `trustedHosts` 栅栏。
- `PUBLIC_ORIGIN` 必须和浏览器地址栏一致，包括非默认端口。
- 公网浏览器仍保持 Harness 的 remote 语义；完整本机权限应使用 SSH 本地端口转发。
- `.env` 含明文密码与签名 secret，权限应保持 `0600`。

## 检查

```sh
npm run check
npm test
nginx -p "$PWD/" -c nginx/nginx.conf -t
```
