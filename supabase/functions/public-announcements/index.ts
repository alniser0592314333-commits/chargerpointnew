import { createClient } from "npm:@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store, max-age=0"};
const json=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:cors});
const now=()=>new Date().toISOString();
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="GET"&&req.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!key)return json({error:"SERVER_NOT_CONFIGURED"},500);
 const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 if(req.method==="GET"&&new URL(req.url).searchParams.get("admin")!=="1"){
  const {data,error}=await db.from("public_announcements").select("id,title,body,image_url,starts_at,ends_at").eq("is_enabled",true).lte("starts_at",now()).gt("ends_at",now()).order("starts_at",{ascending:false}).limit(12);
  if(error)return json({error:"ANNOUNCEMENTS_READ_FAILED"},500);
  return json({announcements:data||[]});
 }
 const token=(req.headers.get("Authorization")||"").match(/^Bearer\s+(.+)$/i)?.[1];
 if(!token)return json({error:"ADMIN_AUTH_REQUIRED"},401);
 const {data:auth,error:authError}=await db.auth.getUser(token);
 if(authError||!auth.user)return json({error:"ADMIN_AUTH_REQUIRED"},401);
 const {data:admin}=await db.from("admins").select("id,role,permissions,is_active,disabled_at").eq("auth_user_id",auth.user.id).maybeSingle();
 if(!admin||!admin.is_active||admin.disabled_at)return json({error:"SETTINGS_PERMISSION_DENIED"},403);
 let allowed=admin.role==="SUPER_ADMIN"||(Array.isArray(admin.permissions)&&admin.permissions.includes("settings:manage"));
 if(!allowed){
  const {data:custom}=await db.from("admin_custom_permissions").select("is_grant").eq("admin_id",admin.id).eq("permission","settings:manage").maybeSingle();
  if(custom)allowed=custom.is_grant===true;
  else{const {data:rp}=await db.from("role_permissions").select("permission").eq("role",admin.role).eq("permission","settings:manage").maybeSingle();allowed=Boolean(rp);}
 }
 if(!allowed)return json({error:"SETTINGS_PERMISSION_DENIED"},403);
 if(req.method==="GET"){
  const {data,error}=await db.from("public_announcements").select("id,title,body,image_url,starts_at,ends_at,is_enabled").order("starts_at",{ascending:false}).limit(100);
  if(error)return json({error:"ANNOUNCEMENTS_READ_FAILED"},500);
  return json({announcements:data||[]});
 }
 let input:any;try{input=await req.json();}catch{return json({error:"INVALID_JSON"},400);}
 if(input.action==="delete"){
  if(typeof input.id!=="string")return json({error:"INVALID_ID"},400);
  const {data:old}=await db.from("public_announcements").select("image_url").eq("id",input.id).maybeSingle();
  const {error}=await db.from("public_announcements").delete().eq("id",input.id);
  if(error)return json({error:"ANNOUNCEMENT_DELETE_FAILED"},500);
  if(old?.image_url){const marker="/storage/v1/object/public/public-announcements/",path=old.image_url.split(marker)[1];if(path)await db.storage.from("public-announcements").remove([decodeURIComponent(path)]);}
  return json({ok:true});
 }
 if(input.action!=="save")return json({error:"INVALID_ACTION"},400);
 const title=typeof input.title==="string"?input.title.trim().slice(0,160):"",body=typeof input.body==="string"?input.body.trim().slice(0,3000):"";
 const start=new Date(input.startsAt),end=new Date(input.endsAt);
 if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)return json({error:"INVALID_SCHEDULE"},400);
 if(!body&&!input.imageBase64&&!input.existingImageUrl)return json({error:"ANNOUNCEMENT_CONTENT_REQUIRED"},400);
 let imageUrl=typeof input.existingImageUrl==="string"?input.existingImageUrl:null;
 if(input.imageBase64){
  if(typeof input.imageBase64!=="string"||input.imageBase64.length>7000000)return json({error:"IMAGE_TOO_LARGE"},413);
  const match=input.imageBase64.match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/);
  if(!match)return json({error:"INVALID_IMAGE"},400);
  const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));
  if(bytes.length>5*1024*1024)return json({error:"IMAGE_TOO_LARGE"},413);
  const ext=match[1]==="image/jpeg"?"jpg":match[1].split("/")[1],path=`${crypto.randomUUID()}.${ext}`;
  const {error}=await db.storage.from("public-announcements").upload(path,bytes,{contentType:match[1],upsert:false,cacheControl:"3600"});
  if(error)return json({error:"IMAGE_UPLOAD_FAILED"},500);
  imageUrl=db.storage.from("public-announcements").getPublicUrl(path).data.publicUrl;
 }
 const record={title,body,image_url:imageUrl,starts_at:start.toISOString(),ends_at:end.toISOString(),is_enabled:input.enabled!==false,updated_at:now(),created_by:auth.user.id};
 let saved;
 if(typeof input.id==="string"&&input.id){const {data,error}=await db.from("public_announcements").update(record).eq("id",input.id).select("id,title,body,image_url,starts_at,ends_at,is_enabled").single();if(error)return json({error:"ANNOUNCEMENT_UPDATE_FAILED"},500);saved=data;}
 else{const {data,error}=await db.from("public_announcements").insert(record).select("id,title,body,image_url,starts_at,ends_at,is_enabled").single();if(error)return json({error:"ANNOUNCEMENT_CREATE_FAILED"},500);saved=data;}
 return json({ok:true,announcement:saved});
});