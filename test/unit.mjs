// Offline unit tests (no network): node test/unit.mjs
import assert from "node:assert/strict";
import { XMLParser } from "fast-xml-parser";
import { decode, encode, unescapeText } from "../src/soap.js";
import { Drebedengi, toApiDateTime } from "../src/api.js";

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
  console.log(`PASS ${name}`);
};

t("unescapeText is single-pass", () => {
  assert.equal(unescapeText("T&amp;T &lt;b&gt;"), "T&T <b>");
  assert.equal(unescapeText("&amp;amp;"), "&amp;"); // literal "&amp;" typed by the user survives
  assert.equal(unescapeText("&quot;q&quot;"), "&quot;q&quot;"); // server does not escape quotes
  assert.equal(unescapeText(5), 5);
});

t("encode escapes text and strips control chars", () => {
  assert.equal(encode("c", 'a&b<c>"\x01'), '<c xsi:type="xsd:string">a&amp;b&lt;c&gt;&quot;</c>');
  assert.match(encode("m", { a: 1, b: undefined }), /^<m xsi:type="ns2:Map"><item>.*<\/item><\/m>$/);
  assert.ok(!encode("m", { a: 1, b: undefined }).includes(">b<"));
});

t("decode maps, arrays and escaped strings", () => {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (name) => name === "item",
  });
  const xml =
    `<r xsi:type="SOAP-ENC:Array"><item xsi:type="ns2:Map">` +
    `<item><key xsi:type="xsd:string">id</key><value xsi:type="xsd:string">7</value></item>` +
    `<item><key xsi:type="xsd:string">comment</key><value xsi:type="xsd:string">T&amp;amp;T</value></item>` +
    `<item><key xsi:type="xsd:string">n</key><value xsi:type="xsd:int">3</value></item>` +
    `</item></r>`;
  assert.deepEqual(decode(parser.parse(xml).r), [{ id: "7", comment: "T&T", n: 3 }]);
});

t("toApiDateTime", () => {
  assert.equal(toApiDateTime("2026-01-02 03:04"), "2026-01-02 03:04:00");
  assert.equal(toApiDateTime("2020-01-02"), "2020-01-02 12:00:00");
  assert.throws(() => toApiDateTime("02.01.2026"));
});

// Fake reference data + canned getRecordList answer.
const places = [
  { id: "1", name: "Кошелёк", parent_id: "-1", is_hidden: "f", is_for_duty: "f" },
  { id: "2", name: "Копилка", parent_id: "-1", is_hidden: "f", is_for_duty: "f" },
  { id: "3", name: "Сергей", parent_id: "-1", is_hidden: "t", is_for_duty: "t" },
];
const currencies = [
  { id: "10", code: "RUB", name: "руб", is_default: "t" },
  { id: "11", code: "", name: "CNY", is_default: "f" },
];
const byId = (a) => new Map(a.map((o) => [String(o.id), o]));
function fake(records, balance = []) {
  const d = new Drebedengi({ login: "x", password: "y" });
  const cache = {
    places, placeById: byId(places),
    categories: [{ id: "20", name: "Еда", parent_id: "-1" }], categoryById: byId([{ id: "20", name: "Еда", parent_id: "-1" }]),
    sources: [], sourceById: new Map(), tags: [], tagById: new Map(),
    currencies, currencyById: byId(currencies), defaultCurrency: currencies[0],
  };
  d.ref = async () => cache;
  d.call = async (m) => (m === "getBalance" ? balance : records);
  return d;
}

{
  const d = fake([
    { id: "101", operation_type: 5, place_id: "1", budget_object_id: "1", sum: "-140000", currency_id: "10", operation_date: "2024-01-12 14:07:30", server_change_id: "100" },
    { id: "100", operation_type: 5, place_id: "1", budget_object_id: "1", sum: "40000", currency_id: "11", operation_date: "2024-01-12 14:07:30", server_change_id: "101" },
    { id: "201", operation_type: 4, place_id: "1", budget_object_id: "2", sum: "-5000", currency_id: "10", operation_date: "2024-01-11 10:00:00", server_move_id: "200" },
    { id: "200", operation_type: 4, place_id: "2", budget_object_id: "1", sum: "5000", currency_id: "10", operation_date: "2024-01-11 10:00:00", server_move_id: "201" },
    { id: "300", operation_type: 3, place_id: "1", budget_object_id: "20", sum: "-999", currency_id: "10", operation_date: "2024-01-10 10:00:00", comment: "обед" },
  ]);
  const r = await d.transactions({ period: "all_time" });
  assert.equal(r.total, 3);
  const [ex, tr, exp] = r.transactions;
  assert.deepEqual([ex.id, ex.amount, ex.currency, ex.to_amount, ex.to_currency], [101, -1400, "RUB", 400, "CNY"]);
  assert.deepEqual([tr.id, tr.amount, tr.to_amount, tr.to_account], [201, -50, 50, "Копилка"]);
  assert.equal(exp.category, "Еда");
  assert.deepEqual(r.sums, { expense_RUB: -9.99 });
  n++;
  console.log("PASS transactions: merged rows, sums only over expenses/incomes");
}

{
  const d = fake([], [
    { place_id: "1", currency_id: "10", sum: "10000", is_for_duty: "f" },
    { place_id: "3", currency_id: "10", sum: "-6000000", is_for_duty: "t" },
  ]);
  const b = await d.balance();
  assert.deepEqual(b.accounts.map((a) => a.account), ["Кошелёк"]);
  assert.deepEqual(b.debts, [{ account_id: 3, account: "Сергей", hidden: true, balances: { RUB: -60000 }, is_credit_card: undefined }]);
  assert.deepEqual(b.debts_total_by_currency, { RUB: -60000 });
  n++;
  console.log("PASS balance: hidden debt account with non-zero balance is shown");
}

{
  const d = fake([]);
  assert.equal((await d.resolvePlace("кошелек")).id, "1");
  assert.equal((await d.resolvePlace("Сергей")).id, "3"); // debt account by name
  assert.equal((await d.resolveCurrency("CNY")).id, "11"); // currency without a code, by name
  await assert.rejects(() => d.resolvePlace("нет такого"), /Счёт\/место хранения/);
  n++;
  console.log("PASS resolve: debt accounts and code-less currencies by name");
}

console.log(`ALL ${n} UNIT TESTS PASSED`);
