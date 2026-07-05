import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import type { PacienteEncontrado } from "../lib/validation";

interface Fila {
  id: string;
  fecha_hora: string;
  tipo_atencion: string;
  es_primera_vez: boolean;
  pacientes: { correlativo: number; nombres: string; apellidos: string } | null;
  jornadas: { fecha: string; equipo: string } | null;
}

export default function Consulta() {
  const { rol } = useAuth();
  const [fecha, setFecha] = useState("");
  const [equipo, setEquipo] = useState("");
  const [filas, setFilas] = useState<Fila[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");

  // Buscador de paciente (reutiliza la RPC buscar_paciente)
  const [q, setQ] = useState("");
  const [candidatos, setCandidatos] = useState<PacienteEncontrado[]>([]);
  const [paciente, setPaciente] = useState<PacienteEncontrado | null>(null);
  const timer = useRef<number>();

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (paciente || q.trim().length < 2) {
      setCandidatos([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      const { data } = await supabase.rpc("buscar_paciente", { q });
      setCandidatos((data as PacienteEncontrado[]) ?? []);
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [q, paciente]);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    let query = supabase
      .from("visitas")
      .select("id, fecha_hora, tipo_atencion, es_primera_vez, pacientes(correlativo, nombres, apellidos), jornadas!inner(fecha, equipo)")
      .order("fecha_hora", { ascending: false })
      .limit(200);
    if (fecha) query = query.eq("jornadas.fecha", fecha);
    if (equipo) query = query.eq("jornadas.equipo", equipo);
    if (paciente) query = query.eq("paciente_id", paciente.id);
    query.then(({ data, error }) => {
      if (!vivo) return;
      setError(error ? error.message : "");
      setFilas(error ? [] : (data as unknown as Fila[]) ?? []);
      setCargando(false);
    });
    return () => { vivo = false; };
  }, [fecha, equipo, paciente]);

  return (
    <>
      <h1>Consulta de visitas</h1>
      {rol === "digitador" && (
        <p style={{ color: "var(--tinta-2)", marginTop: 0 }}>
          Su rol solo muestra las visitas registradas por usted.
        </p>
      )}
      <div className="tarjeta">
        {error && <div className="aviso error">No se pudieron cargar las visitas: {error}</div>}
        <div className="grid-2" style={{ maxWidth: 520 }}>
          <div>
            <label className="etiqueta" htmlFor="f-fecha">Fecha</label>
            <input id="f-fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </div>
          <div>
            <label className="etiqueta" htmlFor="f-equipo">Equipo</label>
            <select id="f-equipo" value={equipo} onChange={(e) => setEquipo(e.target.value)}>
              <option value="">Todos</option>
              {["A", "B", "C", "D"].map((eq) => <option key={eq}>{eq}</option>)}
            </select>
          </div>
        </div>

        <label className="etiqueta" htmlFor="f-paciente">Paciente</label>
        {paciente ? (
          <div className="aviso ok" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span><strong>#{paciente.correlativo}</strong> · {paciente.nombres} {paciente.apellidos}</span>
            <button className="secundario" onClick={() => { setPaciente(null); setQ(""); }}>Quitar filtro</button>
          </div>
        ) : (
          <>
            <input id="f-paciente" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Nombre o correlativo (tolera tildes y errores)" autoComplete="off" style={{ maxWidth: 520 }} />
            {candidatos.length > 0 && (
              <ul className="resultados" style={{ maxWidth: 520 }}>
                {candidatos.map((p) => (
                  <li key={p.id} onClick={() => { setPaciente(p); setCandidatos([]); }}>
                    <span className="correlativo">#{p.correlativo}</span>
                    <span>{p.nombres} {p.apellidos}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <table style={{ marginTop: "1rem" }}>
          <thead>
            <tr>
              <th>Correlativo</th><th>Paciente</th><th>Fecha y hora</th>
              <th>Equipo</th><th>Tipo</th><th>Visita</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.id}>
                <td className="correlativo">#{f.pacientes?.correlativo}</td>
                <td>{f.pacientes?.nombres} {f.pacientes?.apellidos}</td>
                <td>{new Date(f.fecha_hora).toLocaleString("es-GT")}</td>
                <td>{f.jornadas?.equipo}</td>
                <td>{f.tipo_atencion}</td>
                <td>
                  {f.es_primera_vez
                    ? <span className="chip ambar">primera vez</span>
                    : <span className="chip">recurrente</span>}
                </td>
              </tr>
            ))}
            {!cargando && filas.length === 0 && (
              <tr><td colSpan={6} style={{ color: "var(--tinta-2)" }}>Sin visitas para el filtro.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
