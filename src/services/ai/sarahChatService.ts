import { config } from "../../config/env";
import { getFreshSupabaseAuthToken } from "../supabase/client";
export interface SarahChatResponse { answer:string; modelId:string }
const endpoint=()=>{if(!config.supabaseUrl||!config.supabaseAnonKey)throw new Error("SUPABASE_NOT_CONFIGURED");return `${config.supabaseUrl.replace(/\/+$/,"")}/functions/v1/sarah-ai-chat`;};
export const sarahChatService={
 async send(text:string,history:{role:'user'|'assistant';text:string}[]=[]):Promise<SarahChatResponse>{
  const clean=text.trim();if(!clean)throw new Error("TEXT_REQUIRED");if(clean.length>20000)throw new Error("TEXT_TOO_LARGE");
  const session=await getFreshSupabaseAuthToken();if(!session.token)throw new Error(session.reason||"AUTH_SESSION_REQUIRED");
  let response:Response;try{response=await fetch(endpoint(),{method:"POST",headers:{apikey:config.supabaseAnonKey,Authorization:`Bearer ${session.token}`,"Content-Type":"application/json"},body:JSON.stringify({text:clean,history:history.slice(-20)}),cache:"no-store"});}catch{throw new Error("AI_SETTINGS_NETWORK_ERROR");}
  let data:Record<string,unknown>;try{data=await response.json();}catch{throw new Error("AI_SETTINGS_INVALID_RESPONSE");}
  if(!response.ok||data.ok!==true)throw new Error(typeof data.error==="string"?data.error:"AI_REQUEST_FAILED");
  if(typeof data.answer!=="string"||typeof data.modelId!=="string")throw new Error("AI_SETTINGS_INVALID_RESPONSE");
  return {answer:data.answer,modelId:data.modelId};
 }
};