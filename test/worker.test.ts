import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("Worker HTTP surface", () => {
  it("returns 404 for an unknown route", async () => {
    const response = await exports.default.fetch("https://example.com/unknown");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("serves the TLS-only Clash subscription", async () => {
    const response = await exports.default.fetch(`https://example.com/${UUID}/pcl`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("type: url-test");
    expect(body).not.toContain("port: 8443");
  });
});
