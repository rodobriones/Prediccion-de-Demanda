import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import {
  type PacienteEncontrado,
  type PacienteNuevo,
  pacienteNuevoSchema,
  visitaSchema,
} from "../lib/validation";

const EQUIPOS = ["A", "B", "C", "D"] as const;
const TIPOS = ["consulta", "emergencia", "control", "otro"] as const;

export default function Admision() {
  const { rol } = useAuth();
  const [q, setQ] = useState("");
  const [resultados, setResultados] = useState<PacienteEncontrado[]>([]);
  const [seleccionado, setSeleccionado] = useState<PacienteEncontrado | null>(null);
  const [modoNuevo, setModoNuevo] = useState(false);

  const [equipo, setEquipo] = useState<string>("A");
  const [tipo, setTipo] = useState<string>("consulta");
  const [nombres, setNombres] = useState("");
  const [apellidos, setApellidos] = useState("");
  const [documento, setDocumento] = useState("");
  const [duplicados, setDuplicados] = useState<PacienteEncontrado[] | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [exito, setExito] = useState<{ correlativo?: number; mensaje: string } | null>(null);
  const timer = useRef<number>();

  // Búsqueda full-text con debounce mientras se escribe
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResultados([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      const { data } = await supabase.rpc("buscar_paciente", { q });
      setResultados((data as PacienteEncontrado[]) ?? []);
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  function limpiar() {
    setQ(""); setResultados([]); setSeleccionado(null); setModoNuevo(false);
    setNombres(""); setApellidos(""); setDocumento(""); setDuplicados(null);
    setError("");
  }

  // Paciente existente: "vino de nuevo" → nueva visita que cuenta para la demanda
  async function registrarVisita() {
    if (!seleccionado) return;
    const val = visitaSchema.safeParse({ paciente_id: seleccionado.id, equipo, tipo_atencion: tipo });
    if (!val.success) return setError(val.error.issues[0].message);
    setBusy(true); setError(""); setExito(null);
    try {
      const { error } = await supabase.rpc("registrar_visita", {
        p_paciente_id: seleccionado.id, p_equipo: equipo, p_tipo_atencion: tipo,
      });
      if (error) return setError(error.message);
      setExito({ mensaje: `Visita registrada para ${seleccionado.nombres} ${seleccionado.apellidos} (correlativo ${seleccionado.correlativo}).` });
      limpiar();
    } finally {
      setBusy(false);
    }
  }

  // Paciente nuevo: fuerza la revisión de posibles duplicados por nombre.
  // Revalida SIEMPRE (los inputs siguen editables tras la advertencia de
  // duplicados), incluido el camino "Crear de todos modos".
  async function registrarNuevo(confirmado: boolean) {
    const val = pacienteNuevoSchema.safeParse({ nombres, apellidos, documento, equipo, tipo_atencion: tipo });
    if (!val.success) return setError(val.error.issues[0].message);
    const form: PacienteNuevo = val.data;
    setBusy(true); setError(""); setExito(null);
    try {
      if (!confirmado) {
        const { data } = await supabase.rpc("buscar_paciente", { q: `${form.nombres} ${form.apellidos}` });
        const parecidos = (data as PacienteEncontrado[]) ?? [];
        if (parecidos.length > 0) {
          setDuplicados(parecidos); // advertencia: posible duplicado
          return;
        }
      }
      const { data, error } = await supabase.rpc("registrar_paciente", {
        p_nombres: form.nombres, p_apellidos: form.apellidos,
        p_documento: form.documento, p_equipo: form.equipo, p_tipo_atencion: form.tipo_atencion,
      });
      if (error) return setError(error.message);
      setExito({ correlativo: data.correlativo, mensaje: "Paciente creado y primera visita registrada." });
      limpiar();
    } finally {
      setBusy(false);
    }
  }

  function submitNuevo(e: React.FormEvent) {
    e.preventDefault();
    void registrarNuevo(false); // registrarNuevo revalida y muestra el error
  }

  return (
    <>
      <h1>Admisión</h1>
      <p style={{ color: "var(--tinta-2)", marginTop: 0 }}>
        Busque primero al paciente. Si ya existe, registre la visita; si no, créelo.
      </p>

      {exito && (
        <div className="tarjeta" style={{ borderTop: "4px solid var(--acento)" }}>
          {exito.correlativo != null && (
            <>
              <span className="etiqueta">Correlativo permanente asignado</span>
              <div className="correlativo-hero">{exito.correlativo}</div>
            </>
          )}
          <p>{exito.mensaje}</p>
        </div>
      )}

      <div className="grid-2">
        <div className="tarjeta">
          <h2>1 · Buscar paciente</h2>
          <label className="etiqueta" htmlFor="buscar">Nombre, correlativo o DPI</label>
          <input id="buscar" value={q} onChange={(e) => { setQ(e.target.value); setSeleccionado(null); }}
            placeholder="Ej. María López" autoComplete="off" />
          {resultados.length > 0 && (
            <ul className="resultados">
              {resultados.map((p) => (
                <li key={p.id} onClick={() => { setSeleccionado(p); setModoNuevo(false); }}>
                  <span className="correlativo">#{p.correlativo}</span>
                  <span>{p.nombres} {p.apellidos}</span>
                </li>
              ))}
            </ul>
          )}
          {q.trim().length >= 2 && resultados.length === 0 && (
            <p style={{ color: "var(--tinta-2)" }}>Sin coincidencias.</p>
          )}
          <p>
            <button className="secundario" onClick={() => { setModoNuevo(true); setSeleccionado(null); setDuplicados(null); }}>
              Paciente nuevo
            </button>
          </p>
        </div>

        <div className="tarjeta">
          <h2>2 · Registrar</h2>
          <div className="grid-2">
            <div>
              <label className="etiqueta" htmlFor="equipo">Equipo de turno</label>
              <select id="equipo" value={equipo} onChange={(e) => setEquipo(e.target.value)}>
                {EQUIPOS.map((eq) => <option key={eq}>{eq}</option>)}
              </select>
            </div>
            <div>
              <label className="etiqueta" htmlFor="tipo">Tipo de atención</label>
              <select id="tipo" value={tipo} onChange={(e) => setTipo(e.target.value)}>
                {TIPOS.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {seleccionado && (
            <>
              <div className="aviso ok">
                <strong>#{seleccionado.correlativo}</strong> · {seleccionado.nombres} {seleccionado.apellidos}
              </div>
              <button onClick={registrarVisita} disabled={busy}>
                {busy ? "Registrando…" : "Registrar visita (vino de nuevo)"}
              </button>
            </>
          )}

          {modoNuevo && !seleccionado && (
            <form onSubmit={submitNuevo}>
              <label className="etiqueta" htmlFor="nombres">Nombres *</label>
              <input id="nombres" value={nombres} onChange={(e) => setNombres(e.target.value)} required />
              <label className="etiqueta" htmlFor="apellidos">Apellidos *</label>
              <input id="apellidos" value={apellidos} onChange={(e) => setApellidos(e.target.value)} required />
              <label className="etiqueta" htmlFor="documento">DPI / CUI (opcional)</label>
              <input id="documento" value={documento} onChange={(e) => setDocumento(e.target.value)}
                placeholder="13 dígitos o vacío" inputMode="numeric" />

              {duplicados && (
                <div className="aviso advertencia">
                  <strong>Posible duplicado.</strong> Hay pacientes con nombre parecido — verifique antes de crear:
                  <ul className="resultados" style={{ background: "#fff" }}>
                    {duplicados.map((p) => (
                      <li key={p.id} onClick={() => { setSeleccionado(p); setModoNuevo(false); setDuplicados(null); }}>
                        <span className="correlativo">#{p.correlativo}</span>
                        <span>{p.nombres} {p.apellidos}</span>
                      </li>
                    ))}
                  </ul>
                  <p style={{ marginBottom: 0 }}>
                    Si es uno de la lista, selecciónelo. Si de verdad es una persona nueva:
                    {" "}
                    <button type="button" disabled={busy} onClick={() => void registrarNuevo(true)}>
                      Crear de todos modos
                    </button>
                  </p>
                </div>
              )}

              {!duplicados && (
                <p>
                  <button type="submit" disabled={busy}>
                    {busy ? "Registrando…" : "Crear paciente y registrar visita"}
                  </button>
                </p>
              )}
            </form>
          )}

          {!seleccionado && !modoNuevo && (
            <p style={{ color: "var(--tinta-2)" }}>Seleccione un paciente de la búsqueda o cree uno nuevo.</p>
          )}
          {error && <div className="aviso error">{error}</div>}
          {rol === "estadistica" && (
            <div className="aviso advertencia">Su rol es de solo lectura; el registro está deshabilitado.</div>
          )}
        </div>
      </div>
    </>
  );
}
