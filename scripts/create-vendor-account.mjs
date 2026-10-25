import postgres from 'postgres';

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile('.env.local'); } catch {}
  try { process.loadEnvFile('.env'); } catch {}
}

const DATABASE_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;


const RAW_PHONE = "01068786427";
const E164_PHONE = "+201068786427";
const PASSWORD = "12345678a";
const OWNER_NAME = "مالك مغسلة واش اب (Washup Owner)";
const BUSINESS_NAME = { ar: "مغسلة واش اب", en: "Washup Car Wash" };
const BRANCH_NAME = { ar: "الفرع الرئيسي - التجمع الخامس", en: "Main Branch - New Cairo" };
const ADDRESS = { ar: "شارع التسعين، التجمع الخامس، القاهرة الجديدة", en: "90th St, New Cairo, Cairo" };

async function main() {
  console.log("=== Creating Vendor Owner Account ===");
  console.log("Phone:", RAW_PHONE, "-> E.164:", E164_PHONE);

  const adminHeaders = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json"
  };

  // 1. Supabase Auth user creation
  console.log("\n1. Creating / Getting Supabase Auth user by phone...");
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
    console.log("✅ Supabase Auth user created. User ID:", userId);
  } else {
    const err = await authRes.json();
    console.log("Auth response status:", authRes.status, err.message || err.msg);

    // If exists, find by phone
    const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=100`, {
      headers: adminHeaders
    });
    const listData = await listRes.json();
    const existing = listData.users?.find(u => u.phone?.replace(/\D/g, "") === E164_PHONE.replace(/\D/g, ""));

    if (!existing) {
      throw new Error(`Failed to create/find Auth user: ${JSON.stringify(err)}`);
    }

    userId = existing.id;
    console.log("Found existing user with ID:", userId);

    console.log("Updating password and confirming phone...");
    const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        password: PASSWORD,
        phone_confirm: true,
        user_metadata: { name: OWNER_NAME, role: "owner" }
      })
    });
    console.log("Password update status:", updateRes.status);
  }

  // 2. Database records
  console.log("\n2. Connecting to PostgreSQL database...");
  const sql = postgres(DATABASE_URL);

  await sql.begin(async (t) => {
    // Check if staff already exists with this phone
    const [existingStaff] = await t`select id, business_id, branch_id from public.staff where phone = ${E164_PHONE}`;
    
    let businessId;
    let branchId;
    let staffId;

    if (existingStaff) {
      console.log("Staff already exists. Staff ID:", existingStaff.id);
      staffId = existingStaff.id;
      businessId = existingStaff.business_id;
      branchId = existingStaff.branch_id;

      // Update staff user_id, role, status
      await t`
        update public.staff
        set user_id = ${userId}, role = 'owner', status = 'active', name = ${OWNER_NAME}, updated_at = now()
        where id = ${staffId}
      `;
      console.log("✅ Updated existing staff row.");
    } else {
      console.log("Creating new business...");
      const [biz] = await t`
        insert into public.businesses (name, status, status_reason, commission_rate, rating)
        values (${t.json(BUSINESS_NAME)}, 'active', null, 10 /* commission %, like the platform default (7) */, 5.0)
        returning id
      `;
      businessId = biz.id;
      console.log("✅ Business created. Business ID:", businessId);

      console.log("Creating default branch...");
      const [branch] = await t`
        insert into public.branches (
          business_id, name, area_id, address, lat, lng, phone, capacity, active, featured,
          auto_confirm, slot_interval_min, lead_time_min, max_advance_days, free_cancel_min,
          no_show_grace_min, reminder_min, rating, review_count
        )
        values (
          ${businessId}, ${t.json(BRANCH_NAME)}, 'nc', ${t.json(ADDRESS)}, 30.0131, 31.4289,
          ${E164_PHONE}, 4, true, true,
          false /* manual confirmation, the platform default; the wash can switch it on */, 30, 60, 7, 120,
          15, 60, 5.0, 1
        )
        returning id
      `;
      branchId = branch.id;
      console.log("✅ Branch created. Branch ID:", branchId);

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
      console.log("✅ Owner staff created. Staff ID:", staffId);

      // Link owner_staff_id back to business
      await t`update public.businesses set owner_staff_id = ${staffId} where id = ${businessId}`;

      // Settings
      await t`
        insert into public.business_settings (business_id, contact_phone, contact_email, manager_can_edit_services)
        values (${businessId}, ${E164_PHONE}, 'washup.eg@gmail.com', true)
        on conflict (business_id) do update set contact_phone = excluded.contact_phone
      `;

      // Branch working hours (every day 9 AM to 11 PM)
      const days = [0, 1, 2, 3, 4, 5, 6];
      for (const d of days) {
        await t`
          insert into public.branch_working_hours (branch_id, weekday, opens_at, closes_at, closed)
          values (${branchId}, ${d}, '09:00:00', '23:00:00', false)
          on conflict do nothing
        `;
      }

      // Add default wash services
      const sampleServices = [
        { name: { ar: "غسيل خارجي سريع", en: "Quick Exterior Wash" }, type: "primary", category: "exterior", price: 100, duration: 25 },
        { name: { ar: "غسيل كامل (داخلي وخارجي)", en: "Full Wash (Interior & Exterior)" }, type: "primary", category: "full", price: 200, duration: 45 },
        { name: { ar: "تلميع واكس وحماية", en: "Wax & Shine Protection" }, type: "addon", category: "deep", price: 150, duration: 30 }
      ];

      for (const s of sampleServices) {
        await t`
          insert into public.services (branch_id, type, category_id, name, price, duration_min, active)
          values (${branchId}, ${s.type}, ${s.category}, ${t.json(s.name)}, ${s.price}, ${s.duration}, true)
        `;
      }
      console.log("✅ Added working hours and initial services.");
    }
  });

  // 3. Verify Login
  console.log("\n3. Testing Vendor sign-in via Supabase Auth password grant...");
  const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
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

  const loginData = await loginRes.json();
  if (!loginRes.ok) {
    throw new Error(`Login test failed: ${JSON.stringify(loginData)}`);
  }

  console.log("✅ LOGIN SUCCESSFUL!");
  console.log("Access Token received:", loginData.access_token ? "Yes (valid JWT)" : "No");
  console.log("User Phone:", loginData.user?.phone);
  console.log("User ID:", loginData.user?.id);

  // 4. Verify Vendor Portal DB query
  const [vendorCheck] = await sql`
    select st.id as staff_id, st.name as staff_name, st.role, b.id as business_id, b.name as business_name, br.id as branch_id, br.name as branch_name
    from public.staff st
    join public.businesses b on b.id = st.business_id
    left join public.branches br on br.id = st.branch_id
    where st.user_id = ${userId} and st.status = 'active'
  `;
  console.log("\n✅ Vendor Account Profile in Database:");
  console.log(vendorCheck);

  await sql.end();
  console.log("\n🎉 Vendor owner account created and fully verified!");
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
