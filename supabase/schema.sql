-- supabase/schema.sql — schéma public de MyWattUp
--
-- Copie de référence du schéma en production (projet vwodpdoloavliccnnenh),
-- relevée le 2026-10-15. Il sert à garder une trace versionnée des tables,
-- de la RLS, des fonctions et des triggers, et à recréer une base vierge.
-- Ce n'est PAS une migration à rejouer sur la base de production.
--
-- Appliqué ensuite en production (à rejouer après ce fichier pour une base
-- à jour) : migrations/20261015_rls_perf.sql, plus le cron du rappel de
-- coucher passé à toutes les heures (cron.alter_job(8, '0 * * * *')).
--
-- Ordre : tables -> fonctions -> vues -> policies -> triggers -> index.

create extension if not exists "uuid-ossp";

-- =====================================================================
-- Tables
-- =====================================================================

create table public.profiles (
  id uuid not null default uuid_generate_v4(),
  user_id uuid not null,
  sport_type text,
  objective text,
  allergies text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  consent_given boolean not null default false,
  consent_date timestamp with time zone,
  username text,
  avatar_seed text,
  avatar_url text,
  height_cm numeric,
  weight_kg numeric,
  birth_year integer,
  sex text,
  activity_level text,
  plan text not null default 'free'::text,
  is_admin boolean not null default false,
  email text,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_subscription_status text,
  calorie_adjust_pct numeric not null default 0,
  calorie_adjust_at date,
  payment_provider text,
  whop_user_id text,
  whop_membership_id text,
  whop_membership_status text,
  constraint profiles_pkey PRIMARY KEY (id),
  constraint profiles_stripe_customer_id_key UNIQUE (stripe_customer_id),
  constraint profiles_user_id_key UNIQUE (user_id),
  constraint profiles_username_unique UNIQUE (username),
  constraint profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint profiles_birth_year_check CHECK (((birth_year IS NULL) OR ((birth_year >= 1900) AND (birth_year <= (EXTRACT(year FROM now()))::integer)))) NOT VALID,
  constraint profiles_calorie_adjust_pct_check CHECK (((calorie_adjust_pct >= '-0.15'::numeric) AND (calorie_adjust_pct <= 0.15))),
  constraint profiles_height_cm_check CHECK (((height_cm IS NULL) OR ((height_cm >= (100)::numeric) AND (height_cm <= (250)::numeric)))) NOT VALID,
  constraint profiles_measures_sane CHECK ((((height_cm IS NULL) OR ((height_cm >= (80)::numeric) AND (height_cm <= (250)::numeric))) AND ((weight_kg IS NULL) OR ((weight_kg >= (25)::numeric) AND (weight_kg <= (400)::numeric))) AND ((birth_year IS NULL) OR ((birth_year >= 1900) AND (birth_year <= (EXTRACT(year FROM now()))::integer))))),
  constraint profiles_objective_check CHECK ((objective = ANY (ARRAY['perte_de_poids'::text, 'prise_de_masse'::text, 'performance'::text, 'maintien'::text, 'recuperation'::text]))),
  constraint profiles_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'pro'::text]))),
  constraint profiles_sport_type_check CHECK ((sport_type = ANY (ARRAY['force'::text, 'endurance'::text, 'general'::text]))),
  constraint profiles_username_format CHECK (((username IS NULL) OR (username ~ '^[A-Za-z0-9_.-]{3,24}$'::text))),
  constraint profiles_weight_kg_check CHECK (((weight_kg IS NULL) OR ((weight_kg >= (25)::numeric) AND (weight_kg <= (400)::numeric)))) NOT VALID
);
alter table public.profiles enable row level security;

create table public.user_settings (
  user_id uuid not null,
  units text not null default 'metric'::text,
  daily_reminder boolean not null default false,
  push_notifications boolean not null default false,
  updated_at timestamp with time zone not null default now(),
  profile_public boolean not null default true,
  timezone text not null default 'Europe/Paris'::text,
  last_quality_alert_date date,
  reminder_hour integer not null default 20,
  weekly_weigh_in boolean not null default true,
  last_weigh_in_nudge date,
  constraint user_settings_pkey PRIMARY KEY (user_id),
  constraint user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint user_settings_reminder_hour_check CHECK (((reminder_hour >= 0) AND (reminder_hour <= 23))),
  constraint user_settings_units_check CHECK ((units = ANY (ARRAY['metric'::text, 'imperial'::text])))
);
alter table public.user_settings enable row level security;

