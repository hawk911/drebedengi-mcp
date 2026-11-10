#!/usr/bin/env node
// MCP server for drebedengi.ru (home bookkeeping) over its SOAP API.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Drebedengi, PERIODS } from "./api.js";

// ---- config: env vars, optionally from a .env file next to package.json
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.DREBEDENGI_ENV_FILE || join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const readOnly = /^(1|true|yes)$/i.test(process.env.DREBEDENGI_READONLY || "");
const defaultAccount = process.env.DREBEDENGI_DEFAULT_ACCOUNT || undefined;

let dd;
function api() {
  dd ??= new Drebedengi({
    apiId: process.env.DREBEDENGI_API_ID,
    login: process.env.DREBEDENGI_LOGIN,
    password: process.env.DREBEDENGI_PASSWORD,
  });
  return dd;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Ошибка: ${e?.message || e}` }], isError: true });
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args ?? {}));
  } catch (e) {
    return fail(e);
  }
};

const server = new McpServer(
  { name: "drebedengi", version: "1.0.0" },
  {
    instructions:
      "Доступ к домашней бухгалтерии drebedengi.ru. Суммы — в единицах валюты (рубли, не копейки). " +
      "Счета (места хранения), категории, источники и теги можно указывать по id или по названию. " +
      "Долговые счета (люди, банки) тоже можно указывать как счёт: перевод на долговой счёт = дал в долг / вернул долг. " +
      "Перед добавлением операции, если не уверен в названии категории/счёта, вызови list_categories / list_accounts. " +
      (readOnly ? "Сервер запущен в режиме только чтения." : "Перед удалением или изменением операций подтверждай действие у пользователя."),
  },
);

// ---- shared schemas
const periodSchema = z
  .enum(Object.keys(PERIODS))
  .optional()
  .describe("Период: today, this_month (по умолчанию), last_month, this_quarter, this_year, last_year, all_time, last_20. Игнорируется, если заданы date_from/date_to.");
const dateSchema = z.string().optional();
const idOrName = z.union([z.string(), z.number()]);
const filterFields = {
  period: periodSchema,
  date_from: dateSchema.describe("Начало периода YYYY-MM-DD"),
  date_to: dateSchema.describe("Конец периода YYYY-MM-DD (включительно)"),
  accounts: z.array(idOrName).optional().describe("Только эти счета (id или названия)"),
  categories: z.array(idOrName).optional().describe("Только эти категории расходов / источники доходов (id или названия)"),
  tags: z.array(idOrName).optional().describe("Только операции с этими тегами"),
};
const mapFilter = (a) => ({
  period: a.period,
  dateFrom: a.date_from,
  dateTo: a.date_to,
  accounts: a.accounts,
  categories: a.categories,
  tags: a.tags,
});

// ---- read tools
server.registerTool(
  "get_balance",
  {
    title: "Остатки по счетам",
    description:
      "Текущие (или на дату) остатки по счетам — по каждой валюте счёта — и итоги по валютам. " +
      "Долги (кто кому должен) возвращаются отдельным списком debts и в итоги счетов не входят. " +
      "Скрытые счета с ненулевым остатком показываются всегда (hidden: true).",
    inputSchema: {
      date: dateSchema.describe("Дата YYYY-MM-DD, на которую посчитать остатки (по умолчанию — сейчас)"),
      include_hidden: z.boolean().optional().describe("Показывать и пустые скрытые счета"),
      subtract_savings: z.boolean().optional().describe("Вычесть накопления"),
      subtract_debts: z.boolean().optional().describe("Вычесть долги"),
    },
    annotations: { readOnlyHint: true },
  },
  wrap((a) =>
    api().balance({ date: a.date, includeHidden: a.include_hidden, withAccum: a.subtract_savings, withDuty: a.subtract_debts }),
  ),
);

function treeList(items, byId, includeHidden, extra = () => ({})) {
  return items
    .filter((o) => includeHidden || !(o.is_hidden === "t" || o.is_hidden === true))
    .map((o) => ({
      id: Number(o.id),
      name: Drebedengi.path(o, byId),
      parent_id: o.parent_id != null ? Number(o.parent_id) : undefined,
      hidden: o.is_hidden === "t" || undefined,
      ...extra(o),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

server.registerTool(
  "list_accounts",
  {
    title: "Счета / места хранения",
    description:
      "Список счетов (кошельки, карты, банки) с id. С include_debts — ещё и долговые счета (люди и банки, кому должны вы или кто должен вам). " +
      "Остатки — через get_balance.",
    inputSchema: {
      include_hidden: z.boolean().optional(),
      include_debts: z.boolean().optional().describe("Показать и долговые счета (помечены debt: true)"),
    },
    annotations: { readOnlyHint: true },
  },
  wrap(async (a) => {
    const r = await api().ref();
    return treeList(
      r.places.filter((p) => a.include_debts || p.is_for_duty !== "t"),
      r.placeById,
      a.include_hidden,
      (o) => ({
        debt: o.is_for_duty === "t" || undefined,
        credit_card: o.is_credit_card === "t" || undefined,
        description: o.description || undefined,
      }),
    );
  }),
);

server.registerTool(
  "list_categories",
  {
    title: "Категории расходов и источники доходов",
    description: "Дерево категорий расходов (kind=expense) или источников дохода (kind=income) с полными путями.",
    inputSchema: {
      kind: z.enum(["expense", "income"]).default("expense"),
      include_hidden: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  wrap(async (a) => {
    const r = await api().ref();
    return a.kind === "income"
      ? treeList(r.sources, r.sourceById, a.include_hidden)
      : treeList(r.categories, r.categoryById, a.include_hidden);
  }),
);

server.registerTool(
  "list_tags",
  {
    title: "Теги",
    description: "Список тегов (меток) с id.",
    inputSchema: { include_hidden: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  wrap(async (a) => {
    const r = await api().ref();
    return treeList(r.tags, r.tagById, a.include_hidden);
  }),
);

server.registerTool(
  "list_currencies",
  {
    title: "Валюты",
    description: "Валюты пользователя с курсами к основной валюте.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  wrap(async () => {
    const r = await api().ref();
    return r.currencies.map((c) => ({
      id: Number(c.id),
      code: c.code,
      name: c.name,
      rate: Number(c.course),
      is_default: c.is_default === "t",
      hidden: c.is_hidden === "t" || undefined,
    }));
  }),
);

server.registerTool(
  "get_transactions",
  {
    title: "Список операций",
    description:
      "Операции (расходы, доходы, переводы, обмен валют) за период с фильтрами. Суммы: расход < 0, доход > 0. " +
      "Перевод и обмен — одна строка: amount/currency/account — списание, to_amount/to_currency/to_account — зачисление. " +
      "Возвращает также суммы расходов/доходов по валютам по всем найденным операциям.",
    inputSchema: {
      ...filterFields,
      type: z.enum(["all", "expense", "income", "transfer", "exchange"]).optional().describe("Тип операций (по умолчанию all)"),
      search: z.string().optional().describe("Поиск подстроки в комментарии/категории/счёте"),
      min_amount: z.number().optional().describe("Минимальная сумма по модулю"),
      max_amount: z.number().optional().describe("Максимальная сумма по модулю"),
      limit: z.number().int().min(1).max(2000).optional().describe("Сколько операций вернуть (по умолчанию 100)"),
    },
    annotations: { readOnlyHint: true },
  },
  wrap((a) =>
    api().transactions({
      ...mapFilter(a),
      type: a.type,
      search: a.search,
      minAmount: a.min_amount,
      maxAmount: a.max_amount,
      limit: a.limit,
    }),
  ),
);

server.registerTool(
  "get_report",
  {
    title: "Отчёт по категориям / источникам",
    description:
      "Суммы расходов по категориям (group_by=category) или доходов по источникам (group_by=source) за период, " +
      "с опциональным усреднением по месяцам/неделям/дням и конвертацией в одну валюту. Строки родительских категорий включают дочерние.",
    inputSchema: {
      ...filterFields,
      group_by: z.enum(["category", "source"]).default("category"),
      average: z.enum(["none", "month", "week", "day"]).optional().describe("Усреднение"),
      currency: idOrName.optional().describe("Пересчитать всё в эту валюту (код, например RUB, или id)"),
    },
    annotations: { readOnlyHint: true },
  },
  wrap((a) => api().report({ ...mapFilter(a), groupBy: a.group_by, average: a.average, currency: a.currency })),
);

// ---- write tools
if (!readOnly) {
  const common = {
    account: idOrName
      .optional()
      .describe(`Счёт (id или название)${defaultAccount ? `; по умолчанию «${defaultAccount}»` : ""}`),
    date: dateSchema.describe("Дата YYYY-MM-DD или YYYY-MM-DD HH:mm (по умолчанию — сейчас)"),
    comment: z.string().max(2048).optional(),
    currency: idOrName.optional().describe("Валюта (код RUB/USD/EUR или id), по умолчанию основная"),
  };
  const needAccount = (a) => {
    const acc = a.account ?? defaultAccount;
    if (acc === undefined) throw new Error("Не указан счёт (account). Посмотрите list_accounts.");
    return acc;
  };

  server.registerTool(
    "add_expense",
    {
      title: "Добавить расход",
      description: "Записать расход. amount — положительное число в валюте (например 349.90).",
      inputSchema: {
        amount: z.number().positive(),
        category: idOrName.describe("Категория расходов (id или название)"),
        ...common,
      },
    },
    wrap(async (a) =>
      api().addSimple(3, { amount: a.amount, target: a.category, account: needAccount(a), date: a.date, comment: a.comment, currency: a.currency }),
    ),
  );

  server.registerTool(
    "add_income",
    {
      title: "Добавить доход",
      description: "Записать доход. amount — положительное число в валюте.",
      inputSchema: {
        amount: z.number().positive(),
        source: idOrName.describe("Источник дохода (id или название)"),
        ...common,
      },
    },
    wrap(async (a) =>
      api().addSimple(2, { amount: a.amount, target: a.source, account: needAccount(a), date: a.date, comment: a.comment, currency: a.currency }),
    ),
  );

  server.registerTool(
    "add_transfer",
    {
      title: "Перевод между счетами",
      description: "Перевести деньги с одного счёта на другой (в одной валюте).",
      inputSchema: {
        amount: z.number().positive(),
        from_account: idOrName,
        to_account: idOrName,
        date: common.date,
        comment: common.comment,
        currency: common.currency,
      },
    },
    wrap((a) =>
      api().addTransfer({ amount: a.amount, fromAccount: a.from_account, toAccount: a.to_account, date: a.date, comment: a.comment, currency: a.currency }),
    ),
  );

  server.registerTool(
    "add_currency_exchange",
    {
      title: "Обмен валюты",
      description: "Обмен валюты: продано from_amount в from_currency, получено to_amount в to_currency.",
      inputSchema: {
        from_amount: z.number().positive(),
        from_currency: idOrName,
        to_amount: z.number().positive(),
        to_currency: idOrName,
        account: idOrName.describe("Счёт, с которого списана исходная валюта"),
        to_account: idOrName.optional().describe("Счёт, куда зачислена новая валюта (по умолчанию тот же)"),
        date: common.date,
        comment: common.comment,
      },
    },
    wrap((a) =>
      api().addExchange({
        fromAmount: a.from_amount,
        fromCurrency: a.from_currency,
        toAmount: a.to_amount,
        toCurrency: a.to_currency,
        account: a.account,
        toAccount: a.to_account,
        date: a.date,
        comment: a.comment,
      }),
    ),
  );

  server.registerTool(
    "update_transaction",
    {
      title: "Изменить операцию",
      description: "Изменить расход или доход по id (только переданные поля). category — категория для расхода или источник для дохода.",
      inputSchema: {
        id: z.number().int(),
        amount: z.number().positive().optional(),
        category: idOrName.optional(),
        account: idOrName.optional(),
        date: dateSchema,
        comment: z.string().max(2048).optional(),
        currency: idOrName.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    wrap(({ id, ...changes }) => api().updateRecord(id, changes)),
  );

  server.registerTool(
    "delete_transaction",
    {
      title: "Удалить операцию",
      description: "Удалить операцию по id. Для перевода/обмена удаляются обе половины. Необратимо.",
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true },
    },
    wrap((a) => api().deleteRecord(a.id)),
  );

  server.registerTool(
    "create_category",
    {
      title: "Создать категорию / источник / счёт / тег",
      description:
        "Создать категорию расходов (kind=category), источник дохода (source), счёт (account), долговой счёт (debt) или тег (tag).",
      inputSchema: {
        kind: z.enum(["category", "source", "account", "debt", "tag"]),
        name: z.string().min(1),
        parent: idOrName.optional().describe("Родитель (для вложенных категорий)"),
        description: z.string().optional(),
      },
    },
    wrap((a) => api().createObject(a.kind, { name: a.name, parent: a.parent, description: a.description })),
  );
}

// ---- entry
if (process.argv.includes("--check")) {
  try {
    const b = await api().balance();
    console.log(`OK: подключение работает, счетов: ${b.accounts.length}. Итоги:`, b.totals_by_currency);
    process.exit(0);
  } catch (e) {
    console.error(`Ошибка: ${e.message}`);
    process.exit(1);
  }
} else {
  await server.connect(new StdioServerTransport());
}
