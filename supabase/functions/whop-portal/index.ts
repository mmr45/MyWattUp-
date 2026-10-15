import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// « Gérer mon abonnement » pour un abonné Whop : renvoie { url } vers la page
// Whop où l'utilisateur peut résilier ou changer de formule (manage_url).
const WHOP_API_KEY = Deno.env.get("WHOP_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FALLBACK_URL = "https://whop.com/@me/settings/memberships/";

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

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Non authentifié." }, 401);

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("whop_membership_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (!profile?.whop_membership_id) {
      return json({ error: "Aucun abonnement Whop associé à ce compte." }, 400);
    }

    let url = FALLBACK_URL;
    if (WHOP_API_KEY) {
      const res = await fetch(
        `https://api.whop.com/api/v1/memberships/${encodeURIComponent(profile.whop_membership_id)}`,
        { headers: { "Authorization": `Bearer ${WHOP_API_KEY}` } },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data?.manage_url === "string" && data.manage_url) url = data.manage_url;
      else console.error("Whop membership lookup:", res.status, JSON.stringify(data));
    }

    return json({ url });
  } catch (err) {
    console.error(err);
    return json({ error: "Erreur lors de l'ouverture de la gestion d'abonnement." }, 500);
  }
});
