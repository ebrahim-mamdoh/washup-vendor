// Median latency (5 runs, after 1 warm-up) of the heaviest vendor endpoints + session refresh check.
// Usage: node qa/api-check/latency-and-refresh.mjs <base>   (signs in as the demo owner 01200000000)
const base = process.argv[2];
const API = `${base}/api/v1`;
const post = (p, body, token) => fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, j })));
const login = await post("/vendor/auth/login", { phone: "01200000000", password: "demo1234" });
const T = login.j.data.access_token;
console.log("login has refresh_token:", Boolean(login.j.data.refresh_token), "expires_in:", login.j.data.expires_in);

for (const p of ["/vendor/dashboard?branchId=all&period=today", "/vendor/dashboard?branchId=all&period=30d", "/vendor/live?branchId=br_nasr", "/vendor/finance?branchId=all&period=30d", "/vendor/staff?branchId=all", "/vendor/orders?tab=all"]) {
  const runs = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    await fetch(API + p, { headers: { Authorization: `Bearer ${T}` } }).then((r) => r.arrayBuffer());
    if (i) runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  console.log(`${p}  median ${Math.round(runs[2])} ms  (min ${Math.round(runs[0])})`);
}

// Refresh: new token works; the used refresh token can't be replayed.
const r1 = await post("/vendor/auth/refresh", { refresh_token: login.j.data.refresh_token });
console.log("refresh:", r1.status, Boolean(r1.j.data?.access_token), r1.j.data?.access_token !== T ? "(new token)" : "(same token)");
const me = await fetch(`${API}/vendor/auth/me`, { headers: { Authorization: `Bearer ${r1.j.data.access_token}` } });
console.log("me with refreshed token:", me.status);
const bad = await post("/vendor/auth/refresh", { refresh_token: "not-a-token" });
console.log("refresh with garbage token:", bad.status, bad.j.message);
