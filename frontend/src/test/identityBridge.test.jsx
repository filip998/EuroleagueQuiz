import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  AuthContext,
  resolveDisplayName,
  useClerkPrefilledName,
} from "../identityBridge";
import { NICKNAME_MAX_LENGTH } from "../identity";

describe("resolveDisplayName precedence", () => {
  it("prefers the Clerk username over the guest fallback", () => {
    expect(
      resolveDisplayName({ username: "luka77", fullName: "Luka D" }, "guest")
    ).toBe("luka77");
  });

  it("falls back to fullName, then firstName", () => {
    expect(resolveDisplayName({ fullName: "Luka Doncic" }, "guest")).toBe("Luka Doncic");
    expect(resolveDisplayName({ firstName: "Luka" }, "guest")).toBe("Luka");
  });

  it("uses the guest fallback when signed out (no user)", () => {
    expect(resolveDisplayName(null, "Guest 4821")).toBe("Guest 4821");
  });

  it("uses the guest fallback when the user has no usable name", () => {
    expect(resolveDisplayName({ id: "u1" }, "Guest 4821")).toBe("Guest 4821");
  });

  it("never uses the email address (no PII as a public name)", () => {
    expect(
      resolveDisplayName(
        { primaryEmailAddress: { emailAddress: "me@example.com" } },
        "Guest 1"
      )
    ).toBe("Guest 1");
  });

  it("clamps an overlong Clerk name to the nickname limit", () => {
    const long = "a".repeat(NICKNAME_MAX_LENGTH + 25);
    expect(resolveDisplayName({ username: long }, "guest").length).toBe(
      NICKNAME_MAX_LENGTH
    );
  });
});

function Probe({ getFallback }) {
  const [name, setName] = useClerkPrefilledName(getFallback);
  return (
    <input
      aria-label="name"
      value={name}
      onChange={(e) => setName(e.target.value)}
    />
  );
}

function renderWithAuth(ui, identity) {
  return render(
    <AuthContext.Provider value={identity}>{ui}</AuthContext.Provider>
  );
}

const SIGNED_OUT = { isLoaded: true, isSignedIn: false, user: null };
const signedIn = (user) => ({ isLoaded: true, isSignedIn: true, user });

describe("useClerkPrefilledName", () => {
  it("seeds from the guest fallback when signed out", () => {
    renderWithAuth(<Probe getFallback={() => "Guest 99"} />, SIGNED_OUT);
    expect(screen.getByLabelText("name")).toHaveValue("Guest 99");
  });

  it("prefers the Clerk name when signed in", () => {
    renderWithAuth(
      <Probe getFallback={() => "Guest 99"} />,
      signedIn({ username: "clerk_user" })
    );
    expect(screen.getByLabelText("name")).toHaveValue("clerk_user");
  });

  it("upgrades to the Clerk name when it loads after an unedited render", async () => {
    const { rerender } = renderWithAuth(
      <Probe getFallback={() => "Guest 99"} />,
      SIGNED_OUT
    );
    expect(screen.getByLabelText("name")).toHaveValue("Guest 99");

    rerender(
      <AuthContext.Provider value={signedIn({ username: "clerk_user" })}>
        <Probe getFallback={() => "Guest 99"} />
      </AuthContext.Provider>
    );
    await waitFor(() =>
      expect(screen.getByLabelText("name")).toHaveValue("clerk_user")
    );
  });

  it("never clobbers a value the user has typed", async () => {
    const { rerender } = renderWithAuth(
      <Probe getFallback={() => "Guest 99"} />,
      SIGNED_OUT
    );
    const input = screen.getByLabelText("name");
    fireEvent.change(input, { target: { value: "MyChosenName" } });
    expect(input).toHaveValue("MyChosenName");

    // Clerk signs in afterwards; the edited field must be preserved.
    rerender(
      <AuthContext.Provider value={signedIn({ username: "clerk_user" })}>
        <Probe getFallback={() => "Guest 99"} />
      </AuthContext.Provider>
    );
    await waitFor(() => {});
    expect(screen.getByLabelText("name")).toHaveValue("MyChosenName");
  });
});
