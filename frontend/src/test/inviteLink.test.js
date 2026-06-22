import { describe, it, expect } from "vitest";
import {
  buildInviteUrl,
  parseJoinCode,
  parseInviteMode,
  normalizeJoinCode,
  JOIN_PARAM,
  MODE_PARAM,
  RACE_INVITE_MODE,
} from "../inviteLink";

describe("normalizeJoinCode", () => {
  it("uppercases and trims a valid 6-char code", () => {
    expect(normalizeJoinCode("  abc123 ")).toBe("ABC123");
  });

  it("returns '' for anything that is not 6 alphanumerics", () => {
    expect(normalizeJoinCode("abc12")).toBe("");
    expect(normalizeJoinCode("abc1234")).toBe("");
    expect(normalizeJoinCode("abc-12")).toBe("");
    expect(normalizeJoinCode("")).toBe("");
    expect(normalizeJoinCode(null)).toBe("");
    expect(normalizeJoinCode(undefined)).toBe("");
  });
});

describe("parseJoinCode", () => {
  it("extracts and normalizes the join param from a search string", () => {
    expect(parseJoinCode("?join=abc123")).toBe("ABC123");
    expect(parseJoinCode("join=ABC123")).toBe("ABC123");
    expect(parseJoinCode("?foo=1&join=xyz789")).toBe("XYZ789");
  });

  it("returns '' when the param is missing or invalid", () => {
    expect(parseJoinCode("")).toBe("");
    expect(parseJoinCode("?other=1")).toBe("");
    expect(parseJoinCode("?join=nope")).toBe("");
    expect(parseJoinCode(null)).toBe("");
    expect(parseJoinCode(undefined)).toBe("");
  });
});

describe("buildInviteUrl", () => {
  it("builds a shareable tictactoe invite URL from a code", () => {
    expect(buildInviteUrl("ABC123", "/tictactoe", "https://play.example.com")).toBe(
      "https://play.example.com/tictactoe?join=ABC123"
    );
  });

  it("normalizes the code before embedding it", () => {
    expect(buildInviteUrl("  abc123 ", "/tictactoe", "https://play.example.com")).toBe(
      "https://play.example.com/tictactoe?join=ABC123"
    );
  });

  it("defaults to the tictactoe path and the current window origin", () => {
    expect(buildInviteUrl("ABC123")).toBe(
      `${window.location.origin}/tictactoe?join=ABC123`
    );
  });

  it("returns '' for an invalid code so callers fall back to the plain code", () => {
    expect(buildInviteUrl("nope", "/tictactoe", "https://play.example.com")).toBe("");
    expect(buildInviteUrl("", "/tictactoe", "https://play.example.com")).toBe("");
  });

  it("exposes the join query param name", () => {
    expect(JOIN_PARAM).toBe("join");
  });

  it("appends extra query params (e.g. mode=race) without dropping the join code", () => {
    const inviteUrl = buildInviteUrl("abc123", "/list", "https://play.example.com", {
      [MODE_PARAM]: RACE_INVITE_MODE,
    });
    const url = new URL(inviteUrl);
    expect(url.pathname).toBe("/list");
    expect(url.searchParams.get(JOIN_PARAM)).toBe("ABC123");
    expect(url.searchParams.get(MODE_PARAM)).toBe("race");
  });

  it("never lets extra params override the validated join code and skips empty values", () => {
    const inviteUrl = buildInviteUrl("ABC123", "/list", "https://play.example.com", {
      [JOIN_PARAM]: "HACKED",
      mode: "",
      extra: undefined,
    });
    const url = new URL(inviteUrl);
    expect(url.searchParams.get(JOIN_PARAM)).toBe("ABC123");
    expect(url.searchParams.get("mode")).toBeNull();
    expect(url.searchParams.get("extra")).toBeNull();
  });
});

describe("parseInviteMode", () => {
  it("extracts and lowercases the mode param", () => {
    expect(parseInviteMode("?mode=race")).toBe("race");
    expect(parseInviteMode("?mode=RACE")).toBe("race");
    expect(parseInviteMode("?join=ABC123&mode=race")).toBe("race");
  });

  it("returns '' when the mode param is missing or unparseable", () => {
    expect(parseInviteMode("?join=ABC123")).toBe("");
    expect(parseInviteMode("")).toBe("");
    expect(parseInviteMode(null)).toBe("");
    expect(parseInviteMode(undefined)).toBe("");
  });

  it("exposes the race invite constants", () => {
    expect(MODE_PARAM).toBe("mode");
    expect(RACE_INVITE_MODE).toBe("race");
  });
});
