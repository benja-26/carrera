-- ============================================================================
-- ETAPA 1: ESQUEMA SQL COMPLETO, FUNCIONES DE SERVIDOR Y POLÃTICAS RLS
-- Proyecto: Cronometraje PWA Skol (4 km Duplas / 6 km Individuales)
-- Motor: PostgreSQL 15+ (Supabase)
-- ============================================================================

-- Extensiones requeridas
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. TIPOS ENUMERADOS
-- ============================================================================
DO $$ BEGIN
    CREATE TYPE public.user_role AS ENUM ('admin', 'timekeeper');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.race_status AS ENUM ('pending', 'running', 'finished');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.event_status AS ENUM ('valid', 'duplicate', 'void', 'unassigned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.event_type AS ENUM ('finish', 'start_crossing');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 2. TABLAS PRINCIPALES
-- ============================================================================

-- 2.1 Carreras (races)
CREATE TABLE IF NOT EXISTS public.races (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    location text NOT NULL DEFAULT 'Punto A - Circuito Costanera',
    race_date date NOT NULL DEFAULT CURRENT_DATE,
    status public.race_status NOT NULL DEFAULT 'pending',
    net_time_enabled boolean NOT NULL DEFAULT false, -- Opcional: Tiempo neto desactivado por defecto
    duplicate_threshold_ms integer NOT NULL DEFAULT 2000 CHECK (duplicate_threshold_ms >= 0),
    screen_groups jsonb NOT NULL DEFAULT '[
        {"id": 1, "title": "Duplas Funcional", "subtitle": "4 km (Dupla / H-H / M-M)"},
        {"id": 2, "title": "Duplas Scaled", "subtitle": "4 km (Dupla / H-H / M-M)"},
        {"id": 3, "title": "Avanzado", "subtitle": "6 km (Ind / Mujer / Hombre)"},
        {"id": 4, "title": "RX", "subtitle": "6 km (Ind / Mujer / Hombre)"}
    ]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.2 CategorÃ­as (categories)
CREATE TABLE IF NOT EXISTS public.categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    race_id uuid NOT NULL REFERENCES public.races(id) ON DELETE CASCADE,
    slug text NOT NULL,
    name text NOT NULL,
    short_name text NOT NULL,
    distance_km numeric(4,1) NOT NULL CHECK (distance_km IN (4.0, 6.0)),
    is_pair boolean NOT NULL DEFAULT false,
    bib_range_start integer NOT NULL CHECK (bib_range_start > 0),
    bib_range_end integer NOT NULL CHECK (bib_range_end >= bib_range_start),
    bib_step integer NOT NULL DEFAULT 10 CHECK (bib_step >= 1),
    color text NOT NULL, -- Hex de alto contraste
    screen_group integer NOT NULL DEFAULT 1 CHECK (screen_group BETWEEN 1 AND 8),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (race_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_categories_race_screen ON public.categories(race_id, screen_group, sort_order);

-- 2.3 Inscriptos: Atletas individuales y Duplas (entries)
CREATE TABLE IF NOT EXISTS public.entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    race_id uuid NOT NULL REFERENCES public.races(id) ON DELETE CASCADE,
    category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
    bib integer NOT NULL CHECK (bib > 0),
    display_name text NOT NULL,
    team_name text,
    members jsonb NOT NULL DEFAULT '[]'::jsonb, -- Ej: ["Juan PÃ©rez", "Lucas GÃ³mez"]
    active boolean NOT NULL DEFAULT true,       -- false = DNS / Baja
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (race_id, bib)
);

CREATE INDEX IF NOT EXISTS idx_entries_race_bib ON public.entries(race_id, bib);
CREATE INDEX IF NOT EXISTS idx_entries_category ON public.entries(category_id);

-- 2.4 Perfiles de usuario y asignaciÃ³n de pantallas (profiles)
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    race_id uuid REFERENCES public.races(id) ON DELETE SET NULL,
    display_name text NOT NULL,
    role public.user_role NOT NULL DEFAULT 'timekeeper',
    pin_code text UNIQUE CHECK (pin_code IS NULL OR length(pin_code) BETWEEN 4 AND 8),
    synthetic_email text UNIQUE,
    assigned_screens integer[] NOT NULL DEFAULT '{1,2,3,4}',
    revoked boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.5 Largada Ãºnica (race_start)
CREATE TABLE IF NOT EXISTS public.race_start (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    race_id uuid NOT NULL UNIQUE REFERENCES public.races(id) ON DELETE CASCADE,
    ts_utc_ms bigint NOT NULL CHECK (ts_utc_ms > 1700000000000),
    user_id uuid NOT NULL REFERENCES public.profiles(id),
    corrected_by uuid REFERENCES public.profiles(id),
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2.6 Registros de llegada y paso por largada (finish_events)
-- Nota: El UUID es generado en el cliente para garantizar idempotencia en reintentos offline.
CREATE TABLE IF NOT EXISTS public.finish_events (
    id uuid PRIMARY KEY,
    race_id uuid NOT NULL REFERENCES public.races(id) ON DELETE CASCADE,
    event_type public.event_type NOT NULL DEFAULT 'finish',
    bib integer CHECK (bib IS NULL OR bib > 0),
    ts_utc_ms bigint NOT NULL CHECK (ts_utc_ms > 1700000000000),
    clock_offset_ms integer NOT NULL DEFAULT 0,
    device_id text NOT NULL CHECK (length(trim(device_id)) > 0),
    user_id uuid NOT NULL REFERENCES public.profiles(id),
    status public.event_status NOT NULL DEFAULT 'valid',
    high_discrepancy boolean NOT NULL DEFAULT false,
    void_reason text,
    voided_by uuid REFERENCES public.profiles(id),
    voided_at timestamptz,
    assigned_by uuid REFERENCES public.profiles(id),
    assigned_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), -- Timestamp reportado al crear en cliente
    synced_at timestamptz NOT NULL DEFAULT now()   -- Timestamp real de recepciÃ³n en servidor
);

-- Ãndices para consultas en tiempo real y resoluciÃ³n de duplicados
CREATE INDEX IF NOT EXISTS idx_finish_events_race_bib_status
    ON public.finish_events(race_id, event_type, bib, status);
CREATE INDEX IF NOT EXISTS idx_finish_events_race_ts
    ON public.finish_events(race_id, event_type, ts_utc_ms ASC);
CREATE INDEX IF NOT EXISTS idx_finish_events_user_device
    ON public.finish_events(user_id, device_id, synced_at DESC);

-- GarantÃ­a a nivel de base de datos: A lo sumo UN registro 'valid' por (race_id, event_type, bib)
CREATE UNIQUE INDEX IF NOT EXISTS uq_finish_events_one_valid_per_bib
    ON public.finish_events(race_id, event_type, bib)
    WHERE status = 'valid' AND bib IS NOT NULL;

-- 2.7 Registro de AuditorÃ­a Inmutable (audit_log)
CREATE TABLE IF NOT EXISTS public.audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    race_id uuid REFERENCES public.races(id) ON DELETE CASCADE,
    actor_id uuid REFERENCES public.profiles(id),
    action text NOT NULL,
    entity_table text NOT NULL,
    entity_id text NOT NULL,
    before_data jsonb,
    after_data jsonb,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_race_created ON public.audit_log(race_id, created_at DESC);

-- 2.8 Control de intentos de login por PIN (Rate Limiting en servidor)
CREATE TABLE IF NOT EXISTS public.login_attempts (
    id bigserial PRIMARY KEY,
    device_id text NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    success boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_device_time
    ON public.login_attempts(device_id, attempted_at DESC);

-- ============================================================================
-- 3. FUNCIONES AUXILIARES DE SEGURIDAD Y TIEMPO
-- ============================================================================

-- 3.1 Hora exacta del servidor en milisegundos UTC (para cÃ¡lculo de clock offset NTP-like)
CREATE OR REPLACE FUNCTION public.get_server_time_ms()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
$$;

-- 3.2 Verificar si el usuario autenticado es admin activo
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE id = auth.uid()
          AND role = 'admin'
          AND revoked = false
    );
$$;

-- 3.3 Verificar si el usuario autenticado es cronometrista o admin activo
CREATE OR REPLACE FUNCTION public.is_active_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE id = auth.uid()
          AND revoked = false
    );
