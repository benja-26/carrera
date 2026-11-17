# Skol Crono · PWA de Cronometraje Deportivo Offline-First

Aplicación web progresiva (**PWA**, *mobile-first*) diseñada para cronometrar en tiempo real una carrera con **~120 atletas/duplas** y **10 a 20 cronometristas** usando celulares bajo luz solar directa y condiciones de conectividad inestable.

---

## 1. Arquitectura y Reglas de Negocio Implementadas

- **Largada Única en el Punto A**:
  - Todas las categorías largan al mismo tiempo (**UN SOLO botón LARGAR** exclusivo para el Admin, con confirmación obligatoria en **dos pasos**).
  - **4 km (2 ida + 2 vuelta — Duplas)**: `Funcional Dupla`, `Funcional H-H`, `Funcional M-M`, `Scaled Dupla`, `Scaled H-H`, `Scaled M-M`. Cada dupla comparte **1 único dorsal**, nombre de equipo y 2 integrantes.
  - **6 km (3 ida + 3 vuelta — Individuales)**: `Avanzado Individual`, `Avanzado Mujer`, `Avanzado Hombre`, `RX Individual`, `RX Mujer`, `RX Hombre`.
  - **Tiempo Oficial**: Tiempo bruto (*Gun Time*) = `llegada − instante de largada` calculado en el servidor.
  - **Tiempo Neto (Opcional)**: Conmutador preparado y desactivado por defecto (`net_time_enabled = false`) que habilita el registro de paso por el arco de largada (`llegada − paso por largada`).
- **Pantalla del Cronometrista (4 Pantallas Deslizables)**:
  - Grilla de botones cuadrados gigantes con el color de cada categoría y captura en `onPointerDown` (sin latencia de `click`).
  - **Deshacer rápido (10 segundos)** visible tras cada toque propio.
  - **Mantener presionado (Long-press)** para inspeccionar detalle o anular definitivamente (Admin con motivo).
  - **Modo B ("LLEGÓ sin número")** para llegadas masivas en pelotón: captura el timestamp al instante y permite adjudicar el dorsal segundos después.
  - **Sincronización de Reloj tipo NTP** (`get_server_time_ms()`): toma múltiples muestras y conserva el `clock_offset_ms` de la muestra de **menor latencia (RTT)**.
  - **Cola Offline en IndexedDB (Dexie)** con UUID generado en el cliente (idempotencia total) y **backoff exponencial con jitter**.

---

## 2. Ejecución Local, Tests y Simulación

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar servidor de desarrollo
npm run dev

# 3. Ejecutar suite de 9 tests automatizados (tiempos, offsets, duplicados, deshacer 10s, Modo B y cola offline)
npm test

# 4. Ejecutar simulación completa con 120 atletas y 10 dispositivos virtuales concurrentes
npm run simulate

# 5. Compilar bundle de producción
npm run build
```

> **Nota sobre Modo Local vs. Supabase**: Si no se definen variables en `.env`, la aplicación inicia automáticamente en **Modo Offline-First Local (IndexedDB)** con las 12 categorías, los 120 atletas (con dorsales de 10 en 10) y los PINs de prueba (`999999` Admin, `1111`..`4444` Cronometristas) precargados.

---

## 3. Guía Paso a Paso de Despliegue (Supabase + Vercel / Netlify)

### Paso 3.1: Configurar el Backend en Supabase

1. Creá un nuevo proyecto en [supabase.com](https://supabase.com) (región recomendada: **South America — São Paulo `sa-east-1`** por menor RTT desde Argentina).
2. En el panel izquierdo de Supabase, abrí **SQL Editor → New Query**.
3. Copiá y ejecutá el contenido completo de [`supabase/migrations/001_schema_and_rls.sql`](./supabase/migrations/001_schema_and_rls.sql).
   - Esto crea todas las tablas, el índice único parcial `uq_finish_events_one_valid_per_bib`, el trigger `trg_before_insert_finish_event`, los RPCs `SECURITY DEFINER`, las vistas `v_live_results` y `v_public_results`, las políticas **Row Level Security (RLS)** y la publicación de **Supabase Realtime**.
4. Abrí otra pestaña en **SQL Editor** y ejecutá [`supabase/seed.sql`](./supabase/seed.sql) para cargar la carrera inicial, las 12 categorías y los usuarios de prueba.
5. En **Authentication → Providers → Email**, desactivá *"Confirm email"* para que los usuarios sintéticos asociados a los códigos PIN (`crono_<pin>@carrera.skol.local`) autentiquen inmediatamente sin requerir verificación por correo.
6. Copiá desde **Project Settings → API**:
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon public key` → `VITE_SUPABASE_ANON_KEY`
   - *(Nunca expongas `service_role` en el frontend)*.

### Paso 3.2: Desplegar el Frontend en Vercel o Netlify

