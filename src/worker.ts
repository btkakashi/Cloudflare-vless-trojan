import { connect } from "cloudflare:sockets";
import { buildRuntimeConfig, selectPathProxyEndpoints, type ProxyEndpoint, type RuntimeConfig, type RuntimeEnv } from "./config";
import { renderSubscriptionResponse } from "./subscriptions";

type TcpSocket = ReturnType<typeof connect>;
type WorkerEnv = Env & RuntimeEnv;

interface ParsedVlessRequest {
  address: string;
  port: number;
  responseHeader: Uint8Array;
  payload: Uint8Array;
  isUdp: boolean;
}

interface ConnectionState {
  socket: TcpSocket | null;
  connecting: Promise<TcpSocket> | null;
  dnsMode: boolean;
}

interface PrimedSocket {
  socket: TcpSocket;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  firstChunk: Uint8Array;
  endpoint: ProxyEndpoint;
}

interface Logger {
  debug(message: string, details?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const WS_OPEN = 1;
const WS_CLOSING = 2;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const requestId = crypto.randomUUID();
    let config: RuntimeConfig;
    try {
      config = buildRuntimeConfig(env);
    } catch (error) {
      console.error(JSON.stringify({ event: "configuration_error", requestId, error: errorMessage(error) }));
      return new Response("Service configuration error", { status: 503 });
    }

    const url = new URL(request.url);
    const subscription = renderSubscriptionResponse(url.pathname, url.hostname, config);
    if (subscription) return subscription;

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }

