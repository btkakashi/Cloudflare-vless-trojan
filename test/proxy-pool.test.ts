import { describe, expect, it } from "vitest";
import { mergeProxyEndpoints, selectDiversePool, selectRotatingSample } from "../src/proxy-pool";

describe("dynamic ProxyIP pool", () => {
  it("prefers fresh candidates and retains static fallbacks", () => {
    const dynamic = [
      { hostname: "203.0.113.10", port: 443 },
      { hostname: "203.0.113.11", port: 443 },
    ];
    const staticFallbacks = [
      { hostname: "203.0.113.11", port: 443 },
      { hostname: "fallback.example", port: 443 },
    ];
    expect(mergeProxyEndpoints(dynamic, staticFallbacks)).toEqual([
      { hostname: "203.0.113.10", port: 443 },
      { hostname: "203.0.113.11", port: 443 },
      { hostname: "fallback.example", port: 443 },
    ]);
  });

  it("selects a bounded deterministic sample for each refresh window", () => {
    const endpoints = Array.from({ length: 20 }, (_, index) => ({ hostname: `203.0.113.${index + 1}`, port: 443 }));
    const first = selectRotatingSample(endpoints, 6, 21_600_000);
    const repeated = selectRotatingSample(endpoints, 6, 21_600_000 + 1000);
    expect(first).toHaveLength(6);
    expect(repeated).toEqual(first);
    expect(new Set(first.map(({ hostname }) => hostname)).size).toBe(6);
  });

  it("alternates the fastest candidates from each discovery source", () => {
    const selected = selectDiversePool([
      { endpoint: { hostname: "203.0.113.1", port: 443 }, latencyMs: 2, source: "hk" },
      { endpoint: { hostname: "203.0.113.2", port: 443 }, latencyMs: 4, source: "hk" },
      { endpoint: { hostname: "203.0.113.3", port: 443 }, latencyMs: 3, source: "jp" },
      { endpoint: { hostname: "203.0.113.4", port: 443 }, latencyMs: 5, source: "jp" },
    ], 4);
    expect(selected.map(({ source }) => source)).toEqual(["hk", "jp", "hk", "jp"]);
    expect(selected.map(({ latencyMs }) => latencyMs)).toEqual([2, 3, 4, 5]);
  });
});
