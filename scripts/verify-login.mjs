async function testLogin(baseUrl) {
  const url = `${baseUrl}/api/v1/vendor/auth/login`;
  console.log(`\nTesting login at: ${url}`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "01012345678", password: "12345678a" })
    });
    console.log("Status:", res.status);
    const data = await res.json();
    console.log("Response JSON:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Fetch failed:", err.message);
  }
}

async function main() {
  await testLogin("https://washup-vendor.vercel.app");
  await testLogin("http://localhost:3000");
}

main();