    const logger = createLogger(requestId, config.debug);
    try {
      const pathProxyEndpoints = selectPathProxyEndpoints(url.pathname, config);
      return handleWebSocket(request, config, pathProxyEndpoints ?? config.proxyEndpoints, ctx, logger);
    } catch (error) {
      logger.error("websocket_request_rejected", error);
      return new Response("Bad request", { status: 400 });
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

function handleWebSocket(
  request: Request,
  config: RuntimeConfig,
  proxyEndpoints: ProxyEndpoint[],
  ctx: ExecutionContext,
  logger: Logger,
): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const state: ConnectionState = { socket: null, connecting: null, dnsMode: false };
  const input = websocketReadable(server, request.headers.get("sec-websocket-protocol"));
  const pipeline = input.pipeTo(new WritableStream<ArrayBuffer | Uint8Array>({
    async write(chunk) {
      const bytes = toUint8Array(chunk);
      if (state.dnsMode) {
        await forwardDnsPackets(bytes, server, null, logger);
        return;
      }
      if (state.socket || state.connecting) {
        const pendingSocket = state.connecting;
        const socket = state.socket ?? (pendingSocket ? await pendingSocket : null);
        if (!socket) throw new Error("TCP connection is unavailable");
        await writeSocket(socket, bytes);
        return;
      }

      const parsed = parseVlessRequest(bytes, config.userIds);
      if (parsed.isUdp) {
        state.dnsMode = true;
        await forwardDnsPackets(parsed.payload, server, parsed.responseHeader, logger);
        return;
      }

      state.connecting = openSocket({ hostname: parsed.address, port: parsed.port }, config.connectTimeoutMs);
      let socket: TcpSocket | null = null;
      try {
        socket = await state.connecting;
        state.socket = socket;
        await writeSocket(socket, parsed.payload);
      } catch (error) {
        closeSocket(socket);
        state.socket = null;
        logger.debug("direct_connection_failed", { error: errorMessage(error) });
      } finally {
        state.connecting = null;
      }

      const forwarding = (socket
        ? forwardWithFallback(socket, parsed, proxyEndpoints, config, state, server, logger)
        : forwardProxyFallback(parsed, proxyEndpoints, config, state, server, logger, parsed.responseHeader))
        .catch((error) => logger.error("tcp_forwarding_failed", error))
        .finally(() => safeCloseWebSocket(server));
      ctx.waitUntil(forwarding);
    },
    close() {
      closeSocket(state.socket);
      safeCloseWebSocket(server);
    },
    abort(reason) {
      logger.error("websocket_input_aborted", reason);
      closeSocket(state.socket);
      safeCloseWebSocket(server);
    },
  })).catch((error) => {
    logger.error("websocket_pipeline_failed", error);
    closeSocket(state.socket);
    safeCloseWebSocket(server);
  });
  ctx.waitUntil(pipeline);

  return new Response(null, { status: 101, webSocket: client });
}

async function forwardWithFallback(
  directSocket: TcpSocket,
  parsed: ParsedVlessRequest,
  proxyEndpoints: ProxyEndpoint[],
  config: RuntimeConfig,
  state: ConnectionState,
  webSocket: WebSocket,
  logger: Logger,
): Promise<void> {
  let header = parsed.responseHeader;
  const directResult = await pumpSocket(directSocket, webSocket, header, logger);
  if (directResult.receivedData || proxyEndpoints.length === 0 || webSocket.readyState !== WS_OPEN) return;

  header = directResult.headerSent ? new Uint8Array() : header;
  state.socket = null;
  logger.debug("direct_connection_no_data", { fallbackCandidates: proxyEndpoints.length });

  await forwardProxyFallback(parsed, proxyEndpoints, config, state, webSocket, logger, header);
}

async function forwardProxyFallback(
  parsed: ParsedVlessRequest,
  proxyEndpoints: ProxyEndpoint[],
  config: RuntimeConfig,
  state: ConnectionState,
  webSocket: WebSocket,
  logger: Logger,
  responseHeader: Uint8Array,
): Promise<void> {
  if (proxyEndpoints.length === 0) throw new Error("direct connection failed and no ProxyIP fallback is configured");

  const fallbackPromise = dialProxyRace(proxyEndpoints, parsed.payload, config, logger);
  state.connecting = fallbackPromise.then((winner) => winner.socket);
  let winner: PrimedSocket;
  try {
    winner = await fallbackPromise;
    state.socket = winner.socket;
  } finally {
    state.connecting = null;
  }

  sendWebSocket(webSocket, winner.firstChunk, responseHeader);
  await pumpReader(winner.reader, winner.socket, webSocket, logger);
}

async function dialProxyRace(
  endpoints: ProxyEndpoint[],
  firstPayload: Uint8Array,
  config: RuntimeConfig,
  logger: Logger,
): Promise<PrimedSocket> {
  const concurrency = Math.min(config.proxyConcurrentDial, endpoints.length);
  let lastError: unknown = new Error("all ProxyIP candidates failed");

  for (let offset = 0; offset < endpoints.length; offset += concurrency) {
    const batch = endpoints.slice(offset, offset + concurrency);
    const attempts = batch.map((endpoint) => primeSocket(endpoint, firstPayload, config));
    let winner: PrimedSocket | null = null;
    try {
      winner = await Promise.any(attempts);
      logger.debug("proxy_race_winner", { endpoint: endpointLabel(winner.endpoint), batchSize: batch.length });
      return winner;
    } catch (error) {
      lastError = error;
      logger.debug("proxy_race_batch_failed", { offset, batchSize: batch.length });
    } finally {
      if (winner) {
        for (const attempt of attempts) {
          void attempt.then((result) => {
            if (result.socket !== winner?.socket) {
              result.reader.releaseLock();
              closeSocket(result.socket);
            }
          }).catch(() => undefined);
        }
      }
    }
  }
  throw lastError;
}

async function primeSocket(endpoint: ProxyEndpoint, payload: Uint8Array, config: RuntimeConfig): Promise<PrimedSocket> {
  const socket = await openSocket(endpoint, config.connectTimeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    await writeSocket(socket, payload);
    reader = socket.readable.getReader();
    const result = await withTimeout(reader.read(), config.firstByteTimeoutMs, "ProxyIP first-byte timeout");
    if (result.done || !result.value?.byteLength) throw new Error("ProxyIP closed before sending data");
    return { socket, reader, firstChunk: result.value, endpoint };
  } catch (error) {
    reader?.releaseLock();
    closeSocket(socket);
    throw error;
  }
}

async function openSocket(endpoint: ProxyEndpoint, timeoutMs: number): Promise<TcpSocket> {
  const socket = connect({ hostname: endpoint.hostname, port: endpoint.port });
  try {
    await withTimeout(socket.opened, timeoutMs, "TCP connect timeout");
    return socket;
  } catch (error) {
    closeSocket(socket);
    throw error;
  }
}

async function pumpSocket(socket: TcpSocket, webSocket: WebSocket, responseHeader: Uint8Array, logger: Logger): Promise<{ receivedData: boolean; headerSent: boolean }> {
  const reader = socket.readable.getReader();
  let receivedData = false;
  let headerSent = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      receivedData = true;
      sendWebSocket(webSocket, value, headerSent ? null : responseHeader);
      headerSent = true;
    }
  } catch (error) {
    logger.debug("direct_socket_read_failed", { error: errorMessage(error) });
  } finally {
    reader.releaseLock();
    closeSocket(socket);
  }
  return { receivedData, headerSent };
}

