import { describe, expect, it } from "vitest";
import { buildRuntimeConfig, parseEndpoint, parseEndpointList, selectPathProxyEndpoints } from "../src/config";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("runtime configuration", () => {
  it("requires a valid secret and keeps request state local", () => {
    expect(() => buildRuntimeConfig({})).toThrow("missing uuid secret");
    const first = buildRuntimeConfig({ uuid: UUID, proxyip: "proxy-a.example:443" });
    const second = buildRuntimeConfig({ uuid: UUID, proxyip: "proxy-b.example:8443" });
    expect(first.proxyEndpoints[0].hostname).toBe("proxy-a.example");
    expect(second.proxyEndpoints[0].hostname).toBe("proxy-b.example");
  });

  it("strictly parses IPv4, IPv6, hostname and port", () => {
    expect(parseEndpoint("1.1.1.1:8443")).toEqual({ hostname: "1.1.1.1", port: 8443 });
    expect(parseEndpoint("[2606:4700:4700::1111]:443")).toEqual({ hostname: "2606:4700:4700::1111", port: 443 });
    expect(parseEndpoint("proxy.example")).toEqual({ hostname: "proxy.example", port: 443 });
    expect(() => parseEndpoint("anything goes / here")).toThrow();
    expect(() => parseEndpoint("example.com:70000")).toThrow();
    expect(() => parseEndpoint("example.com:25")).toThrow();
  });

  it("deduplicates ProxyIP candidates", () => {
    expect(parseEndpointList("proxy.example,proxy.example:443,backup.example")).toHaveLength(2);
  });

  it("disables path override by default and restricts it to configured endpoints", () => {
    const disabled = buildRuntimeConfig({ uuid: UUID, proxyip: "proxy.example" });
    expect(() => selectPathProxyEndpoints("/pyip=proxy.example", disabled)).toThrow("disabled");
    const enabled = buildRuntimeConfig({ uuid: UUID, proxyip: "proxy.example,backup.example", ALLOW_PATH_PROXYIP: "true" });
    expect(selectPathProxyEndpoints("/pyip=backup.example", enabled)).toEqual([{ hostname: "backup.example", port: 443 }]);
    expect(() => selectPathProxyEndpoints("/pyip=untrusted.example", enabled)).toThrow("allowlist");
    expect(() => selectPathProxyEndpoints("/unexpected", enabled)).toThrow("unsupported");
  });
});
