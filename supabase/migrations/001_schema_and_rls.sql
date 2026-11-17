-- ============================================================================
-- ETAPA 1: ESQUEMA SQL COMPLETO, FUNCIONES DE SERVIDOR Y POLÍTICAS RLS
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

-- 2.2 Categorías (categories)
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
    members jsonb NOT NULL DEFAULT '[]'::jsonb, -- Ej: ["Juan Pérez", "Lucas Gómez"]
    active boolean NOT NULL DEFAULT true,       -- false = DNS / Baja
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (race_id, bib)
);

CREATE INDEX IF NOT EXISTS idx_entries_race_bib ON public.entries(race_id, bib);
CREATE INDEX IF NOT EXISTS idx_entries_category ON public.entries(category_id);

-- 2.4 Perfiles de usuario y asignación de pantallas (profiles)
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

-- 2.5 Largada única (race_start)
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
    synced_at timestamptz NOT NULL DEFAULT now()   -- Timestamp real de recepción en servidor
);

-- Índices para consultas en tiempo real y resolución de duplicados
CREATE INDEX IF NOT EXISTS idx_finish_events_race_bib_status
    ON public.finish_events(race_id, event_type, bib, status);
CREATE INDEX IF NOT EXISTS idx_finish_events_race_ts
    ON public.finish_events(race_id, event_type, ts_utc_ms ASC);
CREATE INDEX IF NOT EXISTS idx_finish_events_user_device
    ON public.finish_events(user_id, device_id, synced_at DESC);

-- Garantía a nivel de base de datos: A lo sumo UN registro 'valid' por (race_id, event_type, bib)
CREATE UNIQUE INDEX IF NOT EXISTS uq_finish_events_one_valid_per_bib
    ON public.finish_events(race_id, event_type, bib)
    WHERE status = 'valid' AND bib IS NOT NULL;

-- 2.7 Registro de Auditoría Inmutable (audit_log)
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

-- 3.1 Hora exacta del servidor en milisegundos UTC (para cálculo de clock offset NTP-like)
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
-- 4. LÓGICA DE NEGOCIO EN SERVIDOR: DUPLICADOS, DESHACER Y MODO B
-- ============================================================================

-- 4.1 Trigger BEFORE INSERT en finish_events:
--     Valida dorsal, estado del usuario, rangos de timestamp y resuelve duplicados
--     conservando SIEMPRE el timestamp más temprano como 'valid'.
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

    -- Forzar timestamp de sincronización del servidor
    NEW.synced_at := clock_timestamp();
    v_now_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;

    -- 2. Validar que el timestamp sea razonable (no más de 60s en el futuro ni > 7 días atrás)
    IF NEW.ts_utc_ms > (v_now_ms + 60000) THEN
        RAISE EXCEPTION 'Timestamp inválido: está en el futuro respecto al servidor (% ms).', (NEW.ts_utc_ms - v_now_ms);
    END IF;

    IF NEW.ts_utc_ms < (v_now_ms - 604800000) THEN
        RAISE EXCEPTION 'Timestamp inválido: demasiado antiguo.';
    END IF;

    -- 3. Caso Modo B ("LLEGÓ sin número"): entra siempre como 'unassigned'
    IF NEW.bib IS NULL THEN
        NEW.status := 'unassigned';
        NEW.high_discrepancy := false;
        RETURN NEW;
    END IF;

    -- 4. Validar que el número de pechera (bib) exista en la carrera
    SELECT EXISTS (
        SELECT 1 FROM public.entries
        WHERE race_id = NEW.race_id AND bib = NEW.bib
    ) INTO v_entry_exists;

    IF NOT v_entry_exists THEN
        RAISE EXCEPTION 'El dorsal #% no existe en la lista de inscriptos de esta carrera.', NEW.bib;
    END IF;

    -- Si ya viene explícitamente anulado, respetarlo
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
        -- Primer registro válido para este dorsal
        NEW.status := 'valid';
        NEW.high_discrepancy := false;
    ELSIF NEW.ts_utc_ms >= v_existing.ts_utc_ms THEN
        -- El existente es más temprano o igual -> el nuevo queda como 'duplicate'
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
            'Sincronización de evento con timestamp anterior al vigente; promovido automáticamente.'
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
        RAISE EXCEPTION 'Solo podés deshacer registros tomados por tu propio usuario y dispositivo.';
    END IF;

    IF v_event.status = 'void' THEN
        RETURN v_event;
    END IF;

    -- Validar ventana temporal (15 segundos desde el timestamp capturado o desde synced_at)
    IF (v_now_ms - v_event.ts_utc_ms) > 15000
       AND (EXTRACT(EPOCH FROM (clock_timestamp() - v_event.synced_at)) * 1000) > 15000 THEN
        RAISE EXCEPTION 'Expiró el tiempo máximo (10 segundos) para deshacer. Solicitá la anulación al administrador.';
    END IF;

    -- Anular el registro (nunca se borra)
    UPDATE public.finish_events
    SET status = 'void',
        void_reason = 'Deshacer rápido (10s) por el cronometrista',
        voided_by = auth.uid(),
        voided_at = clock_timestamp()
    WHERE id = p_event_id
    RETURNING * INTO v_event;

    -- Si era el registro 'valid' de ese dorsal y había un 'duplicate', promover el más temprano a 'valid'
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
        'Deshacer rápido (10s) por el cronometrista'
    );

    RETURN v_event;
