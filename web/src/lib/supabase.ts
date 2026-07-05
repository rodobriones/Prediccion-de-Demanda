import { createClient } from "@supabase/supabase-js";

// Solo la anon key vive en el frontend (pública por diseño; RLS protege
// los datos). La service_role key JAMÁS se importa aquí.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export const API_URL: string = import.meta.env.VITE_API_URL ?? "";
