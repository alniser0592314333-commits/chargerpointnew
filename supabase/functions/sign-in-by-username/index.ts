import { createClient } from "npm:@supabase/supabase-js@2";
import { createUsernameSignInHandler } from "./handler.ts";

Deno.serve(createUsernameSignInHandler({
  getEnv: (name) => Deno.env.get(name),
  createAdminClient: (url, secretKey) => createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any,
}));
