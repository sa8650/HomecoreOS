import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

export interface PgliteHarness {
  pg: PGlite;
  fetch: typeof fetch;
  close: () => Promise<void>;
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(
  THIS_DIR,
  "../../../../database/migrations"
);

export async function createPglitePostgrest(): Promise<PgliteHarness> {
  const pg = new PGlite();

  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f: string) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await pg.exec(sql);
  }

  const customFetch: typeof fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const prefer = headers.get("Prefer") ?? "";
    const accept = headers.get("Accept") ?? "";
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body
          ? await new Response(init.body).text()
          : "";

    try {
      // RPC calls: /rest/v1/rpc/<fn>
      const rpcMatch = url.pathname.match(/\/rest\/v1\/rpc\/([a-zA-Z0-9_]+)$/);
      if (rpcMatch) {
        const fnName = rpcMatch[1]!;
        const args = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        const entries = Object.entries(args);
        const placeholders = entries.map(([k], i) => `${quoteIdent(k)} => $${i + 1}`);
        const values = entries.map(([, v]) => v);
        const sql = `SELECT * FROM public.${quoteIdent(fnName)}(${placeholders.join(", ")})`;
        const res = await pg.query(sql, values);
        return jsonResponse(200, res.rows);
      }

      const tableMatch = url.pathname.match(/\/rest\/v1\/([a-zA-Z0-9_]+)$/);
      if (!tableMatch) {
        return jsonResponse(404, { message: `Unknown REST path: ${url.pathname}` });
      }
      const table = quoteIdent(tableMatch[1]!);

      // Parse query parameters
      const whereParts: string[] = [];
      const params: unknown[] = [];

      const selectRaw = url.searchParams.get("select");
      const orderRaw = url.searchParams.get("order");
      const limitRaw = url.searchParams.get("limit");
      const offsetRaw = url.searchParams.get("offset");
      const onConflictRaw = url.searchParams.get("on_conflict");

      for (const [key, value] of url.searchParams.entries()) {
        if (["select", "order", "limit", "offset", "on_conflict"].includes(key)) {
          continue;
        }
        if (key === "or") {
          const parsedOr = parseOrFilter(value, params);
          if (parsedOr) whereParts.push(parsedOr);
          continue;
        }
        const clause = parseColumnFilter(key, value, params);
        if (clause) whereParts.push(clause);
      }

      const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
      const orderSql = orderRaw ? parseOrderClause(orderRaw) : "";
      const limitSql = limitRaw ? `LIMIT ${Number(limitRaw)}` : "";
      const offsetSql = offsetRaw ? `OFFSET ${Number(offsetRaw)}` : "";
      const selectCols = parseSelectColumns(selectRaw);

      if (method === "GET" || method === "HEAD") {
        let totalCount: number | null = null;
        if (prefer.includes("count=exact")) {
          const countRes = await pg.query<{ c: string }>(
            `SELECT COUNT(*)::text AS c FROM public.${table} ${whereSql}`,
            params
          );
          totalCount = Number(countRes.rows[0]?.c ?? "0");
        }

        if (method === "HEAD") {
          const h = new Headers();
          if (totalCount !== null) {
            h.set("content-range", `0-0/${totalCount}`);
          }
          return new Response(null, { status: 200, headers: h });
        }

        const sql = `SELECT ${selectCols} FROM public.${table} ${whereSql} ${orderSql} ${limitSql} ${offsetSql}`;
        const res = await pg.query(sql, params);
        const rows = res.rows;
        const respHeaders = new Headers({ "Content-Type": "application/json" });
        if (totalCount !== null) {
          respHeaders.set(
            "content-range",
            rows.length > 0 ? `0-${rows.length - 1}/${totalCount}` : `*/${totalCount}`
          );
        }

        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length !== 1) {
            return new Response(
              JSON.stringify({
                code: "PGRST116",
                details: `Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
                hint: null,
                message: "JSON object requested, multiple (or no) rows returned",
              }),
              { status: 406, headers: respHeaders }
            );
          }
          return new Response(JSON.stringify(rows[0]), {
            status: 200,
            headers: respHeaders,
          });
        }

        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: respHeaders,
        });
      }

      if (method === "POST") {
        const parsed = JSON.parse(bodyText || "{}");
        const rowsToInsert = Array.isArray(parsed) ? parsed : [parsed];
        if (rowsToInsert.length === 0) {
          return jsonResponse(201, []);
        }

        const columns = Array.from(
          new Set(rowsToInsert.flatMap((r) => Object.keys(r as Record<string, unknown>)))
        );
        const insertParams: unknown[] = [];
        const valueTuples: string[] = [];

        for (const rowObj of rowsToInsert as Record<string, unknown>[]) {
          const tuplePlaceholders: string[] = [];
          for (const col of columns) {
            if (col in rowObj) {
              insertParams.push(normalizePgValue(rowObj[col]));
              tuplePlaceholders.push(`$${insertParams.length}`);
            } else {
              tuplePlaceholders.push("DEFAULT");
            }
          }
          valueTuples.push(`(${tuplePlaceholders.join(", ")})`);
        }

        let conflictSql = "";
        if (prefer.includes("resolution=merge-duplicates") && onConflictRaw) {
          const conflictCols = onConflictRaw
            .split(",")
            .map((c) => quoteIdent(c.trim()))
            .join(", ");
          const updates = columns
            .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
            .join(", ");
          conflictSql = `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updates}`;
        } else if (prefer.includes("resolution=ignore-duplicates")) {
          conflictSql = "ON CONFLICT DO NOTHING";
        }

        const returningSql = prefer.includes("return=representation")
          ? `RETURNING ${selectCols}`
          : "";

        const sql = `INSERT INTO public.${table} (${columns
          .map(quoteIdent)
          .join(", ")}) VALUES ${valueTuples.join(", ")} ${conflictSql} ${returningSql}`;

        const res = await pg.query(sql, insertParams);
        if (!prefer.includes("return=representation")) {
          return new Response("", { status: 201 });
        }
        if (accept.includes("application/vnd.pgrst.object+json")) {
          return jsonResponse(201, res.rows[0] ?? null);
        }
        return jsonResponse(201, res.rows);
      }

      if (method === "PATCH") {
        const patchObj = JSON.parse(bodyText || "{}") as Record<string, unknown>;
        const entries = Object.entries(patchObj);
        if (entries.length === 0) {
          return jsonResponse(200, []);
        }

        const setParts: string[] = [];
        const allParams: unknown[] = [];
        for (const [k, v] of entries) {
          allParams.push(normalizePgValue(v));
          setParts.push(`${quoteIdent(k)} = $${allParams.length}`);
        }

        // Shift filter params placeholders
        const shiftedWhere = shiftPlaceholders(whereSql, allParams.length);
        allParams.push(...params);

        const returningSql = prefer.includes("return=representation")
          ? `RETURNING ${selectCols}`
          : "";

        const sql = `UPDATE public.${table} SET ${setParts.join(", ")} ${shiftedWhere} ${returningSql}`;
        const res = await pg.query(sql, allParams);

        if (!prefer.includes("return=representation")) {
          return new Response("", { status: 204 });
        }
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (res.rows.length !== 1) {
            return jsonResponse(406, {
              code: "PGRST116",
              details: `Results contain ${res.rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
              hint: null,
              message: "JSON object requested, multiple (or no) rows returned",
            });
          }
          return jsonResponse(200, res.rows[0]);
        }
        return jsonResponse(200, res.rows);
      }

      if (method === "DELETE") {
        const returningSql = prefer.includes("return=representation")
          ? `RETURNING ${selectCols}`
          : "";
        const sql = `DELETE FROM public.${table} ${whereSql} ${returningSql}`;
        const res = await pg.query(sql, params);
        if (!prefer.includes("return=representation")) {
          return new Response("", { status: 204 });
        }
        return jsonResponse(200, res.rows);
      }

      return jsonResponse(405, { message: `Unsupported method ${method}` });
    } catch (err) {
      const e = err as { code?: string; message?: string; detail?: string };
      return jsonResponse(400, {
        code: e.code ?? "PGERR",
        message: e.message ?? "PostgreSQL query error",
        details: e.detail ?? null,
        hint: null,
      });
    }
  };

  return {
    pg,
    fetch: customFetch,
    close: () => pg.close(),
  };
}

