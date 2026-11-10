// High-level wrapper over the drebedengi SOAP API: reference-data cache,
// name resolution, amount/date conversion, record enrichment.

import { DrebedengiClient, DrebedengiError } from "./soap.js";

export const OP = { income: 2, expense: 3, transfer: 4, exchange: 5 };
export const OP_NAME = { 2: "income", 3: "expense", 4: "transfer", 5: "exchange" };

export const PERIODS = {
  custom: 0,
  this_month: 1,
  last_month: 2,
  this_quarter: 3,
  this_year: 4,
  last_year: 5,
  all_time: 6,
  today: 7,
  last_20: 8,
};

// How often (at most) to ask the server whether reference data changed.
const REVISION_CHECK_MS = Number(process.env.DREBEDENGI_REF_CHECK_MS ?? 10 * 60 * 1000);
// Safety net in case revision tracking misses something: full reload at most this often.
const FULL_RELOAD_MS = 6 * 60 * 60 * 1000;
// A name that isn't found triggers a reload of that one list, but not more often than this.
const NOT_FOUND_RELOAD_MS = 60 * 1000;

// Reference lists and the getChangeList object_type_id values that affect them.
const REF_LISTS = {
  places: { method: "getPlaceList", types: [4] },
  categories: { method: "getCategoryList", types: [3] },
  sources: { method: "getSourceList", types: [2] },
  currencies: { method: "getCurrencyList", types: [5] },
  tags: { method: "getTagList", types: [6] },
};

const isTrue = (v) => v === true || v === "t" || v === "1" || v === 1 || v === "true";
const toCents = (amount) => Math.round(Number(amount) * 100);
const fromCents = (cents) => Number(cents) / 100;