-- Compteur des appels IA. Aucune policy : seul le serveur (service role) y accède.
create table public.ai_usage (
  id bigint generated always as identity not null,
  user_id uuid not null,
  kind text not null,
  used_on date not null default ((now() AT TIME ZONE 'Europe/Paris'::text))::date,
  created_at timestamp with time zone not null default now(),
  constraint ai_usage_pkey PRIMARY KEY (id),
  constraint ai_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint ai_usage_kind_check CHECK ((kind = ANY (ARRAY['advice'::text, 'meals'::text, 'estimate'::text])))
);
alter table public.ai_usage enable row level security;

create table public.client_errors (
  id uuid not null default gen_random_uuid(),
  user_id uuid,
  message text not null,
  stack text,
  page text,
  user_agent text,
  created_at timestamp with time zone not null default now(),
  constraint client_errors_pkey PRIMARY KEY (id),
  constraint client_errors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  constraint client_errors_bounded CHECK (((length(message) <= 500) AND ((stack IS NULL) OR (length(stack) <= 4000)) AND ((page IS NULL) OR (length(page) <= 300)) AND ((user_agent IS NULL) OR (length(user_agent) <= 300))))
);
alter table public.client_errors enable row level security;

create table public.daily_logs (
  id uuid not null default uuid_generate_v4(),
  user_id uuid not null,
  log_date date not null default CURRENT_DATE,
  sleep_score integer,
  activity_score integer,
  daily_score integer,
  ai_recommendation text,
  created_at timestamp with time zone not null default now(),
  mood_score integer,
  activity_type text,
  activity_duration_min integer,
  activity_intensity integer,
  sleep_hours numeric,
  sleep_quality text,
  breakfast_done boolean not null default false,
  lunch_done boolean not null default false,
  dinner_done boolean not null default false,
  bedtime time without time zone,
  wake_time time without time zone,
  notes text,
  constraint daily_logs_pkey PRIMARY KEY (id),
  constraint daily_logs_user_id_log_date_key UNIQUE (user_id, log_date),
  constraint daily_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint daily_logs_activity_duration_check CHECK (((activity_duration_min IS NULL) OR ((activity_duration_min >= 0) AND (activity_duration_min <= 600)))) NOT VALID,
  constraint daily_logs_activity_intensity_check CHECK (((activity_intensity >= 1) AND (activity_intensity <= 10))),
  constraint daily_logs_activity_score_check CHECK (((activity_score >= 0) AND (activity_score <= 100))),
  constraint daily_logs_activity_type_check CHECK ((activity_type = ANY (ARRAY['force'::text, 'endurance'::text, 'repos'::text, 'course'::text, 'velo'::text, 'natation'::text, 'hiit'::text, 'sport_co'::text, 'raquette'::text, 'combat'::text, 'marche'::text, 'mobilite'::text]))),
  constraint daily_logs_daily_score_check CHECK (((daily_score >= 0) AND (daily_score <= 100))),
  constraint daily_logs_mood_score_check CHECK (((mood_score >= 1) AND (mood_score <= 10))),
  constraint daily_logs_notes_len CHECK (((notes IS NULL) OR (char_length(notes) <= 1000))),
  constraint daily_logs_sleep_hours_check CHECK (((sleep_hours IS NULL) OR ((sleep_hours >= (0)::numeric) AND (sleep_hours <= (16)::numeric)))) NOT VALID,
  constraint daily_logs_sleep_quality_check CHECK ((sleep_quality = ANY (ARRAY['bonne'::text, 'moyenne'::text, 'mauvaise'::text]))),
  constraint daily_logs_sleep_score_check CHECK (((sleep_score >= 0) AND (sleep_score <= 100)))
);
alter table public.daily_logs enable row level security;

create table public.scanned_products (
  id uuid not null default uuid_generate_v4(),
  user_id uuid not null,
  barcode text not null,
  product_name text,
  personalized_score integer,
  scanned_at timestamp with time zone not null default now(),
  constraint scanned_products_pkey PRIMARY KEY (id),
  constraint scanned_products_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint scanned_products_personalized_score_check CHECK (((personalized_score >= 0) AND (personalized_score <= 100)))
);
alter table public.scanned_products enable row level security;

