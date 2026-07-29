import { z } from "zod";
import { recordOutboundAnalyticsEvent } from "@/lib/outbound-analytics";
import {
  checkPublicWriteRateLimit,
  getPublicClientFingerprint,
  getPublicRequestErrorStatus,
  PublicRequestError,
  readJsonWithLimit,
} from "@/lib/public-request";
import { outboundAnalyticsEntityTypes, outboundAnalyticsEventTypes } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const entityTypeByEvent = {
  card_offer_click: "card_offer",
  merchant_shop_click: "merchant",
  api_transit_outbound_click: "api_transit_station",
  api_transit_coupon_copy: "api_transit_station",
  sponsor_click: "sponsor",
} as const;

const eventSchema = z.object({
  eventType: z.enum(outboundAnalyticsEventTypes),
  entityType: z.enum(outboundAnalyticsEntityTypes),
  entityId: z.string().trim().min(1).max(200),
  offerId: z.string().trim().max(200).nullable().optional(),
  sourceId: z.string().trim().max(200).nullable().optional(),
  productId: z.string().trim().max(200).nullable().optional(),
  stationId: z.string().trim().max(200).nullable().optional(),
  placement: z.string().trim().max(160).nullable().optional(),
  creativeId: z.string().trim().max(200).nullable().optional(),
  campaignId: z.string().trim().max(200).nullable().optional(),
  targetUrl: z.string().trim().max(2048).nullable().optional(),
  pagePath: z.string().trim().max(500).nullable().optional(),
  referrerPath: z.string().trim().max(500).nullable().optional(),
  sessionId: z.string().trim().max(120).nullable().optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable().optional(),
}).superRefine((value, context) => {
  if (entityTypeByEvent[value.eventType] !== value.entityType) {
    context.addIssue({ code: "custom", path: ["entityType"], message: "事件和归因对象不匹配。" });
  }
});

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    checkPublicWriteRateLimit({
      scope: "outbound-events",
      key: getPublicClientFingerprint(request),
      limit: 240,
    });
    const payload = eventSchema.parse(await readJsonWithLimit(request, 24 * 1024));
    const result = await recordOutboundAnalyticsEvent(payload, request);
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    const publicRequestStatus = getPublicRequestErrorStatus(error);
    const status = publicRequestStatus || (error instanceof z.ZodError ? 400 : 500);
    let message = "点击事件记录失败，请稍后重试。";
    if (error instanceof z.ZodError) message = "点击事件格式不正确。";
    else if (publicRequestStatus && error instanceof Error) message = error.message;
    else console.error("Outbound analytics event failed:", error);
    return Response.json({ ok: false, message }, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}

function assertSameOriginRequest(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    throw new PublicRequestError("不允许跨站提交点击事件。", 403);
  }

  const origin = request.headers.get("origin");
  if (!origin) throw new PublicRequestError("点击事件请求缺少来源信息。", 403);

  const requestUrl = new URL(request.url);
  const allowedOrigins = new Set([
    requestUrl.origin,
    "https://priceai.cc",
    "https://www.priceai.cc",
  ]);
  if (!allowedOrigins.has(origin)) throw new PublicRequestError("不允许跨站提交点击事件。", 403);
}