END;
$$;

-- 4.3 RPC: Asignar dorsal a un registro capturado en Modo B ("LLEGÓ sin número")
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
        RAISE EXCEPTION 'El registro sin número no existe.';
    END IF;

    -- Solo el autor del registro o un admin pueden asignarle número
    IF v_event.user_id <> auth.uid() AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'No tenés permiso para asignar un dorsal a este registro.';
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
        -- Este tiempo sin asignar había sido capturado ANTES que el actual 'valid'
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
        'Asignación de dorsal a tiempo capturado en Modo B'
    );

    RETURN v_event;
END;
$$;

-- ============================================================================
-- 5. FUNCIONES EXCLUSIVAS DE ADMINISTRADOR (LARGADA, CORRECCIÓN, RESOLUCIÓN)
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
        RAISE EXCEPTION 'La carrera ya fue largada. Utilizá la opción de corrección manual con motivo.';
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

-- 5.2 RPC: Corregir hora de largada con motivo obligatorio y auditoría
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
        RAISE EXCEPTION 'Debés indicar un motivo detallado (mínimo 5 caracteres) para corregir la largada.';
    END IF;

    SELECT * INTO v_old
    FROM public.race_start
    WHERE race_id = p_race_id
    FOR UPDATE;

    IF v_old.id IS NULL THEN
        RAISE EXCEPTION 'La carrera aún no tiene largada registrada.';
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
            RAISE EXCEPTION 'No se puede validar un registro sin número de pechera.';
        END IF;

        -- Si había otro 'valid' para ese mismo dorsal, pasarlo a 'duplicate'
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

        -- Si era el 'valid' y existe algún 'duplicate', promover el más temprano
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