create table public.food_entries (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  log_date date not null,
  meal_slot text not null,
  source text not null,
  scanned_product_id uuid,
  label text not null,
  quantity_g numeric,
  kcal numeric,
  proteins_g numeric,
  carbs_g numeric,
  fat_g numeric,
  created_at timestamp with time zone default now(),
  constraint food_entries_pkey PRIMARY KEY (id),
  constraint food_entries_scanned_product_id_fkey FOREIGN KEY (scanned_product_id) REFERENCES scanned_products(id),
  constraint food_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint food_entries_kcal_check CHECK (((kcal IS NULL) OR ((kcal >= (0)::numeric) AND (kcal <= (5000)::numeric)))) NOT VALID,
  constraint food_entries_macros_check CHECK ((((proteins_g IS NULL) OR ((proteins_g >= (0)::numeric) AND (proteins_g <= (500)::numeric))) AND ((carbs_g IS NULL) OR ((carbs_g >= (0)::numeric) AND (carbs_g <= (800)::numeric))) AND ((fat_g IS NULL) OR ((fat_g >= (0)::numeric) AND (fat_g <= (500)::numeric))) AND ((quantity_g IS NULL) OR ((quantity_g >= (0)::numeric) AND (quantity_g <= (5000)::numeric))))) NOT VALID,
  constraint food_entries_meal_slot_check CHECK ((meal_slot = ANY (ARRAY['petit_dej'::text, 'dejeuner'::text, 'diner'::text, 'collation'::text]))),
  constraint food_entries_source_check CHECK ((source = ANY (ARRAY['scan'::text, 'manuel'::text, 'meal_plan'::text, 'estimation'::text])))
);
alter table public.food_entries enable row level security;

create table public.friendships (
  id uuid not null default gen_random_uuid(),
  requester_id uuid not null,
  addressee_id uuid not null,
  status text not null default 'pending'::text,
  created_at timestamp with time zone not null default now(),
  responded_at timestamp with time zone,
  constraint friendships_pkey PRIMARY KEY (id),
  constraint friendships_unique_pair UNIQUE (requester_id, addressee_id),
  constraint friendships_addressee_id_fkey FOREIGN KEY (addressee_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint friendships_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint friendships_no_self CHECK ((requester_id <> addressee_id)),
  constraint friendships_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])))
);
alter table public.friendships enable row level security;

create table public.friend_feed_events (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  constraint friend_feed_events_pkey PRIMARY KEY (id),
  constraint friend_feed_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint friend_feed_events_event_type_check CHECK ((event_type = ANY (ARRAY['badge_unlocked'::text, 'shared_recap'::text]))),
  constraint friend_feed_events_payload_sane CHECK (((pg_column_size(payload) < 2048) AND (((payload ->> 'score'::text) IS NULL) OR ((payload ->> 'score'::text) ~ '^[0-9]{1,3}$'::text)) AND (((payload ->> 'badge_label'::text) IS NULL) OR (length((payload ->> 'badge_label'::text)) <= 60))))
);
alter table public.friend_feed_events enable row level security;

create table public.invoices (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  stripe_invoice_id text,
  amount_cents integer not null default 0,
  currency text not null default 'eur'::text,
  status text not null default 'pending'::text,
  card_brand text,
  card_last4 text,
  hosted_invoice_url text,
  issued_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now(),
  pdf_url text,
  plan_label text default 'Offre Pro'::text,
  provider text default 'stripe'::text,
  external_id text,
  constraint invoices_pkey PRIMARY KEY (id),
  constraint invoices_stripe_invoice_id_key UNIQUE (stripe_invoice_id),
  constraint invoices_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint invoices_card_last4_check CHECK (((card_last4 IS NULL) OR (card_last4 ~ '^[0-9]{4}$'::text))),
  constraint invoices_status_check CHECK ((status = ANY (ARRAY['paid'::text, 'failed'::text, 'pending'::text])))
);
alter table public.invoices enable row level security;

