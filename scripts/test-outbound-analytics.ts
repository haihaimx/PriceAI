import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { trackOutboundEvent, withPriceAiUtm } from "../src/lib/outbound-analytics-client.js";

const tracked = withPriceAiUtm("https://example.com/buy?sku=plus&utm_source=old", {
  medium: "card_offer",
  campaign: "priceai_card_shop",
  content: "offer-1",
});
const trackedUrl = new URL(tracked);

assert.equal(trackedUrl.searchParams.get("sku"), "plus");
assert.equal(trackedUrl.searchParams.get("utm_source"), "old");
assert.equal(trackedUrl.searchParams.get("utm_medium"), "card_offer");
assert.equal(trackedUrl.searchParams.get("utm_campaign"), "priceai_card_shop");
assert.equal(trackedUrl.searchParams.get("utm_content"), "offer-1");
assert.equal(withPriceAiUtm("/commercial#slots", { medium: "sponsor", campaign: "home" }), "/commercial#slots");
assert.equal(withPriceAiUtm("mailto:test@example.com", { medium: "merchant_shop", campaign: "merchant" }), "mailto:test@example.com");
const signedUrl = "https://example.com/buy?signature=abc123&expires=123456";
assert.equal(withPriceAiUtm(signedUrl, { medium: "card_offer", campaign: "merchant" }), signedUrl);
assert.doesNotThrow(() => trackOutboundEvent({
  eventType: "card_offer_click",
  entityType: "card_offer",
  entityId: "offer-1",
}));

const migration = readFileSync(
  "supabase/migrations/20260729220000_outbound_analytics_events.sql",
  "utf8",
);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /p_batch_size integer default 5000/);
assert.match(migration, /limit greatest\(1, least\(coalesce\(p_limit, 200\), 500\)\)/);
assert.match(migration, /list_outbound_analytics_event_totals/);
assert.match(migration, /grant insert on table public\.outbound_analytics_events to service_role/);
assert.doesNotMatch(migration, /grant all on table public\.outbound_analytics_events/);
assert.doesNotMatch(migration, /random\(\)/);

console.log("outbound analytics tests passed");
