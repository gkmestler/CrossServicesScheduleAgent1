import assert from "node:assert/strict";
import { test } from "node:test";

import { describeFailure, toSafeMessage } from "../lib/errors.ts";

test("names the cause for the failures that actually happen during setup", () => {
  const cases: [string, RegExp][] = [
    [`relation "schedules" does not exist`, /db:push/],
    ["DATABASE_URL is not set on this deployment.", /DATABASE_URL is not set/],
    ["getaddrinfo ENOTFOUND db.abc.supabase.co", /transaction pooler string on port 6543/],
    ["Connection terminated unexpectedly", /paused itself/],
    ['password authentication failed for user "postgres"', /rejected the password/],
    ["Tenant or user not found", /must include the project reference/],
  ];
  for (const [raw, expected] of cases) {
    assert.match(describeFailure(new Error(raw)), expected, raw);
  }
});

test("never lets a credential reach the browser", () => {
  // A driver error can quote the whole connection string, password included.
  const leaky = new Error(
    "connect ECONNREFUSED postgresql://postgres.abc:hunter2Secret@host.pooler.supabase.com:6543/postgres",
  );
  const safe = toSafeMessage(leaky);
  assert.doesNotMatch(safe, /hunter2Secret/, "the database password leaked");
  assert.match(safe, /\[connection string\]/);

  assert.doesNotMatch(
    toSafeMessage(new Error("bad key sk-ant-api03-abc123XYZ")),
    /abc123XYZ/,
    "the Anthropic key leaked",
  );
  assert.doesNotMatch(
    toSafeMessage(new Error("rejected AIzaSyD-ExampleKey123456")),
    /ExampleKey/,
    "the Google key leaked",
  );
});

test("falls back to the original message rather than swallowing it", () => {
  assert.equal(describeFailure(new Error("Something specific broke")), "Something specific broke");
  assert.equal(describeFailure(new Error("")), "Something went wrong.");
});
