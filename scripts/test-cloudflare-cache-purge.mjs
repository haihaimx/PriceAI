#!/usr/bin/env node

import assert from "node:assert/strict";
import { cloudflareZoneNameFromUrl } from "./purge-cloudflare-cache.mjs";

assert.equal(cloudflareZoneNameFromUrl("https://priceai.cc/channels"), "priceai.cc");
assert.equal(cloudflareZoneNameFromUrl("https://www.priceai.cc/official-prices"), "priceai.cc");

console.log("cloudflare cache purge test passed");
