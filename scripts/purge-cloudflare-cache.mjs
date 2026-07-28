#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const baseUrl = process.env.CLOUDFLARE_SMOKE_BASE_URL || "https://priceai.cc";

if (isCli()) {
  try {
    if (!apiToken || !accountId) {
      throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to purge production cache.");
    }

    const zoneName = cloudflareZoneNameFromUrl(baseUrl);
    const query = new URLSearchParams({ name: zoneName, "account.id": accountId, status: "active" });
    const zones = await cloudflareApi(`/zones?${query.toString()}`, { method: "GET" });
    const zone = zones.result?.find((item) => item.name === zoneName);
    if (!zone?.id) throw new Error(`Could not resolve an active Cloudflare zone for ${zoneName}.`);

    await cloudflareApi(`/zones/${zone.id}/purge_cache`, {
      method: "POST",
      body: JSON.stringify({ purge_everything: true }),
    });
    console.log(`Cloudflare cache purged for ${zoneName}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function cloudflareZoneNameFromUrl(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

async function cloudflareApi(pathname, init) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const details = payload?.errors?.map((item) => item.message).filter(Boolean).join("; ");
    throw new Error(`Cloudflare API ${init.method} ${pathname} failed (${response.status})${details ? `: ${details}` : ""}.`);
  }
  return payload;
}

function isCli() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
