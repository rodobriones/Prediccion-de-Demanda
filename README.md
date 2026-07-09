# Sistema de admisión CAP con predicción de demanda

Proyecto académico para un Centro de Atención Permanente: admisión de pacientes
(buscar primero → visita nueva o paciente nuevo) y predicción de demanda por
turno con aprendizaje automático. **Toda la infraestructura es gratuita** y la
seguridad está integrada desde el diseño.

## Arquitectura

```
React + Vite (Vercel Hobby)  ──anon key──►  Supabase (Postgres + Auth + Storage, free)
        │                                        ▲                ▲
        │ JWT                                    │ service_role   │ service_role
        ▼                                        │                │
/api/predict (FastAPI en Vercel) ◄── predicciones-latest.json ── GitHub Actions (cron 2×/sem: train.py)
```

- **Inferencia** (rápida, serverless, < 10 s) separada del **entrenamiento** (batch, GitHub Actions).
- El frontend hace CRUD directo a Supabase con RLS; no hay backend Node.
- Modelo: `HistGradientBoostingRegressor` (scikit-learn), entrenado en Actions. Vercel **no** carga sklearn: `train.py` materializa las predicciones (deterministas por fecha+equipo) en un JSON y la función las sirve por lookup, así el bundle cabe en el límite (~225 MB) de las funciones Python de Vercel.

## Estructura

| Ruta | Contenido |
|---|---|
| `web/` | Frontend React + Vite + TS (auth, MFA, admisión, consulta, dashboard) |
| `api/predict.py` | Función Python de Vercel: `/api/predict`, `/api/nowcast`, `/api/health` |
| `ml/seed.py` | Datos sintéticos (18 meses de pacientes y visitas) |
| `ml/train.py` | Entrenamiento + subida del modelo al bucket privado |
| `supabase/schema.sql` | Tablas, RLS, RPCs, auditoría, búsqueda full-text/trigram |
| `supabase/auth_hook.sql` | Custom Access Token Hook (rol en el JWT) |
| `.github/workflows/` | `train.yml` (cron 2×/sem) y `backup.yml` (dump lógico) |

## Despliegue paso a paso (todo en tier gratis)

### 1. Supabase

