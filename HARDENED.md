# Hardened Worker（可回退版本）

这是在上游脚本之外新增的可读、可测试版本。原来的 `Vless_workers_pages/_worker.js` 与 `_worker明.js` 均保留，因此可以随时回退。

## 已解决的问题

- UUID 不再写死在源码里，也不会出现在日志中；部署前必须设置 `uuid` Secret。
- UUID、ProxyIP、节点和端口均为请求内只读配置，不再跨请求共享可变全局状态。
- `/pyip=` 默认关闭；开启后也只能选择 `proxyip` 中已配置的地址。
- 所有异步管道均交给 `ctx.waitUntil()` 跟踪，连接错误会被明确收敛。
- WebSocket 后续二进制帧兼容 ArrayBuffer、TypedArray 和 Blob，避免 TLS 握手后数据被误转换为空帧。
- 订阅只生成 443、2083、2087、2096 四个 TLS 节点，移除当前环境不需要的 8443/2053。
- 直连和 ProxyIP 均有首字节超时；ProxyIP 支持按批次并发拨号、TLS 响应校验和首字节竞速，落选连接立即关闭。
- staging 每 6 小时从 HK/JP 发现源更新一次 KV 动态备用池，按区域轮转选优；发现失败或池过期时自动保留/回退静态候选。
- 配置页不再加载第三方 JS/CSS，未知 HTTP 路径返回 404。

## 安全的部署顺序

1. 本地安装依赖并检查：`npm install && npm run check && npm test`。
2. 先部署为独立测试 Worker：`npm run deploy:staging`。默认名称是 `cloudflare-vless-trojan-hardened-staging`，不会覆盖现有 Worker。
3. 设置独立测试 UUID Secret：`npx wrangler secret put uuid --env staging`。
4. 在 staging 的 `wrangler.jsonc` 中设置静态 `proxyip` 兜底和专用 `PROXY_POOL` KV 绑定。
5. 先用临时 workers.dev 域名验证订阅和代理，再把自定义域切换到新 Worker。

## 变量

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `uuid` | 无 | 必填 Secret，可用逗号分隔多个 UUID |
| `proxyip` | 空 | ProxyIP 候选列表，逗号分隔，按顺序分批竞速 |
| `PROXY_CONCURRENT_DIAL` | `2` | 并发拨号上限，范围 1–3 |
| `CONNECT_TIMEOUT_MS` | `1800` | TCP 建连超时，范围 500–10000ms |
| `FIRST_BYTE_TIMEOUT_MS` | `3000` | 直连与 ProxyIP 首字节超时，范围 500–15000ms |
| `ALLOW_PATH_PROXYIP` | `false` | 是否允许 `/pyip=`；即使开启也仅限 `proxyip` 白名单 |
| `DEBUG` | `false` | 调试日志；日志不包含 UUID、目标域名或数据内容 |
| `PROXY_DISCOVERY_HOSTS` | HK、JP 发现域名 | 动态候选发现源，逗号分隔 |
| `PROXY_DISCOVERY_SAMPLE_SIZE` | `24` | 每轮最多预筛的候选数，范围 2–48 |
| `PROXY_POOL_SIZE` | `6` | 写入 KV 的动态候选数，范围 2–8 |
| `PROXY_PROBE_CONCURRENCY` | `4` | 定时预筛并发数，范围 1–4 |
| `PROXY_PROBE_TIMEOUT_MS` | `1500` | 单个候选 TCP 预筛超时，范围 500–5000ms |
| `PROXY_POOL_MAX_AGE_MS` | `86400000` | 动态池最大有效期；过期后只用静态兜底 |

节点地址仍兼容 `ip8/ip11/ip12/ip13` 与 `pt8/pt11/pt12/pt13`。生产环境建议保持 `ALLOW_PATH_PROXYIP=false` 和 `DEBUG=false`。

## 回退

新版本以独立 Worker 验证，不覆盖旧 Worker。切换自定义域前记录旧 Worker 名称；如出现问题，把自定义域重新绑定旧 Worker 即可。仓库中原始上游脚本也未修改。
