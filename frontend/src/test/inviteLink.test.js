import { describe, it, expect } from "vitest";
import { buildInviteUrl, parseJoinCode, normalizeJoinCode, JOIN_PARAM } from "../inviteLink";

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
});