$$;

-- ============================================================================
-- 4. LÃ“GICA DE NEGOCIO EN SERVIDOR: DUPLICADOS, DESHACER Y MODO B
-- ============================================================================

-- 4.1 Trigger BEFORE INSERT en finish_events:
--     Valida dorsal, estado del usuario, rangos de timestamp y resuelve duplicados
--     conservando SIEMPRE el timestamp mÃ¡s temprano como 'valid'.
CREATE OR REPLACE FUNCTION public.trg_fn_process_finish_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing record;
    v_threshold_ms integer;
    v_now_ms bigint;
    v_entry_exists boolean;
BEGIN
    -- 1. Validar que el usuario sea staff activo (no revocado)
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = NEW.user_id AND revoked = false
    ) THEN
        RAISE EXCEPTION 'Usuario revocado o sin permisos para registrar tiempos.';
    END IF;

    -- Forzar timestamp de sincronizaciÃ³n del servidor
    NEW.synced_at := clock_timestamp();
    v_now_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;

    -- 2. Validar que el timestamp sea razonable (no mÃ¡s de 60s en el futuro ni > 7 dÃ­as atrÃ¡s)
    IF NEW.ts_utc_ms > (v_now_ms + 60000) THEN
        RAISE EXCEPTION 'Timestamp invÃ¡lido: estÃ¡ en el futuro respecto al servidor (% ms).', (NEW.ts_utc_ms - v_now_ms);
    END IF;

    IF NEW.ts_utc_ms < (v_now_ms - 604800000) THEN
        RAISE EXCEPTION 'Timestamp invÃ¡lido: demasiado antiguo.';
    END IF;

    -- 3. Caso Modo B ("LLEGÃ“ sin nÃºmero"): entra siempre como 'unassigned'
    IF NEW.bib IS NULL THEN
        NEW.status := 'unassigned';
        NEW.high_discrepancy := false;
        RETURN NEW;
    END IF;

    -- 4. Validar que el nÃºmero de pechera (bib) exista en la carrera
    SELECT EXISTS (
        SELECT 1 FROM public.entries
        WHERE race_id = NEW.race_id AND bib = NEW.bib
    ) INTO v_entry_exists;

    IF NOT v_entry_exists THEN
        RAISE EXCEPTION 'El dorsal #% no existe en la lista de inscriptos de esta carrera.', NEW.bib;
    END IF;

    -- Si ya viene explÃ­citamente anulado, respetarlo
    IF NEW.status = 'void' THEN
        RETURN NEW;
    END IF;

    -- 5. Lock transaccional por (race_id, event_type, bib) para evitar condiciones de carrera
    PERFORM pg_advisory_xact_lock(
        hashtext(NEW.race_id::text || ':' || NEW.event_type::text || ':' || NEW.bib::text)
    );

    SELECT duplicate_threshold_ms INTO v_threshold_ms
    FROM public.races
    WHERE id = NEW.race_id;

    v_threshold_ms := COALESCE(v_threshold_ms, 2000);

    -- Buscar si ya existe un registro 'valid' para este dorsal
    SELECT id, ts_utc_ms, device_id, user_id
    INTO v_existing
    FROM public.finish_events
    WHERE race_id = NEW.race_id
      AND event_type = NEW.event_type
      AND bib = NEW.bib
      AND status = 'valid'
    LIMIT 1;

    IF v_existing.id IS NULL THEN
        -- Primer registro vÃ¡lido para este dorsal
        NEW.status := 'valid';
        NEW.high_discrepancy := false;
    ELSIF NEW.ts_utc_ms >= v_existing.ts_utc_ms THEN
        -- El existente es mÃ¡s temprano o igual -> el nuevo queda como 'duplicate'
        NEW.status := 'duplicate';
        NEW.high_discrepancy := ((NEW.ts_utc_ms - v_existing.ts_utc_ms) > v_threshold_ms);
    ELSE
        -- El nuevo registro (ej. sincronizado offline tarde) tiene un timestamp ANTERIOR al 'valid' actual.
        -- Se degrada el anterior a 'duplicate' y el nuevo pasa a ser el 'valid' oficial.
        UPDATE public.finish_events
        SET status = 'duplicate',
            high_discrepancy = ((v_existing.ts_utc_ms - NEW.ts_utc_ms) > v_threshold_ms)
        WHERE id = v_existing.id;

        NEW.status := 'valid';
        NEW.high_discrepancy := false;

        INSERT INTO public.audit_log (
            race_id, actor_id, action, entity_table, entity_id,
            before_data, after_data, reason
        ) VALUES (
            NEW.race_id,
            NEW.user_id,
            'EARLIER_OFFLINE_SYNC_PROMOTED',
            'finish_events',
            NEW.id::text,
            jsonb_build_object('previous_valid_event_id', v_existing.id, 'previous_ts_utc_ms', v_existing.ts_utc_ms),
            jsonb_build_object('new_valid_event_id', NEW.id, 'new_ts_utc_ms', NEW.ts_utc_ms, 'bib', NEW.bib),
            'SincronizaciÃ³n de evento con timestamp anterior al vigente; promovido automÃ¡ticamente.'
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_before_insert_finish_event ON public.finish_events;
CREATE TRIGGER trg_before_insert_finish_event
BEFORE INSERT ON public.finish_events
FOR EACH ROW
EXECUTE FUNCTION public.trg_fn_process_finish_event();

-- 4.2 RPC: Deshacer propio registro dentro de la ventana de 10s (con 15s de tolerancia por red)
CREATE OR REPLACE FUNCTION public.undo_own_finish_event(
    p_event_id uuid,
    p_device_id text
)
RETURNS public.finish_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_event public.finish_events;
    v_promoted_id uuid;
    v_now_ms bigint;
BEGIN
    v_now_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;

    SELECT * INTO v_event
    FROM public.finish_events
    WHERE id = p_event_id
    FOR UPDATE;

    IF v_event.id IS NULL THEN
        RAISE EXCEPTION 'El registro no existe en el servidor.';
    END IF;

    IF v_event.user_id <> auth.uid() OR v_event.device_id <> p_device_id THEN
        RAISE EXCEPTION 'Solo podÃ©s deshacer registros tomados por tu propio usuario y dispositivo.';
    END IF;

    IF v_event.status = 'void' THEN
        RETURN v_event;
    END IF;

    -- Validar ventana temporal (15 segundos desde el timestamp capturado o desde synced_at)
    IF (v_now_ms - v_event.ts_utc_ms) > 15000
       AND (EXTRACT(EPOCH FROM (clock_timestamp() - v_event.synced_at)) * 1000) > 15000 THEN
        RAISE EXCEPTION 'ExpirÃ³ el tiempo mÃ¡ximo (10 segundos) para deshacer. SolicitÃ¡ la anulaciÃ³n al administrador.';
    END IF;

    -- Anular el registro (nunca se borra)
    UPDATE public.finish_events
    SET status = 'void',
        void_reason = 'Deshacer rÃ¡pido (10s) por el cronometrista',
        voided_by = auth.uid(),
        voided_at = clock_timestamp()
    WHERE id = p_event_id
    RETURNING * INTO v_event;

    -- Si era el registro 'valid' de ese dorsal y habÃ­a un 'duplicate', promover el mÃ¡s temprano a 'valid'
    IF v_event.bib IS NOT NULL THEN
        SELECT id INTO v_promoted_id
        FROM public.finish_events
        WHERE race_id = v_event.race_id
          AND event_type = v_event.event_type
          AND bib = v_event.bib
          AND status = 'duplicate'
        ORDER BY ts_utc_ms ASC
        LIMIT 1
        FOR UPDATE;

        IF v_promoted_id IS NOT NULL THEN
            UPDATE public.finish_events
            SET status = 'valid',
                high_discrepancy = false
            WHERE id = v_promoted_id;
        END IF;
    END IF;

    INSERT INTO public.audit_log (
        race_id, actor_id, action, entity_table, entity_id,
        before_data, after_data, reason
    ) VALUES (
        v_event.race_id,
        auth.uid(),
        'EVENT_UNDO_10S',
        'finish_events',
        v_event.id::text,
        jsonb_build_object('status', 'valid', 'bib', v_event.bib, 'ts_utc_ms', v_event.ts_utc_ms),
        jsonb_build_object('status', 'void', 'promoted_duplicate_id', v_promoted_id),
        'Deshacer rÃ¡pido (10s) por el cronometrista'
    );

    RETURN v_event;
END;
$$;

-- 4.3 RPC: Asignar dorsal a un registro capturado en Modo B ("LLEGÃ“ sin nÃºmero")
CREATE OR REPLACE FUNCTION public.assign_bib_to_event(
    p_event_id uuid,
    p_bib integer
)
RETURNS public.finish_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_event public.finish_events;
    v_existing record;
    v_threshold_ms integer;
    v_new_status public.event_status;
    v_high_disc boolean := false;
BEGIN
    SELECT * INTO v_event
    FROM public.finish_events
    WHERE id = p_event_id
    FOR UPDATE;

    IF v_event.id IS NULL THEN
        RAISE EXCEPTION 'El registro sin nÃºmero no existe.';
    END IF;

    -- Solo el autor del registro o un admin pueden asignarle nÃºmero
    IF v_event.user_id <> auth.uid() AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'No tenÃ©s permiso para asignar un dorsal a este registro.';
    END IF;

    IF v_event.status <> 'unassigned' THEN
        RAISE EXCEPTION 'Este registro ya tiene dorsal asignado o fue anulado (estado actual: %).', v_event.status;
    END IF;

    -- Verificar que el dorsal exista en la carrera
    IF NOT EXISTS (
        SELECT 1 FROM public.entries
        WHERE race_id = v_event.race_id AND bib = p_bib
    ) THEN
        RAISE EXCEPTION 'El dorsal #% no existe en esta carrera.', p_bib;
    END IF;

    -- Lock por dorsal
    PERFORM pg_advisory_xact_lock(
        hashtext(v_event.race_id::text || ':' || v_event.event_type::text || ':' || p_bib::text)
    );

    SELECT duplicate_threshold_ms INTO v_threshold_ms
    FROM public.races WHERE id = v_event.race_id;
    v_threshold_ms := COALESCE(v_threshold_ms, 2000);

    SELECT id, ts_utc_ms INTO v_existing
    FROM public.finish_events
    WHERE race_id = v_event.race_id
      AND event_type = v_event.event_type
      AND bib = p_bib
      AND status = 'valid'
    LIMIT 1;

    IF v_existing.id IS NULL THEN
        v_new_status := 'valid';
    ELSIF v_event.ts_utc_ms >= v_existing.ts_utc_ms THEN
        v_new_status := 'duplicate';
        v_high_disc := ((v_event.ts_utc_ms - v_existing.ts_utc_ms) > v_threshold_ms);
    ELSE
        -- Este tiempo sin asignar habÃ­a sido capturado ANTES que el actual 'valid'
        UPDATE public.finish_events
        SET status = 'duplicate',
            high_discrepancy = ((v_existing.ts_utc_ms - v_event.ts_utc_ms) > v_threshold_ms)
        WHERE id = v_existing.id;

        v_new_status := 'valid';
    END IF;

    UPDATE public.finish_events
    SET bib = p_bib,
        status = v_new_status,
        high_discrepancy = v_high_disc,
        assigned_by = auth.uid(),
        assigned_at = clock_timestamp()
    WHERE id = p_event_id
    RETURNING * INTO v_event;

    INSERT INTO public.audit_log (
        race_id, actor_id, action, entity_table, entity_id,
        before_data, after_data, reason
    ) VALUES (
        v_event.race_id,
        auth.uid(),
        'UNASSIGNED_BIB_ASSIGNED',
        'finish_events',
        v_event.id::text,
        jsonb_build_object('bib', NULL, 'status', 'unassigned'),
        jsonb_build_object('bib', p_bib, 'status', v_new_status, 'ts_utc_ms', v_event.ts_utc_ms),
        'AsignaciÃ³n de dorsal a tiempo capturado en Modo B'
    );

    RETURN v_event;
END;
$$;

-- ============================================================================
-- 5. FUNCIONES EXCLUSIVAS DE ADMINISTRADOR (LARGADA, CORRECCIÃ“N, RESOLUCIÃ“N)
-- ============================================================================

-- 5.1 RPC: LARGAR CARRERA (Un solo disparo para toda la carrera)
CREATE OR REPLACE FUNCTION public.admin_trigger_race_start(
    p_race_id uuid,
    p_override_ts_utc_ms bigint DEFAULT NULL
)
RETURNS public.race_start
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_ts_ms bigint;
    v_start public.race_start;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Solo el administrador puede largar la carrera.';
    END IF;

    IF EXISTS (SELECT 1 FROM public.race_start WHERE race_id = p_race_id) THEN
        RAISE EXCEPTION 'La carrera ya fue largada. UtilizÃ¡ la opciÃ³n de correcciÃ³n manual con motivo.';
    END IF;

    v_ts_ms := COALESCE(
        p_override_ts_utc_ms,
        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
    );

    INSERT INTO public.race_start (race_id, ts_utc_ms, user_id)
    VALUES (p_race_id, v_ts_ms, auth.uid())
    RETURNING * INTO v_start;

    UPDATE public.races
    SET status = 'running',
        updated_at = clock_timestamp()
    WHERE id = p_race_id;

    INSERT INTO public.audit_log (
        race_id, actor_id, action, entity_table, entity_id,
        before_data, after_data, reason
    ) VALUES (
        p_race_id,
        auth.uid(),
        'RACE_START',
        'race_start',
        v_start.id::text,
        NULL,
        jsonb_build_object('ts_utc_ms', v_ts_ms, 'user_id', auth.uid()),
        'Largada oficial de la carrera'
    );

    RETURN v_start;
END;
$$;

-- 5.2 RPC: Corregir hora de largada con motivo obligatorio y auditorÃ­a
CREATE OR REPLACE FUNCTION public.admin_correct_race_start(
    p_race_id uuid,
    p_new_ts_utc_ms bigint,
    p_reason text
)
RETURNS public.race_start
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_old public.race_start;
    v_new public.race_start;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Solo el administrador puede corregir la hora de largada.';
    END IF;

    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'DebÃ©s indicar un motivo detallado (mÃ­nimo 5 caracteres) para corregir la largada.';
    END IF;

    SELECT * INTO v_old
    FROM public.race_start
    WHERE race_id = p_race_id
    FOR UPDATE;

    IF v_old.id IS NULL THEN
        RAISE EXCEPTION 'La carrera aÃºn no tiene largada registrada.';
    END IF;

    UPDATE public.race_start
    SET ts_utc_ms = p_new_ts_utc_ms,
        corrected_by = auth.uid(),
        reason = trim(p_reason),
        updated_at = clock_timestamp()
    WHERE race_id = p_race_id
    RETURNING * INTO v_new;

    INSERT INTO public.audit_log (
        race_id, actor_id, action, entity_table, entity_id,
        before_data, after_data, reason
    ) VALUES (
        p_race_id,
        auth.uid(),
        'RACE_START_CORRECTED',
        'race_start',
        v_new.id::text,
        jsonb_build_object('ts_utc_ms', v_old.ts_utc_ms, 'reason', v_old.reason),
        jsonb_build_object('ts_utc_ms', v_new.ts_utc_ms, 'reason', v_new.reason),
        trim(p_reason)
    );

    RETURN v_new;
END;
$$;

-- 5.3 RPC: Resolver duplicados o anular/revalidar un registro (Solo Admin, con motivo)
CREATE OR REPLACE FUNCTION public.admin_resolve_finish_event(
    p_event_id uuid,
    p_target_status public.event_status,
    p_reason text
)
RETURNS public.finish_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_event public.finish_events;
    v_current_valid public.finish_events;
    v_next_duplicate_id uuid;
    v_before jsonb;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Solo el administrador puede anular o resolver duplicados definitivamente.';
    END IF;

    IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
        RAISE EXCEPTION 'Es obligatorio ingresar un motivo para auditar este cambio.';
    END IF;

    SELECT * INTO v_event
    FROM public.finish_events
    WHERE id = p_event_id
    FOR UPDATE;

    IF v_event.id IS NULL THEN
        RAISE EXCEPTION 'Evento no encontrado.';
    END IF;

    v_before := to_jsonb(v_event);

    IF p_target_status = 'valid' THEN
        IF v_event.bib IS NULL THEN
            RAISE EXCEPTION 'No se puede validar un registro sin nÃºmero de pechera.';
        END IF;

        -- Si habÃ­a otro 'valid' para ese mismo dorsal, pasarlo a 'duplicate'
        SELECT * INTO v_current_valid
        FROM public.finish_events
        WHERE race_id = v_event.race_id
          AND event_type = v_event.event_type
          AND bib = v_event.bib
          AND status = 'valid'
          AND id <> v_event.id
        FOR UPDATE;

        IF v_current_valid.id IS NOT NULL THEN
            UPDATE public.finish_events
            SET status = 'duplicate'
            WHERE id = v_current_valid.id;
        END IF;

        UPDATE public.finish_events
        SET status = 'valid',
            high_discrepancy = false,
            void_reason = NULL,
            voided_by = NULL,
            voided_at = NULL
        WHERE id = v_event.id
        RETURNING * INTO v_event;

    ELSIF p_target_status = 'void' THEN
        UPDATE public.finish_events
        SET status = 'void',
            void_reason = trim(p_reason),
            voided_by = auth.uid(),
            voided_at = clock_timestamp()
        WHERE id = v_event.id
        RETURNING * INTO v_event;

        -- Si era el 'valid' y existe algÃºn 'duplicate', promover el mÃ¡s temprano
        IF (v_before->>'status') = 'valid' AND v_event.bib IS NOT NULL THEN
            SELECT id INTO v_next_duplicate_id
            FROM public.finish_events
            WHERE race_id = v_event.race_id
              AND event_type = v_event.event_type
              AND bib = v_event.bib
              AND status = 'duplicate'
            ORDER BY ts_utc_ms ASC
            LIMIT 1
            FOR UPDATE;

            IF v_next_duplicate_id IS NOT NULL THEN
                UPDATE public.finish_events
                SET status = 'valid',
                    high_discrepancy = false
                WHERE id = v_next_duplicate_id;
            END IF;
        END IF;

    ELSIF p_target_status = 'duplicate' THEN
        UPDATE public.finish_events
        SET status = 'duplicate',
            void_reason = trim(p_reason)
        WHERE id = v_event.id
        RETURNING * INTO v_event;
    ELSE
        RAISE EXCEPTION 'Estado de destino no soportado: %', p_target_status;
    END IF;

    INSERT INTO public.audit_log (
        race_id, actor_id, action, entity_table, entity_id,
        before_data, after_data, reason
    ) VALUES (
        v_event.race_id,
        auth.uid(),
        'ADMIN_EVENT_RESOLUTION',
        'finish_events',
        v_event.id::text,
        v_before,
        to_jsonb(v_event),
        trim(p_reason)
    );

    RETURN v_event;
END;
$$;

-- 5.4 RPC: ResoluciÃ³n de Login por PIN con Rate Limiting por dispositivo
CREATE OR REPLACE FUNCTION public.resolve_pin_login(
    p_pin text,
    p_device_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_failed_count integer;
    v_profile public.profiles;
BEGIN
    -- Verificar rate limiting: mÃ¡x 5 intentos fallidos en los Ãºltimos 5 minutos
    SELECT COUNT(*) INTO v_failed_count
    FROM public.login_attempts
    WHERE device_id = p_device_id
      AND success = false
      AND attempted_at > (clock_timestamp() - interval '5 minutes');

    IF v_failed_count >= 5 THEN
        RAISE EXCEPTION 'Demasiados intentos fallidos desde este dispositivo. EsperÃ¡ 5 minutos.';
    END IF;

    SELECT * INTO v_profile
    FROM public.profiles
    WHERE pin_code = trim(p_pin)
      AND revoked = false
    LIMIT 1;

    IF v_profile.id IS NULL THEN
        INSERT INTO public.login_attempts (device_id, success)
        VALUES (COALESCE(p_device_id, 'unknown'), false);
        RAISE EXCEPTION 'CÃ³digo PIN invÃ¡lido o revocado.';
    END IF;

    INSERT INTO public.login_attempts (device_id, success)
    VALUES (COALESCE(p_device_id, 'unknown'), true);

    RETURN jsonb_build_object(
        'synthetic_email', v_profile.synthetic_email,
        'display_name', v_profile.display_name,
        'role', v_profile.role,
        'race_id', v_profile.race_id
    );
END;
$$;

-- ============================================================================
-- 6. VISTAS DE RESULTADOS Y RANKINGS CALCULADOS EN EL SERVIDOR
-- ============================================================================

-- 6.1 Vista completa de resultados en vivo (v_live_results)
--     Calcula Gun Time (oficial), Net Time (opcional), posiciones por categorÃ­a,
--     por distancia (4 km / 6 km) y orden general de llegada.
CREATE OR REPLACE VIEW public.v_live_results AS
WITH valid_finishes AS (
    SELECT
        fe.id AS finish_event_id,
        fe.race_id,
        fe.bib,
        fe.ts_utc_ms AS finish_ts_utc_ms,
        fe.clock_offset_ms,
        fe.device_id,
        fe.user_id,
        fe.synced_at
    FROM public.finish_events fe
    WHERE fe.event_type = 'finish'
      AND fe.status = 'valid'
      AND fe.bib IS NOT NULL
),
valid_start_crossings AS (
    SELECT
        fe.race_id,
        fe.bib,
        fe.ts_utc_ms AS start_crossing_ts_utc_ms
    FROM public.finish_events fe
    WHERE fe.event_type = 'start_crossing'
      AND fe.status = 'valid'
      AND fe.bib IS NOT NULL
),
duplicate_counts AS (
    SELECT
        fe.race_id,
        fe.bib,
        COUNT(*) FILTER (WHERE fe.status = 'duplicate') AS duplicate_count,
        BOOL_OR(fe.high_discrepancy) FILTER (WHERE fe.status = 'duplicate') AS has_high_discrepancy
    FROM public.finish_events fe
    WHERE fe.event_type = 'finish'
      AND fe.bib IS NOT NULL
    GROUP BY fe.race_id, fe.bib
),
computed AS (
    SELECT
        e.id AS entry_id,
        e.race_id,
        r.name AS race_name,
        r.status AS race_status,
        r.net_time_enabled,
        e.bib,
        e.display_name,
        e.team_name,
        e.members,
        e.active,
        c.id AS category_id,
        c.slug AS category_slug,
        c.name AS category_name,
        c.short_name AS category_short_name,
        c.distance_km,
        c.is_pair,
        c.color AS category_color,
        c.screen_group,
        rs.ts_utc_ms AS race_start_ts_utc_ms,
        vf.finish_event_id,
        vf.finish_ts_utc_ms,
        vsc.start_crossing_ts_utc_ms,
        -- Tiempo Oficial (Bruto / Gun Time) = llegada - largada
        CASE
            WHEN vf.finish_ts_utc_ms IS NOT NULL AND rs.ts_utc_ms IS NOT NULL
            THEN (vf.finish_ts_utc_ms - rs.ts_utc_ms)
            ELSE NULL
        END AS official_time_ms,
        -- Tiempo Neto (Opcional) = llegada - paso por lÃ­nea de largada
        CASE
            WHEN r.net_time_enabled
                 AND vf.finish_ts_utc_ms IS NOT NULL
                 AND vsc.start_crossing_ts_utc_ms IS NOT NULL
            THEN (vf.finish_ts_utc_ms - vsc.start_crossing_ts_utc_ms)
            ELSE NULL
        END AS net_time_ms,
        COALESCE(dc.duplicate_count, 0) AS duplicate_count,
        COALESCE(dc.has_high_discrepancy, false) AS has_high_discrepancy,
        CASE
            WHEN NOT e.active THEN 'dns'
            WHEN vf.finish_ts_utc_ms IS NOT NULL THEN 'finished'
            WHEN rs.ts_utc_ms IS NOT NULL THEN 'running'
            ELSE 'registered'
        END AS runner_status
    FROM public.entries e
    JOIN public.races r ON r.id = e.race_id
    JOIN public.categories c ON c.id = e.category_id
    LEFT JOIN public.race_start rs ON rs.race_id = e.race_id
    LEFT JOIN valid_finishes vf ON vf.race_id = e.race_id AND vf.bib = e.bib
    LEFT JOIN valid_start_crossings vsc ON vsc.race_id = e.race_id AND vsc.bib = e.bib
    LEFT JOIN duplicate_counts dc ON dc.race_id = e.race_id AND dc.bib = e.bib
)
SELECT
    comp.*,
    -- PosiciÃ³n en su CategorÃ­a
    CASE
        WHEN comp.official_time_ms IS NOT NULL AND comp.official_time_ms >= 0 THEN
            RANK() OVER (
                PARTITION BY comp.race_id, comp.category_id, (comp.official_time_ms IS NOT NULL AND comp.official_time_ms >= 0)
                ORDER BY comp.official_time_ms ASC
            )
        ELSE NULL
    END AS category_rank,
    -- PosiciÃ³n General por Distancia (4 km o 6 km)
    CASE
        WHEN comp.official_time_ms IS NOT NULL AND comp.official_time_ms >= 0 THEN
            RANK() OVER (
                PARTITION BY comp.race_id, comp.distance_km, (comp.official_time_ms IS NOT NULL AND comp.official_time_ms >= 0)
                ORDER BY comp.official_time_ms ASC
            )
        ELSE NULL
    END AS distance_rank,
    -- Orden absoluto de cruce de meta en toda la carrera
    CASE
        WHEN comp.finish_ts_utc_ms IS NOT NULL THEN
            RANK() OVER (
                PARTITION BY comp.race_id, (comp.finish_ts_utc_ms IS NOT NULL)
                ORDER BY comp.finish_ts_utc_ms ASC
            )
        ELSE NULL
    END AS overall_finish_order,
    -- Diferencia respecto al lÃ­der de la categorÃ­a (gap)
    CASE
        WHEN comp.official_time_ms IS NOT NULL AND comp.official_time_ms >= 0 THEN
            comp.official_time_ms - MIN(comp.official_time_ms) FILTER (WHERE comp.official_time_ms >= 0) OVER (
                PARTITION BY comp.race_id, comp.category_id
            )
        ELSE NULL
    END AS category_gap_ms,
    -- Diferencia respecto al lÃ­der general de su distancia (4 km o 6 km)
    CASE
        WHEN comp.official_time_ms IS NOT NULL AND comp.official_time_ms >= 0 THEN
            comp.official_time_ms - MIN(comp.official_time_ms) FILTER (WHERE comp.official_time_ms >= 0) OVER (
                PARTITION BY comp.race_id, comp.distance_km
            )
        ELSE NULL
    END AS distance_gap_ms
FROM computed comp;

-- 6.2 Vista pÃºblica de solo lectura (sin metadatos internos ni auditorÃ­a)
CREATE OR REPLACE VIEW public.v_public_results AS
SELECT
    race_id,
    race_name,
    race_status,
    bib,
    display_name,
    team_name,
    members,
    category_id,
    category_slug,
    category_name,
    category_short_name,
    distance_km,
    is_pair,
    category_color,
    runner_status,
    official_time_ms,
    net_time_ms,
    category_rank,
    distance_rank,
    overall_finish_order,
    category_gap_ms,
    distance_gap_ms
FROM public.v_live_results
WHERE active = true;

-- ============================================================================
-- 7. POLÃTICAS DE SEGURIDAD ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE public.races ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.race_start ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finish_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

-- 7.1 PolÃ­ticas sobre RACES
CREATE POLICY "races_select_all"
    ON public.races FOR SELECT
    USING (true);

CREATE POLICY "races_admin_write"
    ON public.races FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 7.2 PolÃ­ticas sobre CATEGORIES
CREATE POLICY "categories_select_all"
    ON public.categories FOR SELECT
    USING (true);

CREATE POLICY "categories_admin_write"
    ON public.categories FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 7.3 PolÃ­ticas sobre ENTRIES
CREATE POLICY "entries_select_all"
    ON public.entries FOR SELECT
    USING (true);

CREATE POLICY "entries_admin_write"
    ON public.entries FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 7.4 PolÃ­ticas sobre PROFILES
-- Cada cronometrista lee su propio perfil; el admin lee y administra todos.
CREATE POLICY "profiles_select_own_or_admin"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (id = auth.uid() OR public.is_admin());

CREATE POLICY "profiles_admin_write"
    ON public.profiles FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 7.5 PolÃ­ticas sobre RACE_START
CREATE POLICY "race_start_select_all"
    ON public.race_start FOR SELECT
    USING (true);

CREATE POLICY "race_start_admin_write"
    ON public.race_start FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 7.6 PolÃ­ticas sobre FINISH_EVENTS (CRÃTICO)
-- Lectura para todo el staff activo y pÃºblico (para rankings en vivo)
CREATE POLICY "finish_events_select_all"
    ON public.finish_events FOR SELECT
    USING (true);

-- El cronometrista SOLO INSERTA registros a su nombre (no tiene UPDATE ni DELETE directo)
CREATE POLICY "finish_events_insert_staff"
    ON public.finish_events FOR INSERT
    TO authenticated
    WITH CHECK (
        public.is_active_staff()
        AND user_id = auth.uid()
    );

-- Solo el admin puede hacer UPDATE directo (las funciones RPC de deshacer 10s y Modo B usan SECURITY DEFINER con validaciones estrictas)
CREATE POLICY "finish_events_update_admin_only"
    ON public.finish_events FOR UPDATE
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- NADIE tiene polÃ­tica FOR DELETE en finish_events (registros 100% inmutables)

-- 7.7 PolÃ­ticas sobre AUDIT_LOG
-- Solo admin lee el log de auditorÃ­a; nadie edita ni borra.
CREATE POLICY "audit_log_select_admin"
    ON public.audit_log FOR SELECT
    TO authenticated
    USING (public.is_admin());

CREATE POLICY "audit_log_insert_staff"
    ON public.audit_log FOR INSERT
    TO authenticated
    WITH CHECK (public.is_active_staff());

-- 7.8 Permisos de ejecuciÃ³n y vistas para roles de Supabase (anon, authenticated)
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.races, public.categories, public.entries, public.race_start, public.finish_events TO anon, authenticated;
GRANT SELECT ON public.v_live_results, public.v_public_results TO anon, authenticated;
GRANT INSERT ON public.finish_events TO authenticated;
GRANT ALL ON public.races, public.categories, public.entries, public.profiles, public.race_start, public.finish_events, public.audit_log TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_server_time_ms() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_pin_login(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_own_finish_event(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_bib_to_event(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_trigger_race_start(uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_correct_race_start(uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_finish_event(uuid, public.event_status, text) TO authenticated;

-- ============================================================================
-- 8. CONFIGURACIÃ“N DE SUPABASE REALTIME
-- ============================================================================
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.races;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.race_start;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.finish_events;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.entries;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- ============================================================================
-- ETAPA 1: SEEDS DE EJEMPLO (12 CategorÃ­as, 120 Atletas/Duplas, Admin + Cronometristas)
-- ============================================================================

DO $$
DECLARE
    v_race_id uuid := 'a0000000-0000-4000-8000-000000000001';
    v_admin_id uuid := 'b0000000-0000-4000-8000-000000000001';
    v_tk1_id uuid   := 'b0000000-0000-4000-8000-000000000011';
    v_tk2_id uuid   := 'b0000000-0000-4000-8000-000000000012';
    v_tk3_id uuid   := 'b0000000-0000-4000-8000-000000000013';
    v_tk4_id uuid   := 'b0000000-0000-4000-8000-000000000014';

    v_cat record;
    i integer;
    v_bib integer;
    v_nombres_h text[] := ARRAY['MartÃ­n', 'Lucas', 'NicolÃ¡s', 'Santiago', 'MatÃ­as', 'JoaquÃ­n', 'Facundo', 'TomÃ¡s', 'AgustÃ­n', 'Federico'];
    v_nombres_m text[] := ARRAY['SofÃ­a', 'Camila', 'Valentina', 'LucÃ­a', 'Julieta', 'Micaela', 'Florencia', 'Catalina', 'Paula', 'Antonella'];
    v_apellidos text[] := ARRAY['GonzÃ¡lez', 'RodrÃ­guez', 'GÃ³mez', 'FernÃ¡ndez', 'LÃ³pez', 'DÃ­az', 'MartÃ­nez', 'PÃ©rez', 'SÃ¡nchez', 'Romero', 'Sosa', 'Torres'];
BEGIN
    -- 1. Crear carrera principal
    INSERT INTO public.races (id, name, location, race_date, status, net_time_enabled, duplicate_threshold_ms)
    VALUES (
        v_race_id,
        'DesafÃ­o Skol 2026 - 4K & 6K',
        'Punto A - Circuito Principal',
        CURRENT_DATE,
        'pending',
        false,
        2000
    )
    ON CONFLICT (id) DO NOTHING;

    -- 2. Crear las 12 categorÃ­as agrupadas en las 4 pantallas (screen_group 1..4)
    -- PANTALLA 1: Duplas Funcional (4 km - 2 ida + 2 vuelta)
    INSERT INTO public.categories (race_id, slug, name, short_name, distance_km, is_pair, bib_range_start, bib_range_end, bib_step, color, screen_group, sort_order)
    VALUES
        (v_race_id, 'funcional-dupla', 'Funcional Dupla', 'FUNC DUPLA', 4.0, true, 100, 290, 10, '#1D4ED8', 1, 1),
        (v_race_id, 'funcional-hh',    'Funcional H-H',   'FUNC H-H',   4.0, true, 300, 490, 10, '#0369A1', 1, 2),
        (v_race_id, 'funcional-mm',    'Funcional M-M',   'FUNC M-M',   4.0, true, 500, 690, 10, '#6D28D9', 1, 3),

    -- PANTALLA 2: Duplas Scaled (4 km - 2 ida + 2 vuelta)
        (v_race_id, 'scaled-dupla',    'Scaled Dupla',    'SCAL DUPLA', 4.0, true, 1000, 1190, 10, '#047857', 2, 4),
        (v_race_id, 'scaled-hh',       'Scaled H-H',      'SCAL H-H',   4.0, true, 1200, 1390, 10, '#15803D', 2, 5),
        (v_race_id, 'scaled-mm',       'Scaled M-M',      'SCAL M-M',   4.0, true, 1400, 1590, 10, '#0F766E', 2, 6),

    -- PANTALLA 3: Avanzado Individuales (6 km - 3 ida + 3 vuelta)
        (v_race_id, 'avanzado-ind',    'Avanzado Individual', 'AVZ IND',    6.0, false, 2000, 2190, 10, '#B45309', 3, 7),
        (v_race_id, 'avanzado-mujer',  'Avanzado Mujer',      'AVZ MUJER',  6.0, false, 2200, 2390, 10, '#C2410C', 3, 8),
        (v_race_id, 'avanzado-hombre', 'Avanzado Hombre',     'AVZ HOMBRE', 6.0, false, 2400, 2590, 10, '#A16207', 3, 9),

    -- PANTALLA 4: RX Individuales (6 km - 3 ida + 3 vuelta)
        (v_race_id, 'rx-ind',          'RX Individual',   'RX IND',     6.0, false, 3000, 3190, 10, '#B91C1C', 4, 10),
        (v_race_id, 'rx-mujer',        'RX Mujer',        'RX MUJER',   6.0, false, 3200, 3390, 10, '#BE123C', 4, 11),
        (v_race_id, 'rx-hombre',       'RX Hombre',       'RX HOMBRE',  6.0, false, 3400, 3590, 10, '#7E22CE', 4, 12)
    ON CONFLICT (race_id, slug) DO NOTHING;

    -- 3. Generar ~120 inscriptos (10 por cada una de las 12 categorÃ­as) con dorsales con salto de 10
    FOR v_cat IN
        SELECT * FROM public.categories WHERE race_id = v_race_id ORDER BY sort_order
    LOOP
        FOR i IN 0..9 LOOP
            v_bib := v_cat.bib_range_start + (i * v_cat.bib_step);

            IF v_cat.is_pair THEN
                -- Dupla: 1 solo nÃºmero, nombre de equipo y 2 integrantes
                INSERT INTO public.entries (
                    race_id, category_id, bib, display_name, team_name, members, active
                ) VALUES (
                    v_race_id,
                    v_cat.id,
                    v_bib,
                    'Equipo ' || v_cat.short_name || ' ' || (i + 1),
                    'Skol Team #' || v_bib,
                    jsonb_build_array(
                        v_nombres_h[(i % 10) + 1] || ' ' || v_apellidos[(i % 12) + 1],
                        v_nombres_m[((i + 3) % 10) + 1] || ' ' || v_apellidos[((i + 5) % 12) + 1]
                    ),
                    true
                )
                ON CONFLICT (race_id, bib) DO NOTHING;
            ELSE
                -- Individual (6 km)
                INSERT INTO public.entries (
                    race_id, category_id, bib, display_name, team_name, members, active
                ) VALUES (
                    v_race_id,
                    v_cat.id,
                    v_bib,
                    CASE
                        WHEN v_cat.slug LIKE '%mujer%' THEN v_nombres_m[(i % 10) + 1] || ' ' || v_apellidos[(i % 12) + 1]
                        ELSE v_nombres_h[(i % 10) + 1] || ' ' || v_apellidos[((i + 2) % 12) + 1]
                    END,
                    NULL,
                    '[]'::jsonb,
                    true
                )
                ON CONFLICT (race_id, bib) DO NOTHING;
            END IF;
        END LOOP;
    END LOOP;

    -- 4. Usuarios en auth.users + public.profiles (para entorno local / Supabase CLI)
    INSERT INTO auth.users (
        id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES
        (v_admin_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@carrera.skol.local', crypt('999999', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Admin General"}', now(), now()),
        (v_tk1_id,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'crono_1111@carrera.skol.local', crypt('1111', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Crono 01 - Funcional"}', now(), now()),
        (v_tk2_id,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'crono_2222@carrera.skol.local', crypt('2222', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Crono 02 - Scaled"}', now(), now()),
        (v_tk3_id,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'crono_3333@carrera.skol.local', crypt('3333', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Crono 03 - Avanzado"}', now(), now()),
        (v_tk4_id,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'crono_4444@carrera.skol.local', crypt('4444', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Crono 04 - RX"}', now(), now())
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, race_id, display_name, role, pin_code, synthetic_email, assigned_screens, revoked)
    VALUES
        (v_admin_id, v_race_id, 'Admin General',        'admin',      '999999', 'admin@carrera.skol.local',      '{1,2,3,4}', false),
        (v_tk1_id,   v_race_id, 'Crono 01 (Funcional)', 'timekeeper', '1111',   'crono_1111@carrera.skol.local', '{1,2,3,4}', false),
        (v_tk2_id,   v_race_id, 'Crono 02 (Scaled)',    'timekeeper', '2222',   'crono_2222@carrera.skol.local', '{2,1,3,4}', false),
        (v_tk3_id,   v_race_id, 'Crono 03 (Avanzado)',  'timekeeper', '3333',   'crono_3333@carrera.skol.local', '{3,4,1,2}', false),
        (v_tk4_id,   v_race_id, 'Crono 04 (RX)',        'timekeeper', '4444',   'crono_4444@carrera.skol.local', '{4,3,1,2}', false)
    ON CONFLICT (id) DO NOTHING;
END $$;
