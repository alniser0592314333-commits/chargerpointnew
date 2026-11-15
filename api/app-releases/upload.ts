
import type { IncomingMessage } from 'node:http';
import { parseReleaseVersion, requireSuperAdmin, sendJson, updateReleasePolicy, type ApiRequest, type ApiResponse, type ReleaseChannel } from '../_lib/appReleaseAuth.js';
import { ensureRelease, releaseAssetName, uploadReleaseAsset } from '../_lib/githubReleases.js';
const MAX_APK_BYTES=4*1024*1024;
async function readBody(req:IncomingMessage):Promise<Buffer>{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=b.length;if(size>MAX_APK_BYTES)throw new Error('APK_TOO_LARGE');chunks.push(b);}return Buffer.concat(chunks,size);}
export const config={api:{bodyParser:false}};
export default async function handler(req:ApiRequest,res:ApiResponse){
 res.setHeader('Cache-Control','no-store, private');
 if(req.method!=='POST'){res.setHeader('Allow','POST');return sendJson(res,405,{error:'METHOD_NOT_ALLOWED'});}
 const auth=await requireSuperAdmin(req);if(!auth.ok)return sendJson(res,auth.status,{error:auth.error});
 const channel=req.headers['x-release-channel'] as ReleaseChannel, version=parseReleaseVersion(req.headers['x-release-version']);
 let notes=String(req.headers['x-release-notes']||'').slice(0,4500);try{notes=decodeURIComponent(notes).slice(0,1500);}catch{return sendJson(res,400,{error:'INVALID_RELEASE_NOTES'});}
 const graceUntil=new Date(String(req.headers['x-release-grace-until']||''));
 if(!['customer','admin'].includes(channel)||!version||!Number.isFinite(graceUntil.getTime())||graceUntil.getTime()<=Date.now())return sendJson(res,400,{error:'INVALID_RELEASE_METADATA'});
 try{
  const file=await readBody(req);if(file.length<1000||file[0]!==0x50||file[1]!==0x4b)return sendJson(res,400,{error:'INVALID_APK_FILE'});
  const tag='v'+version.version, assetName=releaseAssetName(channel,version.version);
  const release=await ensureRelease(tag,'ChargerPoint '+channel+' '+tag,notes||('Signed '+channel+' APK release '+tag));
  const asset=await uploadReleaseAsset(release,assetName,file);
  const policy=await updateReleasePolicy(auth,channel,{latest_version:version.version,version_code:version.code,release_notes:notes,download_url:asset.browser_download_url,grace_until:graceUntil.toISOString()});
  return sendJson(res,200,{success:true,channel,version:version.version,size:file.length,url:asset.browser_download_url,uploadedAt:asset.created_at,policy});
 }catch(error){const m=error instanceof Error?error.message:'';const status=m==='APK_TOO_LARGE'?413:m==='GITHUB_RELEASE_TOKEN_NOT_CONFIGURED'?503:m==='RELEASE_ASSET_ALREADY_EXISTS'||m==='GITHUB_RELEASE_CONFLICT'?409:500;const code=m==='APK_TOO_LARGE'||m==='GITHUB_RELEASE_TOKEN_NOT_CONFIGURED'||m==='RELEASE_ASSET_ALREADY_EXISTS'||m==='GITHUB_RELEASE_TOKEN_INVALID'?m:'RELEASE_UPLOAD_FAILED';return sendJson(res,status,{error:code});}
}
