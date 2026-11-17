-- ============================================================================
-- PARCHE DE SINCRONIZACIÓN MÓVIL Y CREACIÓN DINÁMICA DE PINS DESDE PANEL ADMIN
-- ============================================================================

UPDATE auth.users
SET confirmation_token = COALESCE(confirmation_token, ''),
    recovery_token = COALESCE(recovery_token, ''),
    email_change_token_new = COALESCE(email_change_token_new, ''),
    email_change = COALESCE(email_change, ''),
    phone_change = COALESCE(phone_change, ''),
    phone_change_token = COALESCE(phone_change_token, ''),
    reauthentication_token = COALESCE(reauthentication_token, '');

DROP POLICY IF EXISTS "finish_events_insert_staff" ON public.finish_events;
CREATE POLICY "finish_events_insert_staff"
    ON public.finish_events FOR INSERT
    TO anon, authenticated
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.revoked = false)
    );

DROP POLICY IF EXISTS "finish_events_update_admin_only" ON public.finish_events;
CREATE POLICY "finish_events_update_admin_only"
    ON public.finish_events FOR UPDATE
    TO anon, authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.revoked = false))
    WITH CHECK (true);

DROP POLICY IF EXISTS "profiles_select_own_or_admin" ON public.profiles;
CREATE POLICY "profiles_select_own_or_admin"
    ON public.profiles FOR SELECT
    TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS "profiles_admin_write" ON public.profiles;
CREATE POLICY "profiles_admin_write"
    ON public.profiles FOR ALL
    TO anon, authenticated
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "races_admin_write" ON public.races;
CREATE POLICY "races_admin_write"
    ON public.races FOR ALL
    TO anon, authenticated
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "categories_admin_write" ON public.categories;
CREATE POLICY "categories_admin_write"
    ON public.categories FOR ALL
    TO anon, authenticated
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "entries_admin_write" ON public.entries;
CREATE POLICY "entries_admin_write"
    ON public.entries FOR ALL
    TO anon, authenticated
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "race_start_admin_write" ON public.race_start;
CREATE POLICY "race_start_admin_write"
    ON public.race_start FOR ALL
    TO anon, authenticated
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "audit_log_select_admin" ON public.audit_log;
CREATE POLICY "audit_log_select_admin"
    ON public.audit_log FOR SELECT
    TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS "audit_log_insert_staff" ON public.audit_log;
CREATE POLICY "audit_log_insert_staff"
    ON public.audit_log FOR INSERT
    TO anon, authenticated
    WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.races, public.categories, public.entries, public.profiles, public.race_start, public.finish_events TO anon, authenticated;
GRANT DELETE ON public.categories, public.entries TO anon, authenticated;
GRANT SELECT, INSERT ON public.audit_log, public.login_attempts TO anon, authenticated;
