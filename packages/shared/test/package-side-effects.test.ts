import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * package.json declares `"sideEffects": false`. Bundlers then leave out every
 * module of this package whose exports are unused: the web bundle loads the
 * USB identity rules only with the flasher, and never ships the Seeed
 * reference profiles, which only the Worker reads.
 *
 * That promise holds only while importing a module does nothing but declare
 * things. A module that runs code at import time (registers something, patches
 * a global) would silently lose that code in production builds.
 */
const packageRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(packageRoot, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Top-level statements that do something when the module is imported. */
function importTimeStatements(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of source.statements) {
    const declares =
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isVariableStatement(statement);
    if (declares) continue;
    const { line } = source.getLineAndCharacterOfPosition(statement.getStart());
    found.push(`${name}:${line + 1} ${statement.getText().split("\n")[0]!.slice(0, 80)}`);
  }
  return found;
}

describe("@homecoreos/shared is free of import-time side effects", () => {
  it("declares it in package.json", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      sideEffects?: unknown;
    };
    expect(manifest.sideEffects).toBe(false);
  });

  it("has only declarations at the top level of every source module", () => {
    const files = sourceFiles(sourceRoot);
    const names = files.map((file) => path.relative(sourceRoot, file));
    // The scan must see the modules the promise matters for.
    expect(names).toEqual(
      expect.arrayContaining(["index.ts", "seeed-xiao-catalog.ts", "usb-board-identity.ts", "gpio-pin-selector.ts"])
    );
    const found = files.flatMap((file, index) => importTimeStatements(`src/${names[index]}`, readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });

  it("the scan reports a module that runs code when it is imported", () => {
    // Guards the check itself: a scan that accepts everything proves nothing.
    const sample = [
      'import { register } from "./registry";',
      "export const board = { slug: \"demo\" };",
      "register(board);",
      "if (board.slug) {",
      "  globalThis.demo = board;",
      "}",
      "export function later() {",
      "  register(board);",
      "}",
    ].join("\n");
    expect(importTimeStatements("sample.ts", sample)).toEqual([
      "sample.ts:3 register(board);",
      "sample.ts:4 if (board.slug) {",
    ]);
  });
});
