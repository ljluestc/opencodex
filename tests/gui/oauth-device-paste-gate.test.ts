import { describe, expect, test } from "bun:test";
import { shouldShowLoginPaste } from "../../gui/src/components/login-url-block";

/**
 * The paste field is the manual fallback for an AUTHORIZATION-CODE login: the browser
 * could not reach the loopback callback, so the operator pastes the redirect URL. A
 * device grant has no callback and nothing to paste — the operator types the device
 * code into the vendor's page and the proxy settles the login by polling.
 *
 * Rendering it anyway is what made a successful Meta Muse approval look unfinished:
 * the code had been approved, the backend was already polling, and the dialog still
 * showed a field labelled "paste the redirect URL", which no Meta screen produces.
 *
 * The gate is a pure predicate exported from the component so this reads the real
 * rule rather than a copy of it, the way oauth-first-add-hint.test.ts does for the
 * catalog-row visibility rule.
 */

const paste = {
  value: "",
  busy: false,
  message: "",
  ok: true,
  onChange: () => {},
  onSubmit: () => {},
};

describe("device-code login hides the callback paste", () => {
  test("an active device code suppresses the paste field", () => {
    expect(shouldShowLoginPaste({ deviceCode: "WDJB-MJHT", url: "https://device.example.test" }, paste)).toBe(false);
    // Prose alone does not rescue it: the flow is still a device grant.
    expect(shouldShowLoginPaste({ deviceCode: "WDJB-MJHT", instructions: "Enter code: WDJB-MJHT" }, paste)).toBe(false);
  });

  test("an authorization-code login keeps the paste field", () => {
    expect(shouldShowLoginPaste({ url: "https://accounts.example.test/oauth/authorize?x=1" }, paste)).toBe(true);
  });

  test("the paste field returns once a flow leaves device mode", () => {
    // Meta Muse's fallback: the device grant failed and the provider now wants a
    // hand-entered key. The live hint carries no device code, so the only way in
    // must come back — which is why the gate reads the hint and not a one-time flag
    // captured when the flow started.
    const fallback = { url: "https://dev.meta.ai", instructions: "Paste your Muse Code API key below." };
    expect(shouldShowLoginPaste(fallback, paste)).toBe(true);
  });

  test("a surface that offers no paste at all stays unaffected", () => {
    expect(shouldShowLoginPaste({ deviceCode: "WDJB-MJHT" }, undefined)).toBe(false);
    expect(shouldShowLoginPaste({ url: "https://accounts.example.test/oauth/authorize" }, undefined)).toBe(false);
  });
});