create table public.meal_plans (
  id uuid not null default uuid_generate_v4(),
  user_id uuid not null,
  week_start date,
  objective_snapshot text not null,
  created_at timestamp with time zone not null default now(),
  plan_date date not null default ((now() AT TIME ZONE 'Europe/Paris'::text))::date,
  constraint meal_plans_pkey PRIMARY KEY (id),
  constraint meal_plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
alter table public.meal_plans enable row level security;

create table public.meals (
  id uuid not null default uuid_generate_v4(),
  meal_plan_id uuid not null,
  name text not null,
  meal_type text not null,
  ingredients text,
  created_at timestamp with time zone not null default now(),
  kcal integer,
  proteins_g numeric,
  carbs_g numeric,
  fat_g numeric,
  justification text,
  recipe jsonb,
  constraint meals_pkey PRIMARY KEY (id),
  constraint meals_meal_plan_id_fkey FOREIGN KEY (meal_plan_id) REFERENCES meal_plans(id) ON DELETE CASCADE,
  constraint meals_meal_type_check CHECK ((meal_type = ANY (ARRAY['petit_dejeuner'::text, 'dejeuner'::text, 'diner'::text, 'collation'::text])))
);
alter table public.meals enable row level security;

create table public.push_subscriptions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamp with time zone not null default now(),
  constraint push_subscriptions_pkey PRIMARY KEY (id),
  constraint push_subscriptions_endpoint_key UNIQUE (endpoint),
  constraint push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
alter table public.push_subscriptions enable row level security;

create table public.reviews (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  rating smallint not null,
  comment text,
  display_name text not null,
  avatar_url text,
  approved boolean not null default false,
  created_at timestamp with time zone not null default now(),
  constraint reviews_pkey PRIMARY KEY (id),
  constraint reviews_user_id_key UNIQUE (user_id),
  constraint reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint reviews_comment_check CHECK ((char_length(comment) <= 400)),
  constraint reviews_display_name_check CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 40))),
  constraint reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);
alter table public.reviews enable row level security;

create table public.weight_logs (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  log_date date not null,
  weight_kg numeric not null,
  created_at timestamp with time zone not null default now(),
  constraint weight_logs_pkey PRIMARY KEY (id),
  constraint weight_logs_user_id_log_date_key UNIQUE (user_id, log_date),
  constraint weight_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint weight_logs_weight_kg_check CHECK (((weight_kg >= (25)::numeric) AND (weight_kg <= (400)::numeric)))
);
alter table public.weight_logs enable row level security;

-- =====================================================================
-- Fonctions
-- =====================================================================

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select is_admin from public.profiles where user_id = auth.uid()), false);
$function$;

CREATE OR REPLACE FUNCTION public.current_user_is_pro()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select plan = 'pro' from public.profiles where user_id = auth.uid()),
    false
  );
$function$;