1. Cree un proyecto en [supabase.com](https://supabase.com) (plan Free).
2. **SQL Editor** → ejecute `supabase/schema.sql` completo, luego `supabase/auth_hook.sql`.
3. **Authentication → Hooks → Customize Access Token (JWT) Claims** → seleccione
   `public.custom_access_token_hook` y actívelo (inyecta el rol en el JWT).
4. **Authentication → Sign In / Providers → Email**: active *Confirm email*.
5. **Authentication → Policies / Passwords**: longitud mínima **12** y active
   *Leaked password protection* (HaveIBeenPwned).
6. **Authentication → Multi-Factor**: habilite **TOTP**.
7. **Authentication → Sign In / Providers**: active ***Disable sign ups***
   (⚠️ obligatorio). El registro público provisiona rol `digitador` con acceso al
   padrón; los usuarios los crea solo un admin (invitación) o el `service_role`.
8. **Storage**: cree un bucket llamado `modelos` y déjelo **PRIVADO** (no público).
9. Copie de **Settings → API**: `URL`, `anon key`, `service_role key` y el `JWT Secret`.

### 2. Datos sintéticos y primer usuario

```bash
pip install -r ml/requirements.txt
# PowerShell: $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_KEY="..."
cd ml && python seed.py
```

Con el registro público deshabilitado, cree usuarios desde **Authentication →
Users → Add user** (o por invitación). El trigger crea el perfil con rol
`digitador`; para promover a `admin` o `estadistica`, edite la fila en la tabla
`perfiles` (SQL Editor). El usuario debe **cerrar y abrir sesión** para que el
nuevo rol entre al JWT.

### 3. GitHub (repo público = minutos ilimitados de Actions)

1. Suba el repo a GitHub como **público**.
2. **Settings → Secrets and variables → Actions**: cree
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` y (opcional, para backup)
   `SUPABASE_DB_URL` (connection string de la base).
3. **Actions → Entrenar modelo de demanda → Run workflow** para el primer
   entrenamiento. Luego corre solo cada domingo 06:00 UTC.

### 4. Vercel (Hobby)

1. Importe el repo en [vercel.com](https://vercel.com). `vercel.json` ya define
   build del frontend y la función Python.
2. **Environment Variables** (server-side, sin prefijo `VITE_`):
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `FRONTEND_ORIGIN` (p. ej. `https://su-app.vercel.app`).
3. Variables del frontend: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
   `VITE_API_URL` **déjela vacía** (la API es del mismo origen; el frontend la
   llama en relativo `/api/...`, así no choca con el CSP).
4. En Supabase, **Authentication → URL Configuration**: agregue la URL de
   Vercel como *Site URL* / *Redirect URL*.

## Seguridad (security by design)

- **Autenticación**: Supabase Auth con confirmación de correo obligatoria,
  contraseñas ≥ 12 caracteres, bloqueo de contraseñas filtradas (HIBP) y
  **MFA TOTP** ofrecido a `admin` y `estadistica`. JWT de vida corta con
  rotación de refresh token (defaults de Supabase).
- **RBAC**: roles `digitador` / `estadistica` / `admin` en `perfiles`; el rol
  viaja como claim `user_rol` en el JWT vía Custom Access Token Hook, y las
  políticas RLS lo leen de `auth.jwt()` (sin subconsultas). Privilegio mínimo.
- **RLS deny-by-default** en todas las tablas: el digitador solo ve sus propias
  visitas y no puede borrar pacientes; estadística es solo lectura; solo admin
  lee auditoría. La escritura de jornadas/visitas pasa por RPCs `SECURITY DEFINER`.
- **Auditoría**: triggers en `pacientes` y `visitas` registran INSERT/UPDATE/
  DELETE con `auth.uid()` en la tabla `auditoria` (nadie la modifica).
- **Correlativo inmutable**: secuencia de Postgres (atómica bajo concurrencia)
  + trigger que rechaza cualquier UPDATE del correlativo.
- **Secretos**: la `service_role` key vive SOLO en GitHub Secrets y en las
  variables server-side de Vercel. El frontend usa solo la `anon` key. El
  bucket `modelos` es privado. `/api/predict` verifica la firma del JWT
  (401 sin token) y restringe **CORS** al origin del frontend (nunca `*`).
- **Validación doble**: `zod` en el frontend y `pydantic`/FastAPI en la API.
- **TLS extremo a extremo**: Vercel y Supabase sirven todo sobre HTTPS por
  defecto; no hay tramos en claro.
- **Respaldo**: el free tier no tiene point-in-time recovery; `backup.yml`
  hace un dump lógico semanal como artifact (retención 30 días). ⚠️ El dump
  contiene datos personales; los artifacts de GitHub solo son descargables
  con acceso al repo, pero para producción cífrelos antes de subir (p. ej.
  `gpg --symmetric`) y guarde la passphrase como secret.

### Notas de configuración que afectan la seguridad

- **Verificación del JWT (`/api/predict`)**: valida los access tokens (firmados
  con las *JWT Signing Keys* ES256 de Supabase) contra el **JWKS público** del
  proyecto (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`) con `PyJWKClient`.
  Requiere `SUPABASE_URL` en el entorno; ya no usa `SUPABASE_JWT_SECRET`. Si
  revierte a HS256 legacy, vuelva a validar con el secreto.
- **MFA de extremo a extremo**: el segundo factor (aal2) se exige tanto en el
  cliente como en el **servidor** — el helper `public.mfa_ok()` gatea todas las
  políticas RLS y las RPCs, y `api/predict.py` devuelve 403 sin aal2. Se aplica
  solo a usuarios con TOTP inscrito, así que un digitador sin MFA no se bloquea.
  Ver [docs/SEGURIDAD.md](docs/SEGURIDAD.md).
- **DPI/CUI**: por minimización, `documento` no se expone vía SELECT directo
  (solo lo usan las RPCs `SECURITY DEFINER`). Si un rol necesita mostrar el
  DPI, cree una RPC dedicada en vez de reabrir el `GRANT` de columna.

### Datos y cumplimiento

- **Minimización, finalidad y proporcionalidad**: solo se guardan los datos de
  identidad estrictamente necesarios para reconocer a un paciente que regresa
  (nombres, apellidos, DPI/CUI opcional). **Sin diagnósticos ni datos clínicos.**
- Marco de referencia: **Ley de Acceso a la Información Pública de Guatemala
  (Decreto 57-2008)**, en particular la protección de datos personales
  sensibles (arts. 9 y 30–32). En un despliegue real, el manejo de datos de
  menores debe regirse por las salvaguardas de protección de datos de la
  institución.

## Limitaciones del tier gratis (anotadas)

- **Correo de Auth**: el free usa el SMTP compartido de Supabase con rate limit
  bajo; suficiente para la demo. Producción real requiere SMTP propio
  (Authentication → SMTP Settings).
- **Supabase free** pausa el proyecto tras ~7 días sin actividad (se reanuda
  desde el dashboard) y da 500 MB de base + 1 GB de Storage — este diseño usa
  una fracción mínima.
- **Vercel Hobby** corta funciones a 10 s y limita el bundle Python (~225 MB):
  por eso la inferencia no carga sklearn, solo lee el JSON de predicciones
  (cacheado en memoria) y hace lookup — responde en milisegundos.

## Verificación rápida de los criterios de aceptación

```sql
-- Correlativo inmutable (debe FALLAR):
update pacientes set correlativo = 999999 where correlativo = 1;
-- Búsqueda tolerante a tildes/typos:
select * from buscar_paciente('maria lopes');
-- Auditoría:
select accion, tabla, creado from auditoria order by creado desc limit 5;
```

- `curl https://su-app.vercel.app/api/predict?fecha=2026-07-10&equipo=A` → **401** sin token.
- Inicie sesión como `digitador` → Consulta muestra solo sus visitas; como
  `estadistica` → todo el histórico y el dashboard con métricas del modelo.