/** Strip emoji / punctuation and lowercase, for forgiving name matching. */
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Accepts "YYYY-MM-DD", "YYYY-MM-DD HH:mm[:ss]", ISO; returns "YYYY-MM-DD HH:mm:SS". */
export function toApiDateTime(input) {
  if (!input) {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const m = String(input)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) throw new DrebedengiError(`Неверный формат даты "${input}", ожидается YYYY-MM-DD или YYYY-MM-DD HH:mm`);
  const [, y, mo, d, h, mi, s] = m;
  if (h === undefined) {
    // Date only: keep current time if it's today, else noon.
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${y}-${mo}-${d}` === today ? `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` : "12:00:00";
    return `${y}-${mo}-${d} ${time}`;
  }
  return `${y}-${mo}-${d} ${h}:${mi}:${s ?? "00"}`;
}

function checkDate(d, field) {
  if (!d) return;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  const t = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || t.getUTCMonth() !== +m[2] - 1 || t.getUTCDate() !== +m[3]) {
    throw new DrebedengiError(`${field}: ожидается существующая дата в формате YYYY-MM-DD, получено "${d}"`);
  }
}

/** Currency code, or its name when the user's currency has no code. */
const curLabel = (c) => c.code || c.name;

let clientIdSeq = 0;
/** client_id must be unique per insert (the server remembers client->server mapping). */
function nextClientId() {
  clientIdSeq = (clientIdSeq + 1) % 1000;
  return Date.now() * 1000 + clientIdSeq;
}

export class Drebedengi {
  constructor(opts) {
    this.client = new DrebedengiClient(opts);
    this.cache = null;
    this.cacheAt = 0; // last revision check
    this.fullAt = 0; // last full reload
    this.listAt = {}; // per-list load time
    this.forced = new Set(); // lists to reload on next ref()
  }

  call(method, args) {
    return this.client.call(method, args);
  }

  /**
   * Make the next ref() re-check the server. With `key` (places/categories/…)
   * that list is reloaded regardless of what the revision says.
   */
  invalidate(key) {
    if (key) this.forced.add(key);
    this.cacheAt = 0;
  }

  /**
   * Reference data (accounts, categories, sources, currencies, tags).
   * Loaded once, then kept in sync via getCurrentRevision + getChangeList, as the
   * service asks: only lists that actually changed are re-downloaded.
   */
  ref() {
    this.refPending ??= this.#loadRef().finally(() => {
      this.refPending = null;
    });
    return this.refPending;
  }

  async #loadRef() {
    const now = Date.now();
    if (this.cache && now - this.cacheAt < REVISION_CHECK_MS) return this.cache;

    const revision = await this.call("getCurrentRevision");
    const all = Object.keys(REF_LISTS);
    let stale = new Set(all);
    if (this.cache && now - this.fullAt < FULL_RELOAD_MS) {
      stale = new Set(this.forced);
      if (String(revision) !== String(this.cache.revision)) {
        const changes = await this.call("getChangeList", [["revision", String(this.cache.revision)]]);
        const types = new Set(
          (Array.isArray(changes) ? changes : Object.values(changes || {})).map((x) => Number(x.object_type_id)),
        );
        for (const k of all) if (REF_LISTS[k].types.some((t) => types.has(t))) stale.add(k);
      }
      if (!stale.size) {
        this.cache.revision = revision;
        this.cacheAt = now;
        return this.cache;
      }
    }

    const c = { ...(this.cache || {}) };
    for (const key of stale) {
      const raw = await this.call(REF_LISTS[key].method);
      c[key] = Array.isArray(raw) ? raw : raw ? Object.values(raw) : [];
      this.listAt[key] = now;
      this.forced.delete(key);
    }
    if (stale.size === all.length) this.fullAt = now;
    const byId = (arr) => new Map(arr.map((o) => [String(o.id), o]));
    c.placeById = byId(c.places);
    c.categoryById = byId(c.categories);
    c.sourceById = byId(c.sources);
    c.currencyById = byId(c.currencies);
    c.tagById = byId(c.tags);
    c.defaultCurrency = c.currencies.find((x) => isTrue(x.is_default)) || c.currencies[0];
    c.revision = revision;
    this.cache = c;
    this.cacheAt = now;
    return c;
  }

  /** Full "Parent / Child" path for tree objects (categories, sources, places, tags). */
  static path(obj, byId) {
    const parts = [];
    let cur = obj;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      const pid = String(cur.parent_id ?? "-1");
      cur = pid !== "-1" && pid !== "0" ? byId.get(pid) : null;
    }
    return parts.join(" / ");
  }

  /**
   * Resolve a user-supplied id or name against a list. Prefers visible items,
   * exact matches, then unique substring matches.
   */
  resolve(value, items, byId, what) {
    if (value === undefined || value === null || value === "") return null;
    const s = String(value).trim();
    if (/^\d+$/.test(s) && byId.has(s)) return byId.get(s);
    const q = norm(s);
    const candidates = items.map((o) => ({ o, name: norm(o.name), full: norm(Drebedengi.path(o, byId)) }));
    const pick = (list) => {
      const visible = list.filter((x) => !isTrue(x.o.is_hidden));
      return visible.length ? visible : list;
    };
    let hits = pick(candidates.filter((x) => x.name === q || x.full === q));
    if (hits.length !== 1) {
      const sub = pick(candidates.filter((x) => x.name.includes(q) || x.full.includes(q)));
      if (hits.length === 0) hits = sub;
    }
    if (hits.length === 1) return hits[0].o;
    if (hits.length === 0) {
      const e = new DrebedengiError(`${what} "${s}" не найден(а). Используйте соответствующий list-инструмент, чтобы увидеть варианты.`);
      e.notFound = true;
      throw e;
    }
    const opts = hits.slice(0, 15).map((x) => `${x.o.id}: ${Drebedengi.path(x.o, byId)}`).join("; ");
    throw new DrebedengiError(`${what} "${s}" — неоднозначно, подходят: ${opts}. Укажите id.`);
  }

  /** Resolve against cached data; if not found, re-check the server revision once (cheap) and retry. */
  async #resolveFresh(key, fn) {
    try {
      return fn(await this.ref());
    } catch (e) {
      if (!e.notFound || Date.now() - (this.listAt[key] || 0) < NOT_FOUND_RELOAD_MS) throw e;
      this.invalidate(key);
      return fn(await this.ref());
    }
  }

  /** Ordinary accounts win; debt accounts ("Сергей", "Ozon банк") are tried when nothing else matches. */
  resolvePlace(v) {
    return this.#resolveFresh("places", (r) => {
      try {
        return this.resolve(v, r.places.filter((p) => !isTrue(p.is_for_duty)), r.placeById, "Счёт/место хранения");
      } catch (e) {
        if (!e.notFound) throw e;
        try {
          return this.resolve(v, r.places.filter((p) => isTrue(p.is_for_duty)), r.placeById, "Долговой счёт");
        } catch (e2) {
          throw e2.notFound ? e : e2;
        }
      }
    });
  }
  resolveCategory(v) {
    return this.#resolveFresh("categories", (r) => this.resolve(v, r.categories, r.categoryById, "Категория расходов"));
  }
  resolveSource(v) {
    return this.#resolveFresh("sources", (r) => this.resolve(v, r.sources, r.sourceById, "Источник дохода"));
  }
  resolveTag(v) {
    return this.#resolveFresh("tags", (r) => this.resolve(v, r.tags, r.tagById, "Тег"));
  }
  resolveCurrency(v) {
    return this.#resolveFresh("currencies", (r) => {
      if (v === undefined || v === null || v === "") return r.defaultCurrency;
      const s = String(v).trim();
      const byCode = r.currencies.find((c) => c.code && String(c.code).toUpperCase() === s.toUpperCase());
      if (byCode) return byCode;
      return this.resolve(s, r.currencies, r.currencyById, "Валюта");
    });
  }

  currencyLabel(r, id) {
    const c = r.currencyById.get(String(id));
    return c ? curLabel(c) : String(id);
  }

  // ---------------------------------------------------------------- reads

  async balance({ date, withAccum = false, withDuty = false, includeHidden = false } = {}) {
    checkDate(date, "date");
    const r = await this.ref();
    const params = { is_with_accum: withAccum, is_with_duty: withDuty };
    if (date) params.restDate = date;
    const rows = (await this.call("getBalance", [["params", params]])) || [];
    // getBalance returns one row per (place, currency); group them per place and
    // keep debts (places auto-created for "duty" records) in a separate list.
    const groups = new Map();
    for (const b of Array.isArray(rows) ? rows : Object.values(rows)) {
      const place = r.placeById.get(String(b.place_id));
      // A hidden account is skipped only while it is empty: money or a debt sitting on a
      // hidden account must still show up, otherwise the totals are silently wrong.
      const hidden = Boolean(place && isTrue(place.is_hidden));
      if (!includeHidden && hidden && Number(b.sum) === 0) continue;
      const id = Number(b.place_id);
      if (!groups.has(id)) {
        groups.set(id, {
          account_id: id,
          account: place ? Drebedengi.path(place, r.placeById) : b.place_name,
          hidden: hidden || undefined,
          balances: {},
          is_credit_card: isTrue(b.is_credit_card) || undefined,
          debt: isTrue(b.is_for_duty),
        });
      }
      const cur = this.currencyLabel(r, b.currency_id);
      const g = groups.get(id);
      g.balances[cur] = Math.round(((g.balances[cur] || 0) + fromCents(b.sum)) * 100) / 100;
    }
    const sum = (list) => {
      const t = {};
      for (const g of list) for (const [cur, v] of Object.entries(g.balances)) t[cur] = Math.round(((t[cur] || 0) + v) * 100) / 100;
      return t;
    };
    const strip = ({ debt, ...g }) => g;
    const accounts = [...groups.values()].filter((g) => !g.debt);
    const debts = [...groups.values()].filter((g) => g.debt);
    return {
      date: date || "сейчас",
      accounts: accounts.map(strip),
      totals_by_currency: sum(accounts),
      debts: debts.map(strip),
      debts_total_by_currency: sum(debts),
      note: "Долги: положительный остаток — должны вам, отрицательный — должны вы.",
    };
  }

  buildFilter({ period = "this_month", dateFrom, dateTo, relativeDate, type = "all", accounts, categories, tags, currency }, r) {
    const p = {};
    if (dateFrom || dateTo) {
      checkDate(dateFrom, "date_from");
      checkDate(dateTo, "date_to");
      p.r_period = 0;
      p.period_from = dateFrom || "2000-01-01";
      p.period_to = dateTo || toApiDateTime().slice(0, 10);
    } else {
      if (!(period in PERIODS)) throw new DrebedengiError(`Неизвестный период ${period}`);
      p.r_period = PERIODS[period];
    }
    if (relativeDate) {
      checkDate(relativeDate, "relative_date");
      p.relative_date = relativeDate;
    }
    p.r_what = { income: 2, expense: 3, transfer: 4, exchange: 5, all: 6 }[type] ?? 6;
    return p;
  }

  async applyListFilters(p, { accounts, categories, tags }) {
    if (accounts?.length) {
      p.r_is_place = 1;
      p.r_place = await Promise.all(accounts.map(async (a) => Number((await this.resolvePlace(a)).id)));
    }
    if (categories?.length) {
      p.r_is_category = 1;
      // r_category applies to both expense categories and income sources.
      p.r_category = await Promise.all(
        categories.map(async (c) => {
          try {
            return Number((await this.resolveCategory(c)).id);
          } catch (e) {
            try {
              return Number((await this.resolveSource(c)).id);
            } catch {
              throw e;
            }
          }
        }),
      );
    }
    if (tags?.length) {
      p.r_is_tag = 1;
      p.r_tag = await Promise.all(tags.map(async (t) => Number((await this.resolveTag(t)).id)));
    }
  }

  enrich(rec, r) {
    const type = Number(rec.operation_type);
    const place = r.placeById.get(String(rec.place_id));
    const objId = String(rec.budget_object_id);
    let target;
    if (type === OP.expense) target = r.categoryById.get(objId);
    else if (type === OP.income) target = r.sourceById.get(objId);
    else target = r.placeById.get(objId);
    const targetName = target
      ? Drebedengi.path(target, type === OP.expense ? r.categoryById : type === OP.income ? r.sourceById : r.placeById)
      : objId;
    const row = {
      id: Number(rec.id),
      date: rec.operation_date,
      type: OP_NAME[type] || String(type),
      amount: fromCents(rec.sum),
      currency: this.currencyLabel(r, rec.currency_id),
      account: place ? Drebedengi.path(place, r.placeById) : String(rec.place_id),
    };
    if (type === OP.expense) row.category = targetName;
    else if (type === OP.income) row.source = targetName;
    else if (type === OP.transfer) row[Number(rec.sum) < 0 ? "to_account" : "from_account"] = targetName;
    else if (type === OP.exchange) row.counter_account = targetName;
    if (rec.server_move_id) row.paired_id = Number(rec.server_move_id);
    if (rec.server_change_id) row.paired_id = Number(rec.server_change_id);
    if (rec.comment) row.comment = rec.comment;
    if (rec.group_id) row.receipt_group_id = Number(rec.group_id);
    return row;
  }

  async transactions(opts = {}) {
    const r = await this.ref();
    const p = { is_report: false, r_how: 1, ...this.buildFilter(opts, r) };
    await this.applyListFilters(p, opts);
    const raw = await this.call("getRecordList", [["params", p]]);
    let rows = (Array.isArray(raw) ? raw : Object.values(raw || {})).map((x) => this.enrich(x, r));
    // A transfer/exchange comes back as two halves. Merge them into one row: the outgoing
    // (negative) half is the base, the incoming half's amount/currency/account are attached
    // as to_amount / to_currency / to_account, so neither side is lost.
    // With an account filter only the matching half may be present; it is kept as is.
    {
      const byId = new Map(rows.map((x) => [x.id, x]));
      const drop = new Set();
      for (const x of rows) {
        if (!x.paired_id || drop.has(x.id)) continue;
        const twin = byId.get(x.paired_id);
        if (!twin || drop.has(twin.id)) continue;
        const [out, inc] = x.amount < 0 ? [x, twin] : [twin, x];
        out.to_amount = inc.amount;
        out.to_currency = inc.currency;
        out.to_account = inc.account;
        if (out.type === "exchange") delete out.counter_account;
        if (!out.comment && inc.comment) out.comment = inc.comment;
        drop.add(inc.id);
      }
      rows = rows.filter((x) => !drop.has(x.id));
    }
    if (opts.search) {
      const q = norm(opts.search);
      rows = rows.filter((x) => norm([x.comment, x.category, x.source, x.account, x.to_account, x.from_account].join(" ")).includes(q));
    }
    if (opts.minAmount !== undefined) rows = rows.filter((x) => Math.abs(x.amount) >= opts.minAmount);
    if (opts.maxAmount !== undefined) rows = rows.filter((x) => Math.abs(x.amount) <= opts.maxAmount);
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    const total = rows.length;
    const limit = opts.limit ?? 100;
    const sums = {};
    for (const x of rows) {
      if (x.type !== "expense" && x.type !== "income") continue;
      const k = `${x.type}_${x.currency}`;
      sums[k] = Math.round(((sums[k] || 0) + x.amount) * 100) / 100;
    }
    return { total, shown: Math.min(total, limit), sums, transactions: rows.slice(0, limit) };
  }

  async getById(ids) {
    const r = await this.ref();
    const raw = await this.call("getRecordList", [
      ["params", { is_report: false, r_how: 1, r_what: 6, r_period: 6 }],
      ["idList", ids.map(Number)],
    ]);
    return { r, raw: Array.isArray(raw) ? raw : Object.values(raw || {}) };
  }

  async report(opts = {}) {
    const r = await this.ref();
    const groupBy = opts.groupBy || (opts.type === "income" ? "source" : "category");
    const type = groupBy === "source" ? "income" : "expense";
    const p = { is_report: true, ...this.buildFilter({ ...opts, type }, r) };
    p.r_how = groupBy === "source" ? 2 : 3;
    p.r_middle = { none: 0, month: 2592000, week: 604800, day: 86400 }[opts.average || "none"];
    if (opts.currency) p.r_currency = Number((await this.resolveCurrency(opts.currency)).id);
    await this.applyListFilters(p, opts);
    const raw = (await this.call("getRecordList", [["params", p]])) || [];
    const rows = (Array.isArray(raw) ? raw : Object.values(raw)).map((x) => {
      const map = groupBy === "source" ? r.sourceById : r.categoryById;
      const obj = map.get(String(x.budget_object_id));
      return {
        id: Number(x.budget_object_id),
        name: obj ? Drebedengi.path(obj, map) : x.name,
        amount: Math.round(fromCents(x.difference) * 100) / 100,
        currency: this.currencyLabel(r, x.currency_id),
        is_leaf: isTrue(x.nochild),
        parent_id: Number(x.parent_id),
      };
    });
    const totals = {};
    for (const x of rows) {
      if (x.parent_id !== -1) continue; // top-level rows already include children
      totals[x.currency] = Math.round(((totals[x.currency] || 0) + x.amount) * 100) / 100;
    }
    return { group_by: groupBy, average: opts.average || "none", totals_by_currency: totals, rows };
  }

  // --------------------------------------------------------------- writes

  async setRecords(list) {
    const res = await this.call("setRecordList", [["list", list]]);
    const arr = Array.isArray(res) ? res : Object.values(res || {});
    const wanted = new Set(list.map((x) => x.client_id ?? x.server_id).map(String));
    const mine = arr.filter((x) => wanted.has(String(x.client_id ?? x.server_id)));
    if (mine.length < list.length) {
      throw new DrebedengiError(`Сервер не подтвердил запись (${mine.length} из ${list.length}): ${JSON.stringify(arr).slice(0, 300)}`);
    }
    const bad = mine.filter((x) => x.status && !["inserted", "updated"].includes(String(x.status)));
    if (bad.length) throw new DrebedengiError(`Сервер отклонил запись: ${JSON.stringify(bad)}`);
    return mine.map((x) => ({ id: Number(x.server_id), status: x.status, client_id: x.client_id }));
  }

  async addSimple(kind, { amount, target, account, date, comment, currency }) {
    if (!(Number(amount) > 0)) throw new DrebedengiError("amount должен быть положительным числом");
    const place = await this.resolvePlace(account);
    const obj = kind === OP.expense ? await this.resolveCategory(target) : await this.resolveSource(target);
    const cur = await this.resolveCurrency(currency);
    const cents = toCents(amount);
    const rec = {
      client_id: nextClientId(),
      place_id: Number(place.id),
      budget_object_id: Number(obj.id),
      sum: kind === OP.expense ? -cents : cents,
      operation_date: toApiDateTime(date),
      comment: comment || "",
      currency_id: Number(cur.id),
      operation_type: kind,
      is_duty: false,
    };
    const [res] = await this.setRecords([rec]);
    // Build the confirmation locally instead of re-reading it (fewer requests).
    return this.enrich({ ...rec, id: res.id }, await this.ref());
  }

  async addTransfer({ amount, fromAccount, toAccount, date, comment, currency }) {
    if (!(Number(amount) > 0)) throw new DrebedengiError("amount должен быть положительным числом");
    const from = await this.resolvePlace(fromAccount);
    const to = await this.resolvePlace(toAccount);
    if (from.id === to.id) throw new DrebedengiError("Счета перевода совпадают");
    const cur = await this.resolveCurrency(currency);
    const cents = toCents(amount);
    const when = toApiDateTime(date);
    const id1 = nextClientId();
    const base = { operation_date: when, comment: comment || "", currency_id: Number(cur.id), operation_type: OP.transfer, is_duty: false };
    const res = await this.setRecords([
      { ...base, client_id: id1, place_id: Number(from.id), budget_object_id: Number(to.id), sum: -cents },
      { ...base, client_id: nextClientId(), client_move_id: id1, place_id: Number(to.id), budget_object_id: Number(from.id), sum: cents },
    ]);
    return { ids: res.map((x) => x.id), from: from.name, to: to.name, amount: Number(amount), currency: curLabel(cur), date: when };
  }

  async addExchange({ fromAmount, fromCurrency, toAmount, toCurrency, account, toAccount, date, comment }) {
    if (!(Number(fromAmount) > 0) || !(Number(toAmount) > 0)) throw new DrebedengiError("Суммы должны быть положительными");
    const from = await this.resolvePlace(account);
    const to = toAccount ? await this.resolvePlace(toAccount) : from;
    const c1 = await this.resolveCurrency(fromCurrency);
    const c2 = await this.resolveCurrency(toCurrency);
    if (c1.id === c2.id) throw new DrebedengiError("Валюты обмена совпадают");
    const when = toApiDateTime(date);
    const id1 = nextClientId();
    const base = { operation_date: when, comment: comment || "", operation_type: OP.exchange, is_duty: false };
    const res = await this.setRecords([
      { ...base, client_id: id1, place_id: Number(from.id), budget_object_id: Number(to.id), sum: -toCents(fromAmount), currency_id: Number(c1.id) },
      {
        ...base,
        client_id: nextClientId(),
        client_change_id: id1,
        place_id: Number(to.id),
        budget_object_id: Number(from.id),
        sum: toCents(toAmount),
        currency_id: Number(c2.id),
      },
    ]);
    return { ids: res.map((x) => x.id), sold: `${fromAmount} ${curLabel(c1)}`, bought: `${toAmount} ${curLabel(c2)}`, account: from.name, to_account: to.name, date: when };
  }

  async updateRecord(id, changes) {
    const { r, raw } = await this.getById([id]);
    const rec = raw.find((x) => Number(x.id) === Number(id));
    if (!rec) throw new DrebedengiError(`Операция ${id} не найдена`);
    const type = Number(rec.operation_type);
    if (type !== OP.expense && type !== OP.income) {
      throw new DrebedengiError("Редактировать можно только расходы и доходы. Перевод/обмен удалите и создайте заново.");
    }
    const out = {
      server_id: Number(rec.id),
      place_id: Number(rec.place_id),
      budget_object_id: Number(rec.budget_object_id),
      sum: Number(rec.sum),
      operation_date: rec.operation_date,
      comment: rec.comment || "",
      currency_id: Number(rec.currency_id),
      operation_type: type,
      is_duty: isTrue(rec.is_duty),
    };
    // Keep the record inside its receipt group.
    if (rec.group_id) out.group_id = Number(rec.group_id);
    if (changes.amount !== undefined) {
      if (!(Number(changes.amount) > 0)) throw new DrebedengiError("amount должен быть положительным числом");
      out.sum = type === OP.expense ? -toCents(changes.amount) : toCents(changes.amount);
    }
    if (changes.account !== undefined) out.place_id = Number((await this.resolvePlace(changes.account)).id);
    if (changes.category !== undefined) {
      out.budget_object_id = Number(
        (type === OP.expense ? await this.resolveCategory(changes.category) : await this.resolveSource(changes.category)).id,
      );
    }
    if (changes.date !== undefined) out.operation_date = toApiDateTime(changes.date);
    if (changes.comment !== undefined) out.comment = changes.comment;
    if (changes.currency !== undefined) out.currency_id = Number((await this.resolveCurrency(changes.currency)).id);
    await this.setRecords([out]);
    return { before: this.enrich(rec, r), after: this.enrich({ ...rec, ...out, id: rec.id }, await this.ref()) };
  }

  async deleteRecord(id) {
    const { r, raw } = await this.getById([id]);
    const rec = raw.find((x) => Number(x.id) === Number(id));
    if (!rec) throw new DrebedengiError(`Операция ${id} не найдена`);
    const type = OP_NAME[Number(rec.operation_type)];
    const apiType = { expense: "waste", income: "income", transfer: "move", exchange: "change" }[type];
    await this.call("deleteObject", [["id", Number(id)], ["type", apiType]]);
    return { deleted: this.enrich(rec, r) };
  }

  async createObject(kind, { name, parent, description }) {
    // "debt" is a debt account (a person or a bank you owe / who owes you): a place with is_for_duty.
    const debt = kind === "debt";
    if (debt) kind = "account";
    const method = { category: "setCategoryList", source: "setSourceList", account: "setPlaceList", tag: "setTagList" }[kind];
    if (!method) throw new DrebedengiError(`Неизвестный тип объекта ${kind}`);
    // Required fields per object type (the server rejects records without them).
    const rec = { client_id: nextClientId(), name, is_hidden: false, sort: 0 };
    if (kind === "category") Object.assign(rec, { type: 3, is_for_duty: false });
    if (kind === "source") Object.assign(rec, { type: 2, is_for_duty: false });
    if (kind === "account") Object.assign(rec, { type: 4, is_for_duty: debt, is_autohide: false, icon_id: 0 });
    if (kind === "tag") rec.is_family = true;
    if (parent) {
      const p =
        kind === "category"
          ? await this.resolveCategory(parent)
          : kind === "source"
            ? await this.resolveSource(parent)
            : kind === "tag"
              ? await this.resolveTag(parent)
              : await this.resolvePlace(parent);
      rec.parent_id = Number(p.id);
    } else if (kind !== "account") {
      rec.parent_id = -1;
    }
    if (description && kind !== "tag") rec.description = description;
    const res = await this.call(method, [["list", [rec]]]);
    this.invalidate({ category: "categories", source: "sources", account: "places", tag: "tags" }[kind]);
    const arr = Array.isArray(res) ? res : Object.values(res || {});
    const mine = arr.find((x) => String(x.client_id) === String(rec.client_id)) || arr[0];
    if (!mine?.server_id) throw new DrebedengiError(`Сервер не создал объект: ${JSON.stringify(arr)}`);
    return { id: Number(mine.server_id), kind: debt ? "debt" : kind, name, status: mine.status, parent_id: rec.parent_id };
  }
}