-- Quota IA atomique, appelé par api/_quota.js avec la clé service role.
CREATE OR REPLACE FUNCTION public.consume_ai_quota(p_user_id uuid, p_kind text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_is_pro boolean;
  v_limit  int;
  v_used   int;
  v_id     bigint;
  v_today  date := (now() at time zone 'Europe/Paris')::date;
begin
  if p_kind not in ('advice', 'meals', 'estimate') then
    raise exception 'kind invalide: %', p_kind;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_kind, 0));

  select p.plan = 'pro' into v_is_pro
  from public.profiles p
  where p.user_id = p_user_id;

  v_limit := case p_kind
    when 'advice' then case when v_is_pro then 30  else 1  end
    when 'meals'  then case when v_is_pro then 30  else 1  end
    else               case when v_is_pro then 300 else 20 end
  end;

  select count(*) into v_used
  from public.ai_usage u
  where u.user_id = p_user_id and u.kind = p_kind and u.used_on = v_today;

  if v_used >= v_limit then
    return null;
  end if;

  insert into public.ai_usage (user_id, kind, used_on)
  values (p_user_id, p_kind, v_today)
  returning id into v_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_user(target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'Accès refusé : réservé aux administrateurs.';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'Utilise la suppression de compte classique (Paramètres) pour supprimer ton propre compte.';
  end if;
  delete from auth.users where id = target_user_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_user_account()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Non authentifié.';
  end if;

  delete from public.push_subscriptions where user_id = uid;
  delete from public.user_settings where user_id = uid;
  delete from public.meals
  where meal_plan_id in (select id from public.meal_plans where user_id = uid);
  delete from public.meal_plans where user_id = uid;
  delete from public.scanned_products where user_id = uid;
  delete from public.daily_logs where user_id = uid;
  delete from public.profiles where user_id = uid;
  delete from auth.users where id = uid;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_friend_profiles(ids uuid[])
 RETURNS TABLE(user_id uuid, username text, avatar_seed text, avatar_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.user_id, p.username, p.avatar_seed, p.avatar_url
  from public.profiles p
  where p.user_id = any(ids)
    and (
      p.user_id = auth.uid()
      or exists (
        select 1 from public.friendships f
        where f.status = 'accepted'
          and ((f.requester_id = auth.uid() and f.addressee_id = p.user_id)
            or (f.addressee_id = auth.uid() and f.requester_id = p.user_id))
      )
      or exists (
        select 1 from public.friendships f
        where f.status = 'pending'
          and f.addressee_id = auth.uid() and f.requester_id = p.user_id
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.get_public_profiles(username_filter text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, user_id uuid, username text, avatar_seed text, avatar_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id, p.user_id, p.username, p.avatar_seed, p.avatar_url
  from public.profiles p
  left join public.user_settings s on s.user_id = p.user_id
  where auth.uid() is not null
    and username_filter is not null
    and length(btrim(username_filter)) >= 3
    and lower(p.username) = lower(btrim(username_filter))
    and coalesce(s.profile_public, true)
  limit 5;
$function$;

-- ----- Fonctions de trigger -----

CREATE OR REPLACE FUNCTION public.enforce_free_meal_plan_quota()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  used int;
begin
  if public.current_user_is_pro() or auth.role() = 'service_role' then
    return new;
  end if;

  select count(*) into used
  from public.meal_plans
  where user_id = new.user_id
    and plan_date = coalesce(new.plan_date, current_date);

  if used >= 1 then
    raise exception 'Quota atteint : 1 génération de repas par jour en offre Gratuite.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_free_scan_quota()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  used int;
begin
  if public.current_user_is_pro() or auth.role() = 'service_role' then
    return new;
  end if;

  select count(*) into used
  from public.scanned_products
  where user_id = new.user_id
    and scanned_at >= date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris';

  if used >= 5 then
    raise exception 'Quota atteint : 5 scans par jour en offre Gratuite.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.force_scanned_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() <> 'service_role' then
    new.scanned_at := now();
  end if;
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.guard_profiles_sensitive_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    if not public.is_admin() then
      new.is_admin := false;
      new.plan := 'free';
      new.stripe_customer_id := null;
      new.stripe_subscription_id := null;
      new.stripe_subscription_status := null;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if auth.role() <> 'service_role' and not public.is_admin() then
      new.is_admin := old.is_admin;
      new.plan := old.plan;
      new.stripe_customer_id := old.stripe_customer_id;
      new.stripe_subscription_id := old.stripe_subscription_id;
      new.stripe_subscription_status := old.stripe_subscription_status;
      new.user_id := old.user_id;
      new.created_at := old.created_at;

      if new.email is distinct from old.email
         and new.email is distinct from (select u.email from auth.users u where u.id = old.user_id) then
        new.email := old.email;
      end if;
    end if;
    return new;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.handle_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_plan_self_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.plan is distinct from old.plan
     and auth.role() <> 'service_role'
     and not public.is_admin() then
    raise exception 'Le champ plan ne peut être modifié que par le système de facturation';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_profile_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.email is null then
    select email into new.email from auth.users where id = new.user_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sync_profile_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.profiles set email = new.email where user_id = new.id;
  return new;
end;
$function$;

-- ----- Droits d'exécution (comme en production) -----
-- Appelables par les utilisateurs connectés : is_admin, current_user_is_pro,
-- admin_delete_user, delete_user_account, get_friend_profiles, get_public_profiles.
-- Toutes les autres fonctions : service_role uniquement.
do $$
declare f text;
begin
  foreach f in array array[
    'consume_ai_quota(uuid, text)', 'enforce_free_meal_plan_quota()', 'enforce_free_scan_quota()',
    'force_scanned_at()', 'guard_profiles_sensitive_columns()', 'handle_updated_at()',
    'prevent_plan_self_update()', 'set_profile_email()', 'sync_profile_email()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'is_admin()', 'current_user_is_pro()', 'admin_delete_user(uuid)', 'delete_user_account()',
    'get_friend_profiles(uuid[])', 'get_public_profiles(text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- =====================================================================
-- Vues
-- =====================================================================

create or replace view public.admin_user_overview with (security_invoker=on) as
 SELECT p.user_id,
    p.username,
    p.email,
    p.plan,
    p.is_admin,
    p.created_at,
    COALESCE(sp.scan_count, 0::bigint) AS scan_count,
    COALESCE(mp.meal_plan_count, 0::bigint) AS meal_plan_count
   FROM profiles p
     LEFT JOIN ( SELECT scanned_products.user_id,
            count(*) AS scan_count
           FROM scanned_products
          GROUP BY scanned_products.user_id) sp ON sp.user_id = p.user_id
     LEFT JOIN ( SELECT meal_plans.user_id,
            count(*) AS meal_plan_count
           FROM meal_plans
          GROUP BY meal_plans.user_id) mp ON mp.user_id = p.user_id;

create or replace view public.reviews_stats with (security_invoker=true) as
 SELECT round(avg(rating), 1) AS average,
    count(*)::integer AS total
   FROM reviews
  WHERE approved = true;

-- =====================================================================
-- Policies (RLS)
-- =====================================================================

-- profiles
create policy profiles_owner_select on public.profiles as PERMISSIVE for SELECT to authenticated
  using ((auth.uid() = user_id));
create policy profiles_owner_insert on public.profiles as PERMISSIVE for INSERT to authenticated
  with check ((auth.uid() = user_id));
create policy profiles_owner_update on public.profiles as PERMISSIVE for UPDATE to authenticated
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));
create policy profiles_owner_delete on public.profiles as PERMISSIVE for DELETE to authenticated
  using ((auth.uid() = user_id));
create policy admins_select_all_profiles on public.profiles as PERMISSIVE for SELECT to public
  using (is_admin());
create policy admins_update_all_profiles on public.profiles as PERMISSIVE for UPDATE to public
  using (is_admin())
  with check (is_admin());

-- user_settings
create policy "Users can view their own settings" on public.user_settings as PERMISSIVE for SELECT to public
  using ((auth.uid() = user_id));
create policy "Users can insert their own settings" on public.user_settings as PERMISSIVE for INSERT to public
  with check ((auth.uid() = user_id));
create policy "Users can update their own settings" on public.user_settings as PERMISSIVE for UPDATE to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));
create policy "Users can delete their own settings" on public.user_settings as PERMISSIVE for DELETE to authenticated
  using ((auth.uid() = user_id));

-- client_errors
create policy client_errors_insert on public.client_errors as PERMISSIVE for INSERT to anon, authenticated
  with check (((user_id IS NULL) OR (user_id = auth.uid())));
create policy client_errors_admin_select on public.client_errors as PERMISSIVE for SELECT to authenticated
  using (is_admin());

-- daily_logs
create policy "Les utilisateurs voient leurs propres logs" on public.daily_logs as PERMISSIVE for SELECT to public
  using ((auth.uid() = user_id));
create policy "Les utilisateurs créent leurs propres logs" on public.daily_logs as PERMISSIVE for INSERT to public
  with check ((auth.uid() = user_id));
create policy "Les utilisateurs modifient leurs propres logs" on public.daily_logs as PERMISSIVE for UPDATE to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));
create policy "Les utilisateurs suppriment leurs propres logs" on public.daily_logs as PERMISSIVE for DELETE to public
  using ((auth.uid() = user_id));

