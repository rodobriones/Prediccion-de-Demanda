import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";

const credencialesSchema = z.object({
  email: z.string().email("Correo inválido"),
  password: z.string().min(12, "La contraseña tiene al menos 12 caracteres"),
});

export default function Login() {
  const nav = useNavigate();
  const { session, needsMfa, rol } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [codigo, setCodigo] = useState("");
  const [faseMfa, setFaseMfa] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Si se llega aquí con sesión aal1 y factor inscrito (p. ej. navegando
  // directo para saltar el MFA), forzar la fase del segundo factor.
  useEffect(() => {
    if (needsMfa) setFaseMfa(true);
    else if (session && rol) nav("/", { replace: true });
  }, [needsMfa, session, rol, nav]);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const val = credencialesSchema.safeParse({ email, password });
    if (!val.success) return setError(val.error.issues[0].message);

    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return setError(error.message);

      // ¿La cuenta tiene MFA? Entonces falta el segundo factor (aal2)
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === "aal2" && aal.nextLevel !== aal.currentLevel) {
        setFaseMfa(true);
        return;
      }
      nav("/", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  async function verificarMfa(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { data } = await supabase.auth.mfa.listFactors();
      const factor = data?.totp?.find((f) => f.status === "verified");
      if (!factor) return setError("No hay factor TOTP configurado");
      const { data: ch, error: e1 } = await supabase.auth.mfa.challenge({ factorId: factor.id });
      if (e1 || !ch) return setError(e1?.message ?? "Error");
      const { error: e2 } = await supabase.auth.mfa.verify({ factorId: factor.id, challengeId: ch.id, code: codigo });
      if (e2) return setError("Código incorrecto");
      nav("/", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-caja">
        <h1 style={{ textAlign: "center" }}>
          CAP · <em style={{ color: "var(--acento-oscuro)", fontStyle: "normal" }}>Admisión</em>
        </h1>
        <p style={{ textAlign: "center", color: "var(--tinta-2)", marginTop: 0 }}>
          Centro de Atención Permanente
        </p>
        <div className="tarjeta">
          {!faseMfa ? (
            <form onSubmit={entrar}>
              <label className="etiqueta" htmlFor="email">Correo</label>
              <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
              <label className="etiqueta" htmlFor="password">Contraseña</label>
              <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
              <p><button type="submit" disabled={busy} style={{ width: "100%" }}>{busy ? "Entrando…" : "Entrar"}</button></p>
            </form>
          ) : (
            <form onSubmit={verificarMfa}>
              <h2>Segundo factor</h2>
              <p>Escriba el código de 6 dígitos de su app de autenticación.</p>
              <input value={codigo} onChange={(e) => setCodigo(e.target.value)} inputMode="numeric" maxLength={6} autoFocus required />
              <p><button type="submit" disabled={busy} style={{ width: "100%" }}>Verificar</button></p>
            </form>
          )}
          {error && <div className="aviso error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
