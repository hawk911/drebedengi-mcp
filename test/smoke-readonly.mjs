// Read-only smoke test on the user's own account (credentials from .env). Prints counts only.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: process.execPath, args: ["src/server.js"], env: { ...process.env, DREBEDENGI_READONLY: "1" } });
const c = new Client({ name: "smoke", version: "1" }, {});
await c.connect(t);
console.log("tools:", (await c.listTools()).tools.map((x) => x.name).join(", "));
const run = async (name, args, summarize) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = r.content[0].text;
  if (r.isError) return console.log(`ERR  ${name}: ${text}`);
  console.log(`OK   ${name} ${JSON.stringify(args)} — ${summarize(JSON.parse(text))} (${Date.now() - t0}ms)`);
};
await run("get_balance", {}, (d) => `счетов: ${d.accounts.length}, долгов: ${d.debts.length}, валют в итогах: ${Object.keys(d.totals_by_currency).length}`);
await run("list_accounts", {}, (d) => `счетов: ${d.length}`);
await run("list_categories", { kind: "expense" }, (d) => `категорий расходов: ${d.length}`);
await run("list_categories", { kind: "income" }, (d) => `источников дохода: ${d.length}`);
await run("list_tags", {}, (d) => `тегов: ${d.length}`);
await run("list_currencies", {}, (d) => `валют: ${d.length}, основная задана: ${d.some((x) => x.is_default)}`);
await run("get_transactions", { period: "this_month", limit: 5 }, (d) => `операций за месяц: ${d.total}, полей у первой: ${d.transactions[0] ? Object.keys(d.transactions[0]).join("/") : "-"}`);
await run("get_report", { period: "this_month" }, (d) => `строк отчёта: ${d.rows.length}`);
await c.close();
