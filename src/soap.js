// Minimal SOAP (rpc/encoded) client for the drebedengi.ru API.
// WSDL: https://www.drebedengi.ru/soap/dd.wsdl
// PHP SoapServer on the other side: associative arrays travel as Apache "ns2:Map",
// lists as SOAP-ENC:Array.

import { XMLParser } from "fast-xml-parser";

const ENDPOINT = "https://www.drebedengi.ru/soap/";

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Serialise a JS value as a SOAP-encoded element named `name`. */
function encode(name, v) {
  if (v === null || v === undefined) return `<${name} xsi:nil="true"/>`;
  if (typeof v === "boolean") return `<${name} xsi:type="xsd:boolean">${v}</${name}>`;
  if (typeof v === "number") {
    const t = Number.isInteger(v) ? "xsd:int" : "xsd:float";
    return `<${name} xsi:type="${t}">${v}</${name}>`;
  }
  if (Array.isArray(v)) {
    // PHP-style indexed array, encoded as map with 0..N keys (what PHP SoapClient sends).
    const items = v.map((x, i) => `<item>${encode("key", i)}${encode("value", x)}</item>`).join("");
    return `<${name} xsi:type="ns2:Map">${items}</${name}>`;
  }
  if (typeof v === "object") {
    const items = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `<item>${encode("key", k)}${encode("value", x)}</item>`)
      .join("");
    return `<${name} xsi:type="ns2:Map">${items}</${name}>`;
  }
  return `<${name} xsi:type="xsd:string">${esc(v)}</${name}>`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => name === "item",
});

/** Convert parsed SOAP-encoded node into plain JS. */
function decode(node) {
  if (node === undefined || node === null) return null;
  if (typeof node !== "object") return node;
  if (node["@nil"] === "true") return null;
  const type = node["@type"] || "";
  const items = node.item;
  if (type.endsWith(":Map") || type === "Map") {
    const out = {};
    for (const it of items || []) out[String(decode(it.key))] = decode(it.value);
    return out;
  }
  if (type.endsWith(":Array") || type === "Array" || node["@arrayType"]) {
    return (items || []).map(decode);
  }
  if (items) {
    // Untyped container: decide by presence of key/value pairs.
    if (items.every((it) => it && typeof it === "object" && "key" in it)) {
      const out = {};
      for (const it of items) out[String(decode(it.key))] = decode(it.value);
      return out;
    }
    return items.map(decode);
  }
  const text = node["#text"] ?? "";
  if (type.endsWith(":int") || type.endsWith(":integer") || type.endsWith(":long")) return Number(text);
  if (type.endsWith(":float") || type.endsWith(":double")) return Number(text);
  if (type.endsWith(":boolean")) return text === "true" || text === "1";
  return text;
}

export class DrebedengiError extends Error {}

export class DrebedengiClient {
  constructor({ apiId, login, password, endpoint = ENDPOINT, timeoutMs = 60000, minIntervalMs }) {
    if (!login || !password) {
      throw new DrebedengiError(
        "Не заданы DREBEDENGI_LOGIN / DREBEDENGI_PASSWORD (переменные окружения).",
      );
    }
    this.apiId = apiId || "demo_api";
    this.login = login;
    this.password = password;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    // The service asks clients not to flood it: requests are serialised and
    // spaced at least minIntervalMs apart.
    this.minIntervalMs = minIntervalMs ?? Number(process.env.DREBEDENGI_MIN_INTERVAL_MS ?? 1000);
    this.queue = Promise.resolve();
    this.lastAt = 0;
    this.requestCount = 0;
  }

  /**
   * Call a SOAP method. `args` is an ordered list of [name, value] pairs that
   * follow the standard apiId/login/pass triple.
   */
  call(method, args = []) {
    const run = async () => {
      const wait = this.lastAt + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await this.#send(method, args);
      } finally {
        this.lastAt = Date.now();
        this.requestCount++;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async #send(method, args) {
    const parts = [
      encode("apiId", this.apiId),
      encode("login", this.login),
      encode("pass", this.password),
      ...args.map(([n, v]) => encode(n, v)),
    ].join("");
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"` +
      ` xmlns:ns1="urn:ddengi" xmlns:xsd="http://www.w3.org/2001/XMLSchema"` +
      ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
      ` xmlns:ns2="http://xml.apache.org/xml-soap"` +
      ` xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"` +
      ` SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<SOAP-ENV:Body><ns1:${method}>${parts}</ns1:${method}></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: '"urn:SoapAction"',
        },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new DrebedengiError(`Сетевая ошибка при вызове ${method}: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    const xml = await res.text();
    let doc;
    try {
      doc = parser.parse(xml);
    } catch {
      throw new DrebedengiError(`Некорректный ответ сервера (HTTP ${res.status}): ${xml.slice(0, 300)}`);
    }
    const bodyNode = doc?.Envelope?.Body;
    if (!bodyNode) throw new DrebedengiError(`Пустой ответ (HTTP ${res.status}): ${xml.slice(0, 300)}`);
    if (bodyNode.Fault) {
      const f = bodyNode.Fault;
      const msg = decode(f.faultstring) || decode(f.detail) || "SOAP Fault";
      throw new DrebedengiError(`${method}: ${msg}`);
    }
    const resp = bodyNode[`${method}Response`];
    if (!resp || typeof resp !== "object") return null;
    const key = Object.keys(resp).find((k) => !k.startsWith("@"));
    return key ? decode(resp[key]) : null;
  }
}
