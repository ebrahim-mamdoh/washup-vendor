import postgres from 'postgres';

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile('.env.local'); } catch {}
  try { process.loadEnvFile('.env'); } catch {}
}

const DATABASE_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const RAW_PHONE = "01012345678";
const E164_PHONE = "+201012345678";
const PASSWORD = "12345678a";
const OWNER_NAME = "حساب فندور تجريبي (Test Vendor)";
const BUSINESS_NAME = { ar: "مغسلة واش اب التجريبية", en: "Washup Test Car Wash" };
const BRANCH_NAME = { ar: "فرع تجريبي - القاهرة", en: "Test Branch - Cairo" };
const ADDRESS = { ar: "شارع التسعين، القاهرة الجديدة", en: "90th St, New Cairo, Cairo" };

async function main() {
  console.log("=== Creating Test Vendor Account ===");
  console.log("Target Phone:", RAW_PHONE, "->", E164_PHONE);
  console.log("Supabase URL:", SUPABASE_URL);

  const adminHeaders = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json"
  };

  // 1. Supabase Auth user creation or update
  console.log("\n1. Provisioning Supabase Auth user...");
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      phone: E164_PHONE,
      password: PASSWORD,
      phone_confirm: true,
      user_metadata: { name: OWNER_NAME, role: "owner" }
    })
  });

  let userId;
  if (authRes.ok) {
    const authData = await authRes.json();
    userId = authData.id;
    console.log("✅ Supabase Auth user created successfully. User ID:", userId);
  } else {
    const err = await authRes.json();
    console.log("User may already exist:", err.message || err.msg || authRes.statusText);

    // Fetch existing user by phone
    const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=100`, {
      headers: adminHeaders
    });
    const listData = await listRes.json();
    const existing = listData.users?.find(
      (u) => u.phone?.replace(/\D/g, "") === E164_PHONE.replace(/\D/g, "")
    );

    if (!existing) {
      throw new Error(`Failed to create or locate Supabase Auth user: ${JSON.stringify(err)}`);
    }

    userId = existing.id;
    console.log("Found existing user ID:", userId);

    console.log("Updating password and ensuring phone_confirm = true...");
    const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        password: PASSWORD,
        phone_confirm: true,
        user_metadata: { name: OWNER_NAME, role: "owner" }
      })
    });

    if (!updateRes.ok) {
      const updateErr = await updateRes.json();
      throw new Error(`Failed to update user password: ${JSON.stringify(updateErr)}`);
    }
    console.log("✅ Password updated successfully.");
  }

  // 2. Database records (Business, Branch, Staff, Working Hours, Services)
  console.log("\n2. Connecting to PostgreSQL database...");
  const sql = postgres(DATABASE_URL);

  await sql.begin(async (t) => {
    // Check if staff row already exists
    const [existingStaff] = await t`
      select id, business_id, branch_id from public.staff where phone = ${E164_PHONE}
    `;

    let businessId;
    let branchId;
    let staffId;

    const ownerPermissions = {
      confirmBooking: true,
      cancelOrder: true,
      closeShift: true,
      editServices: true,
      refund: true,
      collectPayment: true,
      runService: true,
      manageStaff: true
    };

    if (existingStaff) {
      console.log("Staff record already exists with ID:", existingStaff.id);
      staffId = existingStaff.id;
      businessId = existingStaff.business_id;
      branchId = existingStaff.branch_id;

      await t`
        update public.staff
        set user_id = ${userId},
            role = 'owner',
            status = 'active',
            name = ${OWNER_NAME},
            permissions = ${t.json(ownerPermissions)},
            max_discount_pct = 100,
            updated_at = now()
        where id = ${staffId}
      `;
      console.log("✅ Staff record updated to active owner.");

      // Ensure business is active
      await t`
        update public.businesses
        set status = 'active', status_reason = null, updated_at = now()
        where id = ${businessId}
      `;
      console.log("✅ Business status set to active.");
    } else {
      console.log("Creating new business...");
      const [biz] = await t`
        insert into public.businesses (name, status, status_reason, commission_rate, rating)
        values (${t.json(BUSINESS_NAME)}, 'active', null, 7, 5.0)
        returning id
      `;
      businessId = biz.id;
      console.log("✅ Business created with ID:", businessId);

      // Find an existing area id from public.areas, or default to 'nc'
      const [areaRow] = await t`select id from public.areas limit 1`;
      const areaId = areaRow?.id || 'nc';

      console.log("Creating primary branch with area:", areaId);
      const [branch] = await t`
        insert into public.branches (
          business_id, name, area_id, address, lat, lng, phone, capacity, active, featured,
          auto_confirm, slot_interval_min, lead_time_min, max_advance_days, free_cancel_min,
          no_show_grace_min, reminder_min, rating, review_count
        )
        values (
          ${businessId}, ${t.json(BRANCH_NAME)}, ${areaId}, ${t.json(ADDRESS)}, 30.0131, 31.4289,
          ${E164_PHONE}, 4, true, true,
          false, 30, 60, 7, 120,
          15, 60, 5.0, 0
        )
        returning id
      `;
      branchId = branch.id;
      console.log("✅ Branch created with ID:", branchId);

      console.log("Creating owner staff...");
      const [staff] = await t`
        insert into public.staff (
          user_id, business_id, branch_id, name, phone, role, status, max_discount_pct, permissions
        )
        values (
          ${userId}, ${businessId}, ${branchId}, ${OWNER_NAME}, ${E164_PHONE}, 'owner', 'active', 100, ${t.json(ownerPermissions)}
        )
        returning id
      `;
      staffId = staff.id;
      console.log("✅ Owner staff created with ID:", staffId);

      // Link owner_staff_id back to business
      await t`update public.businesses set owner_staff_id = ${staffId} where id = ${businessId}`;

      // Settings
      await t`
        insert into public.business_settings (business_id, contact_phone, contact_email, manager_can_edit_services)
        values (${businessId}, ${E164_PHONE}, 'test-vendor@carzen.app', true)
        on conflict (business_id) do update set contact_phone = excluded.contact_phone
      `;

      // Branch working hours (every day 09:00 - 23:00)
      const days = [0, 1, 2, 3, 4, 5, 6];
      for (const d of days) {
        await t`
          insert into public.branch_working_hours (branch_id, weekday, opens_at, closes_at, closed)
          values (${branchId}, ${d}, '09:00:00', '23:00:00', false)
          on conflict do nothing
        `;
      }

      // Sample services
      const sampleServices = [
        { name: { ar: "غسيل خارجي سريع", en: "Quick Exterior Wash" }, type: "primary", category: "exterior", price: 100, duration: 25 },
        { name: { ar: "غسيل كامل (داخلي وخارجي)", en: "Full Wash (Interior & Exterior)" }, type: "primary", category: "full", price: 200, duration: 45 },
        { name: { ar: "تلميع واكس وحماية", en: "Wax & Polish" }, type: "addon", category: "deep", price: 150, duration: 30 }
      ];

      for (const s of sampleServices) {
        await t`
          insert into public.services (branch_id, type, category_id, name, price, duration_min, active)
          values (${branchId}, ${s.type}, ${s.category}, ${t.json(s.name)}, ${s.price}, ${s.duration}, true)
        `;
      }
      console.log("✅ Working hours and default services created.");
    }
  });

  // 3. Supabase Auth Direct Verification
  console.log("\n3. Testing direct Supabase Auth password grant...");
  const authVerifyRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: PUBLISHABLE_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      phone: E164_PHONE,
      password: PASSWORD
    })
  });

  const authVerifyData = await authVerifyRes.json();
  if (!authVerifyRes.ok) {
    console.error("❌ Supabase Auth password test failed:", authVerifyData);
    throw new Error(`Direct auth failed: ${JSON.stringify(authVerifyData)}`);
  }
  console.log("✅ Supabase Auth password grant verified successfully!");
  console.log("User ID:", authVerifyData.user?.id);
  console.log("Access Token received:", !!authVerifyData.access_token);

  // 4. Query staff and business status from DB
  const [profile] = await sql`
    select st.id as staff_id, st.name as staff_name, st.phone, st.role, st.status,
           b.id as business_id, b.name as business_name, b.status as business_status,
           br.id as branch_id, br.name as branch_name
    from public.staff st
    join public.businesses b on b.id = st.business_id
    left join public.branches br on br.id = st.branch_id
    where st.user_id = ${userId}
  `;

  console.log("\n✅ Vendor Profile In Database:");
  console.dir(profile, { depth: null });

  await sql.end();
  console.log("\n🎉 ALL STEPS COMPLETED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