-- scanned_products
create policy "Les utilisateurs voient leurs propres scans" on public.scanned_products as PERMISSIVE for SELECT to public
  using ((auth.uid() = user_id));
create policy "Les utilisateurs créent leurs propres scans" on public.scanned_products as PERMISSIVE for INSERT to public
  with check ((auth.uid() = user_id));
create policy "Les utilisateurs suppriment leurs propres scans" on public.scanned_products as PERMISSIVE for DELETE to public
  using ((auth.uid() = user_id));
create policy admins_select_all_scanned_products on public.scanned_products as PERMISSIVE for SELECT to public
  using (is_admin());

-- food_entries / weight_logs
create policy "own food entries" on public.food_entries as PERMISSIVE for ALL to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));
create policy "own weight logs" on public.weight_logs as PERMISSIVE for ALL to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

-- friendships
create policy friendships_select_own_pro on public.friendships as PERMISSIVE for SELECT to authenticated
  using ((((auth.uid() = requester_id) OR (auth.uid() = addressee_id)) AND current_user_is_pro()));
create policy friendships_insert_own_pro on public.friendships as PERMISSIVE for INSERT to authenticated
  with check (((auth.uid() = requester_id) AND (status = 'pending'::text) AND current_user_is_pro()));
create policy friendships_respond_as_addressee on public.friendships as PERMISSIVE for UPDATE to authenticated
  using (((auth.uid() = addressee_id) AND (status = 'pending'::text)))
  with check (((auth.uid() = addressee_id) AND (status = ANY (ARRAY['accepted'::text, 'declined'::text]))));
