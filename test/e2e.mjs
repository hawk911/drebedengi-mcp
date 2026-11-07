// End-to-end test against the public demo account (demo@example.com / demo).
// Creates records and deletes them afterwards.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.js"],
  env: { ...process.env, DREBEDENGI_LOGIN: "demo@example.com", DREBEDENGI_PASSWORD: "demo", DREBEDENGI_API_ID: "demo_api", DREBEDENGI_ENV_FILE: "nonexistent" },
});
const client = new Client({ name: "e2e", version: "1" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));

let failed = 0;
async function call(name, args, check = () => true, expectError = false) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  let data; try { data = JSON.parse(text); } catch { data = text; }
  const good = expectError ? !!r.isError : !r.isError && check(data);
  if (!good) failed++;
  console.log(`${good ? "PASS" : "FAIL"} ${name} ${JSON.stringify(args)} -> ${text.slice(0, 300).replace(/\s+/g, " ")}`);
  return data;
}

await call("get_balance", {}, (d) => d.accounts.length > 0);
await call("list_accounts", {}, (d) => d.length > 0);
await call("list_categories", { kind: "expense" }, (d) => d.some((x) => x.name.includes("/")));
await call("list_categories", { kind: "income" }, (d) => d.length > 0);
await call("list_tags", {}, (d) => d.length > 0);
await call("list_currencies", {}, (d) => d.some((x) => x.is_default));
await call("get_transactions", { period: "this_month", type: "expense", limit: 3 }, (d) => d.transactions.length === 3 && d.transactions[0].category);
await call("get_transactions", { date_from: "2026-10-01", date_to: "2026-10-31", search: "перекресток", limit: 2 }, (d) => d.total >= 0);
await call("get_transactions", { period: "all_time", type: "transfer", limit: 2 }, (d) => d.transactions[0].to_account);
await call("get_report", { period: "this_month", group_by: "category" }, (d) => d.rows.length > 0);
await call("get_report", { period: "this_year", group_by: "source", average: "month", currency: "RUB" }, (d) => d.rows.length > 0);

// writes
const exp = await call("add_expense", { amount: 123.45, category: "еда", account: "Сбербанк", comment: "MCP e2e" }, (d) => d.amount === -123.45);
await call("update_transaction", { id: exp.id, amount: 200, comment: "MCP e2e upd" }, (d) => d.after.amount === -200 && d.after.comment === "MCP e2e upd");
await call("delete_transaction", { id: exp.id }, (d) => d.deleted.id === exp.id);
const inc = await call("add_income", { amount: 10, source: "Фазерлинк", account: "Сбербанк", date: "2026-11-07 09:30" }, (d) => d.amount === 10 && d.date === "2026-11-07 09:30:00");
await call("delete_transaction", { id: inc.id }, (d) => d.deleted);
const tr = await call("add_transfer", { amount: 5, from_account: "Сбербанк", to_account: "Газпромбанк", comment: "MCP e2e" }, (d) => d.ids.length === 2);
await call("delete_transaction", { id: tr.ids[0] }, (d) => d.deleted.type === "transfer");
const ex = await call("add_currency_exchange", { from_amount: 90, from_currency: "RUB", to_amount: 1, to_currency: "USD", account: "Сбербанк" }, (d) => d.ids.length === 2);
await call("delete_transaction", { id: ex.ids[0] }, (d) => d.deleted.type === "exchange");
// leftovers check
await call("get_transactions", { period: "all_time", search: "MCP e2e", limit: 10 }, (d) => d.total === 0);
// error paths
await call("add_expense", { amount: 1, category: "несуществующая категория xyz", account: "Сбербанк" }, undefined, true);
await call("delete_transaction", { id: 1 }, undefined, true);

await client.close();
console.log(failed === 0 ? "ALL PASSED" : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
