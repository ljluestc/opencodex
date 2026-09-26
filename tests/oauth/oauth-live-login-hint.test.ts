import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  cancelLoginFlow,
  clearLoginState,
  getLoginStatus,
  OAUTH_PROVIDERS,
  startLoginFlow,
} from "../../src/oauth";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OAuthController } from "../../src/oauth/types";

/**
 * A device grant is finished by the operator in the vendor's browser and settled by the
 * proxy's poll loop. Every client that watches it — the add-provider modal, the provider
 * workspace panel — watches `/api/oauth/status`, and `startLoginFlow`'s promise resolves
 * exactly once, on the FIRST `onAuth`.
 *
 * That made a later `onAuth` invisible. It is not a hypothetical second call: `loginMetaMuse`
 * starts a device grant and, when the grant fails, publishes a second hint asking for a
 * hand-entered Muse Code key (src/oauth/meta-muse.ts, manualKeyCredential). The dashboard
 * kept rendering the device code of the dead grant and the operator had no way to see the
 * step that was actually waiting on them.
 *
 * Nothing here talks to Meta. The provider entry is replaced with a controllable login so the
 * transition is deterministic, which is the same technique oauth-public-surface.test.ts uses.
 */

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const TEST_DIR = join(import.meta.dir, ".tmp-oauth-live-login-hint");
const previousHome = process.env.OPENCODEX_HOME;

