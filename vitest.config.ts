import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          uuid: "11111111-1111-4111-8111-111111111111",
          proxyip: "proxy.example",
        },
      },
    }),
  ],
});
