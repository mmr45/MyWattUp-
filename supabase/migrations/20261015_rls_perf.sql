-- 20261015_rls_perf.sql — performances RLS et index (aucun changement de droits)
--
-- 1) auth.uid(), is_admin() et current_user_is_pro() sont enveloppés dans
--    (select ...) : Postgres les évalue une fois par requête au lieu d'une fois
--    par ligne (alerte Supabase « auth_rls_initplan », 41 policies).
-- 2) Les policies « admin » et « propriétaire » d'une même action sont
--    fusionnées en une seule (alerte « multiple_permissive_policies ») :
--    même résultat, puisque deux policies permissives se combinent déjà en OU.
-- 3) Index : 2 doublons supprimés, 3 clés étrangères indexées.

begin;

alter policy profiles_owner_select on public.profiles
  using ((((select auth.uid()) = user_id)) OR (select is_admin()));
alter policy profiles_owner_insert on public.profiles
  with check (((select auth.uid()) = user_id));
alter policy profiles_owner_update on public.profiles
  using ((((select auth.uid()) = user_id)) OR (select is_admin()))
  with check ((((select auth.uid()) = user_id)) OR (select is_admin()));
alter policy profiles_owner_delete on public.profiles
  using (((select auth.uid()) = user_id));
drop policy admins_select_all_profiles on public.profiles;
drop policy admins_update_all_profiles on public.profiles;
alter policy "Users can view their own settings" on public.user_settings
  using (((select auth.uid()) = user_id));
alter policy "Users can insert their own settings" on public.user_settings
  with check (((select auth.uid()) = user_id));
alter policy "Users can update their own settings" on public.user_settings
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));
alter policy "Users can delete their own settings" on public.user_settings
  using (((select auth.uid()) = user_id));
alter policy client_errors_insert on public.client_errors
  with check (((user_id IS NULL) OR (user_id = (select auth.uid()))));
alter policy client_errors_admin_select on public.client_errors
  using ((select is_admin()));
alter policy "Les utilisateurs voient leurs propres logs" on public.daily_logs
  using (((select auth.uid()) = user_id));
alter policy "Les utilisateurs créent leurs propres logs" on public.daily_logs
  with check (((select auth.uid()) = user_id));
alter policy "Les utilisateurs modifient leurs propres logs" on public.daily_logs
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));
alter policy "Les utilisateurs suppriment leurs propres logs" on public.daily_logs
  using (((select auth.uid()) = user_id));
alter policy "Les utilisateurs voient leurs propres scans" on public.scanned_products
  using ((((select auth.uid()) = user_id)) OR (select is_admin()));
alter policy "Les utilisateurs créent leurs propres scans" on public.scanned_products
  with check (((select auth.uid()) = user_id));
alter policy "Les utilisateurs suppriment leurs propres scans" on public.scanned_products
  using (((select auth.uid()) = user_id));
drop policy admins_select_all_scanned_products on public.scanned_products;
alter policy "own food entries" on public.food_entries
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));
alter policy "own weight logs" on public.weight_logs
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));
alter policy friendships_select_own_pro on public.friendships
  using (((((select auth.uid()) = requester_id) OR ((select auth.uid()) = addressee_id)) AND (select current_user_is_pro())));
alter policy friendships_insert_own_pro on public.friendships
  with check ((((select auth.uid()) = requester_id) AND (status = 'pending'::text) AND (select current_user_is_pro())));
alter policy friendships_respond_as_addressee on public.friendships
  using ((((select auth.uid()) = addressee_id) AND (status = 'pending'::text)))
  with check ((((select auth.uid()) = addressee_id) AND (status = ANY (ARRAY['accepted'::text, 'declined'::text]))));
alter policy friendships_delete_own on public.friendships
  using ((((select auth.uid()) = addressee_id) OR ((select auth.uid()) = requester_id)));
