import { describe, expect, it } from "vitest";
import { toUint8Array } from "../src/worker";

describe("WebSocket binary chunk conversion", () => {
  it("preserves ArrayBuffer data", async () => {
    const source = new Uint8Array([1, 2, 3]).buffer;
    expect([...await toUint8Array(source)]).toEqual([1, 2, 3]);
  });

  it("preserves typed-array views", async () => {
    const source = new Uint16Array([0x0201, 0x0403]);
    expect([...await toUint8Array(source)]).toEqual([1, 2, 3, 4]);
  });

  it("reads Blob-backed Worker messages", async () => {
    const source = new Blob([new Uint8Array([5, 6, 7])]);
    expect([...await toUint8Array(source)]).toEqual([5, 6, 7]);
  });

  it("rejects text WebSocket messages", async () => {
    await expect(toUint8Array("not-binary")).rejects.toThrow("unsupported WebSocket message type");
  });
});
