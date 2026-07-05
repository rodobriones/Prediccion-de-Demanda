"""Funcion serverless de inferencia (Vercel, plan Hobby: <10 s).

- Verifica el JWT de Supabase (Authorization: Bearer) antes de todo.
- CORS restringido al origin del frontend (nunca *).
- Sirve las predicciones que train.py materializo a JSON en el bucket
  PRIVADO (lookup por fecha+equipo). No carga sklearn: la funcion no cabe
  en el limite de 225 MB con scipy/numpy/scikit-learn.
"""

import json
import os
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

import jwt
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from jwt import PyJWKClient
from pydantic import BaseModel

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173")

BUCKET = "modelos"
PRED_PATH = "predicciones-latest.json"
TZ_GT = timezone(timedelta(hours=-6))

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

_cache = {}  # modelo cacheado entre invocaciones warm


def _http_get(url: str, headers: dict | None = None, timeout: float = 5.0):
    # ponytail: urllib en vez de supabase-py; ese paquete arrastra ~70 MB
    # (cryptography, httpx, realtime...) y revienta el limite de 225 MB de la
    # funcion. Devuelve la respuesta (usar como context manager).
    h = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
    if headers:
        h.update(headers)
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout)


def _jwks_client() -> PyJWKClient:
    # Supabase firma los access tokens con JWT Signing Keys asimétricas (ES256);
    # se validan contra el JWKS público del proyecto. Lazy: el constructor exige
    # una URL válida, y el cliente cachea las claves entre invocaciones warm.
    if "jwks" not in _cache:
        _cache["jwks"] = PyJWKClient(
            f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json", cache_keys=True)
    return _cache["jwks"]


def _count_de(content_range: str) -> int:
    # PostgREST devuelve "0-24/573" o "*/0"; extrae el total tras la barra
    cola = content_range.rsplit("/", 1)[-1] if "/" in content_range else ""
    return int(cola) if cola.isdigit() else 0


def verificar_jwt(request: Request) -> dict:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "Token requerido")
    token = auth[7:]
    try:
        signing_key = _jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(token, signing_key.key, algorithms=["ES256"],
                            audience="authenticated")
    except Exception:
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
        mfa_cache = _cache.setdefault("_mfa", {})
        cached = mfa_cache.get(sub)
        if cached is None or now_ts - cached[1] > 300.0:
            inscrito = False
            try:
                with _http_get(f"{SUPABASE_URL}/auth/v1/admin/users/{sub}",
                               timeout=3) as resp:
                    factores = json.loads(resp.read()).get("factors") or []
                inscrito = any(f.get("status") == "verified" for f in factores)
            except Exception:
                inscrito = False  # fail-open: no romper si Auth no responde
            cached = (inscrito, now_ts)
            mfa_cache[sub] = cached
        if cached[0]:
            raise HTTPException(403, "Se requiere verificación en dos pasos (aal2)")

    return claims


def cargar_predicciones() -> dict:
    if "pred" not in _cache:
        url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{PRED_PATH}"
        with _http_get(url, timeout=8) as resp:
            _cache["pred"] = json.loads(resp.read())
    return _cache["pred"]


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
    datos = cargar_predicciones()
    val = datos["predicciones"].get(f"{fecha.isoformat()}|{equipo}")
    if val is None:
        raise HTTPException(422, "Fecha fuera del horizonte de predicción")
    return Prediccion(
        prediccion=val, equipo=equipo, fecha=fecha, modelo=datos["metrics"],
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

    # order determinista: si hay varias jornadas abiertas hoy (varios
    # equipos), toma la más reciente en vez de una fila arbitraria.
    q = urllib.parse.urlencode({
        "select": "id,equipo",
        "fecha": f"eq.{ahora.date().isoformat()}",
        "abierta": "eq.true",
        "order": "id.desc",
        "limit": "1",
    })
    with _http_get(f"{SUPABASE_URL}/rest/v1/jornadas?{q}") as resp:
        jor = json.loads(resp.read())
    if not jor:
        return {"jornada_abierta": False}

    # solo el conteo: limit=1 (traer 1 fila) + Prefer count=exact -> Content-Range
    q = urllib.parse.urlencode({"select": "id", "jornada_id": f"eq.{jor[0]['id']}",
                                "limit": "1"})
    with _http_get(f"{SUPABASE_URL}/rest/v1/visitas?{q}",
                   headers={"Prefer": "count=exact"}) as resp:
        n = _count_de(resp.headers.get("Content-Range", ""))

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


if __name__ == "__main__":
    assert _count_de("0-24/573") == 573
    assert _count_de("*/0") == 0
    assert _count_de("0-0/1") == 1
    assert _count_de("") == 0
    print("ok")
