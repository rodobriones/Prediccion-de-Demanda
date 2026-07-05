# CLAUDE.md — guía para agentes

Monorepo de un **sistema de admisión de pacientes con predicción de demanda por
turno** (proyecto académico, Centro de Atención Permanente). Toda la infra es
gratuita y la seguridad está integrada desde el diseño.

Para el **despliegue paso a paso** ver [`README.md`](./README.md). Para el detalle
temático: [`docs/ARQUITECTURA.md`](./docs/ARQUITECTURA.md),
[`docs/SEGURIDAD.md`](./docs/SEGURIDAD.md),
[`docs/BASE-DE-DATOS.md`](./docs/BASE-DE-DATOS.md), [`docs/ML.md`](./docs/ML.md).

## Mapa del repo

| Ruta | Qué es |
|---|---|
| `web/` | Frontend React + Vite + TypeScript. CRUD directo a Supabase (sin backend Node). |
| `web/src/lib/supabase.ts` | Cliente Supabase (solo **anon key**) y `API_URL`. |
| `web/src/lib/validation.ts` | Esquemas `zod` y tipos compartidos. |
| `web/src/auth/` | `AuthProvider` (sesión/rol/MFA), `RequireRole` (guarda), `MfaSetup` (alta TOTP). |
| `web/src/pages/` | `Login`, `Admision`, `Consulta`, `Dashboard`. |
| `web/src/components/` | `Layout` (navbar por rol), `BarChart` (SVG sin dependencias). |
| `api/predict.py` | Función serverless FastAPI en Vercel: `/api/predict`, `/api/nowcast`, `/api/health`. Verifica JWT + CORS. Sirve predicciones por lookup del JSON del bucket (sin sklearn); habla con Supabase por REST vía `urllib`. |
| `ml/seed.py` | Genera 18 meses de datos sintéticos (pacientes, jornadas, visitas). |
| `ml/train.py` | Entrenamiento batch (GitHub Actions), sube el modelo al bucket privado. |
| `ml/feriados.py` | Feriados de Guatemala (helper compartido seed/train). |
| `ml/requirements.txt` | Deps de entrenamiento. |
| `supabase/schema.sql` | Tablas, RLS, RPCs, vista, triggers, extensiones. **Fuente de verdad del modelo de datos.** |
| `supabase/auth_hook.sql` | Custom Access Token Hook (inyecta `user_rol` en el JWT). |
| `.github/workflows/train.yml` | Cron semanal de reentrenamiento + `workflow_dispatch`. |
| `.github/workflows/backup.yml` | Dump lógico semanal como artifact. |
| `vercel.json` | Build del frontend + función Python (`maxDuration` 10 s). |
| `requirements.txt` (raíz) | Deps **mínimas** de la función de Vercel (límite 500 MB). |

## Stack

- Frontend: React 18 + Vite 5 + TypeScript 5, `react-router-dom` 6, `@supabase/supabase-js` 2, `zod` 3.
- Backend de datos: Supabase (Postgres + Auth + Storage), plan free.
- Inferencia: FastAPI en Vercel (Python 3.12), `scikit-learn` `HistGradientBoostingRegressor`.
- Entrenamiento: Python 3.12 en GitHub Actions.

## Comandos

```bash
# Frontend
cd web && npm install
cd web && npm run build      # tsc -b && vite build  (así se valida el TS)
cd web && npm run dev        # servidor de desarrollo

# Validar sintaxis de Python (no hay tests formales)
python -m py_compile api/predict.py ml/seed.py ml/train.py ml/feriados.py

# ML (requieren env vars; usan la SERVICE KEY)
pip install -r ml/requirements.txt
cd ml && python seed.py      # necesita SUPABASE_URL y SUPABASE_SERVICE_KEY
cd ml && python train.py     # idem; lee v_demanda_por_turno, sube modelo-latest.joblib
```

`train.py` y `seed.py` importan `feriados` de forma relativa, por eso se corren
con `cd ml` (o `working-directory: ml`, como en `train.yml`).