function quoteIdent(ident: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) {
    throw new Error(`Invalid SQL identifier: ${ident}`);
  }
  return `"${ident}"`;
}

function parseSelectColumns(selectRaw: string | null): string {
  if (!selectRaw || selectRaw.trim() === "*") return "*";
  return selectRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (s === "*") return "*";
      return quoteIdent(s);
    })
    .join(", ");
}

function parseOrderClause(orderRaw: string): string {
  const parts = orderRaw.split(",").map((part) => {
    const segments = part.trim().split(".");
    const col = quoteIdent(segments[0]!);
    const dir = segments[1]?.toLowerCase() === "desc" ? "DESC" : "ASC";
    const nulls =
      segments[2]?.toLowerCase() === "nullsfirst"
        ? "NULLS FIRST"
        : segments[2]?.toLowerCase() === "nullslast"
          ? "NULLS LAST"
          : "";
    return `${col} ${dir} ${nulls}`.trim();
  });
  return `ORDER BY ${parts.join(", ")}`;
}

function parseColumnFilter(
  colRaw: string,
  expr: string,
  params: unknown[]
): string | null {
  const col = quoteIdent(colRaw);
  if (expr.startsWith("not.")) {
    const inner = parseColumnFilter(colRaw, expr.slice(4), params);
    return inner ? `NOT (${inner})` : null;
  }
  if (expr.startsWith("eq.")) {
    params.push(coerceScalar(expr.slice(3)));
    return `${col} = $${params.length}`;
  }
  if (expr.startsWith("neq.")) {
    params.push(coerceScalar(expr.slice(4)));
    return `${col} <> $${params.length}`;
  }
  if (expr.startsWith("gt.")) {
    params.push(coerceScalar(expr.slice(3)));
    return `${col} > $${params.length}`;
  }
  if (expr.startsWith("gte.")) {
    params.push(coerceScalar(expr.slice(4)));
    return `${col} >= $${params.length}`;
  }
  if (expr.startsWith("lt.")) {
    params.push(coerceScalar(expr.slice(3)));
    return `${col} < $${params.length}`;
  }
  if (expr.startsWith("lte.")) {
    params.push(coerceScalar(expr.slice(4)));
    return `${col} <= $${params.length}`;
  }
  if (expr.startsWith("ilike.")) {
    params.push(expr.slice(6).replace(/\*/g, "%"));
    return `${col}::text ILIKE $${params.length}`;
  }
  if (expr.startsWith("like.")) {
    params.push(expr.slice(5).replace(/\*/g, "%"));
    return `${col}::text LIKE $${params.length}`;
  }
  if (expr === "is.null") {
    return `${col} IS NULL`;
  }
  if (expr === "is.not.null" || expr === "not.is.null") {
    return `${col} IS NOT NULL`;
  }
  if (expr.startsWith("in.(") && expr.endsWith(")")) {
    const inner = expr.slice(4, -1);
    if (!inner.trim()) return "FALSE";
    const items = inner.split(",").map((x) => coerceScalar(x.trim().replace(/^"|"$/g, "")));
    const placeholders = items.map((item) => {
      params.push(item);
      return `$${params.length}`;
    });
    return `${col} IN (${placeholders.join(", ")})`;
  }
  if (expr.startsWith("cs.{") && expr.endsWith("}")) {
    const inner = expr.slice(4, -1);
    const items = inner ? inner.split(",").map((s) => s.trim().replace(/^"|"$/g, "")) : [];
    params.push(items);
    return `${col} @> $${params.length}`;
  }
  throw new Error(`Unsupported PostgREST filter expression: ${colRaw}=${expr}`);
}

