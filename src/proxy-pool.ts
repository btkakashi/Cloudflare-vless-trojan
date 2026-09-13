import { connect } from "cloudflare:sockets";
import { endpointKey, parseEndpoint, parseEndpointList, type ProxyEndpoint } from "./config";

const POOL_KEY = "active-v1";
const DOH_URL = "https://cloudflare-dns.com/dns-query";

export interface ProxyPoolEnv {
  PROXY_POOL?: KVNamespace;
  PROXY_DISCOVERY_HOSTS?: string;
  PROXY_DISCOVERY_SAMPLE_SIZE?: string;
  PROXY_POOL_SIZE?: string;
  PROXY_PROBE_CONCURRENCY?: string;
  PROXY_PROBE_TIMEOUT_MS?: string;
  PROXY_POOL_MAX_AGE_MS?: string;
}

interface PoolRecord {
  version: 1;
  updatedAt: number;
  endpoints: string[];
  latencyMs: Record<string, number>;
}

interface DnsJsonResponse {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

export interface ProbeResult {
  endpoint: ProxyEndpoint;
  latencyMs: number;
  source: string;
}

interface DiscoveryCandidate {
  endpoint: ProxyEndpoint;
  source: string;
}

export async function loadProxyPool(env: ProxyPoolEnv): Promise<ProxyEndpoint[]> {
  if (!env.PROXY_POOL) return [];
  try {
    const record = await env.PROXY_POOL.get<PoolRecord>(POOL_KEY, "json");
    if (!isPoolRecord(record)) return [];
    const maxAgeMs = readInteger(env.PROXY_POOL_MAX_AGE_MS, 86_400_000, 3_600_000, 604_800_000);
    if (Date.now() - record.updatedAt > maxAgeMs) return [];
    return parseEndpointList(record.endpoints.join(",")).slice(0, 8);
  } catch (error) {
    console.error(JSON.stringify({ event: "proxy_pool_read_failed", error: errorMessage(error) }));
    return [];
  }
}

export function mergeProxyEndpoints(dynamicEndpoints: ProxyEndpoint[], staticEndpoints: ProxyEndpoint[]): ProxyEndpoint[] {
  const merged = new Map<string, ProxyEndpoint>();
  for (const endpoint of [...dynamicEndpoints, ...staticEndpoints]) merged.set(endpointKey(endpoint), endpoint);
  return [...merged.values()].slice(0, 8);
}

export async function refreshProxyPool(env: ProxyPoolEnv): Promise<void> {
  if (!env.PROXY_POOL) throw new Error("PROXY_POOL binding is missing");
  const discoveryHosts = parseDiscoveryHosts(env.PROXY_DISCOVERY_HOSTS);
  const discoveredGroups = await Promise.all(discoveryHosts.map(async (source) => ({
    source,
    endpoints: await resolveIpv4(source),
  })));
  const discovered = deduplicate(discoveredGroups.flatMap(({ source, endpoints }) => (
    endpoints.map((endpoint) => ({ endpoint, source }))
  )));
  const sampleSize = readInteger(env.PROXY_DISCOVERY_SAMPLE_SIZE, 24, 2, 48);
  const perSourceSampleSize = Math.max(2, Math.ceil(sampleSize / Math.max(1, discoveredGroups.length)));
  const sample = deduplicate(discoveredGroups.flatMap(({ source, endpoints }) => (
    selectRotatingSample(endpoints, perSourceSampleSize, Date.now()).map((endpoint) => ({ endpoint, source }))
  ))).slice(0, sampleSize);
  const timeoutMs = readInteger(env.PROXY_PROBE_TIMEOUT_MS, 1500, 500, 5000);
  const concurrency = readInteger(env.PROXY_PROBE_CONCURRENCY, 4, 1, 4);
  const reachable = await probeCandidates(sample, timeoutMs, concurrency);
  const poolSize = readInteger(env.PROXY_POOL_SIZE, 6, 2, 8);
  const selected = selectDiversePool(reachable, poolSize);
  if (selected.length < 2) throw new Error("fewer than two reachable ProxyIP candidates; existing pool preserved");

  const record: PoolRecord = {
    version: 1,
    updatedAt: Date.now(),
    endpoints: selected.map(({ endpoint }) => endpointKey(endpoint)),
    latencyMs: Object.fromEntries(selected.map(({ endpoint, latencyMs }) => [endpointKey(endpoint), latencyMs])),
  };
  await env.PROXY_POOL.put(POOL_KEY, JSON.stringify(record), { expirationTtl: 172_800 });
  console.log(JSON.stringify({
    event: "proxy_pool_refreshed",
    discovered: discovered.length,
    probed: sample.length,
    reachable: reachable.length,
    selected: selected.length,
    bestLatencyMs: selected[0]?.latencyMs,
  }));
}

function parseDiscoveryHosts(value: string | undefined): string[] {
  const inputs = (value ?? "proxyip.hk.fxxk.dedyn.io,proxyip.jp.fxxk.dedyn.io")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const hosts = inputs.slice(0, 8).map((item) => parseEndpoint(item).hostname);
  return [...new Set(hosts)];
}

async function resolveIpv4(hostname: string): Promise<ProxyEndpoint[]> {
  const url = new URL(DOH_URL);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", "A");
  const response = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!response.ok) throw new Error(`ProxyIP discovery returned ${response.status}`);
  const body = await response.json<DnsJsonResponse>();
  if (body.Status !== 0) throw new Error(`ProxyIP DNS lookup failed with status ${body.Status ?? "unknown"}`);
  return (body.Answer ?? [])
    .filter((answer) => answer.type === 1 && typeof answer.data === "string")
    .map((answer) => parseEndpoint(`${answer.data}:443`));
}

