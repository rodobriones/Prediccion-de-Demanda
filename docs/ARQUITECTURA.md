# Arquitectura

Sistema web de admisión de pacientes con predicción de demanda por turno para un
Centro de Atención Permanente (CAP). Toda la infraestructura es gratuita (Supabase
free, Vercel Hobby, GitHub Actions en repo público).

Ver también: [SEGURIDAD](./SEGURIDAD.md) · [BASE-DE-DATOS](./BASE-DE-DATOS.md) ·
[ML](./ML.md) · [despliegue](../README.md).

## Flujo general

```
                         ┌──────────────────────────────────────────┐
                         │            Supabase (plan free)           │
   ┌───────────┐  anon   │  Postgres (RLS) · Auth · Storage privado  │
   │  Frontend │ ──key──► │                                          │
   │ React+Vite│         │  ┌─ pacientes / visitas / jornadas ─┐     │
   │  (Vercel) │ ◄──────► │  │ RPCs SECURITY DEFINER            │     │
   └─────┬─────┘  RLS     │  └──────────────────────────────────┘     │
         │                │  bucket privado "modelos"                 │
         │ JWT (Bearer)   └───────▲──────────────────▲───────────────┘
         ▼                        │ service_role     │ service_role
   ┌──────────────┐   descarga    │                  │
   │ /api/predict │ ── modelo ────┘                  │
   │  (FastAPI en │                                   │
   │   Vercel)    │        ┌──────────────────────────┴───────┐
   └──────────────┘        │ GitHub Actions (cron semanal)     │
                           │ train.py: lee v_demanda_por_turno,│
                           │ entrena, sube modelo-latest.joblib│
                           └───────────────────────────────────┘
```

## Separación inferencia / entrenamiento

Son dos caminos deliberadamente separados:

- **Inferencia** (`api/predict.py`): serverless, rápida, síncrona. Carga el modelo
  cacheado en memoria y llama `predict()`. Debe responder en **menos de 10 s**
  (límite de Vercel Hobby); en la práctica es instantánea.
- **Entrenamiento** (`ml/train.py`): batch, pesado, asíncrono. Corre en GitHub
  Actions por cron. **Nunca** dentro de un request.

El artefacto que los une es `modelo-latest.joblib` en un bucket privado de Storage:
el entrenamiento lo escribe (upsert), la inferencia lo lee.

## Decisiones de diseño

### Serverless para inferencia, batch para entrenamiento
Entrenar tarda y consume memoria; hacerlo dentro de un request reventaría el
límite de 10 s y el de 500 MB de las funciones Python de Vercel. Separarlo permite
que la inferencia sea trivial (cargar + predecir) y que el reentrenamiento use los
minutos ilimitados de Actions en repo público.

### `HistGradientBoostingRegressor`, no TensorFlow/PyTorch
Los frameworks de deep learning no caben en el límite de **500 MB sin comprimir**
de las funciones Python de Vercel. `scikit-learn` sí, y para una serie temporal
tabular con pocas features un gradient boosting es más apropiado y más preciso que
una red neuronal. El `requirements.txt` de la raíz se mantiene mínimo por esto.

### El correlativo del paciente es una secuencia de Postgres
El correlativo es el **ID permanente** del paciente, asignado una sola vez. Una
`SEQUENCE` es atómica por diseño (sin bloqueos, sin condiciones de carrera bajo
registros concurrentes) y un trigger la hace **inmutable**. Puede tener huecos por
rollbacks, lo cual es aceptable para un ID. Si el CAP exigiera numeración sin
huecos, se cambiaría por una tabla contador con `SELECT ... FOR UPDATE`.

### "Buscar primero" contra duplicados
El DPI/CUI **no** sirve como llave única: a veces el paciente no lo trae y puede
repetirse o quedar vacío. La defensa contra pacientes duplicados es el flujo de
admisión: el digitador **busca primero** (full-text + trigram, tolerante a tildes
y errores de tipeo vía `buscar_paciente`); si el paciente existe registra una
visita nueva ("vino de nuevo"), y si no, antes de crear uno nuevo la pantalla
advierte de posibles duplicados por nombre para que confirme.

### Paciente vs. visita
Se distingue la **persona** (paciente, registrado una sola vez, con su correlativo)
del **evento** (visita, cada llegada). La demanda se mide por visitas: el conteo de
visitas por jornada es el target del modelo (vista `v_demanda_por_turno`).

### Jornadas de 24 h con equipo rotativo
Cada turno es una `jornada` (día + equipo A/B/C/D). Las visitas se agrupan por
jornada; esa granularidad es la unidad de predicción.