function parseOrFilter(expr: string, params: unknown[]): string | null {
  if (!expr.startsWith("(") || !expr.endsWith(")")) return null;
  const body = expr.slice(1, -1);
  const items = splitTopLevelComma(body);
  const sqlParts: string[] = [];
  for (const item of items) {
    const firstDot = item.indexOf(".");
    if (firstDot === -1) continue;
    const col = item.slice(0, firstDot);
    const rest = item.slice(firstDot + 1);
    const clause = parseColumnFilter(col, rest, params);
    if (clause) sqlParts.push(clause);
  }
  return sqlParts.length > 0 ? `(${sqlParts.join(" OR ")})` : null;
}

function splitTopLevelComma(str: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of str) {
    if (ch === "(" || ch === "{") depth++;
    if (ch === ")" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function coerceScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  return raw;
}

function normalizePgValue(val: unknown): unknown {
  if (val === undefined) return null;
  if (Array.isArray(val)) return val;
  if (val !== null && typeof val === "object" && !(val instanceof Date)) {
    return JSON.stringify(val);
  }
  return val;
}

function shiftPlaceholders(sql: string, offset: number): string {
  if (!sql || offset === 0) return sql;
  return sql.replace(/\$(\d+)/g, (_, num) => `$${Number(num) + offset}`);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