async function pumpReader(reader: ReadableStreamDefaultReader<Uint8Array>, socket: TcpSocket, webSocket: WebSocket, logger: Logger): Promise<void> {
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.byteLength) sendWebSocket(webSocket, value, null);
    }
  } catch (error) {
    logger.debug("proxy_socket_read_failed", { error: errorMessage(error) });
  } finally {
    reader.releaseLock();
    closeSocket(socket);
  }
}

async function writeSocket(socket: TcpSocket, data: Uint8Array): Promise<void> {
  if (!data.byteLength) return;
  const writer = socket.writable.getWriter();
  try {
    await writer.write(data);
  } finally {
    writer.releaseLock();
  }
}

function parseVlessRequest(data: Uint8Array, allowedUsers: Uint8Array[]): ParsedVlessRequest {
  if (data.byteLength < 24) throw new Error("invalid VLESS request");
  const version = data[0];
  const providedUser = data.subarray(1, 17);
  if (!allowedUsers.some((expected) => constantTimeEqual(providedUser, expected))) throw new Error("invalid credentials");

  const optionLength = data[17];
  const commandIndex = 18 + optionLength;
  requireBytes(data, commandIndex, 4);
  const command = data[commandIndex];
  if (command !== 1 && command !== 2) throw new Error("unsupported VLESS command");
  const port = new DataView(data.buffer, data.byteOffset + commandIndex + 1, 2).getUint16(0);
  if (port === 0 || port === 25) throw new Error("destination port is not allowed");

  const addressTypeIndex = commandIndex + 3;
  const addressType = data[addressTypeIndex];
  let cursor = addressTypeIndex + 1;
  let address = "";
  if (addressType === 1) {
    requireBytes(data, cursor, 4);
    address = [...data.subarray(cursor, cursor + 4)].join(".");
    cursor += 4;
  } else if (addressType === 2) {
    requireBytes(data, cursor, 1);
    const length = data[cursor++];
    if (length === 0 || length > 253) throw new Error("invalid destination hostname length");
    requireBytes(data, cursor, length);
    address = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data.subarray(cursor, cursor + length));
    cursor += length;
  } else if (addressType === 3) {
    requireBytes(data, cursor, 16);
    const view = new DataView(data.buffer, data.byteOffset + cursor, 16);
    address = Array.from({ length: 8 }, (_, index) => view.getUint16(index * 2).toString(16)).join(":");
    cursor += 16;
  } else {
    throw new Error("unsupported destination address type");
  }

  if (command === 2 && port !== 53) throw new Error("UDP is limited to DNS port 53");
  return { address, port, responseHeader: new Uint8Array([version, 0]), payload: data.slice(cursor), isUdp: command === 2 };
}