function deduplicate(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  return [...new Map(candidates.map((candidate) => [endpointKey(candidate.endpoint), candidate])).values()];
}

export function selectRotatingSample(endpoints: ProxyEndpoint[], limit: number, nowMs: number): ProxyEndpoint[] {
  const rotation = Math.floor(nowMs / 21_600_000);
  return [...endpoints]
    .sort((left, right) => stableScore(`${rotation}:${endpointKey(left)}`) - stableScore(`${rotation}:${endpointKey(right)}`))
    .slice(0, limit);
}

async function probeCandidates(candidates: DiscoveryCandidate[], timeoutMs: number, concurrency: number): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    const batch = candidates.slice(offset, offset + concurrency);
    const settled = await Promise.all(batch.map((candidate) => probeCandidate(candidate, timeoutMs)));
    for (const result of settled) if (result) results.push(result);
  }
  return results;
}

async function probeCandidate(candidate: DiscoveryCandidate, timeoutMs: number): Promise<ProbeResult | null> {
  const { endpoint, source } = candidate;
  const startedAt = Date.now();
  const socket = connect(endpoint);
  try {
    await withTimeout(socket.opened, timeoutMs, "ProxyIP probe timeout");
    return { endpoint, latencyMs: Math.max(1, Date.now() - startedAt), source };
  } catch {
    return null;
  } finally {
    void socket.close().catch(() => undefined);
  }
}

export function selectDiversePool(results: ProbeResult[], limit: number): ProbeResult[] {
  const groups = new Map<string, ProbeResult[]>();
  for (const result of results) {
    const group = groups.get(result.source) ?? [];
    group.push(result);
    groups.set(result.source, group);
  }
  for (const group of groups.values()) group.sort((left, right) => left.latencyMs - right.latencyMs);

  const selected: ProbeResult[] = [];
  while (selected.length < limit) {
    let added = false;
    for (const group of groups.values()) {
      const candidate = group.shift();
      if (!candidate) continue;
      selected.push(candidate);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected;
}

function isPoolRecord(value: unknown): value is PoolRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PoolRecord>;
  return record.version === 1 && Number.isFinite(record.updatedAt) && Array.isArray(record.endpoints)
    && record.endpoints.every((endpoint) => typeof endpoint === "string");
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error("invalid ProxyIP pool numeric configuration");
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) throw new Error("ProxyIP pool numeric configuration is out of range");
  return parsed;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function stableScore(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
