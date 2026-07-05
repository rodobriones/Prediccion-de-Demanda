# Base de datos

Referencia del esquema definido en [`supabase/schema.sql`](../supabase/schema.sql)
y [`supabase/auth_hook.sql`](../supabase/auth_hook.sql). Todo vive en el schema
`public` salvo las extensiones (`extensions`). Ver también
[SEGURIDAD](./SEGURIDAD.md) y [ARQUITECTURA](./ARQUITECTURA.md).

## Extensiones

- **`unaccent`** — normaliza acentos para la búsqueda. Se envuelve en
  `public.f_unaccent(text)` (wrapper `IMMUTABLE`) para poder usarla en columnas
  generadas e índices.
- **`pg_trgm`** — similitud por trigramas, tolera errores de tipeo.

## Tablas

### `perfiles`
Perfil de cada usuario (1:1 con `auth.users`).

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | FK a `auth.users(id)`, `on delete cascade` |
| `nombre` | text | default `''` |
| `rol` | text | `digitador` \| `estadistica` \| `admin` (check), default `digitador` |
| `creado` | timestamptz | default `now()` |

Trigger `on_auth_user_created` (función `handle_new_user`, `SECURITY DEFINER`):
inserta el perfil al registrarse un usuario, con `nombre` del metadata o el local
del email, y rol por defecto `digitador`.

### `pacientes`
La persona. Se registra una sola vez; su `correlativo` es el ID permanente.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | default `gen_random_uuid()` |
| `correlativo` | bigint | **único, inmutable**; default `nextval('seq_correlativo')` |
| `nombres` | text NOT NULL | check longitud 1–120 (trim) |
| `apellidos` | text NOT NULL | check longitud 1–120 (trim) |
| `documento` | text | **DPI/CUI opcional y NO único**; check ≤ 20 chars. No se lee por SELECT directo |
| `created_at` | timestamptz | default `now()` |
| `busqueda` | tsvector | **generada** desde `f_unaccent(nombres+apellidos+documento)`, config `simple` |

Índices: `pacientes_busqueda_idx` (GIN sobre `busqueda`), `pacientes_trgm_idx`
(GIN trigram sobre `f_unaccent(nombres+apellidos)`).

Trigger `trg_correlativo_inmutable` (`before update`): lanza excepción si se
intenta cambiar `correlativo`.

### `jornadas`
Cada instancia de turno de 24 h.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | bigint PK | identity |
| `fecha` | date NOT NULL | |
| `equipo` | text NOT NULL | `A` \| `B` \| `C` \| `D` (check) — rotativo |
| `abierta` | boolean NOT NULL | default `true` |

Único `(fecha, equipo)`. La creación pasa por `obtener_jornada` (upsert atómico).

### `visitas`
El evento de demanda. Cada llegada de un paciente genera una visita.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | default `gen_random_uuid()` |
| `paciente_id` | uuid NOT NULL | FK a `pacientes(id)` |
| `jornada_id` | bigint NOT NULL | FK a `jornadas(id)` |
| `fecha_hora` | timestamptz NOT NULL | hora real de llegada, default `now()` |
| `tipo_atencion` | text NOT NULL | `consulta` \| `emergencia` \| `control` \| `otro`, default `consulta` |
| `es_primera_vez` | boolean NOT NULL | default `false` |
| `usuario_id` | uuid | FK a `auth.users`, default `auth.uid()` |
| `created_at` | timestamptz | default `now()` |

Índices: `visitas_jornada_idx`, `visitas_paciente_idx`.

### `modelos`
Métricas de cada modelo entrenado.

| Columna | Tipo |
|---|---|
| `id` | bigint PK identity |
| `creado` | timestamptz default `now()` |
| `mae`, `rmse`, `r2` | double precision NOT NULL |
| `n_filas` | integer NOT NULL |
| `storage_path` | text NOT NULL |

### `auditoria`
Bitácora inmutable escrita por triggers.

| Columna | Tipo |
|---|---|
| `id` | bigint PK identity |
| `usuario_id` | uuid (`auth.uid()`) |
| `accion` | text (`INSERT`/`UPDATE`/`DELETE`) |
| `tabla` | text |
| `registro_id` | text |
| `datos` | jsonb (en UPDATE: `{antes, despues}`) |
| `creado` | timestamptz default `now()` |