create policy friendships_delete_own on public.friendships as PERMISSIVE for DELETE to public
  using (((auth.uid() = addressee_id) OR (auth.uid() = requester_id)));

-- friend_feed_events
create policy feed_select_own_and_friends_pro on public.friend_feed_events as PERMISSIVE for SELECT to authenticated
  using ((current_user_is_pro() AND ((auth.uid() = user_id) OR (EXISTS ( SELECT 1
   FROM friendships f
  WHERE ((f.status = 'accepted'::text) AND (((f.requester_id = auth.uid()) AND (f.addressee_id = friend_feed_events.user_id)) OR ((f.addressee_id = auth.uid()) AND (f.requester_id = friend_feed_events.user_id)))))))));
create policy feed_insert_own on public.friend_feed_events as PERMISSIVE for INSERT to public
  with check ((auth.uid() = user_id));
create policy feed_delete_own on public.friend_feed_events as PERMISSIVE for DELETE to public
  using ((auth.uid() = user_id));

-- invoices (écrites uniquement par les webhooks, en service role)
create policy invoices_owner_select on public.invoices as PERMISSIVE for SELECT to authenticated
  using ((auth.uid() = user_id));
create policy invoices_admin_select on public.invoices as PERMISSIVE for SELECT to authenticated
  using (is_admin());

-- meal_plans
create policy "Les utilisateurs voient leurs propres plans" on public.meal_plans as PERMISSIVE for SELECT to public
  using ((auth.uid() = user_id));
create policy "Les utilisateurs créent leurs propres plans" on public.meal_plans as PERMISSIVE for INSERT to public
  with check ((auth.uid() = user_id));
create policy "Les utilisateurs modifient leurs propres plans" on public.meal_plans as PERMISSIVE for UPDATE to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));
create policy "Les utilisateurs suppriment leurs propres plans" on public.meal_plans as PERMISSIVE for DELETE to public
  using ((auth.uid() = user_id));
create policy admins_select_all_meal_plans on public.meal_plans as PERMISSIVE for SELECT to public
  using (is_admin());

-- meals
create policy "Les utilisateurs voient les repas de leurs propres plans" on public.meals as PERMISSIVE for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM meal_plans
  WHERE ((meal_plans.id = meals.meal_plan_id) AND (meal_plans.user_id = auth.uid())))));
create policy "Les utilisateurs créent des repas sur leurs propres plans" on public.meals as PERMISSIVE for INSERT to public
  with check ((EXISTS ( SELECT 1
   FROM meal_plans
  WHERE ((meal_plans.id = meals.meal_plan_id) AND (meal_plans.user_id = auth.uid())))));
create policy "Les utilisateurs modifient les repas de leurs propres plans" on public.meals as PERMISSIVE for UPDATE to authenticated
  using ((EXISTS ( SELECT 1
   FROM meal_plans mp
  WHERE ((mp.id = meals.meal_plan_id) AND (mp.user_id = auth.uid())))))
  with check ((EXISTS ( SELECT 1
   FROM meal_plans mp
  WHERE ((mp.id = meals.meal_plan_id) AND (mp.user_id = auth.uid())))));
create policy "Les utilisateurs suppriment les repas de leurs propres plans" on public.meals as PERMISSIVE for DELETE to public
  using ((EXISTS ( SELECT 1
   FROM meal_plans
  WHERE ((meal_plans.id = meals.meal_plan_id) AND (meal_plans.user_id = auth.uid())))));

-- push_subscriptions
create policy "Users can view their own subscriptions" on public.push_subscriptions as PERMISSIVE for SELECT to public
  using ((auth.uid() = user_id));
