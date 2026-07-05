import type { Session } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export type Rol = "digitador" | "estadistica" | "admin";

interface AuthCtx {
  session: Session | null;
  rol: Rol | null;
  cargando: boolean;
  needsMfa: boolean; // tiene TOTP inscrito pero la sesión sigue en aal1
  salir: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({ session: null, rol: null, cargando: true, needsMfa: false, salir: async () => {} });

// El rol viaja como claim `user_rol` dentro del JWT (custom access token hook)
function rolDelToken(token: string): Rol | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.user_rol ?? null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [rol, setRol] = useState<Rol | null>(null);
  const [cargando, setCargando] = useState(true);
  const [needsMfa, setNeedsMfa] = useState(false);

  useEffect(() => {
    async function aplicar(s: Session | null) {
      setSession(s);
      if (!s) {
        setRol(null);
        setNeedsMfa(false);
        setCargando(false);
        return;
      }
      let r = rolDelToken(s.access_token);
      if (!r) {
        // Fallback si el hook aún no inyecta el claim
        const { data } = await supabase.from("perfiles").select("rol").eq("id", s.user.id).single();
        r = (data?.rol as Rol) ?? null;
      }
      setRol(r);
      // Step-up MFA: si hay un factor verificado, la sesión debe llegar a aal2
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      setNeedsMfa(!!aal && aal.nextLevel === "aal2" && aal.currentLevel === "aal1");
      setCargando(false);
    }
    supabase.auth.getSession().then(({ data }) => aplicar(data.session));
    // Diferir con setTimeout: supabase-js sostiene un lock durante el
    // callback y llamar sus métodos async aquí adentro puede deadlockear.
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setTimeout(() => aplicar(s), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const salir = async () => {
    await supabase.auth.signOut(); // invalida la sesión local
  };

  return <Ctx.Provider value={{ session, rol, cargando, needsMfa, salir }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
