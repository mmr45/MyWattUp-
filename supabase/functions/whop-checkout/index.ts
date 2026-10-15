import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Paiement Pro via Whop. Renvoie { url } vers le checkout hébergé Whop.
// Secrets requis (Supabase > Edge Functions > Secrets) :
//   WHOP_API_KEY          clé API de l'entreprise Whop
// Plans du produit « MyWattUp Pro » (biz_5Wvg7ieIkas5Bs / prod_Ve93ul6xBW7Re).
// Un ID de plan n'est pas un secret : valeurs par défaut codées en dur,
// surchargeables par WHOP_PLAN_ID_MONTH / WHOP_PLAN_ID_YEAR.
const WHOP_API_KEY = Deno.env.get("WHOP_API_KEY") ?? "";
const WHOP_PLAN_ID_MONTH = Deno.env.get("WHOP_PLAN_ID_MONTH") ?? "plan_UOHsi8HqHDA8E"; // 6,99 €/mois
const WHOP_PLAN_ID_YEAR = Deno.env.get("WHOP_PLAN_ID_YEAR") ?? "plan_3iYYUsc2LUI3j"; // 59,99 €/an
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://my-watt-up.vercel.app";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!WHOP_API_KEY || !WHOP_PLAN_ID_MONTH || !WHOP_PLAN_ID_YEAR) {
    console.error("Configuration Whop incomplète : secret WHOP_API_KEY manquant.");
    return json({ error: "Le paiement est momentanément indisponible. Réessaie plus tard." }, 503);
  }

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const annuel = body?.interval === "year";
    const planId = annuel ? WHOP_PLAN_ID_YEAR : WHOP_PLAN_ID_MONTH;

    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Non authentifié." }, 401);
    const user = userData.user;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("plan, whop_membership_status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profile?.plan === "pro") {
      return json({ error: "Tu es déjà abonné à l'offre Pro." }, 409);
    }

    const res = await fetch("https://api.whop.com/api/v1/checkout_configurations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHOP_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "payment",
        plan_id: planId,
        // Relu dans le webhook pour savoir quel compte MyWattUp passer en Pro.
        metadata: {
          supabase_user_id: user.id,
          billing_interval: annuel ? "year" : "month",
        },
        redirect_url: `${SITE_URL}/#abonnement?success=true`,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.purchase_url) {
      console.error("Whop checkout error:", res.status, JSON.stringify(data));
      return json({ error: "Erreur lors de la création du paiement." }, 502);
    }

    await supabaseAdmin
      .from("profiles")
      .update({ payment_provider: "whop" })
      .eq("user_id", user.id);

    return json({ url: data.purchase_url });
  } catch (err) {
    console.error(err);
    return json({ error: "Erreur lors de la création du paiement." }, 500);
  }
});