beforeEach(() => {
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  clearLoginState("xai");
  removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(async () => {
  clearLoginState("xai");
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(TEST_DIR);
});

/**
 * Replace xai's login with one this test drives: it publishes a device hint, waits for the
 * test to release it, publishes a paste hint, then resolves with a credential. Returns the
 * gates so each case can stop wherever it needs to.
 */
function stagedDeviceThenPasteLogin() {
  const original = OAUTH_PROVIDERS.xai.login;
  let releaseSecondHint!: () => void;
  let releaseCredential!: () => void;
  let signalFirstHint!: () => void;
  let signalSecondHint!: () => void;
  const firstHintPublished = new Promise<void>(resolve => { signalFirstHint = resolve; });
  const secondHintPublished = new Promise<void>(resolve => { signalSecondHint = resolve; });
  const secondHintGate = new Promise<void>(resolve => { releaseSecondHint = resolve; });
  const credentialGate = new Promise<void>(resolve => { releaseCredential = resolve; });

  OAUTH_PROVIDERS.xai.login = async (ctrl: OAuthController) => {
    ctrl.onAuth?.({
      url: "https://device.example.test/activate?user_code=WDJB-MJHT",
      instructions: "Enter code: WDJB-MJHT",
      deviceCode: "WDJB-MJHT",
    });
    signalFirstHint();
    await secondHintGate;
    // The grant failed; the provider now wants a pasted key instead. No device code.
    ctrl.onAuth?.({
      url: "https://keys.example.test",
      instructions: "The device login did not complete. Paste an API key instead.",
    });
    signalSecondHint();
    await credentialGate;
    return {
      access: "staged-access",
      refresh: "staged-refresh",
      accountId: "staged-account",
      expires: Date.now() + 60_000,
    };
  };

  return {
    firstHintPublished,
    secondHintPublished,
    releaseSecondHint,
    releaseCredential,
    restore: () => { OAUTH_PROVIDERS.xai.login = original; },
  };
}

describe("live login hint projection", () => {
  test("the first onAuth publishes the device URL and device code through status", async () => {
    const staged = stagedDeviceThenPasteLogin();
    try {
      const started = await startLoginFlow("xai");
      await staged.firstHintPublished;

      // What the caller that started the flow already had.
      expect(started).toMatchObject({
        url: "https://device.example.test/activate?user_code=WDJB-MJHT",
        deviceCode: "WDJB-MJHT",
      });
      // ...is now also readable by a client that only polls.
      expect(getLoginStatus("xai")).toMatchObject({
        done: false,
        url: "https://device.example.test/activate?user_code=WDJB-MJHT",
        deviceCode: "WDJB-MJHT",
        instructions: "Enter code: WDJB-MJHT",
      });
    } finally {
      staged.releaseSecondHint();
      staged.releaseCredential();
      staged.restore();
      cancelLoginFlow("xai");
    }
  });

  test("a later onAuth replaces the live hint without restarting the flow", async () => {
    const staged = stagedDeviceThenPasteLogin();
    try {
      await startLoginFlow("xai");
      await staged.firstHintPublished;
      staged.releaseSecondHint();
      await staged.secondHintPublished;

      const status = getLoginStatus("xai");
      // Still the same flow: it has not settled and no second startLoginFlow was needed.
      expect(status.done).toBe(false);
      expect(status.url).toBe("https://keys.example.test");
      expect(status.instructions).toBe("The device login did not complete. Paste an API key instead.");
      // The superseded device code is GONE, not merged. A stale code is the whole bug:
      // it is what kept the dashboard telling the operator to type something into a
      // verification page whose grant is no longer running.
      expect(status.deviceCode).toBeUndefined();
    } finally {
      staged.releaseCredential();
      staged.restore();
      cancelLoginFlow("xai");
    }
  });

  test("polling settles the login with no manual callback submission", async () => {
    const staged = stagedDeviceThenPasteLogin();
    try {
      await startLoginFlow("xai");
      await staged.firstHintPublished;
      staged.releaseSecondHint();
      await staged.secondHintPublished;
      staged.releaseCredential();

      let status = getLoginStatus("xai");
      for (let attempt = 0; attempt < 200 && !status.done; attempt += 1) {
        await Bun.sleep(5);
        status = getLoginStatus("xai");
      }
      expect(status).toMatchObject({ done: true, loggedIn: true });
      // A settled flow has nothing left for the operator to do, so it publishes no hint.
      expect(status.url).toBeUndefined();
      expect(status.deviceCode).toBeUndefined();
      expect(status.instructions).toBeUndefined();
    } finally {
      staged.restore();
      clearLoginState("xai");
    }
  });

  test("cancellation clears the transient hint", async () => {
    const staged = stagedDeviceThenPasteLogin();
    try {
      await startLoginFlow("xai");
      await staged.firstHintPublished;
      expect(getLoginStatus("xai").deviceCode).toBe("WDJB-MJHT");

      expect(cancelLoginFlow("xai")).toBe(true);
      const status = getLoginStatus("xai");
      expect(status).toMatchObject({ done: true, error: "Login cancelled" });
      expect(status.deviceCode).toBeUndefined();
      expect(status.url).toBeUndefined();
      expect(status.instructions).toBeUndefined();
    } finally {
      staged.releaseSecondHint();
      staged.releaseCredential();
      staged.restore();
      clearLoginState("xai");
    }
  });

  test("a superseded flow's late hint never lands on its replacement", async () => {
    const stale = stagedDeviceThenPasteLogin();
    try {
      await startLoginFlow("xai");
      await stale.firstHintPublished;
      expect(cancelLoginFlow("xai")).toBe(true);

      // A replacement flow owns the provider now, with a hint of its own.
      const original = OAUTH_PROVIDERS.xai.login;
      OAUTH_PROVIDERS.xai.login = async (ctrl: OAuthController) => {
        ctrl.onAuth?.({ url: "https://device.example.test/second", deviceCode: "REPLACEMENT" });
        return await new Promise(() => {});
      };
      try {
        await startLoginFlow("xai");
        expect(getLoginStatus("xai").deviceCode).toBe("REPLACEMENT");

        // The abandoned flow now reaches its second onAuth. It must write nothing.
        stale.releaseSecondHint();
        await stale.secondHintPublished;
        await Bun.sleep(20);

        expect(getLoginStatus("xai")).toMatchObject({
          done: false,
          url: "https://device.example.test/second",
          deviceCode: "REPLACEMENT",
        });
      } finally {
        OAUTH_PROVIDERS.xai.login = original;
      }
    } finally {
      stale.releaseSecondHint();
      stale.releaseCredential();
      stale.restore();
      cancelLoginFlow("xai");
      clearLoginState("xai");
    }
  });
});
