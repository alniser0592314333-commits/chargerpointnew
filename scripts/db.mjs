export const token = process.env.SUPABASE_ACCESS_TOKEN;
export const project = "ydhcyamtgioyrxfarkwk";

export async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query: sql })
  });
  const data = await res.json();
  if (data.error || data.message) {
    throw new Error(data.error || data.message);
  }
  return data;
}
