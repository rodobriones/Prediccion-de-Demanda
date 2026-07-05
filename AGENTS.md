# AGENTS.md

Monorepo de admisión de pacientes con predicción de demanda por turno. Frontend
React/Vite/TS que hace CRUD directo a Supabase (sin backend Node), inferencia ML
en una función Python de Vercel, y entrenamiento batch en GitHub Actions.

La guía detallada para agentes está en [`CLAUDE.md`](./CLAUDE.md); el despliegue
en [`README.md`](./README.md). Este archivo es el resumen mínimo autónomo.

## Estructura

- `web/` — frontend (React 18, Vite 5, TypeScript 5, supabase-js 2, zod 3).
- `api/predict.py` — FastAPI en Vercel: `/api/predict`, `/api/nowcast`, `/api/health`.
- `ml/` — `seed.py` (datos sintéticos), `train.py` (entrenamiento), `feriados.py`.
- `supabase/` — `schema.sql` (tablas, RLS, RPCs) y `auth_hook.sql` (rol en JWT).
- `.github/workflows/` — `train.yml` (cron) y `backup.yml`.

## Comandos

```bash
cd web && npm install && npm run build          # build + typecheck del frontend
python -m py_compile api/predict.py ml/*.py      # validar sintaxis Python
cd ml && python seed.py                          # requiere SUPABASE_URL + SUPABASE_SERVICE_KEY
cd ml && python train.py                         # idem
```

No hay suite de tests; la validación es `npm run build` (TS estricto) y `py_compile`.

## Reglas — no romper

- **Nunca** poner la `service_role` key en el frontend ni prefijarla con `VITE_`. El frontend usa solo la `anon` key.
- **Nunca** desactivar RLS. Todas las tablas son deny-by-default; la escritura de `jornadas`/`visitas` pasa por RPCs `SECURITY DEFINER`.
- Fechas de negocio en zona `America/Guatemala` (UTC-6), no UTC.
- supabase-js devuelve `{ data, error }` (no lanza); no hacer `await` dentro de callbacks de `onAuthStateChange`.
- El `correlativo` del paciente es inmutable (trigger lo protege); `documento`/DPI no se lee por SELECT directo, solo por RPC.
- Identificadores y mensajes en español.

Detalle completo de gotchas y convenciones: [`CLAUDE.md`](./CLAUDE.md).
