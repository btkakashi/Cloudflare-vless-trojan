import { describe, expect, it } from "vitest";
import { buildRuntimeConfig } from "../src/config";
import { renderClash, renderSingBox, renderVlessLinks } from "../src/subscriptions";

const UUID = "11111111-1111-4111-8111-111111111111";
const config = buildRuntimeConfig({ uuid: UUID });

describe("TLS-only subscriptions", () => {
  it("generates only the four approved TLS ports", () => {
    const links = renderVlessLinks("example.com", config).split("\n");
    expect(links).toHaveLength(4);
    expect(links.map((link) => Number(new URL(link).port))).toEqual([443, 2083, 2087, 2096]);
    expect(links.join("\n")).not.toContain(":8443");
    expect(links.join("\n")).not.toContain(":2053");
  });

  it("generates a Clash config with automatic node switching", () => {
    const clash = renderClash("example.com", config);
    expect(clash).toContain("type: url-test");
    expect(clash).toContain("- MATCH,Proxy");
    expect(clash).not.toContain("port: 8443");
  });

  it("generates valid Sing-box JSON", () => {
    const singBox = JSON.parse(renderSingBox("example.com", config));
    expect(singBox.outbounds[0].tag).toBe("Proxy");
    expect(singBox.outbounds.filter((item: { type: string }) => item.type === "vless")).toHaveLength(4);
  });
});
