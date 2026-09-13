export interface ProxyEndpoint {
  hostname: string;
  port: number;
}

export interface SubscriptionNode extends ProxyEndpoint {
  name: string;
}

export interface RuntimeConfig {
  userIds: Uint8Array[];
  userIdText: string;
  proxyEndpoints: ProxyEndpoint[];
  subscriptionNodes: SubscriptionNode[];
  proxyConcurrentDial: number;
  connectTimeoutMs: number;
  firstByteTimeoutMs: number;
  allowPathProxyIp: boolean;
  debug: boolean;
}

export interface RuntimeEnv {
  uuid?: string;
  proxyip?: string;
  PROXY_IPS?: string;
  PROXY_CONCURRENT_DIAL?: string;
  CONNECT_TIMEOUT_MS?: string;
  FIRST_BYTE_TIMEOUT_MS?: string;
  ALLOW_PATH_PROXYIP?: string;
  DEBUG?: string;
  ip8?: string;
  ip11?: string;
  ip12?: string;
  ip13?: string;
  pt8?: string;
  pt11?: string;
  pt12?: string;
  pt13?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST_LABEL_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

const DEFAULT_TLS_NODES: ReadonlyArray<SubscriptionNode> = [
  { name: "CF_TLS_443", hostname: "usa.visa.com", port: 443 },
  { name: "CF_TLS_2083", hostname: "www.visaeurope.ch", port: 2083 },
  { name: "CF_TLS_2087", hostname: "www.visa.com.br", port: 2087 },
  { name: "CF_TLS_2096", hostname: "www.visasoutheasteurope.com", port: 2096 },
];

export function parseUuid(uuid: string): Uint8Array {
  const normalized = uuid.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error("uuid must be an RFC 4122 version 4 UUID");
  }
  const hex = normalized.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

export function parseEndpoint(value: string): ProxyEndpoint {
  const input = value.trim();
  if (!input || input.length > 300 || /[\s/?#@]/.test(input)) {
    throw new Error("invalid proxy endpoint");
  }

  let hostname = input;
  let port = 443;
  if (input.startsWith("[")) {
    const match = input.match(/^\[([0-9a-f:.]+)](?::(\d{1,5}))?$/i);
    if (!match || !isIpv6(match[1])) throw new Error("invalid IPv6 proxy endpoint");
    hostname = match[1];
    port = parsePort(match[2]);
  } else {
    const colonCount = (input.match(/:/g) ?? []).length;
    if (colonCount > 1) throw new Error("IPv6 proxy endpoints must use brackets");
    if (colonCount === 1) {
      const separator = input.lastIndexOf(":");
      hostname = input.slice(0, separator);
      port = parsePort(input.slice(separator + 1));
    }
    if (!isIpv4(hostname) && !isHostname(hostname)) throw new Error("invalid proxy hostname");
  }

  return { hostname: hostname.toLowerCase(), port };
}

export function parseEndpointList(value: string | undefined): ProxyEndpoint[] {
  if (!value?.trim()) return [];
  const unique = new Map<string, ProxyEndpoint>();
  for (const item of value.split(",")) {
    const endpoint = parseEndpoint(item);
    unique.set(endpointKey(endpoint), endpoint);
  }
  return [...unique.values()];
}

export function endpointKey(endpoint: ProxyEndpoint): string {
  return `${endpoint.hostname.toLowerCase()}:${endpoint.port}`;
}

export function buildRuntimeConfig(env: RuntimeEnv): RuntimeConfig {
  const userIdTexts = (env.uuid ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (userIdTexts.length === 0) throw new Error("missing uuid secret");
  const userIds = userIdTexts.map(parseUuid);
  const proxyEndpoints = parseEndpointList(env.proxyip ?? env.PROXY_IPS);
  if (proxyEndpoints.length > 8) throw new Error("at most 8 ProxyIP endpoints are allowed");

  return {
    userIds,
    userIdText: userIdTexts[0],
    proxyEndpoints,
    subscriptionNodes: buildSubscriptionNodes(env),
    proxyConcurrentDial: readInteger(env.PROXY_CONCURRENT_DIAL, 2, 1, 3),
    connectTimeoutMs: readInteger(env.CONNECT_TIMEOUT_MS, 1800, 500, 10_000),
    firstByteTimeoutMs: readInteger(env.FIRST_BYTE_TIMEOUT_MS, 3000, 500, 15_000),
    allowPathProxyIp: readBoolean(env.ALLOW_PATH_PROXYIP, false),
    debug: readBoolean(env.DEBUG, false),
  };
}

export function selectPathProxyEndpoints(pathname: string, config: RuntimeConfig): ProxyEndpoint[] | null {
  if (pathname === "/") return null;
  if (!pathname.startsWith("/pyip=")) throw new Error("unsupported WebSocket path");
  if (!config.allowPathProxyIp) throw new Error("path ProxyIP override is disabled");

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(6));
  } catch {
    throw new Error("invalid encoded ProxyIP override");
  }
  const requested = parseEndpointList(decoded);
  if (requested.length === 0) throw new Error("empty ProxyIP override");
  const allowed = new Set(config.proxyEndpoints.map(endpointKey));
  if (requested.some((endpoint) => !allowed.has(endpointKey(endpoint)))) {
    throw new Error("ProxyIP override is not in the configured allowlist");
  }
  return requested;
}

function buildSubscriptionNodes(env: RuntimeEnv): SubscriptionNode[] {
  const slots = [
    ["ip8", "pt8"],
    ["ip11", "pt11"],
    ["ip12", "pt12"],
    ["ip13", "pt13"],
  ] as const;
  return slots.map(([ipKey, portKey], index) => {
    const fallback = DEFAULT_TLS_NODES[index];
    const endpoint = parseEndpoint(`${env[ipKey] ?? fallback.hostname}:${env[portKey] ?? fallback.port}`);
    return { ...endpoint, name: `CF_TLS_${endpoint.port}_${index + 1}` };
  });
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 443;
  if (!/^\d{1,5}$/.test(value)) throw new Error("invalid proxy port");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 25) {
    throw new Error("proxy port is not allowed");
  }
  return port;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

function isHostname(value: string): boolean {
  return value.length <= 253 && value.split(".").every((label) => HOST_LABEL_PATTERN.test(label));
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error("invalid numeric configuration");
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) throw new Error("numeric configuration is out of range");
  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("boolean configuration must be true or false");
}
