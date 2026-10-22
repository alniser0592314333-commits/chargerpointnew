import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: cors });
const normalize = (v: unknown, max = 256) =>
  typeof v === "string" && v.length <= max ? v.trim() : "";
const decodeB64 = (s: string) => { const v = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(v.padEnd(Math.ceil(v.length / 4) * 4, "=")), c => c.charCodeAt(0)); };
const encodeB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
function derToRaw(input: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> | null {
  // Android's SHA256withECDSA returns ASN.1 DER; WebCrypto expects fixed-width r||s.
  if (input.length < 8 || input[0] !== 0x30) return null;
  let p = 2;
  if (input[1] & 0x80) p += (input[1] & 0x7f);
  if (input[p++] !== 0x02) return null;
  const rLen = input[p++];
  let r = input.slice(p, p + rLen); p += rLen;
  if (input[p++] !== 0x02) return null;
  const sLen = input[p++];
  let s = input.slice(p, p + sLen);
  const trim = (x: Uint8Array) => x.length > 32 && x[0] === 0 ? x.slice(1) : x;
  r = trim(r); s = trim(s);
  if (r.length > 32 || s.length > 32) return null;
  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length); raw.set(s, 64 - s.length);
  return raw;
}
async function verifySignature(spki: string, challenge: string, signatureB64: string) {
  try {
    const key = await crypto.subtle.importKey("spki", decodeB64(spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = derToRaw(decodeB64(signatureB64));
    if (!sig) return false;
    const signatureBytes = new Uint8Array(sig);\n    const challengeBytes = new TextEncoder().encode(challenge);\n    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureBytes, challengeBytes);
  } catch { return false; }
}
function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
  } catch { return null; }
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  const url = Deno.env.get("SUPABASE_URL");
  const secret = Deno.env.get("auth_supabase_secret_key") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !secret || !anon) return reply(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const auth = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  let input: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 12000) return reply(413, { ok: false, error: "REQUEST_TOO_LARGE" });
    input = JSON.parse(raw);
  } catch { return reply(400, { ok: false, error: "INVALID_REQUEST" }); }
  const action = normalize(input.action, 40);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  const getAuthenticatedIdentity = async () => {
    if (!bearer || bearer === anon) return null;
    const { data, error } = await auth.auth.getUser(bearer);
    if (error || !data.user) return null;
    const uid = data.user.id;
    const { data: customer } = await admin.from("customer_account_links")
      .select("customer_id,auth_user_id,account_status,login_email").eq("auth_user_id", uid).maybeSingle();
    if (customer && customer.account_status === "ACTIVE") return { type: "customer", id: customer.customer_id, uid, email: customer.login_email };
    const { data: adminRow } = await admin.from("admins")
      .select("id,auth_user_id,email,username,role,is_active").eq("auth_user_id", uid).maybeSingle();
    if (adminRow?.is_active === true) {
      const { data: userData } = await admin.auth.admin.getUserById(uid);
      const email = userData.user?.email || adminRow.email;
      if (email) return { type: "admin", id: adminRow.id, uid, email, role: adminRow.role };
    }
    return null;
  };
  const createChallenge = async (identity: {type:string;id:string;uid:string}, purpose: "enroll"|"login", credentialId: string | null) => {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const {count, error: countError} = await admin.from("account_biometric_challenges").select("id",{count:"exact",head:true})
    .eq("account_type",identity.type).eq("subject_id",identity.id).gte("created_at",since);
  if (countError || Number(count || 0) >= 10) return null;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
    const challenge = Array.from(bytes, b => b.toString(16).padStart(2,"0")).join("");
    const { data, error } = await admin.from("account_biometric_challenges").insert({
      account_type: identity.type, subject_id: identity.id, auth_user_id: identity.uid,
      purpose, challenge, credential_id: credentialId, expires_at: new Date(Date.now()+120000).toISOString(),
    }).select("id").single();
    if (error || !data) return null;
    return { challengeId: data.id as string, challenge };
  };
  const consumeAndVerify = async (challengeId: string, signature: string, expectedPurpose: "enroll"|"login") => {
    const { data: c, error } = await admin.from("account_biometric_challenges").select("*")
      .eq("id", challengeId).eq("purpose", expectedPurpose).is("consumed_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (error || !c) return null;
    const { data: updated, error: consumeError } = await admin.from("account_biometric_challenges")
      .update({ consumed_at: new Date().toISOString() }).eq("id", challengeId).is("consumed_at", null).select("id").maybeSingle();
    if (consumeError || !updated) return null;
    return { challenge: c, valid: signature };
  };
  try {
    if (action === "enroll-challenge") {
      const identity = await getAuthenticatedIdentity();
      if (!identity) return reply(401, { ok:false, error:"AUTH_REQUIRED" });
      const old = await admin.from("account_biometric_credentials").select("id").eq("account_type",identity.type).eq("subject_id",identity.id).is("revoked_at",null).maybeSingle();
      if (old.data) return reply(409, {ok:false,error:"BIOMETRIC_ALREADY_ENROLLED"});
      const c = await createChallenge(identity,"enroll",null);
      return c ? reply(200,{ok:true,...c,accountType:identity.type}) : reply(503,{ok:false,error:"CHALLENGE_UNAVAILABLE"});
    }
    if (action === "enroll-verify") {
      const identity = await getAuthenticatedIdentity();
      const challengeId = normalize(input.challengeId, 64);
      const publicKey = normalize(input.publicKey, 4096);
      const signature = normalize(input.signature, 2048);
      if (!identity || !challengeId || !publicKey || !signature) return reply(400,{ok:false,error:"INVALID_REQUEST"});
      const consumed = await consumeAndVerify(challengeId,signature,"enroll");
      if (!consumed || consumed.challenge.auth_user_id !== identity.uid || consumed.challenge.subject_id !== identity.id ||
          !(await verifySignature(publicKey,consumed.challenge.challenge,signature))) return reply(401,{ok:false,error:"BIOMETRIC_PROOF_INVALID"});
      const { data, error } = await admin.from("account_biometric_credentials").upsert({
        account_type:identity.type, subject_id:identity.id, auth_user_id:identity.uid,
        public_key_spki:publicKey, device_label:normalize(input.deviceLabel,120)||"Android device",
        revoked_at:null, last_used_at:new Date().toISOString(),
      },{onConflict:"account_type,subject_id"}).select("id").single();
      return !error && data ? reply(200,{ok:true,credentialId:data.id}) : reply(503,{ok:false,error:"BIOMETRIC_ENROLLMENT_FAILED"});
    }
    if (action === "login-challenge") {
      const type = normalize(input.accountType,16);
      const identifier = normalize(input.identifier,256);
      if (!["customer","admin"].includes(type) || !identifier) return reply(400,{ok:false,error:"INVALID_REQUEST"});
      let identity: any = null;
      if (type === "customer") {
        let customerId = identifier;
        if (!/^[0-9a-f-]{36}$/i.test(identifier)) {
          const { data: qr } = await admin.from("qr_tokens").select("target_id").eq("public_token",identifier).eq("token_type","CUSTOMER").eq("is_active",true).maybeSingle();
          if (!qr) return reply(401,{ok:false,error:"BIOMETRIC_UNAVAILABLE"});
          customerId = qr.target_id;
        }
        const { data: link } = await admin.from("customer_account_links").select("customer_id,auth_user_id,login_email,account_status").eq("customer_id",customerId).maybeSingle();
        if (link?.account_status === "ACTIVE") identity = {type,id:link.customer_id,uid:link.auth_user_id,email:link.login_email};
      } else {
        const { data: row } = identifier.includes("@")
          ? await admin.from("admins").select("id,auth_user_id,email,username,role,is_active").eq("email",identifier.toLowerCase()).maybeSingle()
          : await admin.from("admins").select("id,auth_user_id,email,username,role,is_active").eq("username",identifier).maybeSingle();
        if (row?.is_active === true) {
          const { data: u } = await admin.auth.admin.getUserById(row.auth_user_id);
          const email = u.user?.email || row.email;
          if (email) identity = {type,id:row.id,uid:row.auth_user_id,email,role:row.role};
        }
      }
      if (!identity) return reply(401,{ok:false,error:"BIOMETRIC_UNAVAILABLE"});
      const {data: cred} = await admin.from("account_biometric_credentials").select("id").eq("account_type",type).eq("subject_id",identity.id).eq("auth_user_id",identity.uid).is("revoked_at",null).maybeSingle();
      if (!cred) return reply(401,{ok:false,error:"BIOMETRIC_UNAVAILABLE"});
      const c = await createChallenge(identity,"login",cred.id);
      return c ? reply(200,{ok:true,...c,credentialId:cred.id,accountType:type,requiresBin:type === "admin" && ["SUPER_ADMIN","Super Admin"].includes(String(identity.role))}) : reply(503,{ok:false,error:"CHALLENGE_UNAVAILABLE"});
    }
    if (action === "login-verify") {
      const challengeId = normalize(input.challengeId,64);
      const credentialId = normalize(input.credentialId,64);
      const signature = normalize(input.signature,2048);
      if (!challengeId || !credentialId || !signature) return reply(400,{ok:false,error:"INVALID_REQUEST"});
      const consumed = await consumeAndVerify(challengeId,signature,"login");
      if (!consumed || consumed.challenge.credential_id !== credentialId) return reply(401,{ok:false,error:"BIOMETRIC_PROOF_INVALID"});
      const {data: cred} = await admin.from("account_biometric_credentials").select("*").eq("id",credentialId)
        .eq("account_type",consumed.challenge.account_type).eq("subject_id",consumed.challenge.subject_id)
        .eq("auth_user_id",consumed.challenge.auth_user_id).is("revoked_at",null).maybeSingle();
      if (!cred || !(await verifySignature(cred.public_key_spki,consumed.challenge.challenge,signature))) return reply(401,{ok:false,error:"BIOMETRIC_PROOF_INVALID"});
      const {data: identity} = await admin.auth.admin.getUserById(cred.auth_user_id);
      const email = identity.user?.email;
      if (!email || identity.user?.banned_until && new Date(identity.user.banned_until).getTime()>Date.now()) return reply(401,{ok:false,error:"ACCOUNT_UNAVAILABLE"});
      const {data: link} = await admin.auth.admin.generateLink({type:"magiclink",email});
      const tokenHash = link?.properties?.hashed_token;
      if (!tokenHash) return reply(503,{ok:false,error:"BIOMETRIC_SESSION_UNAVAILABLE"});
      const {data: sessionData,error: sessionError} = await auth.auth.verifyOtp({token_hash:tokenHash,type:"magiclink"});
      if (sessionError || !sessionData.session || sessionData.user?.id !== cred.auth_user_id) return reply(401,{ok:false,error:"BIOMETRIC_SESSION_UNAVAILABLE"});
      if (cred.account_type === "customer") {
        const claims = jwtClaims(sessionData.session.access_token);
        const sessionId = normalize(claims?.session_id,64);
        const issuedAt = Number(claims?.iat);
        if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !Number.isSafeInteger(issuedAt)) return reply(503,{ok:false,error:"BIOMETRIC_SESSION_UNAVAILABLE"});
        const expiresAt = new Date(Date.now()+7*24*60*60*1000).toISOString();
        const {data: current} = await admin.from("customer_account_sessions").select("auth_issued_at").eq("customer_id",cred.subject_id).maybeSingle();
        if (current && issuedAt <= Number(current.auth_issued_at)) return reply(401,{ok:false,error:"STALE_BIOMETRIC_SESSION"});
        const {error: regError} = await admin.from("customer_account_sessions").upsert({
          customer_id:cred.subject_id,auth_user_id:cred.auth_user_id,session_id:sessionId,auth_issued_at:issuedAt,
          created_at:new Date().toISOString(),expires_at:expiresAt,revoked_at:null,
        },{onConflict:"customer_id"});
        if (regError) return reply(503,{ok:false,error:"BIOMETRIC_SESSION_UNAVAILABLE"});
      }
      await admin.from("account_biometric_credentials").update({last_used_at:new Date().toISOString()}).eq("id",credentialId);
      return reply(200,{ok:true,session:sessionData.session,accountType:cred.account_type,subjectId:cred.subject_id,session_expires_at:cred.account_type === "customer" ? new Date(Date.now()+7*24*60*60*1000).toISOString() : undefined});
    }
    if (action === "status") {
      const identity = await getAuthenticatedIdentity();
      if (!identity) return reply(401,{ok:false,error:"AUTH_REQUIRED"});
      const {data: cred,error} = await admin.from("account_biometric_credentials").select("id,created_at,last_used_at")
        .eq("account_type",identity.type).eq("subject_id",identity.id).eq("auth_user_id",identity.uid).is("revoked_at",null).maybeSingle();
      if (error) return reply(503,{ok:false,error:"BIOMETRIC_STATUS_UNAVAILABLE"});
      return reply(200,{ok:true,enrolled:Boolean(cred),credentialId:cred?.id||null});
    }
    if (action === "revoke") {
      const identity = await getAuthenticatedIdentity();
      if (!identity) return reply(401,{ok:false,error:"AUTH_REQUIRED"});
      const {error} = await admin.from("account_biometric_credentials").update({revoked_at:new Date().toISOString()})
        .eq("account_type",identity.type).eq("subject_id",identity.id).eq("auth_user_id",identity.uid).is("revoked_at",null);
      return error ? reply(503,{ok:false,error:"BIOMETRIC_REVOCATION_FAILED"}) : reply(200,{ok:true});
    }
    return reply(400,{ok:false,error:"UNKNOWN_ACTION"});
  } catch {
    return reply(503,{ok:false,error:"SERVICE_UNAVAILABLE"});
  }
});