Triggers `trg_audit_pacientes` y `trg_audit_visitas` (`after insert/update/delete`,
función `fn_auditoria` `SECURITY DEFINER`).

## Vista

### `v_demanda_por_turno`
Dataset de entrenamiento. `security_invoker = true` (respeta la RLS de quien
consulta). Agrupa visitas por jornada:

```sql
select j.id as jornada_id, j.fecha, j.equipo, count(v.id)::int as pacientes
from jornadas j join visitas v on v.jornada_id = j.id
group by j.id, j.fecha, j.equipo;
```

`pacientes` aquí es el **conteo de visitas** de la jornada (el target del modelo).

## RPCs

Todas son `SECURITY DEFINER` con `search_path = ''`.

| Función | Firma | Qué hace | EXECUTE |
|---|---|---|---|
| `obtener_jornada` | `(p_equipo text) → bigint` | Upsert atómico de la jornada del día (fecha en `America/Guatemala`) para el equipo; devuelve `id`. | Nadie directo (solo la usan otras RPCs) |
| `buscar_paciente` | `(q text) → tabla(id, correlativo, nombres, apellidos)` | Full-text (`websearch_to_tsquery`) + trigram + match por correlativo. Solo campos de desambiguación, orden por relevancia, límite 20. La resolución por **documento (DPI/CUI) es solo para `admin`**. La usan Admisión y Consulta. | `authenticated` (rol `digitador`/`estadistica`/`admin`) |
| `registrar_paciente` | `(p_nombres, p_apellidos, p_documento, p_equipo, p_tipo_atencion) → jsonb` | Crea paciente (correlativo desde la secuencia), abre/obtiene jornada, inserta **primera visita** (`es_primera_vez=true`). Devuelve `{paciente_id, correlativo, visita_id}`. | `authenticated` (rol `digitador`/`admin`) |
| `registrar_visita` | `(p_paciente_id uuid, p_equipo, p_tipo_atencion) → jsonb` | Paciente existente: abre/obtiene jornada, inserta visita (`es_primera_vez=false`). Devuelve `{visita_id}`. | `authenticated` (rol `digitador`/`admin`) |
| `rol` | `() → text` | Lee `user_rol` del JWT con fallback a `perfiles`. Usada por las políticas RLS. | — |
| `custom_access_token_hook` | `(event jsonb) → jsonb` | Hook de Auth: inyecta `user_rol` en los claims. | `supabase_auth_admin` |

`registrar_paciente` y `registrar_visita` usan `auth.uid()` como `usuario_id`.
`buscar_paciente`, `registrar_*` validan `public.rol()` y lanzan `No autorizado`
si no corresponde.

## Políticas RLS por rol

RLS deny-by-default en todas las tablas. `public.rol()` lee el rol del JWT.

| Tabla | `digitador` | `estadistica` | `admin` |
|---|---|---|---|
| `pacientes` | SELECT (columnas sin `documento`) | SELECT (sin `documento`) | SELECT · UPDATE · DELETE |
| `visitas` | SELECT propio (`usuario_id=auth.uid()`) | SELECT total | SELECT · UPDATE · DELETE |
| `jornadas` | SELECT | SELECT | SELECT (escritura solo por RPC) |
| `perfiles` | ve/edita el suyo (no cambia su rol) | ve/edita el suyo | gestiona todos |
| `modelos` | — | SELECT | SELECT |
| `auditoria` | — | — | SELECT |

Notas:
- **El `INSERT` directo a `pacientes` y `visitas` está revocado** (`revoke insert
  ... from authenticated`): el alta pasa solo por las RPCs `registrar_paciente` /
  `registrar_visita` (`SECURITY DEFINER`), que validan rol y `aal2`. Evita evadir
  su lógica y envenenar el dataset de demanda.
- Toda política (salvo `perfiles`) añade `and public.mfa_ok()`: quien tiene TOTP
  inscrito necesita token `aal2` (ver [SEGURIDAD](./SEGURIDAD.md#cómo-se-fuerza-el-segundo-factor-aal2)).
- El `grant` de columna en `pacientes` excluye `documento` y `busqueda` para todos
  los roles vía PostgREST (ver [SEGURIDAD](./SEGURIDAD.md#minimización-de-columnas-dpicui)).
- `perfiles` tiene además una política para `supabase_auth_admin` (el hook necesita
  leer el rol).
- `auditoria` no tiene políticas de escritura: nadie puede modificarla.
