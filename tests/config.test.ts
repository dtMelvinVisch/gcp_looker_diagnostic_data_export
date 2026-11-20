import { describe, expect, it } from "vitest";
import { loadConfig, parsePayload, ConfigError } from "../src/config";
import { baseEnv } from "./helpers";

describe("loadConfig", () => {
  it("loads defaults", () => {
    const c = loadConfig(baseEnv);
    expect(c.slowField).toBe("async_processing");
    expect(c.slowThresholdS).toBe(30);
    expect(c.lagS).toBe(300);
    expect(c.lookerBaseUrl).toBe("https://acme.cloud.looker.com");
    expect(c.region).toBe("europe-west9");
  });
  it("reports all problems at once, without secret values", () => {
    try {
      loadConfig({ ...baseEnv, DT_ENV_URL: "http://evil", LOOKER_CLIENT_SECRET: "", SLOW_QUERY_THRESHOLD_S: "abc", LOG_LEVEL: "loud" });
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).problems.join("|");
      expect(msg).toMatch(/DT_ENV_URL/);
      expect(msg).toMatch(/LOOKER_CLIENT_SECRET/);
      expect(msg).toMatch(/SLOW_QUERY_THRESHOLD_S/);
      expect(msg).toMatch(/LOG_LEVEL/);
      expect(msg).not.toMatch(/SECRETSECRET/);
    }
  });
  it.each([
    "http://acme.cloud.looker.com",
    "https://169.254.169.254",
    "https://localhost",
    "https://metadata.google.internal",
    "https://user:pw@acme.cloud.looker.com",
    "https://[::1]",
  ])("rejects unsafe Looker URL %s", (url) => {
    expect(() => loadConfig({ ...baseEnv, LOOKER_BASE_URL: url })).toThrow(ConfigError);
  });
  it("accepts original deployment on port 19999 and normalises to origin", () => {
    const c = loadConfig({ ...baseEnv, LOOKER_DEPLOYMENT: "original", LOOKER_BASE_URL: "https://acme.looker.com:19999/" });
    expect(c.lookerBaseUrl).toBe("https://acme.looker.com:19999");
  });
  it("restricts the Dynatrace host to dynatrace suffixes", () => {
    expect(() => loadConfig({ ...baseEnv, DT_ENV_URL: "https://abc.example.com" })).toThrow(ConfigError);
    expect(loadConfig({ ...baseEnv, DT_ENV_URL: "https://abc.sprint.dynatracelabs.com", DT_HOST_SUFFIXES: ".dynatracelabs.com" }).dtEnvUrl)
      .toBe("https://abc.sprint.dynatracelabs.com");
  });
  it("rejects unknown slow field and out-of-range numbers", () => {
    expect(() => loadConfig({ ...baseEnv, SLOW_QUERY_FIELD: "nope" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, MAX_CATCHUP_MIN: "120" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, MAX_CATCHUP_MIN: "58", LAG_SECONDS: "300" })).toThrow(/58 minutes/);
  });
  it("flags old or unknown Looker versions", () => {
    expect(loadConfig({ ...baseEnv, LOOKER_VERSION: "25.18" }).versionCaveat).toBe(true);
    expect(loadConfig({ ...baseEnv, LOOKER_VERSION: "26.20" }).versionCaveat).toBe(false);
    const { LOOKER_VERSION: _v, ...noVer } = baseEnv;
    expect(loadConfig(noVer).versionCaveat).toBe(true);
  });
});

describe("parsePayload", () => {
  it("accepts a valid payload", () => {
    expect(parsePayload({ job: "overall", groups: ["overall"], events: true, windowMin: 1 })).toEqual({ job: "overall", groups: ["overall"], events: true, windowMin: 1, lateCheckMin: 0 });
  });
  it("defaults events=false and windowMin=1", () => {
    expect(parsePayload({ job: "d", groups: ["queue"] })).toMatchObject({ events: false, windowMin: 1 });
  });
  it.each([null, "x", {}, { job: "../x", groups: ["queue"] }, { job: "a", groups: ["nope"] }, { job: "a", groups: [] }, { job: "a", groups: ["queue"], windowMin: 99 }, { job: "a", groups: ["queue"], lateCheckMin: 99 }])(
    "rejects %j", (b) => { expect(() => parsePayload(b)).toThrow(ConfigError); });
});
