import type { RuntimeConfig, SubscriptionNode } from "./config";

export function renderSubscriptionResponse(pathname: string, host: string, config: RuntimeConfig): Response | null {
  const basePath = `/${config.userIdText}`;
  if (pathname === basePath) return htmlResponse(renderHome(host, config));
  if (pathname === `${basePath}/pty`) return textResponse(toBase64(renderVlessLinks(host, config)));
  if (pathname === `${basePath}/pcl`) return textResponse(renderClash(host, config));
  if (pathname === `${basePath}/psb`) return jsonTextResponse(renderSingBox(host, config));
  return null;
}

export function renderVlessLinks(host: string, config: RuntimeConfig): string {
  return config.subscriptionNodes.map((node) => renderVlessLink(host, config.userIdText, node)).join("\n");
}

export function renderClash(host: string, config: RuntimeConfig): string {
  const proxyBlocks = config.subscriptionNodes.map((node) => [
    `  - name: ${yamlQuote(node.name)}`,
    "    type: vless",
    `    server: ${yamlQuote(node.hostname)}`,
    `    port: ${node.port}`,
    `    uuid: ${yamlQuote(config.userIdText)}`,
    "    udp: false",
    "    tls: true",
    `    servername: ${yamlQuote(host)}`,
    "    network: ws",
    "    ws-opts:",
    "      path: /?ed=2560",
    "      headers:",
    `        Host: ${yamlQuote(host)}`,
  ].join("\n")).join("\n");
  const names = config.subscriptionNodes.map((node) => `      - ${yamlQuote(node.name)}`).join("\n");

  return [
    "mixed-port: 7890",
    "allow-lan: true",
    "mode: rule",
    "log-level: warning",
    "proxies:",
    proxyBlocks,
    "proxy-groups:",
    "  - name: Auto",
    "    type: url-test",
    "    url: https://www.gstatic.com/generate_204",
    "    interval: 300",
    "    tolerance: 50",
    "    proxies:",
    names,
    "  - name: Proxy",
    "    type: select",
    "    proxies:",
    "      - Auto",
    ...config.subscriptionNodes.map((node) => `      - ${yamlQuote(node.name)}`),
    "      - DIRECT",
    "rules:",
    "  - GEOIP,LAN,DIRECT,no-resolve",
    "  - GEOIP,CN,DIRECT,no-resolve",
    "  - MATCH,Proxy",
    "",
  ].join("\n");
}

export function renderSingBox(host: string, config: RuntimeConfig): string {
  const outbounds = config.subscriptionNodes.map((node) => ({
    type: "vless",
    tag: node.name,
    server: node.hostname,
    server_port: node.port,
    uuid: config.userIdText,
    tls: { enabled: true, server_name: host, insecure: false },
    transport: { type: "ws", path: "/?ed=2560", headers: { Host: host } },
  }));
  return JSON.stringify({
    log: { level: "warn", timestamp: true },
    outbounds: [
      { type: "selector", tag: "Proxy", default: "Auto", outbounds: ["Auto", ...outbounds.map((item) => item.tag), "direct"] },
      { type: "urltest", tag: "Auto", outbounds: outbounds.map((item) => item.tag), url: "https://www.gstatic.com/generate_204", interval: "5m", tolerance: 50 },
      ...outbounds,
      { type: "direct", tag: "direct" },
    ],
  }, null, 2);
}

function renderVlessLink(host: string, uuid: string, node: SubscriptionNode): string {
  const query = new URLSearchParams({
    encryption: "none",
    security: "tls",
    sni: host,
    fp: "randomized",
    type: "ws",
    host,
    path: "/?ed=2560",
  });
  const address = node.hostname.includes(":") ? `[${node.hostname}]` : node.hostname;
  return `vless://${uuid}@${address}:${node.port}?${query.toString()}#${encodeURIComponent(node.name)}`;
}

function renderHome(host: string, config: RuntimeConfig): string {
  const base = `https://${host}/${config.userIdText}`;
  const links = [
    ["通用订阅", `${base}/pty`],
    ["Clash Meta", `${base}/pcl`],
    ["Sing-box", `${base}/psb`],
  ];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloudflare VLESS</title><style>body{max-width:760px;margin:48px auto;padding:0 20px;font:16px/1.6 system-ui;color:#18212f}code{overflow-wrap:anywhere}li{margin:12px 0}.ok{color:#08783e}</style></head><body><h1>Cloudflare VLESS</h1><p class="ok">已启用安全精简配置：仅生成 443、2083、2087、2096 四个 TLS 节点。</p><ul>${links.map(([label, url]) => `<li>${escapeHtml(label)}：<code>${escapeHtml(url)}</code></li>`).join("")}</ul><p>ProxyIP 故障切换在服务端自动完成，不需要修改客户端订阅。</p></body></html>`;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function textResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function jsonTextResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function htmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}
