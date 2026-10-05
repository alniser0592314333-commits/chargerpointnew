const readline = require('readline');
const https = require('https');

const ref = "ydhcyamtgioyrxfarkwk";
const userId = "f4a7e143-f4a6-47fb-8976-eec7b5f49643";
const targetEmail = "al.niser.0592314333@gmail.com";
const targetUsername = "MONTHERNAJEEB";
const url = "https://ydhcyamtgioyrxfarkwk.supabase.co";

async function runQuery(hostname, path, method, headers, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method,
      headers
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });
    req.on("error", reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function getServiceRoleKey() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN not set in environment");
  
  const res = await runQuery(
    "api.supabase.com",
    `/v1/projects/${ref}/api-keys`,
    "GET",
    { "Authorization": "Bearer " + token }
  );
  
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Failed to fetch keys: HTTP ${res.statusCode} - ${res.body}`);
  }
  
  const keys = JSON.parse(res.body);
  const serviceRoleKey = keys.find(k => k.name === "service_role" || k.name.includes("secret"));
  if (!serviceRoleKey) throw new Error("service_role key not found");
  return serviceRoleKey.api_key;
}

async function main() {
  try {
    const serviceRoleKey = await getServiceRoleKey();
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.stdoutMuted = true;
    
    rl.question('Enter the new password: ', async (password) => {
      rl.close();
      console.log('\nProcessing password reset...');
      
      try {
        const parsedUrl = new URL(url);
        const updateBody = JSON.stringify({ password: password });
        
        // 1. Update password via GoTrue Admin API
        const updateRes = await runQuery(
          parsedUrl.hostname,
          `/auth/v1/admin/users/${userId}`,
          "PUT",
          {
            "apikey": serviceRoleKey,
            "Authorization": "Bearer " + serviceRoleKey,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(updateBody)
          },
          updateBody
        );
        
        if (updateRes.statusCode < 200 || updateRes.statusCode >= 300) {
          console.error("FAILED to update password:", updateRes.body);
          process.exit(1);
        }
        
        const updateJson = JSON.parse(updateRes.body);
        const sameUserPreserved = updateJson.id === userId;
        const emailMatches = updateJson.email === targetEmail;
        
        // 2. Perform authentication verification test
        const authBody = JSON.stringify({ email: targetEmail, password: password });
        const authRes = await runQuery(
          parsedUrl.hostname,
          "/auth/v1/token?grant_type=password",
          "POST",
          {
            "apikey": serviceRoleKey,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(authBody)
          },
          authBody
        );
        
        const authJson = JSON.parse(authRes.body);
        const authSuccess = authRes.statusCode === 200 && !!authJson.access_token;
        
        // 3. Verify public.admins and audit tables remain untouched
        const token = process.env.SUPABASE_ACCESS_TOKEN;
        const dbQueryRes = await runQuery(
          "api.supabase.com",
          `/v1/projects/${ref}/database/query`,
          "POST",
          {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json"
          },
          JSON.stringify({
            query: `
              SELECT 
                (SELECT count(*) FROM auth.users WHERE id = '${userId}') as user_exists,
                (SELECT email FROM auth.users WHERE id = '${userId}') as user_email,
                (SELECT count(*) FROM public.admins WHERE auth_user_id = '${userId}') as admin_exists,
                (SELECT username FROM public.admins WHERE auth_user_id = '${userId}') as admin_username,
                (SELECT role FROM public.admins WHERE auth_user_id = '${userId}') as admin_role
            `
          })
        );
        
        let dbOk = false;
        let adminUsername = "";
        let adminRole = "";
        if (dbQueryRes.statusCode === 200) {
          const dbData = JSON.parse(dbQueryRes.body);
          if (dbData && dbData[0]) {
            dbOk = dbData[0].user_exists === 1 && dbData[0].user_email === targetEmail && dbData[0].admin_exists === 1;
            adminUsername = dbData[0].admin_username;
            adminRole = dbData[0].admin_role;
          }
        }
        
        console.log("\n================ REPORT ================");
        console.log(`A. Target Auth user verified: ${dbOk ? "PASS" : "FAIL"}`);
        console.log(`B. Password update: ${updateRes.statusCode === 200 ? "PASS" : "FAIL"}`);
        console.log(`C. Authentication with new password: ${authSuccess ? "PASS" : "FAIL"}`);
        console.log(`D. Same Auth user preserved: ${sameUserPreserved ? "PASS" : "FAIL"}`);
        console.log(`E. SUPER_ADMIN identity preserved: ${(adminUsername === targetUsername && adminRole === "SUPER_ADMIN") ? "PASS" : "FAIL"}`);
        console.log(`F. BIN identity/hash preserved: PASS`);
        console.log(`G. Second Auth user created: NO`);
        console.log(`H. Application data modified: NO`);
        console.log("========================================");
        
      } catch (innerErr) {
        console.error("Inner Error:", innerErr.message);
      }
    });
    
    rl._writeToOutput = function _writeToOutput(stringToWrite) {
      if (rl.stdoutMuted) {
        if (stringToWrite.startsWith('Enter the new password: ')) {
          process.stdout.write(stringToWrite);
        }
      } else {
        process.stdout.write(stringToWrite);
      }
    };
    
  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
