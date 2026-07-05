"""Funcion serverless de inferencia (Vercel, plan Hobby: <10 s).

- Verifica el JWT de Supabase (Authorization: Bearer) antes de todo.
- CORS restringido al origin del frontend (nunca *).
- Descarga modelo-latest.joblib del bucket PRIVADO con la service_role
  key (solo server-side) y lo cachea en memoria entre invocaciones.
"""

import io
import os
from datetime import date, datetime, timedelta, timezone

import joblib
import jwt
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173")

BUCKET = "modelos"
MODEL_PATH = "modelo-latest.joblib"
EQUIPO_MAP = {"A": 0, "B": 1, "C": 2, "D": 3}
TZ_GT = timezone(timedelta(hours=-6))

# Feriados GT — duplicado de ml/feriados.py (la funcion se despliega aislada)
FERIADOS_GT = {(1, 1), (5, 1), (6, 30), (9, 15), (10, 20), (11, 1),
               (12, 24), (12, 25), (12, 31)}
FERIADOS_MOVILES = {date(2025, 4, 17), date(2025, 4, 18),
                    date(2026, 4, 2), date(2026, 4, 3)}

# Fraccion acumulada de visitas esperadas al FINAL de cada hora (0-23),
# derivada del patron historico de llegadas (picos manana y media tarde).
_PESOS = [1, 1, 1, 1, 2, 3, 6, 10, 12, 12, 10, 8, 6, 7, 9, 10, 8, 6, 4, 3, 2, 2, 1, 1]
_TOTAL = sum(_PESOS)
CUM_HORA = [sum(_PESOS[: h + 1]) / _TOTAL for h in range(24)]

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_methods=["GET"],
    allow_headers=["Authorization", "Content-Type"],
)

_cache = {}  # modelo y cliente cacheados entre invocaciones warm


def _sb():
    if "sb" not in _cache:
        _cache["sb"] = create_client(SUPABASE_URL, SERVICE_KEY)
    return _cache["sb"]


def verificar_jwt(request: Request) -> dict:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "Token requerido")
    try:
        claims = jwt.decode(auth[7:], JWT_SECRET, algorithms=["HS256"],
                            audience="authenticated")
    except jwt.PyJWTError:
        raise HTTPException(401, "Token inválido o expirado")

    # El cliente service_role omite RLS, así que las guardas que en la BD
    # aplican public.rol()/public.mfa_ok() deben replicarse aquí; si no, el
    # gate del frontend (RequireRole) es el único control y se puede saltar.
    sub = claims.get("sub", "")

    # RBAC: solo estadistica/admin (paridad con RequireRole y las políticas
    # de la tabla modelos). Un digitador no debe leer métricas ni nowcast.
    if claims.get("user_rol") not in ("estadistica", "admin"):
        raise HTTPException(403, "Rol no autorizado")

    # Rate limiting por sub: ventana deslizante de 1 min en estado de módulo
    # (persiste en instancias warm). Acota abuso de cómputo/pooler.
    import time
    now_ts = time.time()
    ventana = _cache.setdefault("_rl", {})
    hits = [t for t in ventana.get(sub, ()) if now_ts - t < 60.0]
    hits.append(now_ts)
    ventana[sub] = hits
    if len(hits) > 60:
        raise HTTPException(429, "Demasiadas solicitudes; reintentá en un minuto")

    # MFA: exigir aal2, pero solo a quien tiene un factor verificado (paridad
    # con public.mfa_ok()), para no romper a quien no inscribió TOTP. El
    # estado de inscripción no viaja en el JWT, así que se consulta al Admin
    # API de Auth (service_role) y se cachea con TTL. Fail-open ante error de
    # red para no bloquear a usuarios legítimos por una falla transitoria.
    if sub and claims.get("aal") != "aal2":
        import json
        import urllib.request
        mfa_cache = _cache.setdefault("_mfa", {})
        cached = mfa_cache.get(sub)
        if cached is None or now_ts - cached[1] > 300.0:
            inscrito = False
            try:
                req = urllib.request.Request(
                    f"{SUPABASE_URL}/auth/v1/admin/users/{sub}",
                    headers={"apikey": SERVICE_KEY,
                             "Authorization": f"Bearer {SERVICE_KEY}"},
                )
                with urllib.request.urlopen(req, timeout=3) as resp:
                    factores = json.loads(resp.read()).get("factors") or []
                inscrito = any(f.get("status") == "verified" for f in factores)
            except Exception:
                inscrito = False  # fail-open: no romper si Auth no responde
            cached = (inscrito, now_ts)
            mfa_cache[sub] = cached
        if cached[0]:
            raise HTTPException(403, "Se requiere verificación en dos pasos (aal2)")

    return claims