create policy "Users can insert their own subscriptions" on public.push_subscriptions as PERMISSIVE for INSERT to public
  with check ((auth.uid() = user_id));
create policy "Users can update their own subscriptions" on public.push_subscriptions as PERMISSIVE for UPDATE to authenticated
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));
create policy "Users can delete their own subscriptions" on public.push_subscriptions as PERMISSIVE for DELETE to public
  using ((auth.uid() = user_id));

-- reviews
create policy reviews_select_approved on public.reviews as PERMISSIVE for SELECT to public
  using (((approved = true) OR (auth.uid() = user_id)));
create policy reviews_insert_own on public.reviews as PERMISSIVE for INSERT to authenticated
  with check (((auth.uid() = user_id) AND (approved = false)));
create policy reviews_update_own on public.reviews as PERMISSIVE for UPDATE to authenticated
  using ((auth.uid() = user_id))
  with check (((auth.uid() = user_id) AND (approved = false)));

-- ai_usage : aucune policy (accès service role uniquement).

-- =====================================================================
-- Triggers
-- =====================================================================

CREATE TRIGGER before_profile_insert_set_email BEFORE INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION set_profile_email();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER trg_guard_profiles_sensitive_columns BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profiles_sensitive_columns();
CREATE TRIGGER trg_prevent_plan_self_update BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION prevent_plan_self_update();
CREATE TRIGGER trg_a_force_scanned_at BEFORE INSERT ON public.scanned_products FOR EACH ROW EXECUTE FUNCTION force_scanned_at();
CREATE TRIGGER trg_enforce_free_scan_quota BEFORE INSERT ON public.scanned_products FOR EACH ROW EXECUTE FUNCTION enforce_free_scan_quota();
CREATE TRIGGER trg_enforce_free_meal_plan_quota BEFORE INSERT ON public.meal_plans FOR EACH ROW EXECUTE FUNCTION enforce_free_meal_plan_quota();
CREATE TRIGGER on_auth_user_email_sync AFTER INSERT OR UPDATE OF email ON auth.users FOR EACH ROW EXECUTE FUNCTION sync_profile_email();

-- =====================================================================
-- Index
-- =====================================================================

CREATE INDEX ai_usage_user_kind_day_idx ON public.ai_usage USING btree (user_id, kind, used_on);
CREATE INDEX client_errors_created_idx ON public.client_errors USING btree (created_at DESC);
CREATE INDEX food_entries_user_id_log_date_idx ON public.food_entries USING btree (user_id, log_date);
CREATE INDEX friend_feed_events_user_idx ON public.friend_feed_events USING btree (user_id, created_at DESC);
CREATE INDEX friendships_addressee_idx ON public.friendships USING btree (addressee_id, status);
CREATE INDEX friendships_requester_idx ON public.friendships USING btree (requester_id, status);
CREATE INDEX idx_daily_logs_user_date ON public.daily_logs USING btree (user_id, log_date DESC);
CREATE UNIQUE INDEX daily_logs_user_date_unique ON public.daily_logs USING btree (user_id, log_date);
CREATE INDEX idx_meal_plans_user ON public.meal_plans USING btree (user_id);
CREATE INDEX idx_meal_plans_user_plan_date ON public.meal_plans USING btree (user_id, plan_date DESC);
CREATE INDEX meal_plans_user_date_idx ON public.meal_plans USING btree (user_id, plan_date DESC);
CREATE INDEX idx_meals_plan ON public.meals USING btree (meal_plan_id);
CREATE INDEX idx_scanned_products_user ON public.scanned_products USING btree (user_id, scanned_at DESC);
CREATE INDEX invoices_user_issued_idx ON public.invoices USING btree (user_id, issued_at DESC);
CREATE UNIQUE INDEX invoices_external_id_key ON public.invoices USING btree (external_id) WHERE (external_id IS NOT NULL);
CREATE INDEX profiles_whop_membership_id_idx ON public.profiles USING btree (whop_membership_id);
CREATE UNIQUE INDEX profiles_username_unique_idx ON public.profiles USING btree (lower(username)) WHERE (username IS NOT NULL);
CREATE INDEX reviews_approved_created_idx ON public.reviews USING btree (approved, created_at DESC);
CREATE INDEX weight_logs_user_date_idx ON public.weight_logs USING btree (user_id, log_date DESC);