-- 5.4 RPC: Resolución de Login por PIN con Rate Limiting por dispositivo
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
    -- Verificar rate limiting: máx 5 intentos fallidos en los últimos 5 minutos
    SELECT COUNT(*) INTO v_failed_count
    FROM public.login_attempts
    WHERE device_id = p_device_id
      AND success = false
      AND attempted_at > (clock_timestamp() - interval '5 minutes');

    IF v_failed_count >= 5 THEN
        RAISE EXCEPTION 'Demasiados intentos fallidos desde este dispositivo. Esperá 5 minutos.';
    END IF;

    SELECT * INTO v_profile
    FROM public.profiles
    WHERE pin_code = trim(p_pin)
      AND revoked = false
    LIMIT 1;

    IF v_profile.id IS NULL THEN
        INSERT INTO public.login_attempts (device_id, success)
        VALUES (COALESCE(p_device_id, 'unknown'), false);
        RAISE EXCEPTION 'Código PIN inválido o revocado.';
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
--     Calcula Gun Time (oficial), Net Time (opcional), posiciones por categoría,
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
        -- Tiempo Neto (Opcional) = llegada - paso por línea de largada
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
    -- Posición en su Categoría
    CASE
        WHEN comp.official_time_ms IS NOT NULL AND comp.official_time_ms >= 0 THEN
            RANK() OVER (
                PARTITION BY comp.race_id, comp.category_id, (comp.official_time_ms IS NOT NULL AND comp.official_time_ms >= 0)
                ORDER BY comp.official_time_ms ASC
            )
        ELSE NULL
    END AS category_rank,
    -- Posición General por Distancia (4 km o 6 km)
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
    -- Diferencia respecto al líder de la categoría (gap)
    CASE
        WHEN comp.official_time_ms IS NOT NULL AND comp.official_time_ms >= 0 THEN
            comp.official_time_ms - MIN(comp.official_time_ms) FILTER (WHERE comp.official_time_ms >= 0) OVER (
                PARTITION BY comp.race_id, comp.category_id
            )
        ELSE NULL
    END AS category_gap_ms,
    -- Diferencia respecto al líder general de su distancia (4 km o 6 km)
    CASE
        WHEN comp.official_time_ms IS NOT NULL AND comp.official_time_ms >= 0 THEN
            comp.official_time_ms - MIN(comp.official_time_ms) FILTER (WHERE comp.official_time_ms >= 0) OVER (
                PARTITION BY comp.race_id, comp.distance_km
            )
        ELSE NULL
    END AS distance_gap_ms
FROM computed comp;

-- 6.2 Vista pública de solo lectura (sin metadatos internos ni auditoría)
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
-- 7. POLÍTICAS DE SEGURIDAD ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE public.races ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.race_start ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finish_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

-- 7.1 Políticas sobre RACES
CREATE POLICY "races_select_all"
    ON public.races FOR SELECT
    USING (true);

CREATE POLICY "races_admin_write"
    ON public.races FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 7.2 Políticas sobre CATEGORIES
CREATE POLICY "categories_select_all"
    ON public.categories FOR SELECT
    USING (true);

CREATE POLICY "categories_admin_write"
    ON public.categories FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 7.3 Políticas sobre ENTRIES
CREATE POLICY "entries_select_all"
    ON public.entries FOR SELECT
    USING (true);

CREATE POLICY "entries_admin_write"
    ON public.entries FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 7.4 Políticas sobre PROFILES
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

-- 7.5 Políticas sobre RACE_START
CREATE POLICY "race_start_select_all"
    ON public.race_start FOR SELECT
    USING (true);

CREATE POLICY "race_start_admin_write"
    ON public.race_start FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 7.6 Políticas sobre FINISH_EVENTS (CRÍTICO)
-- Lectura para todo el staff activo y público (para rankings en vivo)
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

-- NADIE tiene política FOR DELETE en finish_events (registros 100% inmutables)

-- 7.7 Políticas sobre AUDIT_LOG
-- Solo admin lee el log de auditoría; nadie edita ni borra.
CREATE POLICY "audit_log_select_admin"
    ON public.audit_log FOR SELECT
    TO authenticated
    USING (public.is_admin());

CREATE POLICY "audit_log_insert_staff"
    ON public.audit_log FOR INSERT
    TO authenticated
    WITH CHECK (public.is_active_staff());

-- 7.8 Permisos de ejecución y vistas para roles de Supabase (anon, authenticated)
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
-- 8. CONFIGURACIÓN DE SUPABASE REALTIME
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