async function forwardDnsPackets(data: Uint8Array, webSocket: WebSocket, responseHeader: Uint8Array | null, logger: Logger): Promise<void> {
  let cursor = 0;
  let header = responseHeader;
  while (cursor < data.byteLength) {
    requireBytes(data, cursor, 2);
    const length = new DataView(data.buffer, data.byteOffset + cursor, 2).getUint16(0);
    cursor += 2;
    if (length === 0 || length > 4096) throw new Error("invalid DNS packet length");
    requireBytes(data, cursor, length);
    const packet = data.slice(cursor, cursor + length);
    cursor += length;
    const response = await fetch(DOH_URL, { method: "POST", headers: { "content-type": "application/dns-message", accept: "application/dns-message" }, body: packet });
    if (!response.ok) throw new Error(`DNS upstream returned ${response.status}`);
    const dnsResponse = new Uint8Array(await response.arrayBuffer());
    if (dnsResponse.byteLength > 65_535) throw new Error("DNS response is too large");
    const framed = new Uint8Array(2 + dnsResponse.byteLength);
    new DataView(framed.buffer).setUint16(0, dnsResponse.byteLength);
    framed.set(dnsResponse, 2);
    sendWebSocket(webSocket, framed, header);
    header = null;
    logger.debug("dns_query_completed", { responseBytes: dnsResponse.byteLength });
  }
}

function websocketReadable(webSocket: WebSocket, earlyDataHeader: string | null): ReadableStream<ArrayBuffer | Uint8Array> {
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener("message", (event) => {
        if (!cancelled) controller.enqueue(event.data as ArrayBuffer);
      });
      webSocket.addEventListener("close", () => {
        if (!cancelled) controller.close();
      });
      webSocket.addEventListener("error", () => {
        if (!cancelled) controller.error(new Error("websocket error"));
      });
      if (earlyDataHeader) {
        const earlyData = decodeBase64Url(earlyDataHeader);
        if (earlyData.byteLength) controller.enqueue(earlyData);
      }
    },
    cancel() {
      cancelled = true;
      safeCloseWebSocket(webSocket);
    },
  });
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("invalid early-data header");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sendWebSocket(webSocket: WebSocket, payload: Uint8Array, header: Uint8Array | null): void {
  if (webSocket.readyState !== WS_OPEN) throw new Error("websocket is not open");
  if (!header?.byteLength) {
    webSocket.send(payload);
    return;
  }
  const combined = new Uint8Array(header.byteLength + payload.byteLength);
  combined.set(header);
  combined.set(payload, header.byteLength);
  webSocket.send(combined);
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function constantTimeEqual(provided: Uint8Array, expected: Uint8Array): boolean {
  if (provided.byteLength !== expected.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < expected.byteLength; index += 1) difference |= provided[index] ^ expected[index];
  return difference === 0;
}

function requireBytes(data: Uint8Array, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > data.byteLength) throw new Error("truncated VLESS request");
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

function closeSocket(socket: TcpSocket | null): void {
  if (!socket) return;
  void socket.close().catch(() => undefined);
}

function safeCloseWebSocket(webSocket: WebSocket): void {
  if (webSocket.readyState !== WS_OPEN && webSocket.readyState !== WS_CLOSING) return;
  try {
    webSocket.close(1000, "connection closed");
  } catch {
    // The peer may already have closed between the readyState check and close().
  }
}

function endpointLabel(endpoint: ProxyEndpoint): string {
  return `${endpoint.hostname.includes(":") ? `[${endpoint.hostname}]` : endpoint.hostname}:${endpoint.port}`;
}

function createLogger(requestId: string, debugEnabled: boolean): Logger {
  return {
    debug(message, details = {}) {
      if (debugEnabled) console.log(JSON.stringify({ event: message, requestId, ...details }));
    },
    error(message, error) {
      console.error(JSON.stringify({ event: message, requestId, error: errorMessage(error) }));
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
