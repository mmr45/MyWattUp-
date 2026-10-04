import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Webhook Whop (format Standard Webhooks, signé HMAC-SHA256).
// Secret requis : WHOP_WEBHOOK_SECRET (ws_..., utilisé tel quel).
// Évènements à cocher dans Whop : membership.activated, membership.deactivated,
// membership.updated, payment.succeeded, payment.failed.
const WHOP_WEBHOOK_SECRET = Deno.env.get("WHOP_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const PRO_STATUSES = new Set(["active", "trialing", "canceling"]);
const MAX_SKEW_SECONDS = 5 * 60;

// deno-lint-ignore no-explicit-any
type Any = any;

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function verify(req: Request, body: string): Promise<boolean> {
  const id = req.headers.get("webhook-id");
  const ts = req.headers.get("webhook-timestamp");
  const sigHeader = req.headers.get("webhook-signature");
  if (!id || !ts || !sigHeader || !WHOP_WEBHOOK_SECRET) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > MAX_SKEW_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WHOP_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // L'en-tête peut contenir plusieurs signatures : "v1,xxx v1,yyy"
  return sigHeader.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    return version === "v1" && !!sig && timingSafeEqual(sig, expected);
  });
}

function pick(obj: Any, ...paths: string[]): Any {
  for (const p of paths) {
    const v = p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

async function findUserId(data: Any): Promise<string | null> {
  const fromMeta = pick(data, "metadata.supabase_user_id", "membership.metadata.supabase_user_id");
  if (fromMeta) return String(fromMeta);

  const membershipId = pick(data, "membership.id", "membership_id", "id");
  if (membershipId) {
    const { data: row } = await supabaseAdmin
      .from("profiles").select("user_id").eq("whop_membership_id", String(membershipId)).maybeSingle();
    if (row?.user_id) return row.user_id;
  }

  const whopUserId = pick(data, "user.id", "user_id");
  if (whopUserId) {
    const { data: row } = await supabaseAdmin
      .from("profiles").select("user_id").eq("whop_user_id", String(whopUserId)).maybeSingle();
    if (row?.user_id) return row.user_id;
  }
  return null;
}

async function setPlan(userId: string, plan: "free" | "pro", data: Any, status: string | null) {
  const patch: Record<string, unknown> = {
    plan,
    payment_provider: "whop",
    whop_membership_status: status,
  };
  const membershipId = pick(data, "membership.id", "id");
  if (membershipId && String(membershipId).startsWith("mem_")) patch.whop_membership_id = String(membershipId);
  const whopUserId = pick(data, "user.id", "user_id");
  if (whopUserId) patch.whop_user_id = String(whopUserId);

  const { error } = await supabaseAdmin.from("profiles").update(patch).eq("user_id", userId);
  if (error) throw error;
}

async function recordPayment(userId: string, data: Any, status: "paid" | "failed") {
  const paymentId = pick(data, "id");
  if (!paymentId) return;
  const { data: existing } = await supabaseAdmin
    .from("invoices").select("id").eq("external_id", String(paymentId)).maybeSingle();

  const amount = Number(pick(data, "total", "final_amount", "subtotal", "amount") ?? 0);
  const row = {
    user_id: userId,
    provider: "whop",
    external_id: String(paymentId),
    amount_cents: Math.round(amount * 100),
    currency: String(pick(data, "currency") ?? "eur").toLowerCase(),
    status,
    card_brand: pick(data, "card_brand", "payment_method.card.brand"),
    card_last4: pick(data, "card_last4", "card_last_4", "payment_method.card.last4"),
    plan_label: "Offre Pro",
    issued_at: new Date(pick(data, "paid_at", "created_at") ?? Date.now()).toISOString(),
  };

  if (existing?.id) await supabaseAdmin.from("invoices").update(row).eq("id", existing.id);
  else await supabaseAdmin.from("invoices").insert(row);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = await req.text();
  if (!(await verify(req, body))) {
    console.error("Signature Whop invalide ou absente.");
    return new Response("Signature invalide.", { status: 401 });
  }

  let event: Any;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("JSON invalide.", { status: 400 });
  }

  const type: string = event?.type ?? event?.action ?? "";
  const data: Any = event?.data ?? {};

  try {
    const userId = await findUserId(data);
    if (!userId) {
      console.warn("Webhook Whop sans utilisateur MyWattUp associé:", type, pick(data, "id"));
      return new Response(JSON.stringify({ received: true, matched: false }), { status: 200 });
    }

    switch (type) {
      case "membership.activated":
      case "membership.went_valid":
        await setPlan(userId, "pro", data, String(pick(data, "status") ?? "active"));
        break;

      case "membership.deactivated":
      case "membership.went_invalid":
        await setPlan(userId, "free", data, String(pick(data, "status") ?? "expired"));
        break;

      case "membership.updated": {
        const status = String(pick(data, "status") ?? "");
        if (status) await setPlan(userId, PRO_STATUSES.has(status) ? "pro" : "free", data, status);
        break;
      }

      case "payment.succeeded":
        await recordPayment(userId, data, "paid");
        break;

      case "payment.failed":
        await recordPayment(userId, data, "failed");
        break;

      default:
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Erreur traitement webhook Whop:", err);
    return new Response("Erreur interne.", { status: 500 });
  }
});