#### Opción A: Vercel (recomendado)
1. Subí el repositorio a GitHub / GitLab.
2. En [vercel.com](https://vercel.com), hacé clic en **Add New Project** e importá el repositorio.
3. Vercel detectará automáticamente **Vite** y leerá [`vercel.json`](./vercel.json) (que configura las redirecciones SPA, la caché `must-revalidate` para `/sw.js` y los headers de seguridad CSP / HSTS).
4. En **Environment Variables**, agregá:
   - `VITE_SUPABASE_URL` = `https://<tu-proyecto>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `<tu-anon-key>`
   - `VITE_DEFAULT_RACE_ID` = `a0000000-0000-4000-8000-000000000001`
5. Hacé clic en **Deploy**.

#### Opción B: Netlify
1. En [app.netlify.com](https://app.netlify.com), elegí **Add new site → Import an existing project**.
2. Netlify leerá automáticamente [`netlify.toml`](./netlify.toml) (`command = "npm run build"`, `publish = "dist"`, headers CSP y redirecciones SPA).
3. Cargá las mismas 3 variables de entorno en **Site configuration → Environment variables** y desplegá.

---

## 4. Checklist Operativo para el Día de la Carrera

### 📅 24 a 48 horas antes de la carrera
- [ ] **Cargar padrón definitivo**: En `/admin` → pestaña **Atletas y Duplas**, importar el CSV definitivo de inscriptos.
- [ ] **Verificar saltos de dorsales**: Confirmar que no existan números consecutivos propensos a confusión visual (usar el botón **Reenumerar con Salto** si hace falta).
- [ ] **Generar PINs individuales**: En `/admin` → **Cronometristas y PINs**, crear un PIN único (4 dígitos) para cada uno de los 10–20 cronometristas y asignarle sus pantallas correspondientes:
  - *Equipo Pantalla 1*: Duplas Funcional (4 km)
  - *Equipo Pantalla 2*: Duplas Scaled (4 km)
  - *Equipo Pantalla 3*: Avanzado (6 km)
  - *Equipo Pantalla 4*: RX (6 km)
  - *Equipo Respaldo / Modo B*: Asignado a todas las pantallas para capturar pelotones.
- [ ] **Descargar padrón y backup base**: Hacer clic en **Exportar Inscriptos CSV** y **Backup Completo JSON**.

### ⏰ 60 minutos antes de largar (en el Punto A)
- [ ] **Instalar la PWA en los celulares**: Cada cronometrista abre la URL en Chrome (Android) o Safari (iOS) y selecciona **"Agregar a pantalla de inicio" / "Instalar aplicación"**.
- [ ] **Configurar pantalla de cada teléfono**:
  - Brillo al máximo y activar el **Modo Sol (☀️)** desde la barra superior de la app.
  - Extender el bloqueo automático de pantalla del celular a **10 o 30 minutos**.
  - Subir el volumen multimedia para escuchar el *beep* de confirmación en cada toque.
  - Comprobar que la batería esté al **> 85%** (tener 2 *powerbanks* en mesa de control).
- [ ] **Login y sincronización de reloj**:
  - Cada cronometrista ingresa con su PIN CON conexión 4G/WiFi activa para que la app descargue el padrón completo a IndexedDB y calibre su `Offset: ±X ms` contra el servidor.
- [ ] **Marcar ausentes (DNS)**: En `/admin`, desmarcar el check *"Habilitado para largar"* a las duplas o atletas que no retiraron kit.

### 🔫 5 minutos antes de la Largada Única
- [ ] **Ubicar al Admin en la línea de salida (Punto A)**.
- [ ] A la orden de *"Listos"*, el Admin toca **`LARGAR CARRERA (Paso 1/2)`** para armar el disparador.
- [ ] Exactamente al sonar la bocina de salida, el Admin toca **`¡CONFIRMAR LARGADA YA! (Paso 2/2)`**.
- [ ] Verificar que el cronómetro verde empieza a correr en todos los teléfonos. *(Si hubo demora humana al tocar el botón, usar **Corregir Largada** e ingresar ej. `-1.5` segundos con el motivo correspondiente).*

### 🏁 Durante las Llegadas (Meta 4 km Duplas y 6 km Individuales)
- [ ] **Regla para Duplas (4 km)**: El cuadrado de la dupla se toca cuando **ambos integrantes** cruzan juntos la línea de llegada.
- [ ] **Toque erróneo**: Si un cronometrista toca un dorsal equivocado, presiona inmediatamente el botón amarillo **`Deshacer (10s)`** en la parte inferior. Si pasaron más de 10 segundos, avisa por voz/handy al Admin indicando el número de dorsal para que lo anule.
- [ ] **Pelotón compacto (3 o más corredores al mismo tiempo)**:
  - No perder tiempo buscando en la grilla: tocar el botón gigante **`⚡ LLEGÓ (SIN NÚMERO)`** por cada corredor en el instante en que pisa la línea, cantar o anotar el orden de los dorsales (ej. *"140, 320, 1050"*) y asignarlos segundos después desde **`Sin Asignar`**.
- [ ] **Monitoreo de Duplicados**: El Admin mantiene abierta la pestaña **`Duplicados y Cola`** en `/admin` y resuelve cualquier alerta roja de discrepancia alta (`> 2s`).

### 🏆 Cierre de Carrera y Publicación Oficial
- [ ] Verificar que todos los teléfonos muestren **`Todo Sincronizado (0 pendientes)`** en la barra de estado (si algún teléfono perdió señal 4G, acercarlo al WiFi/hotspot del Admin y tocar **`Sincronizar Ahora`**).
- [ ] Verificar que en `/admin` → **Duplicados y Cola** queden `0` tiempos sin asignar (`Modo B`) y `0` discrepancias altas sin revisar.
- [ ] Cambiar el estado de la carrera en `/admin` → **Carrera y 4 Pantallas** a **`Finalizada`**.
- [ ] Descargar los respaldos oficiales finales:
  1. En `/resultados`, exportar el **CSV Oficial de Resultados** (general 4K, general 6K y por categoría).
  2. En `/admin`, descargar el **Backup Completo JSON** con todos los eventos y el `audit_log` completo.
