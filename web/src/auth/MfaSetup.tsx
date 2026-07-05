import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

// Alta de MFA (TOTP) — ofrecido a roles admin y estadistica.
export default function MfaSetup() {
  const [estado, setEstado] = useState<"cargando" | "activo" | "enrolar" | "verificar">("cargando");
  const [qr, setQr] = useState("");
  const [secreto, setSecreto] = useState("");
  const [factorId, setFactorId] = useState("");
  const [codigo, setCodigo] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data }) => {
      const verificado = data?.totp?.some((f) => f.status === "verified");
      setEstado(verificado ? "activo" : "enrolar");
    });
  }, []);

  async function enrolar() {
    setError("");
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    if (error || !data) return setError(error?.message ?? "Error al iniciar MFA");
    setQr(data.totp.qr_code);
    setSecreto(data.totp.secret);
    setFactorId(data.id);
    setEstado("verificar");
  }

  async function verificar(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const { data: ch, error: e1 } = await supabase.auth.mfa.challenge({ factorId });
    if (e1 || !ch) return setError(e1?.message ?? "Error");
    const { error: e2 } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code: codigo });
    if (e2) return setError("Código incorrecto, intente de nuevo");
    setEstado("activo");
  }

  return (
    <div className="tarjeta">
      <h2>Autenticación en dos pasos (MFA)</h2>
      {estado === "cargando" && <p>Cargando…</p>}
      {estado === "activo" && <div className="aviso ok">MFA activo: su cuenta pide un código TOTP al iniciar sesión.</div>}
      {estado === "enrolar" && (
        <>
          <p>
            Proteja su cuenta con un segundo factor. Necesita una app de autenticación
            (Google Authenticator, Authy, etc.).
          </p>
          <button onClick={enrolar}>Activar MFA</button>
        </>
      )}
      {estado === "verificar" && (
        <form onSubmit={verificar}>
          <p>Escanee el código QR con su app y escriba el código de 6 dígitos:</p>
          {/* qr_code de supabase es un data-URL para <img>, no SVG crudo */}
          <img className="qr-mfa" src={qr} alt="Código QR para configurar MFA" width={180} height={180} />
          <p className="mono">Clave manual: {secreto}</p>
          <label className="etiqueta" htmlFor="mfa-code">Código</label>
          <input id="mfa-code" value={codigo} onChange={(e) => setCodigo(e.target.value)}
            inputMode="numeric" pattern="\d{6}" maxLength={6} required style={{ maxWidth: 140 }} />
          <p><button type="submit">Verificar y activar</button></p>
        </form>
      )}
      {error && <div className="aviso error">{error}</div>}
    </div>
  );
}
