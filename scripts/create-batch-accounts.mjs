import postgres from 'postgres';

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile('.env.local'); } catch {}
  try { process.loadEnvFile('.env'); } catch {}
}

const DATABASE_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;


const ADMIN_EMAIL = "superadmin@gmail.com";
const ADMIN_PASSWORD = "12345678a";

const VENDOR_PHONE_RAW = "01022437824";
const VENDOR_PHONE_E164 = "+201022437824";
const VENDOR_PASSWORD = "12345678a";

const adminHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json"
};

async function createSuperAdmin(sql) {
  console.log("\n==========================================");
  console.log("1. CREATING SUPER ADMIN:", ADMIN_EMAIL);
  console.log("==========================================");

  // Auth User
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      email_confirm: true,
      user_metadata: { name: "Super Admin", role: "super" }
    })
  });

  let userId;
  if (authRes.ok) {
    const data = await authRes.json();
    userId = data.id;
    console.log("✅ Supabase Auth user created. ID:", userId);
  } else {
    const err = await authRes.json();
    console.log("Auth user notice:", err.message || err.msg);

    const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=100`, { headers: adminHeaders });
    const listData = await listRes.json();
    const existing = listData.users?.find(u => u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase());
    if (!existing) throw new Error("Could not find or create auth user");
    userId = existing.id;

    // Update password
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ password: ADMIN_PASSWORD, email_confirm: true })
    });
    console.log("✅ Updated password for existing auth user:", userId);
  }

  // Database Profile
  const [existingAdmin] = await sql`select id from public.admin_users where lower(email) = ${ADMIN_EMAIL.toLowerCase()}`;
  let adminId;
  if (existingAdmin) {
    const [u] = await sql`
      update public.admin_users
      set user_id = ${userId}, role = 'super', status = 'active', name = 'Super Admin', updated_at = now()
      where id = ${existingAdmin.id}
      returning id
    `;
    adminId = u.id;
    console.log("✅ Updated existing admin_users row:", adminId);
  } else {
    const [inserted] = await sql`
      insert into public.admin_users (name, email, role, status, user_id)
      values ('Super Admin', ${ADMIN_EMAIL}, 'super', 'active', ${userId})
      returning id
    `;
    adminId = inserted.id;
    console.log("✅ Inserted new admin_users row:", adminId);
  }

  // Verify Login
  const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  const loginData = await loginRes.json();
  if (!loginRes.ok) throw new Error(`Super Admin login check failed: ${JSON.stringify(loginData)}`);
  console.log("✅ SUPER ADMIN LOGIN VERIFIED! Token received.");

  return { email: ADMIN_EMAIL, userId, adminId };
}

async function createVendor(sql) {
  console.log("\n==========================================");
  console.log("2. CREATING VENDOR OWNER:", VENDOR_PHONE_RAW);
  console.log("==========================================");

  // Auth User
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      phone: VENDOR_PHONE_E164,
      password: VENDOR_PASSWORD,
      phone_confirm: true,
      user_metadata: { name: "مالك مغسلة (Vendor Owner)", role: "owner" }
    })
  });

  let userId;
  if (authRes.ok) {
    const data = await authRes.json();
    userId = data.id;
    console.log("✅ Supabase Auth user created. ID:", userId);
  } else {
    const err = await authRes.json();
    console.log("Auth user notice:", err.message || err.msg);

    const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=100`, { headers: adminHeaders });
    const listData = await listRes.json();
    const existing = listData.users?.find(u => u.phone?.replace(/\D/g, "") === VENDOR_PHONE_E164.replace(/\D/g, ""));
    if (!existing) throw new Error("Could not find or create auth user");
    userId = existing.id;

    // Update password
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ password: VENDOR_PASSWORD, phone_confirm: true })
    });
    console.log("✅ Updated password for existing auth user:", userId);
  }

  // Database Profile
  let staffId, businessId, branchId;
  await sql.begin(async (t) => {
    const [existingStaff] = await t`select id, business_id, branch_id from public.staff where phone = ${VENDOR_PHONE_E164}`;

    if (existingStaff) {
      staffId = existingStaff.id;
      businessId = existingStaff.business_id;
      branchId = existingStaff.branch_id;
      await t`
        update public.staff
        set user_id = ${userId}, role = 'owner', status = 'active', updated_at = now()
        where id = ${staffId}
      `;
      console.log("✅ Updated existing staff row:", staffId);
    } else {
      const bizName = { ar: "مغسلة النصر لخدمات السيارات", en: "Al-Nasr Car Care Wash" };
      const [biz] = await t`
        insert into public.businesses (name, status, commission_rate, rating)
        values (${t.json(bizName)}, 'active', 10 /* commission %, like the platform default (7) */, 5.0)
        returning id
      `;
      businessId = biz.id;

      const branchName = { ar: "فرع مدينة نصر", en: "Nasr City Branch" };
      const address = { ar: "شارع عباس العقاد، مدينة نصر، القاهرة", en: "Abbas El-Akkad St, Nasr City, Cairo" };
      const [branch] = await t`
        insert into public.branches (
          business_id, name, area_id, address, lat, lng, phone, capacity, active, featured,
          auto_confirm, slot_interval_min, lead_time_min, max_advance_days, free_cancel_min,
          no_show_grace_min, reminder_min, rating, review_count
        )
        values (
          ${businessId}, ${t.json(branchName)}, 'nasr', ${t.json(address)}, 30.0561, 31.3412,
          ${VENDOR_PHONE_E164}, 4, true, false,
          false /* manual confirmation, the platform default; the wash can switch it on */, 30, 60, 7, 120,
          15, 60, 5.0, 0
        )
        returning id
      `;
      branchId = branch.id;

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

      const [staff] = await t`
        insert into public.staff (
          user_id, business_id, branch_id, name, phone, role, status, max_discount_pct, permissions
        )
        values (
          ${userId}, ${businessId}, ${branchId}, 'مالك المغسلة (Al-Nasr Owner)', ${VENDOR_PHONE_E164}, 'owner', 'active', 100, ${t.json(ownerPermissions)}
        )
        returning id
      `;
      staffId = staff.id;

      await t`update public.businesses set owner_staff_id = ${staffId} where id = ${businessId}`;

      await t`
        insert into public.business_settings (business_id, contact_phone, contact_email, manager_can_edit_services)
        values (${businessId}, ${VENDOR_PHONE_E164}, 'alnasr.wash@gmail.com', true)
        on conflict (business_id) do update set contact_phone = excluded.contact_phone
      `;

      // Working hours
      for (const d of [0, 1, 2, 3, 4, 5, 6]) {
        await t`
          insert into public.branch_working_hours (branch_id, weekday, opens_at, closes_at, closed)
          values (${branchId}, ${d}, '09:00:00', '23:00:00', false)
          on conflict do nothing
        `;
      }

      // Default wash services
      const services = [
        { name: { ar: "غسيل خارجي", en: "Exterior Wash" }, type: "primary", category: "exterior", price: 120, duration: 25 },
        { name: { ar: "غسيل كامل متكامل", en: "Full Wash" }, type: "primary", category: "full", price: 220, duration: 45 },
        { name: { ar: "تنظيف وتطهير داخلي عميق", en: "Deep Interior Cleaning" }, type: "addon", category: "deep", price: 180, duration: 40 }
      ];
      for (const s of services) {
        await t`
          insert into public.services (branch_id, type, category_id, name, price, duration_min, active)
          values (${branchId}, ${s.type}, ${s.category}, ${t.json(s.name)}, ${s.price}, ${s.duration}, true)
        `;
      }
      console.log("✅ Business, Branch, Staff, and Services created successfully.");
    }
  });

  // Verify Login
  const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: VENDOR_PHONE_E164, password: VENDOR_PASSWORD })
  });
  const loginData = await loginRes.json();
  if (!loginRes.ok) throw new Error(`Vendor login check failed: ${JSON.stringify(loginData)}`);
  console.log("✅ VENDOR LOGIN VERIFIED! Token received.");

  return { phone: VENDOR_PHONE_RAW, userId, staffId, businessId, branchId };
}

async function main() {
  const sql = postgres(DATABASE_URL);
  try {
    const admin = await createSuperAdmin(sql);
    const vendor = await createVendor(sql);

    console.log("\n==========================================");
    console.log("🎉 ALL ACCOUNTS CREATED & VERIFIED SUCCESSFULLY!");
    console.log("==========================================");
    console.log("1. Super Admin:");
    console.log("   - Email:", admin.email);
    console.log("   - Password:", ADMIN_PASSWORD);
    console.log("   - Auth ID:", admin.userId);
    console.log("   - Admin ID:", admin.adminId);
    console.log("2. Vendor Owner:");
    console.log("   - Phone:", vendor.phone);
    console.log("   - Password:", VENDOR_PASSWORD);
    console.log("   - Auth ID:", vendor.userId);
    console.log("   - Staff ID:", vendor.staffId);
    console.log("   - Business ID:", vendor.businessId);
    console.log("   - Branch ID:", vendor.branchId);
  } finally {
    await sql.end();
  }
}

main().catch(err => {
  console.error("❌ Fatal Error:", err);
  process.exit(1);
});
