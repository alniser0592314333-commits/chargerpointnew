import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Polyfill localStorage for Vitest Node environment
const createLocalStorageMock = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
};

const mockStorage = createLocalStorageMock();
(globalThis as any).localStorage = mockStorage;
if (typeof window !== "undefined") {
  (window as any).localStorage = mockStorage;
}

import { authService } from "../services/auth/authService";
import {
  getSavedLogos,
  getActiveLogo,
  saveCustomLogo,
  setActiveLogo,
  deleteCustomLogo,
  DEFAULT_APP_LOGO,
} from "../services/storage/logoStorage";

describe("Settings Phase 1 UI & Security Refinements", () => {
  beforeEach(() => {
    mockStorage.clear();
    vi.restoreAllMocks();
  });

  describe("PART 1: Secure Change BIN 2-Step Flow", () => {
    it("1. Identity verification fails with empty credentials", async () => {
      const res = await authService.verifyCurrentPassword("", "");
      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
    });

    it("2. Identity verification fails with wrong password in local mode", async () => {
      vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(false);
      const res = await authService.verifyCurrentPassword("admin", "definitely_wrong_pass_xyz");
      expect(res.success).toBe(false);
      expect(res.token).toBeUndefined();
    });

    it("3. Identity verification succeeds with correct credentials in local mode", async () => {
      vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(false);
      const res = await authService.verifyCurrentPassword("admin", "123456");
      expect(res.success).toBe(true);
      expect(res.error).toBeNull();
      expect(res.token).toBeDefined();
    });

    it("4. Changing BIN fails if new BIN is less than 4 digits", async () => {
      const res = await authService.changeAdminBin("123");
      expect(res.success).toBe(false);
      expect(res.error).toContain("4");
    });

    it("5. Changing BIN succeeds with valid 4+ digit numeric BIN in local mode", async () => {
      vi.spyOn(authService, "isSupabaseConfigured").mockReturnValue(false);
      const res = await authService.changeAdminBin("7890", "mock_verified_token");
      expect(res.success).toBe(true);
      expect(res.error).toBeNull();
    });
  });

  describe("PART 3: Application Logo Management", () => {
    it("1. Initializes with Default System Logo when storage is empty", () => {
      const active = getActiveLogo();
      expect(active.id).toBe("default");
      expect(active.isDefault).toBe(true);

      const all = getSavedLogos();
      expect(all.length).toBe(1);
      expect(all[0].id).toBe("default");
    });

    it("2. Adding custom logo saves and activates it immediately", () => {
      const mockDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const mockDarkUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
      const saved = saveCustomLogo("فرع الرياض", mockDataUrl, mockDarkUrl);

      expect(saved.id).toBeDefined();
      expect(saved.name).toBe("فرع الرياض");
      expect(saved.lightDataUrl).toBe(mockDataUrl);
      expect(saved.darkDataUrl).toBe(mockDarkUrl);
      expect(saved.isDefault).toBe(false);

      const active = getActiveLogo();
      expect(active.id).toBe(saved.id);
      expect(active.name).toBe("فرع الرياض");

      const all = getSavedLogos();
      expect(all.length).toBe(2);
      expect(all.some((l) => l.id === "default")).toBe(true);
      expect(all.some((l) => l.id === saved.id)).toBe(true);
    });

    it("3. Switching active logo between custom and default", () => {
      const mockDataUrl = "data:image/png;base64,sample1";
      const mockDarkUrl = "data:image/png;base64,sample1_dark";
      const custom1 = saveCustomLogo("شعار مخصص 1", mockDataUrl, mockDarkUrl);

      expect(getActiveLogo().id).toBe(custom1.id);

      // Switch back to default
      setActiveLogo("default");
      expect(getActiveLogo().id).toBe("default");

      // Switch to custom 1
      setActiveLogo(custom1.id);
      expect(getActiveLogo().id).toBe(custom1.id);
    });

    it("4. Deleting custom logo reverts active to default if deleted logo was active", () => {
      const custom = saveCustomLogo("شعار مؤقت", "data:image/png;base64,temp", "data:image/png;base64,temp_dark");
      expect(getActiveLogo().id).toBe(custom.id);

      const deleted = deleteCustomLogo(custom.id);
      expect(deleted).toBe(true);
      expect(getActiveLogo().id).toBe("default");
      expect(getSavedLogos().length).toBe(1);
    });

    it("5. Cannot delete default system logo", () => {
      const deleted = deleteCustomLogo("default");
      expect(deleted).toBe(false);
      expect(getActiveLogo().id).toBe("default");
    });
  });
});
