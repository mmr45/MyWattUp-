import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
// Prix Pro (sept. 2026). Codés en dur : un ID de prix n'est pas un secret.
// - Mensuel 6,99 € : lookup_key `pro_monthly`
// - Annuel 59,99 € : lookup_key `pro_yearly` (soit 4,99 €/mois, 2 mois offerts)
// Ancien prix 9,99 € : price_1U9mTh9mg5tMWWXBYkLrrclc (archivé).
const STRIPE_PRICE_ID_PRO_MONTH = "price_1UEaul9mg5tMWWXBHqYEeBxk";
const STRIPE_PRICE_ID_PRO_YEAR = "price_1UFgoA9mg5tMWWXBgahguvuX";
// Valeur de repli alignée sur le domaine réel : si le secret SITE_URL venait
// à manquer, les redirections restent sur le bon site.
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://my-watt-up.vercel.app";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// Statuts qui signifient "un abonnement existe déjà" : on refuse d'en créer un 2e.
// past_due / unpaid : paiement en échec, l'utilisateur doit mettre à jour sa carte
// via le portail, pas souscrire à nouveau.
const LIVE_SUB_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // Période choisie côté client : { interval: "month" | "year" }.
    // Corps absent ou invalide (anciens clients en cache) => mensuel.
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const annuel = body?.interval === "year";
    const priceId = annuel ? STRIPE_PRICE_ID_PRO_YEAR : STRIPE_PRICE_ID_PRO_MONTH;
    const rappelFacturation = annuel
      ? "Abonnement de 59,99 € par an (soit 4,99 € par mois), reconduit automatiquement jusqu'à résiliation, "
      : "Abonnement de 6,99 € par mois, reconduit automatiquement jusqu'à résiliation, ";

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);

    if (userError || !userData?.user) {
      return json({ error: "Non authentifié." }, 401);
    }

    const user = userData.user;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id, plan")
      .eq("user_id", user.id)
      .maybeSingle();

    // 1) Déjà Pro en base : pas de 2e abonnement.
    if (profile?.plan === "pro") {
      return json({ error: "Tu es déjà abonné à l'offre Pro." }, 409);
    }

    let customerId = profile?.stripe_customer_id ?? null;

    if (customerId) {
      // 2) Source de vérité = Stripe (couvre le délai du webhook et les paiements en échec).
      const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
      if (subs.data.some((s) => LIVE_SUB_STATUSES.has(s.status))) {
        return json({
          error: "Un abonnement existe déjà sur ton compte. Gère-le depuis « Gérer mon abonnement ».",
        }, 409);
      }

      // 3) Double clic / 2 onglets : on expire les sessions de paiement encore ouvertes
      //    pour qu'une seule puisse aboutir.
      const openSessions = await stripe.checkout.sessions.list({ customer: customerId, status: "open", limit: 20 });
      for (const s of openSessions.data) {
        try {
          await stripe.checkout.sessions.expire(s.id);
        } catch (e) {
          console.error("Expiration session impossible:", s.id, e);
        }
      }
    } else {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;

      await supabaseAdmin
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("user_id", user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${SITE_URL}/#abonnement?success=true`,
      cancel_url: `${SITE_URL}/#abonnement?canceled=true`,
      client_reference_id: user.id,
      subscription_data: {
        metadata: { supabase_user_id: user.id, billing_interval: annuel ? "year" : "month" },
      },
      allow_promotion_codes: true,
      // Obligations consommateur (FR/UE) : acceptation explicite des CGV horodatée par
      // Stripe, et rappel de la reconduction + renonciation au droit de rétractation.
      consent_collection: {
        terms_of_service: "required",
      },
      custom_text: {
        terms_of_service_acceptance: {
          message:
            "J'accepte les [conditions générales](" + SITE_URL + "/cgu.html) et la " +
            "[politique de confidentialité](" + SITE_URL + "/politique-confidentialite.html).",
        },
        submit: {
          message:
            rappelFacturation +
            "annulable à tout moment depuis ton compte. En confirmant, tu demandes l'accès " +
            "immédiat à l'offre Pro et renonces à ton droit de rétractation une fois le service fourni.",
        },
      },
    });

    return json({ url: session.url });
  } catch (err) {
    console.error(err);
    return json({ error: "Erreur lors de la création de la session de paiement." }, 500);
  }
});
