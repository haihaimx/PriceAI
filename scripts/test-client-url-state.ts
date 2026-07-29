import assert from "node:assert/strict";
import {
  buildClientSearchUrl,
  replaceClientSearchParams,
} from "../src/lib/client-url-state.js";

assert.equal(
  buildClientSearchUrl("/api-transit", "?q=ai&channel=official_api&sort=rate", {
    model: null,
    family: "claude",
  }),
  "/api-transit?q=ai&channel=official_api&sort=rate&family=claude",
  "setting a family preserves filters owned by the explorer",
);

assert.equal(
  buildClientSearchUrl("/api-transit", "?model=claude&q=ai", {
    model: null,
    family: "gpt",
  }),
  "/api-transit?q=ai&family=gpt",
  "switching a family removes the legacy model-family parameter",
);

assert.equal(
  buildClientSearchUrl("/api-transit", "?family=gemini&q=price", {
    model: null,
    family: null,
  }),
  "/api-transit?q=price",
  "selecting all removes the family without clearing search",
);

assert.equal(
  buildClientSearchUrl("/api-transit/models", "?family=deepseek&q=old", {
    q: "新 模型",
  }),
  "/api-transit/models?family=deepseek&q=%E6%96%B0+%E6%A8%A1%E5%9E%8B",
  "model search updates only its owned parameter",
);

assert.equal(
  buildClientSearchUrl("/api-transit", "?family=qwen", {
    q: null,
    channel: null,
    pool: null,
    sort: null,
  }),
  "/api-transit?family=qwen",
  "explorer defaults do not overwrite the active family",
);

let replaceStateCall: { data: unknown; url: string | URL | null | undefined } | null = null;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: { pathname: "/api-transit", search: "?q=ai" },
    history: {
      state: { __NA: true },
      replaceState(data: unknown, _unused: string, url?: string | URL | null) {
        replaceStateCall = { data, url };
      },
    },
  },
});

assert.equal(
  replaceClientSearchParams("/api-transit", { family: "claude" }),
  true,
  "writes changed client search parameters",
);
assert.deepEqual(
  replaceStateCall,
  { data: null, url: "/api-transit?q=ai&family=claude" },
  "uses a null history state so Next updates useSearchParams",
);

delete (globalThis as { window?: unknown }).window;

console.log("client URL state tests passed");
