/**
 * The skill provider must satisfy the registry's two shapes:
 *   list()            -> candidates  (name, description, source, rank, provider)
 *   get(candidate)    -> definition  (name, description, source, provider, content)
 *
 * These assertions mirror the checks in @deepseek-ai/dsh-skill's
 * validateCandidate / validateDefinition, because a mismatch there surfaces
 * only at runtime, as a session that fails to start - which is how
 * "non-string source" reached the user.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "..", "lib", "index.js");

let pass = 0;
let fail = 0;
function ok(label) {
  pass++;
  console.log(`  PASS  ${label}`);
}
function bad(label, detail) {
  fail++;
  console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
}
function truthy(value, label) {
  value ? ok(label) : bad(label);
}
function eq(actual, expected, label) {
  actual === expected ? ok(label) : bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

console.log("--- skill provider shape ---");
const mod = await import(pathToFileURL(path.resolve(DIST)).href);
truthy(typeof mod.registerSkills === "function", "registerSkills is exported");

const registered = [];
const fakeSkills = {
  registerProvider(create) {
    registered.push(create());
    return () => {};
  },
};
const fakeCtx = { get: (name) => (name === "skills" ? fakeSkills : undefined) };
const warnings = [];
mod.registerSkills(fakeCtx, { warn: (m) => warnings.push(m) });

eq(registered.length, 1, "exactly one provider registered");
const provider = registered[0];
eq(provider.name, "github-engineer", "provider name");

const candidates = await provider.list();
truthy(Array.isArray(candidates) && candidates.length > 0, "list() returns candidates");

for (const candidate of candidates) {
  const label = candidate.name;
  truthy(typeof candidate.name === "string" && SKILL_NAME.test(candidate.name), `${label}: valid name`);
  truthy(typeof candidate.description === "string" && candidate.description.length > 0, `${label}: description`);
  truthy(typeof candidate.source === "string", `${label}: source is a string`);
  truthy(typeof candidate.provider === "string" && candidate.provider === provider.name, `${label}: provider matches`);
  truthy(typeof candidate.rank === "number" && Number.isFinite(candidate.rank), `${label}: rank is finite`);

  const definition = await provider.get(candidate);
  truthy(definition !== null && typeof definition === "object", `${label}: get() returns a definition`);
  truthy(typeof definition.content === "string" && definition.content.length > 0, `${label}: definition has content`);
  eq(definition.provider, provider.name, `${label}: definition provider`);
  truthy(typeof definition.source === "string", `${label}: definition source`);

  // The body must not be swallowed by its own example fences.
  truthy(definition.content.includes("preflight"), `${label}: body survived fence nesting`);
}

console.log("\n--- skill file hygiene ---");
const skillsDir = path.join(ROOT, "..", "skills");
const dirs = existsSync(skillsDir) ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
truthy(dirs.length > 0, "at least one skill directory ships");
for (const dir of dirs) {
  const file = path.join(skillsDir, dir.name, "SKILL.md");
  truthy(existsSync(file), `${dir.name}: SKILL.md exists`);
  const raw = readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  truthy(match !== null, `${dir.name}: frontmatter parses`);
  if (match) {
    truthy(/^name:\s*\S+/m.test(match[1]), `${dir.name}: frontmatter has name`);
    truthy(/^description:\s*\S+/m.test(match[1]), `${dir.name}: frontmatter has description`);
  }
  // Fence discipline: an inner example must be shorter than its wrapper.
  let open = null;
  let broken = false;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(`{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (open === null) open = { ticks: m[1].length };
    else if (m[2].trim() === "" && m[1].length >= open.ticks) open = null;
  }
  if (open !== null) broken = true;
  truthy(!broken, `${dir.name}: fences balanced`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
