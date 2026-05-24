async function trigger() {
  try {
    const res = await fetch("http://localhost:3000/api/execute-test-trade", { method: "POST" });
    const data = await res.json();
    console.log(data);
  } catch (e) {
    console.error(e);
  }
}
trigger();
