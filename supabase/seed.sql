-- ============================================================================
-- ETAPA 1: SEEDS DE EJEMPLO (8 Categorías Oficiales, 120 Atletas/Duplas, Admin + Cronometristas)
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
    v_nombres_h text[] := ARRAY['Martín', 'Lucas', 'Nicolás', 'Santiago', 'Matías', 'Joaquín', 'Facundo', 'Tomás', 'Agustín', 'Federico', 'Gonzalo', 'Ramiro', 'Ignacio', 'Sebastián', 'Franco'];
    v_nombres_m text[] := ARRAY['Sofía', 'Camila', 'Valentina', 'Lucía', 'Julieta', 'Micaela', 'Florencia', 'Catalina', 'Paula', 'Antonella', 'Agustina', 'Martina', 'Victoria', 'Carolina', 'Milagros'];
    v_apellidos text[] := ARRAY['González', 'Rodríguez', 'Gómez', 'Fernández', 'López', 'Díaz', 'Martínez', 'Pérez', 'Sánchez', 'Romero', 'Sosa', 'Torres', 'Álvarez', 'Ruiz', 'Castro'];
BEGIN
    -- 1. Crear carrera principal
    INSERT INTO public.races (id, name, location, race_date, status, net_time_enabled, duplicate_threshold_ms, screen_groups)
    VALUES (
        v_race_id,
        'Desafío Skol 2026 - 4K & 6K',
        'Punto A - Circuito Principal',
        CURRENT_DATE,
        'pending',
        false,
        2000,
        '[
            {"id": 1, "title": "Duplas Funcional", "subtitle": "4 km (H-H · M-M)"},
            {"id": 2, "title": "Duplas Scaled",    "subtitle": "4 km (H-H · M-M)"},
            {"id": 3, "title": "Avanzado",         "subtitle": "6 km (H · M)"},
            {"id": 4, "title": "RX",               "subtitle": "6 km (H · M)"}
        ]'::jsonb
    )
    ON CONFLICT (id) DO NOTHING;

    -- 2. Crear las 8 categorías oficiales agrupadas en las 4 pantallas (screen_group 1..4)
    INSERT INTO public.categories (id, race_id, slug, name, short_name, distance_km, is_pair, bib_range_start, bib_range_end, bib_step, color, screen_group, sort_order)
    VALUES
        -- PANTALLA 1: Duplas Funcional (4 km)
        ('c0000000-0000-4000-8000-000000000001', v_race_id, 'funcional-hh', 'Funcional H-H', 'FUNC H-H', 4.0, true,  100,  290, 10, '#0369A1', 1, 1),
        ('c0000000-0000-4000-8000-000000000002', v_race_id, 'funcional-mm', 'Funcional M-M', 'FUNC M-M', 4.0, true,  300,  490, 10, '#6D28D9', 1, 2),

        -- PANTALLA 2: Duplas Scaled (4 km)
        ('c0000000-0000-4000-8000-000000000003', v_race_id, 'scaled-hh',    'Scaled H-H',    'SCAL H-H', 4.0, true, 1000, 1190, 10, '#15803D', 2, 3),
        ('c0000000-0000-4000-8000-000000000004', v_race_id, 'scaled-mm',    'Scaled M-M',    'SCAL M-M', 4.0, true, 1200, 1390, 10, '#0F766E', 2, 4),

        -- PANTALLA 3: Avanzado Individuales (6 km)
        ('c0000000-0000-4000-8000-000000000005', v_race_id, 'avanzado-h',   'Avanzado H',    'AVZ H',    6.0, false, 2000, 2190, 10, '#A16207', 3, 5),
        ('c0000000-0000-4000-8000-000000000006', v_race_id, 'avanzado-m',   'Avanzado M',    'AVZ M',    6.0, false, 2200, 2390, 10, '#C2410C', 3, 6),

        -- PANTALLA 4: RX Individuales (6 km)
        ('c0000000-0000-4000-8000-000000000007', v_race_id, 'rx-h',         'RX H',          'RX H',     6.0, false, 3000, 3190, 10, '#7E22CE', 4, 7),
        ('c0000000-0000-4000-8000-000000000008', v_race_id, 'rx-m',         'RX M',          'RX M',     6.0, false, 3200, 3390, 10, '#BE123C', 4, 8)
    ON CONFLICT (race_id, slug) DO NOTHING;

    -- 3. Generar 120 inscriptos (15 por cada una de las 8 categorías) con dorsales con salto de 10
    FOR v_cat IN
        SELECT * FROM public.categories WHERE race_id = v_race_id ORDER BY sort_order
    LOOP
        FOR i IN 0..14 LOOP
            v_bib := v_cat.bib_range_start + (i * v_cat.bib_step);

            IF v_cat.is_pair THEN
                INSERT INTO public.entries (
                    race_id, category_id, bib, display_name, team_name, members, active
                ) VALUES (
                    v_race_id,
                    v_cat.id,
                    v_bib,
                    'Dupla ' || v_cat.short_name || ' #' || v_bib,
                    'Dupla ' || v_cat.short_name || ' #' || v_bib,
                    CASE
                        WHEN v_cat.slug LIKE '%-mm' THEN jsonb_build_array(
                            v_nombres_m[(i % 15) + 1] || ' ' || v_apellidos[(i % 15) + 1],
                            v_nombres_m[((i + 4) % 15) + 1] || ' ' || v_apellidos[((i + 6) % 15) + 1]
                        )
                        ELSE jsonb_build_array(
                            v_nombres_h[(i % 15) + 1] || ' ' || v_apellidos[(i % 15) + 1],
                            v_nombres_h[((i + 4) % 15) + 1] || ' ' || v_apellidos[((i + 6) % 15) + 1]
                        )
                    END,
                    true
                )
                ON CONFLICT (race_id, bib) DO NOTHING;
            ELSE
                INSERT INTO public.entries (
                    race_id, category_id, bib, display_name, team_name, members, active
                ) VALUES (
                    v_race_id,
                    v_cat.id,
                    v_bib,
                    CASE
                        WHEN v_cat.slug LIKE '%-m' THEN v_nombres_m[(i % 15) + 1] || ' ' || v_apellidos[(i % 15) + 1]
                        ELSE v_nombres_h[(i % 15) + 1] || ' ' || v_apellidos[((i + 2) % 15) + 1]
                    END,
                    NULL,
                    '[]'::jsonb,
                    true
                )
                ON CONFLICT (race_id, bib) DO NOTHING;
            END IF;
        END LOOP;
    END LOOP;

    -- 4. Usuarios en auth.users + public.profiles
    INSERT INTO auth.users (
        id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, confirmation_token, recovery_token, email_change_token_new, email_change,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES
        (v_admin_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@carrera.skol.local', crypt('999999', gen_salt('bf')), now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{"display_name":"Admin General"}', now(), now()),
        (v_tk1_id,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'crono_1111@carrera.skol.local', crypt('1111', gen_salt('bf')), now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{"display_name":"Crono 01 - Funcional"}', now(), now()),
        (v_tk2_id,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'crono_2222@carrera.skol.local', crypt('2222', gen_salt('bf')), now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{"display_name":"Crono 02 - Scaled"}', now(), now()),
        (v_tk3_id,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'crono_3333@carrera.skol.local', crypt('3333', gen_salt('bf')), now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{"display_name":"Crono 03 - Avanzado"}', now(), now()),
        (v_tk4_id,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'crono_4444@carrera.skol.local', crypt('4444', gen_salt('bf')), now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{"display_name":"Crono 04 - RX"}', now(), now())
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
