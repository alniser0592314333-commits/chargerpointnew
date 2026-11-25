import { createClient } from "npm:@supabase/supabase-js@2";
const MAX_BODY_BYTES=24*1024;
const headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store"};
const respond=(status:number,body:Record<string,unknown>)=>new Response(JSON.stringify(body),{status,headers});
const safeText=(v:unknown,max:number)=>typeof v==="string"&&v.length<=max?v.trim():"";
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers});
 if(req.method!=="POST")return respond(405,{ok:false,error:"METHOD_NOT_ALLOWED"});
 const url=Deno.env.get("SUPABASE_URL")||"",serviceKey=Deno.env.get("auth_supabase_secret_key")||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",anonKey=Deno.env.get("SUPABASE_ANON_KEY")||Deno.env.get("SUPABASE_PUBLISHABLE_KEY")||"";
 if(!url||!serviceKey||!anonKey)return respond(503,{ok:false,error:"SERVICE_UNAVAILABLE"});
 const bearer=req.headers.get("authorization")?.replace(/^Bearer\s+/i,"").trim()||"";
 if(!bearer||bearer===anonKey)return respond(401,{ok:false,error:"ADMIN_SESSION_UNAVAILABLE"});
 const declared=Number(req.headers.get("content-length")||0);if(declared>MAX_BODY_BYTES)return respond(400,{ok:false,error:"REQUEST_TOO_LARGE"});
 const raw=await req.text();if(new TextEncoder().encode(raw).byteLength>MAX_BODY_BYTES)return respond(400,{ok:false,error:"REQUEST_TOO_LARGE"});
 let body:Record<string,unknown>;try{const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw 0;body=parsed;}catch{return respond(400,{ok:false,error:"INVALID_REQUEST"});}
 const text=safeText(body.text,20000);if(!text)return respond(400,{ok:false,error:"TEXT_REQUIRED"});
 const history=Array.isArray(body.history)?body.history.slice(-20):[];const contents: Array<{role:"user"|"model";parts:Array<{text:string}>}> = [];for(const item of history){if(!item||typeof item!=="object"||!["user","assistant"].includes(item.role)||typeof item.text!=="string"||item.text.length>20000)return respond(400,{ok:false,error:"INVALID_HISTORY"});contents.push({role:item.role==="assistant"?"model":"user",parts:[{text:item.text}]});}contents.push({role:"user",parts:[{text}]});
 const caller=createClient(url,anonKey,{global:{headers:{Authorization:`Bearer ${bearer}`}},auth:{persistSession:false,autoRefreshToken:false}});
 const {data:userData,error:userError}=await caller.auth.getUser(bearer);if(userError||!userData.user)return respond(401,{ok:false,error:"ADMIN_SESSION_UNAVAILABLE"});
 const {data:profile,error:profileError}=await caller.rpc("get_current_admin_profile");
 if(profileError||!profile||profile.authenticated!==true||profile.is_admin!==true||profile.is_active===false||profile.auth_user_id!==userData.user.id)return respond(401,{ok:false,error:"ADMIN_SESSION_UNAVAILABLE"});
 const perms=Array.isArray(profile.permissions)?profile.permissions:[];
 const role=String(profile.role||"").toUpperCase().replace(/\s+/g,"_");
 if(role!=="SUPER_ADMIN"&&!perms.includes("ai:use"))return respond(403,{ok:false,error:"AI_USE_PERMISSION_REQUIRED"});
 const admin=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:configRow,error:cfgErr}=await admin.from("sarah_ai_provider_config").select("provider_id,model_id,generation_config,enabled").eq("id","default").maybeSingle();
 if(cfgErr||!configRow||configRow.enabled!==true||configRow.provider_id!=="gemini")return respond(503,{ok:false,error:"AI_PROVIDER_NOT_CONFIGURED"});
 const {data:key,error:keyErr}=await admin.rpc("sarah_ai_get_provider_secret");if(keyErr||typeof key!=="string"||!key)return respond(503,{ok:false,error:"PROVIDER_CREDENTIAL_UNAVAILABLE"});
 const generation=configRow.generation_config||{},timeout=Math.min(Math.max(Number(generation.timeoutMs||30000),5000),120000);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 try{
  const resp=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(configRow.model_id)}:generateContent`,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},signal:controller.signal,body:JSON.stringify({systemInstruction:{parts:[{text:"You are Sarah, the Arabic-first assistant for ChargerPointNew. Respond helpfully, accurately, and clearly. You cannot access or change app data or execute operations in this version. Do not claim that you performed actions or inspected application records."}]},contents,generationConfig:{temperature:generation.temperature??0.2,maxOutputTokens:generation.maxOutputTokens??2048}})});
  if(!resp.ok){const status=resp.status;return respond(status===429?429:status>=500?503:400,{ok:false,error:status===429?"GEMINI_QUOTA_OR_RATE_LIMIT":status>=500?"GEMINI_PROVIDER_UNAVAILABLE":"GEMINI_REQUEST_REJECTED"});}
  const result=await resp.json(),answer=Array.isArray(result?.candidates?.[0]?.content?.parts)?result.candidates[0].content.parts.map((p:Record<string,unknown>)=>typeof p.text==="string"?p.text:"").join(""):"";
  if(!answer.trim())return respond(502,{ok:false,error:"AI_EMPTY_RESPONSE"});
  return respond(200,{ok:true,answer,modelId:configRow.model_id});
 }catch(e){return respond(503,{ok:false,error:e instanceof DOMException&&e.name==="AbortError"?"AI_REQUEST_TIMEOUT":"AI_PROVIDER_UNAVAILABLE"});}finally{clearTimeout(timer);}
});