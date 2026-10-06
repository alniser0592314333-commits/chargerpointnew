const token = process.env.SUPABASE_ACCESS_TOKEN;
const project = process.env.SUPABASE_PROJECT_REF;
if (!project) { throw new Error('Missing SUPABASE_PROJECT_REF'); }

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query: sql })
  });
  const data = await res.json();
  return data;
}

module.exports = { query };