## Convenciones

- **Idioma**: identificadores, columnas y mensajes en español; términos técnicos en inglés.
- **RPCs `SECURITY DEFINER`**: todo registro/búsqueda pasa por funciones (`registrar_paciente`, `registrar_visita`, `buscar_paciente`, `obtener_jornada`) que corren como owner y validan el rol con `public.rol()`. La escritura de `jornadas`/`visitas` NO se hace por INSERT directo desde el cliente.
- **RLS deny-by-default**: todas las tablas tienen RLS activo. Ninguna se deja sin políticas. Nunca desactivar RLS "temporalmente".
- **Rol vía JWT**: `public.rol()` lee el claim `user_rol` (inyectado por el hook), con fallback a `perfiles`. Las políticas usan `public.rol()`, no subconsultas a `perfiles` (evita recursión RLS).
- El frontend valida con `zod`; la API valida con `pydantic`/tipos de FastAPI. Validar en ambos lados.

## GOTCHAS (leer antes de tocar)

- **`service_role` key NUNCA en el frontend.** Solo vive en secrets de GitHub Actions y en env vars server-side de Vercel. El frontend usa exclusivamente la `anon` key. Jamás prefijar un secreto con `VITE_`.
- **JWT: ES256 vía JWKS.** El proyecto Supabase usa *JWT Signing Keys* asimétricas. `api/predict.py` valida con `PyJWKClient` contra `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` y `jwt.decode(..., algorithms=["ES256"], audience="authenticated")`. Requiere `pyjwt[crypto]` (trae `cryptography`) y que `SUPABASE_URL` esté en el entorno de Vercel. Ya NO se usa `SUPABASE_JWT_SECRET`. Si se revirtiera a HS256 legacy, habría que volver a validar con el secreto.
- **Fechas en hora de Guatemala (UTC-6), no UTC.** `obtener_jornada` usa `(now() at time zone 'America/Guatemala')::date`. En el frontend, calcular fechas por defecto desplazando el reloj a GT antes de `toISOString()` (ver `manana()` en `Dashboard.tsx`), si no salta un día por la tarde-noche.
- **`qr_code` de MFA es un data-URL para `<img src>`**, no SVG crudo. Renderizar con `<img>`, nunca con `dangerouslySetInnerHTML`.
- **`documento` (DPI/CUI) no es accesible por SELECT directo.** El `grant` de columna en `pacientes` excluye `documento` (y `busqueda`). Solo las RPCs `SECURITY DEFINER` lo leen. Si un rol necesita mostrar el DPI, crear una RPC dedicada, no reabrir el grant.
- **Callbacks de `onAuthStateChange` no deben hacer `await`.** supabase-js sostiene un lock durante el callback; llamar sus métodos async adentro puede deadlockear. Diferir con `setTimeout(..., 0)` (ver `AuthProvider.tsx`).
- **supabase-js no rechaza promesas.** Devuelve `{ data, error }` y `data === null` en fallo. Siempre leer `error`; no envolver en try/catch esperando excepción.
- **El correlativo del paciente es inmutable.** Un trigger `before update` rechaza cualquier cambio de `pacientes.correlativo`. No intentar actualizarlo.
- **NO hacer `INSERT` directo a `pacientes` ni `visitas`.** Está revocado (`revoke insert ... from authenticated`); el alta pasa solo por las RPCs `registrar_paciente` / `registrar_visita`. Un `.insert()` de supabase-js sobre esas tablas fallará por diseño.
- **Toda política RLS (salvo `perfiles`) exige `public.mfa_ok()`.** Al añadir una tabla o política nueva, incluir `and public.mfa_ok()` para no dejar un hueco de segundo factor. El helper es *fail-safe*: token sin claim `aal` se trata como `aal1`.
- **Orden de instalación en Supabase**: `schema.sql` → `auth_hook.sql` → activar el hook en el Dashboard. Un usuario debe reiniciar sesión para que un cambio de rol entre al JWT.