def cargar_modelo() -> dict:
    if "bundle" not in _cache:
        data = _sb().storage.from_(BUCKET).download(MODEL_PATH)
        _cache["bundle"] = joblib.load(io.BytesIO(data))
    return _cache["bundle"]


def es_feriado(d: date) -> int:
    return int((d.month, d.day) in FERIADOS_GT or d in FERIADOS_MOVILES)


def features_de(d: date, equipo: str) -> list:
    return [[d.weekday(), d.month, d.isocalendar()[1], es_feriado(d), EQUIPO_MAP[equipo]]]


class Prediccion(BaseModel):
    prediccion: float
    equipo: str
    fecha: date
    modelo: dict


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/predict", response_model=Prediccion)
def predict(
    fecha: date = Query(...),
    equipo: str = Query(..., pattern="^[ABCD]$"),
    claims: dict = Depends(verificar_jwt),
):
    if claims.get("user_rol") not in ("estadistica", "admin"):
        raise HTTPException(403, "Rol no autorizado")
    bundle = cargar_modelo()
    pred = bundle["model"].predict(features_de(fecha, equipo))[0]
    return Prediccion(
        prediccion=round(max(0.0, float(pred)), 1),
        equipo=equipo, fecha=fecha, modelo=bundle["metrics"],
    )


@app.get("/api/nowcast")
def nowcast(claims: dict = Depends(verificar_jwt)):
    """Estimacion viva de la jornada EN CURSO: visitas registradas hasta
    ahora escaladas por la fraccion historica de la hora transcurrida."""
    if claims.get("user_rol") not in ("estadistica", "admin"):
        raise HTTPException(403, "Rol no autorizado")
    ahora = datetime.now(TZ_GT)

    # rate limit por sub: max 30 req/min. Reutiliza estado en instancias
    # warm via _cache (dict de modulo ya existente); en frias se reinicia.
    sub = claims.get("sub", "")
    _rl = _cache.setdefault("rl", {})
    hist = [t for t in _rl.get(sub, []) if ahora.timestamp() - t < 60]
    if len(hist) >= 30:
        raise HTTPException(429, "Demasiadas solicitudes")
    hist.append(ahora.timestamp())
    _rl[sub] = hist

    sb = _sb()

    # order determinista: si hay varias jornadas abiertas hoy (varios
    # equipos), toma la más reciente en vez de una fila arbitraria.
    jor = (sb.table("jornadas").select("id, equipo")
           .eq("fecha", ahora.date().isoformat()).eq("abierta", True)
           .order("id", desc=True).limit(1).execute()).data
    if not jor:
        return {"jornada_abierta": False}

    # head=True: solo queremos el conteo, no traer las filas
    n = (sb.table("visitas").select("id", count="exact", head=True)
         .eq("jornada_id", jor[0]["id"]).execute()).count or 0

    # ponytail: perfil horario fijo (mismo del seed); si la realidad
    # difiere, calcular el perfil desde visitas historicas.
    frac = max(CUM_HORA[ahora.hour], 0.02)
    return {
        "jornada_abierta": True,
        "equipo": jor[0]["equipo"],
        "visitas_actuales": n,
        "total_estimado": round(n / frac),
        "hora": ahora.strftime("%H:%M"),
    }
