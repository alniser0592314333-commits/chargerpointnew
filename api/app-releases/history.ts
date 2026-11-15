
import type { ApiRequest, ApiResponse, ReleaseChannel } from '../_lib/appReleaseAuth.js';
import { requireSuperAdmin, sendJson } from '../_lib/appReleaseAuth.js';
import { listChannelReleases } from '../_lib/githubReleases.js';
export default async function handler(req:ApiRequest,res:ApiResponse){
 res.setHeader('Cache-Control','no-store, private');
 if(req.method!=='GET'){res.setHeader('Allow','GET');return sendJson(res,405,{error:'METHOD_NOT_ALLOWED'});}
 const auth=await requireSuperAdmin(req);if(!auth.ok)return sendJson(res,auth.status,{error:auth.error});
 const channel=new URL(req.url||'/','https://internal.invalid').searchParams.get('channel') as ReleaseChannel|null;
 if(channel!=='customer'&&channel!=='admin')return sendJson(res,400,{error:'INVALID_CHANNEL'});
 try{return sendJson(res,200,{releases:await listChannelReleases(channel)});}catch(error){const m=error instanceof Error?error.message:'';return sendJson(res,m==='GITHUB_RELEASE_TOKEN_NOT_CONFIGURED'?503:500,{error:m==='GITHUB_RELEASE_TOKEN_NOT_CONFIGURED'?m:'RELEASE_HISTORY_UNAVAILABLE'});}
}
