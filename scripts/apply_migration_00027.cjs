const https = require('https');
const ref = process.env.SUPABASE_PROJECT_REF;
if (!ref) { throw new Error('Missing SUPABASE_PROJECT_REF'); }
const token = process.env.SUPABASE_ACCESS_TOKEN;

async function runQuery(query) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query });
    const req = https.request({
      hostname: "api.supabase.com",
      path: `/v1/projects/${ref}/database/query`,
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function main() {
  try {
    const sql = "NOTIFY pgrst, 'reload schema';";
    const res = await runQuery(sql);
    console.log("Migration 00027 application result:", res);
  } catch (err) {
    console.error("Error applying migration:", err);
    process.exit(1);
  }
}
main();
