import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import BarChart, { type Punto } from "../components/BarChart";
import { API_URL, supabase } from "../lib/supabase";

interface Modelo { creado: string; mae: number; rmse: number; r2: number; n_filas: number; }
interface Prediccion { prediccion: number; equipo: string; fecha: string; }
interface Nowcast { jornada_abierta: boolean; equipo?: string; visitas_actuales?: number; total_estimado?: number; hora?: string; }

// Fecha en hora de Guatemala (UTC-6) desplazada `dias`: restamos 6h antes de
// tomar la fecha, si no toISOString() (UTC) salta un día por la tarde-noche.
const fechaGT = (dias = 0) =>
  new Date(Date.now() - 6 * 3600000 + dias * 86400000).toISOString().slice(0, 10);
const manana = () => fechaGT(1);

export default function Dashboard() {
  const { session } = useAuth();
  const [demanda, setDemanda] = useState<Punto[]>([]);
  const [modelo, setModelo] = useState<Modelo | null>(null);
  const [fecha, setFecha] = useState(manana());
  const [equipo, setEquipo] = useState("A");
  const [pred, setPred] = useState<Prediccion | null>(null);
  const [semana, setSemana] = useState<Prediccion | null>(null);
  const [mes, setMes] = useState<Prediccion | null>(null);
  const [nowcast, setNowcast] = useState<Nowcast | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const auth = { Authorization: `Bearer ${session?.access_token}` };

  const predecirFecha = (f: string, eq: string): Promise<Prediccion | null> =>
    fetch(`${API_URL}/api/predict?fecha=${f}&equipo=${eq}`, { headers: auth })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

  useEffect(() => {
    supabase
      .from("v_demanda_por_turno")
      .select("fecha, equipo, pacientes")
      .order("fecha", { ascending: false })
      .limit(90)
      .then(({ data }) => setDemanda(((data as Punto[]) ?? []).reverse()));
    supabase
      .from("modelos")
      .select("creado, mae, rmse, r2, n_filas")
      .order("creado", { ascending: false })
      .limit(1)
      .then(({ data }) => setModelo((data?.[0] as Modelo) ?? null));
    fetch(`${API_URL}/api/nowcast`, { headers: auth })
      .then((r) => (r.ok ? r.json() : null))
      .then(setNowcast)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pronóstico automático: semana (+7) y mes (+30) que vienen, para el equipo
  // seleccionado. Se recalcula al cambiar de equipo.
  useEffect(() => {
    predecirFecha(fechaGT(7), equipo).then(setSemana);
    predecirFecha(fechaGT(30), equipo).then(setMes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipo]);

  async function predecir() {
    setBusy(true); setError(""); setPred(null);
    try {
      const r = await fetch(`${API_URL}/api/predict?fecha=${fecha}&equipo=${equipo}`, { headers: auth });
      if (!r.ok) throw new Error(`El servicio respondió ${r.status}`);
      setPred(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al predecir");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Dashboard de demanda</h1>

      <div className="tarjeta">
        <h2>Visitas por jornada (últimas 90)</h2>
        <BarChart data={demanda} />
      </div>

      <div className="grid-2">
        <div className="tarjeta" style={{ borderTop: "4px solid var(--acento)" }}>
          <h2>Predicción de demanda</h2>
          <div className="stats">
            <div className="stat">
              <div className="valor">{semana ? `${Math.round(semana.prediccion)}` : "—"}</div>
              <div className="nombre">semana que viene · {fechaGT(7)} · equipo {equipo}</div>
            </div>
            <div className="stat">
              <div className="valor">{mes ? `${Math.round(mes.prediccion)}` : "—"}</div>
              <div className="nombre">mes que viene · {fechaGT(30)} · equipo {equipo}</div>
            </div>
          </div>
          <h3 style={{ fontSize: "0.95rem", color: "var(--tinta-2)", marginTop: "1rem" }}>Consultar otra fecha</h3>
          <div className="grid-2">
            <div>
              <label className="etiqueta" htmlFor="p-fecha">Fecha</label>
              <input id="p-fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
            </div>
            <div>
              <label className="etiqueta" htmlFor="p-equipo">Equipo</label>
              <select id="p-equipo" value={equipo} onChange={(e) => setEquipo(e.target.value)}>
                {["A", "B", "C", "D"].map((eq) => <option key={eq}>{eq}</option>)}
              </select>
            </div>
          </div>
          <p><button onClick={predecir} disabled={busy}>{busy ? "Calculando…" : "Predecir"}</button></p>
          {pred && (
            <div className="stat">
              <div className="valor">{Math.round(pred.prediccion)} pacientes</div>
              <div className="nombre">estimados · {pred.fecha} · equipo {pred.equipo}</div>
            </div>
          )}
          {error && <div className="aviso error">{error}</div>}
        </div>

        <div>
          {nowcast?.jornada_abierta && (
            <div className="tarjeta" style={{ borderTop: "4px solid var(--ambar)" }}>
              <h2>Jornada en curso</h2>
              <div className="stats">
                <div className="stat">
                  <div className="valor">{nowcast.visitas_actuales}</div>
                  <div className="nombre">visitas hasta {nowcast.hora}</div>
                </div>
                <div className="stat">
                  <div className="valor">≈ {nowcast.total_estimado}</div>
                  <div className="nombre">total estimado · equipo {nowcast.equipo}</div>
                </div>
              </div>
            </div>
          )}
          <div className="tarjeta">
            <h2>Modelo activo</h2>
            {modelo ? (
              <>
                <div className="stats">
                  <div className="stat"><div className="valor">{modelo.mae.toFixed(1)}</div><div className="nombre">MAE</div></div>
                  <div className="stat"><div className="valor">{modelo.rmse.toFixed(1)}</div><div className="nombre">RMSE</div></div>
                  <div className="stat"><div className="valor">{modelo.r2.toFixed(2)}</div><div className="nombre">R²</div></div>
                </div>
                <p style={{ color: "var(--tinta-2)", fontSize: "0.85rem" }}>
                  Entrenado el {new Date(modelo.creado).toLocaleDateString("es-GT")} con {modelo.n_filas} jornadas.
                </p>
              </>
            ) : (
              <p style={{ color: "var(--tinta-2)" }}>Aún no hay modelo entrenado. Corra el workflow de entrenamiento.</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
