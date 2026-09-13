# Hardened Worker（可回退版本）

这是在上游脚本之外新增的可读、可测试版本。原来的 `Vless_workers_pages/_worker.js` 与 `_worker明.js` 均保留，因此可以随时回退。

## 已解决的问题

- UUID 不再写死在源码里，也不会出现在日志中；部署前必须设置 `uuid` Secret。
- UUID、ProxyIP、节点和端口均为请求内只读配置，不再跨请求共享可变全局状态。
- `/pyip=` 默认关闭；开启后也只能选择 `proxyip` 中已配置的地址。
- 所有异步管道均交给 `ctx.waitUntil()` 跟踪，连接错误会被明确收敛。
- 订阅只生成 443、2083、2087、2096 四个 TLS 节点，移除当前环境不需要的 8443/2053。
- ProxyIP 支持逗号分隔的候选列表，按批次并发拨号并以首字节竞速，落选连接立即关闭。
- 配置页不再加载第三方 JS/CSS，未知 HTTP 路径返回 404。

## 安全的部署顺序

1. 本地安装依赖并检查：`npm install && npm run check && npm test`。
2. 先部署为独立 Worker：`npm run deploy`。默认名称是 `cloudflare-vless-trojan-hardened`，不会覆盖现有 Worker。
3. 设置 UUID Secret：`npx wrangler secret put uuid`。
4. 在 Cloudflare 控制台设置普通变量 `proxyip`，例如：`proxyip.hk.fxxk.dedyn.io,proxyip.jp.fxxk.dedyn.io`。
5. 先用临时 workers.dev 域名验证订阅和代理，再把自定义域切换到新 Worker。

## 变量

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `uuid` | 无 | 必填 Secret，可用逗号分隔多个 UUID |
| `proxyip` | 空 | ProxyIP 候选列表，逗号分隔，按顺序分批竞速 |
| `PROXY_CONCURRENT_DIAL` | `2` | 并发拨号上限，范围 1–3 |
| `CONNECT_TIMEOUT_MS` | `1800` | TCP 建连超时，范围 500–10000ms |
| `FIRST_BYTE_TIMEOUT_MS` | `3000` | ProxyIP 首字节超时，范围 500–15000ms |
| `ALLOW_PATH_PROXYIP` | `false` | 是否允许 `/pyip=`；即使开启也仅限 `proxyip` 白名单 |
| `DEBUG` | `false` | 调试日志；日志不包含 UUID、目标域名或数据内容 |

节点地址仍兼容 `ip8/ip11/ip12/ip13` 与 `pt8/pt11/pt12/pt13`。生产环境建议保持 `ALLOW_PATH_PROXYIP=false` 和 `DEBUG=false`。

## 回退

新版本以独立 Worker 验证，不覆盖旧 Worker。切换自定义域前记录旧 Worker 名称；如出现问题，把自定义域重新绑定旧 Worker 即可。仓库中原始上游脚本也未修改。
