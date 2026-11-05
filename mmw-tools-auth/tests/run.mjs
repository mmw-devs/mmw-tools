import { runAuthTests } from "./auth.test.mjs";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`not ok ${name}`);
  }
}

try {
  await runAuthTests(test);
} catch (error) {
  failed += 1;
  failures.push({ name: "suite bootstrap", error });
  console.error("not ok suite bootstrap");
}

for (const failure of failures) {
  console.error(`\n--- ${failure.name} ---`);
  console.error(failure.error?.stack ?? failure.error);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
