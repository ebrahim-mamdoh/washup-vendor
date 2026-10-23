if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile('.env.local'); } catch {}
  try { process.loadEnvFile('.env'); } catch {}
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;


const EMAIL = "washup.eg@gmail.com";
const PASSWORD = "washup@2026";
const NAME = "Washup Super Admin";
const ROLE = "super";

async function main() {
  console.log("=== Creating Super Admin Account ===");
  console.log("Project:", SUPABASE_URL);
  console.log("Email:", EMAIL);
  console.log("Role:", ROLE);

  const adminHeaders = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json"
  };

  // 1. Create or get user in Supabase Auth
  console.log("\n1. Creating user in Supabase Auth...");
  const createAuthRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { name: NAME, role: ROLE }
    })
  });

  let userId;
  if (createAuthRes.ok) {
    const authUser = await createAuthRes.json();
    userId = authUser.id;
    console.log("✅ Supabase Auth user created successfully. ID:", userId);
  } else {
    const err = await createAuthRes.json();
    console.log("Notice from Auth creation:", createAuthRes.status, err.message || err.msg);

    // If already exists, retrieve existing user id and update password
    const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=100`, {
      headers: adminHeaders
    });
    const listData = await listRes.json();
    const existing = listData.users?.find(u => u.email?.toLowerCase() === EMAIL.toLowerCase());
    
    if (!existing) {
      throw new Error(`Failed to create Auth user: ${JSON.stringify(err)}`);
    }

    userId = existing.id;
    console.log("User already exists in Supabase Auth. ID:", userId);

    // Update password and email_confirm
    console.log("Updating password and confirming email...");
    const updateAuthRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { name: NAME, role: ROLE }
      })
    });
    console.log("Password update status:", updateAuthRes.status);
  }

  // 2. Check public.admin_users for existing row
  console.log("\n2. Checking public.admin_users table for", EMAIL);
  const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/admin_users?email=eq.${encodeURIComponent(EMAIL)}&select=*`, {
    headers: adminHeaders
  });
  const existingRows = await checkRes.json();

  if (Array.isArray(existingRows) && existingRows.length > 0) {
    const existingProfile = existingRows[0];
    console.log("Found existing admin profile. Updating ID:", existingProfile.id);

    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/admin_users?id=eq.${encodeURIComponent(existingProfile.id)}`, {
      method: "PATCH",
      headers: {
        ...adminHeaders,
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        user_id: userId,
        name: NAME,
        role: ROLE,
        status: "active",
        updated_at: new Date().toISOString()
      })
    });
    const updated = await updateRes.json();
    console.log("✅ Updated admin profile:", updated);
  } else {
    console.log("Inserting new row into public.admin_users...");
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/admin_users`, {
      method: "POST",
      headers: {
        ...adminHeaders,
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        user_id: userId,
        name: NAME,
        email: EMAIL,
        role: ROLE,
        status: "active"
      })
    });
    if (!insertRes.ok) {
      const txt = await insertRes.text();
      throw new Error(`Failed to insert into admin_users: ${insertRes.status} ${txt}`);
    }
    const inserted = await insertRes.json();
    console.log("✅ Inserted admin profile:", inserted);
  }

  // 3. Test SuperAdmin Login via password grant
  console.log("\n3. Testing Super Admin login via password grant...");
  const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: PUBLISHABLE_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD
    })
  });

  const loginData = await loginRes.json();
  if (!loginRes.ok) {
    throw new Error(`Login verification failed: ${JSON.stringify(loginData)}`);
  }

  console.log("✅ LOGIN SUCCESSFUL!");
  console.log("Access Token received:", loginData.access_token ? "Yes (valid JWT)" : "No");
  console.log("User email:", loginData.user?.email);
  console.log("User ID:", loginData.user?.id);
  console.log("\n🎉 Super Admin account is ready to use!");
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
