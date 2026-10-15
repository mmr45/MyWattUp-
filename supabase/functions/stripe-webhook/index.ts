import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@18";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Aligné sur la version d'API de l'endpoint webhook (Dashboard > Webhooks).
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2026-08-26.dahlia" as Stripe.LatestApiVersion });
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function setPlanByCustomerId(
  customerId: string,
  plan: "free" | "pro",
  subscriptionId: string | null,
  status: string | null,
) {
  await supabaseAdmin
    .from("profiles")
    .update({
      plan,
      stripe_subscription_id: subscriptionId,
      stripe_subscription_status: status,
    })
    .eq("stripe_customer_id", customerId);
}

async function userIdForCustomer(customerId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.user_id ?? null;
}

// Enregistre la facture dans public.invoices pour alimenter l'écran
// "Historique des factures". Idempotent : stripe_invoice_id est unique,
// donc un même évènement rejoué ne crée pas de doublon.
async function recordInvoice(invoice: Stripe.Invoice, status: "paid" | "failed") {
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  const userId = await userIdForCustomer(customerId);
  if (!userId) return;

  // NB : l'endpoint webhook est en version d'API 2026-08-26.dahlia, où
  // invoice.payment_intent et invoice.charge n'existent plus. On lit donc
  // le moyen de paiement sur le client, ce qui reste stable d'une version
  // d'API à l'autre.
  let cardBrand: string | null = null;
  let cardLast4: string | null = null;
  try {
    const customer = await stripe.customers.retrieve(customerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    if (!("deleted" in customer)) {
      const pm = customer.invoice_settings?.default_payment_method as Stripe.PaymentMethod | null;
      if (pm && typeof pm !== "string" && pm.card) {
        cardBrand = pm.card.brand ?? null;
        cardLast4 = pm.card.last4 ?? null;
      }
    }
  } catch (err) {
    console.error("Impossible de récupérer le moyen de paiement:", err);
  }

  // Facture payée : montant réellement encaissé. Facture en échec : amount_paid
  // vaut 0, on affiche donc le montant dû pour que l'historique reste lisible.
  const amountCents = status === "paid"
    ? (invoice.amount_paid ?? 0)
    : (invoice.amount_due ?? invoice.total ?? 0);

  await supabaseAdmin.from("invoices").upsert(
    {
      user_id: userId,
      stripe_invoice_id: invoice.id,
      amount_cents: amountCents,
      currency: invoice.currency ?? "eur",
      status,
      card_brand: cardBrand,
      card_last4: cardLast4,
      plan_label: "Offre Pro",
      pdf_url: invoice.invoice_pdf ?? null,
      hosted_invoice_url: invoice.hosted_invoice_url ?? null,
      issued_at: new Date((invoice.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    },
    { onConflict: "stripe_invoice_id" },
  );
}

Deno.serve(async (req: Request) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  if (!signature) {
    return new Response("Signature Stripe manquante.", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Signature invalide:", err);
    return new Response("Signature invalide.", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription" && session.customer) {
          const subscriptionId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id ?? null;
          await setPlanByCustomerId(session.customer as string, "pro", subscriptionId, "active");
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const isActive = sub.status === "active" || sub.status === "trialing";
        await setPlanByCustomerId(sub.customer as string, isActive ? "pro" : "free", sub.id, sub.status);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await setPlanByCustomerId(sub.customer as string, "free", null, "canceled");
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        await recordInvoice(invoice, "paid");
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await recordInvoice(invoice, "failed");
        if (invoice.customer) {
          // On repasse l'utilisateur en Gratuit dès le premier échec ; Stripe Smart Retries
          // continuera de réessayer en arrière-plan et renverra customer.subscription.updated
          // avec le statut 'active' si un retry aboutit.
          await setPlanByCustomerId(invoice.customer as string, "free", null, "payment_failed");
        }
        break;
      }

      default:
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Erreur traitement webhook:", err);
    return new Response("Erreur interne.", { status: 500 });
  }
});