alter policy feed_select_own_and_friends_pro on public.friend_feed_events
  using (((select current_user_is_pro()) AND (((select auth.uid()) = user_id) OR (EXISTS ( SELECT 1
   FROM friendships f
  WHERE ((f.status = 'accepted'::text) AND (((f.requester_id = (select auth.uid())) AND (f.addressee_id = friend_feed_events.user_id)) OR ((f.addressee_id = (select auth.uid())) AND (f.requester_id = friend_feed_events.user_id)))))))));
alter policy feed_insert_own on public.friend_feed_events
  with check (((select auth.uid()) = user_id));
alter policy feed_delete_own on public.friend_feed_events
  using (((select auth.uid()) = user_id));
alter policy invoices_owner_select on public.invoices
  using ((((select auth.uid()) = user_id)) OR (select is_admin()));
drop policy invoices_admin_select on public.invoices;
alter policy "Les utilisateurs voient leurs propres plans" on public.meal_plans
  using ((((select auth.uid()) = user_id)) OR (select is_admin()));
alter policy "Les utilisateurs créent leurs propres plans" on public.meal_plans
  with check (((select auth.uid()) = user_id));
alter policy "Les utilisateurs modifient leurs propres plans" on public.meal_plans
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));
alter policy "Les utilisateurs suppriment leurs propres plans" on public.meal_plans
  using (((select auth.uid()) = user_id));
drop policy admins_select_all_meal_plans on public.meal_plans;
alter policy "Les utilisateurs voient les repas de leurs propres plans" on public.meals
  using ((EXISTS ( SELECT 1
   FROM meal_plans
  WHERE ((meal_plans.id = meals.meal_plan_id) AND (meal_plans.user_id = (select auth.uid()))))));
alter policy "Les utilisateurs créent des repas sur leurs propres plans" on public.meals
  with check ((EXISTS ( SELECT 1
   FROM meal_plans
  WHERE ((meal_plans.id = meals.meal_plan_id) AND (meal_plans.user_id = (select auth.uid()))))));
alter policy "Les utilisateurs modifient les repas de leurs propres plans" on public.meals
  using ((EXISTS ( SELECT 1
   FROM meal_plans mp
  WHERE ((mp.id = meals.meal_plan_id) AND (mp.user_id = (select auth.uid()))))))
  with check ((EXISTS ( SELECT 1
   FROM meal_plans mp
  WHERE ((mp.id = meals.meal_plan_id) AND (mp.user_id = (select auth.uid()))))));
alter policy "Les utilisateurs suppriment les repas de leurs propres plans" on public.meals
  using ((EXISTS ( SELECT 1
   FROM meal_plans
  WHERE ((meal_plans.id = meals.meal_plan_id) AND (meal_plans.user_id = (select auth.uid()))))));
alter policy "Users can view their own subscriptions" on public.push_subscriptions
  using (((select auth.uid()) = user_id));
alter policy "Users can insert their own subscriptions" on public.push_subscriptions
  with check (((select auth.uid()) = user_id));
alter policy "Users can update their own subscriptions" on public.push_subscriptions
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));
alter policy "Users can delete their own subscriptions" on public.push_subscriptions
  using (((select auth.uid()) = user_id));
alter policy reviews_select_approved on public.reviews
  using (((approved = true) OR ((select auth.uid()) = user_id)));
alter policy reviews_insert_own on public.reviews
  with check ((((select auth.uid()) = user_id) AND (approved = false)));
alter policy reviews_update_own on public.reviews
  using (((select auth.uid()) = user_id))
  with check ((((select auth.uid()) = user_id) AND (approved = false)));

-- Index en double (identiques à une contrainte ou à un autre index)
drop index if exists public.daily_logs_user_date_unique;      -- doublon de daily_logs_user_id_log_date_key
drop index if exists public.meal_plans_user_date_idx;         -- doublon de idx_meal_plans_user_plan_date

-- Clés étrangères sans index
create index if not exists client_errors_user_id_idx on public.client_errors (user_id);
create index if not exists food_entries_scanned_product_id_idx on public.food_entries (scanned_product_id);
create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

commit;
