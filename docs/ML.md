# Pipeline de Machine Learning

Predice el número de pacientes (visitas) de una jornada. Ver también
[ARQUITECTURA](./ARQUITECTURA.md) y [BASE-DE-DATOS](./BASE-DE-DATOS.md).

Archivos: [`ml/seed.py`](../ml/seed.py) (datos sintéticos),
[`ml/train.py`](../ml/train.py) (entrenamiento), [`ml/feriados.py`](../ml/feriados.py)
(feriados), [`api/predict.py`](../api/predict.py) (inferencia).

## Datos sintéticos (`seed.py`)

Como no hay datos reales, `seed.py` genera **18 meses (540 días)** de historia e
inserta con la `service_role` key (saltando RLS). Genera pacientes, jornadas y
visitas coherentes con la vista `v_demanda_por_turno`.

- **Pacientes**: nombres y apellidos guatemaltecos variados (para ejercitar la
  búsqueda full-text y trigram). ~25 % sin DPI/CUI (`documento` opcional).
- **Rotación**: un equipo por día, ciclo `A/B/C/D` (`EQUIPOS[i % 4]`).
- **Mezcla primeras vs recurrentes**: `P_PRIMERA_VEZ = 0.40` — ~40 % primeras
  visitas, el resto de pacientes ya en el pool (`es_primera_vez` refleja esto).
  *(Nota `ponytail` en el código: con esa mezcla el total de pacientes queda en
  ~14 k, no ~2 k; primó la proporción realista.)*
- **Estacionalidad** (`visitas_del_dia`): base 65; **lunes y viernes** +15;
  fin de semana −15; **feriados** −25; ruido ±12; mínimo 15. Resultado ≈ 40–90
  visitas por jornada.
- **Horas pico** (`hora_llegada`): distribución con picos en la mañana y media
  tarde (`PESO_HORA`), hora de llegada en zona `America/Guatemala` (UTC-6).

`random.seed(42)` hace el seed reproducible. Inserta en lotes (`chunked`).

## Feriados (`feriados.py`)

`es_feriado(date) → 0/1`. Combina feriados fijos de Guatemala (Año Nuevo, Día del
Trabajo, Día del Ejército, Independencia, Revolución, Todos los Santos, Navidad,
etc.) con una lista de móviles (Jueves/Viernes Santo de los años del dataset).
`api/predict.py` **duplica** esta lista porque la función de Vercel se despliega
aislada del paquete `ml/`.

## Entrenamiento (`train.py`)

Corre en GitHub Actions (ver más abajo). Pasos:

1. Lee toda la vista `v_demanda_por_turno` (paginada de 1000 en 1000), ordenada por
   fecha. Aborta si hay menos de 50 filas.
2. Construye las **features** con `construir_features`:

   | Feature | Origen |
   |---|---|
   | `dia_semana` | `fecha.weekday()` (0=lunes) |
   | `mes` | `fecha.month` |
   | `semana_iso` | `fecha.isocalendar()[1]` |
   | `feriado` | `es_feriado(fecha)` (0/1) |
   | `equipo_cod` | `equipo` → `{A:0, B:1, C:2, D:3}` |

   El **target** es `pacientes` (conteo de visitas por jornada).
3. **Split temporal 80/20** sin shuffle (es serie temporal): entrena con el primer
   80 % y evalúa con el 20 % final.
4. Entrena `HistGradientBoostingRegressor(random_state=42)`.
5. Evalúa sobre el 20 % de test: **MAE**, **RMSE** (`sqrt(MSE)`), **R²**.
6. **Reentrena con el 100 %** de los datos para el modelo publicado.
7. Serializa con `joblib` un bundle
   `{model, features, equipo_map, metrics}` y lo sube al bucket privado como
   `modelos/modelo-latest.joblib` (upsert).
8. Inserta una fila en la tabla `modelos` con las métricas y `n_filas`. Imprime
   las métricas al final.

## Publicación del modelo

El modelo vive en el **bucket privado `modelos`** de Supabase Storage como
`modelo-latest.joblib` (siempre el mismo path, upsert). Solo se accede con la
`service_role` key: `train.py` lo escribe, `api/predict.py` lo lee (y lo cachea en
memoria entre invocaciones warm).

## Reentrenamiento (cron)

[`.github/workflows/train.yml`](../.github/workflows/train.yml):
`schedule` cron **domingo 06:00 UTC** + `workflow_dispatch` manual. Python 3.12,
instala `ml/requirements.txt`, corre `python train.py` con `working-directory: ml`.
Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. Repo público → minutos ilimitados.

## Inferencia (`api/predict.py`)

- `GET /api/predict?fecha=YYYY-MM-DD&equipo=A` → predice el total de la jornada.
  Reconstruye las **mismas features** del entrenamiento (`features_de`) y devuelve
  `{prediccion, equipo, fecha, modelo:{mae,rmse,r2}}`. La predicción se acota a ≥ 0
  y se redondea.
- Verifica el JWT y aplica CORS antes de responder (ver [SEGURIDAD](./SEGURIDAD.md)).

### Nowcasting

`GET /api/nowcast` estima el total de la **jornada en curso**: cuenta las visitas
ya registradas hoy y las escala por la fracción histórica de la hora transcurrida
(`CUM_HORA`, derivada del mismo perfil horario del seed). Devuelve
`{jornada_abierta, equipo, visitas_actuales, total_estimado, hora}`, o
`{jornada_abierta: false}` si no hay jornada abierta. Aprovecha que el registro es
evento por evento para dar una estimación viva del turno.

*(Nota `ponytail`: el perfil horario es fijo; si la realidad difiere, calcularlo
desde las visitas históricas.)*
