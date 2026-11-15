
import type { ApiRequest, ApiResponse, ReleaseChannel } from '../_lib/appReleaseAuth.js';
import { parseReleaseVersion, requireSuperAdmin, sendJson, updateReleasePolicy } from '../_lib/appReleaseAuth.js';
import { findChannelAsset } from '../_lib/githubReleases.js';
export default async function handler(req:ApiRequest,res:ApiResponse){
 res.setHeader('Cache-Control','no-store, private');
 if(req.method!=='POST'){res.setHeader('Allow','POST');return sendJson(res,405,{error:'METHOD_NOT_ALLOWED'});}
 const auth=await requireSuperAdmin(req);if(!auth.ok)return sendJson(res,auth.status,{error:auth.error});
 const body=req.body as {channel?:ReleaseChannel;url?:string}|undefined,channel=body?.channel;
 if((channel!=='customer'&&channel!=='admin')||typeof body?.url!=='string')return sendJson(res,400,{error:'INVALID_RESTORE_REQUEST'});
 try{
  const target=new URL(body.url),match=target.pathname.match(/^\/alniser0592314333-commits\/chargerpointnew\/releases\/download\/v([^/]+)\/([^/]+)$/);
  if(target.protocol!=='https:'||target.hostname!=='github.com'||!match||match[2]!==('ChargerPoint-'+channel+'-v'+match[1]+'.apk'))return sendJson(res,400,{error:'INVALID_GITHUB_RELEASE_URL'});
  const version=parseReleaseVersion(match[1]);if(!version)return sendJson(res,400,{error:'INVALID_RELEASE_VERSION'});
  const found=await findChannelAsset(channel,version.version,body.url);if(!found)return sendJson(res,404,{error:'RELEASE_NOT_FOUND'});
  const policy=await updateReleasePolicy(auth,channel,{latest_version:version.version,version_code:version.code,release_notes:'تمت استعادة الإصدار '+version.version,download_url:body.url,grace_until:new Date(Date.now()+7*24*60*60*1000).toISOString()});
  return sendJson(res,200,{success:true,policy});
 }catch(error){const m=error instanceof Error?error.message:'';return sendJson(res,m==='GITHUB_RELEASE_TOKEN_NOT_CONFIGURED'?503:500,{error:m==='GITHUB_RELEASE_TOKEN_NOT_CONFIGURED'?m:'RELEASE_RESTORE_FAILED'});}
}
