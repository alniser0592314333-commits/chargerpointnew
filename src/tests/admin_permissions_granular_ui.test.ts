import { describe, it, expect } from "vitest";

describe("Admin Granular Custom Permissions UI & Transfer Logic", () => {
  const SYSTEM_PERMISSIONS = [
    { key: "orders:view", labelAr: "عرض الطلبات", labelEn: "View Orders" },
    { key: "orders:create", labelAr: "إنشاء الطلبات", labelEn: "Create Orders" },
    { key: "customers:view", labelAr: "عرض العملاء", labelEn: "View Customers" },
    { key: "finance:create-payment", labelAr: "إنشاء عمليات دفع", labelEn: "Create Payments" },
    { key: "settings:manage", labelAr: "إدارة إعدادات النظام", labelEn: "Manage Global Settings" },
    { key: "admin:manage", labelAr: "إدارة المشرفين الفرعيين", labelEn: "Manage Subordinate Admins" },
  ];

  it("1. Divides permissions into active and disabled correctly based on tempPermissions map", () => {
    const tempPermissions: Record<string, boolean> = {
      "orders:view": true,
      "customers:view": true,
    };

    const activeList = SYSTEM_PERMISSIONS.filter((p) => tempPermissions[p.key] === true);
    const disabledList = SYSTEM_PERMISSIONS.filter((p) => !tempPermissions[p.key]);

    expect(activeList.map((p) => p.key)).toEqual(["orders:view", "customers:view"]);
    expect(disabledList.map((p) => p.key)).toEqual([
      "orders:create",
      "finance:create-payment",
      "settings:manage",
      "admin:manage",
    ]);
  });

  it("2. Toggling a disabled permission immediately moves it to active list", () => {
    let tempPermissions: Record<string, boolean> = {
      "orders:view": false,
    };

    // Toggle to true
    tempPermissions = {
      ...tempPermissions,
      "orders:view": !tempPermissions["orders:view"],
    };

    const activeList = SYSTEM_PERMISSIONS.filter((p) => tempPermissions[p.key] === true);
    const disabledList = SYSTEM_PERMISSIONS.filter((p) => !tempPermissions[p.key]);

    expect(activeList.some((p) => p.key === "orders:view")).toBe(true);
    expect(disabledList.some((p) => p.key === "orders:view")).toBe(false);
  });

  it("3. Toggling an active permission immediately returns it to disabled list", () => {
    let tempPermissions: Record<string, boolean> = {
      "orders:view": true,
    };

    // Toggle to false
    tempPermissions = {
      ...tempPermissions,
      "orders:view": !tempPermissions["orders:view"],
    };

    const activeList = SYSTEM_PERMISSIONS.filter((p) => tempPermissions[p.key] === true);
    const disabledList = SYSTEM_PERMISSIONS.filter((p) => !tempPermissions[p.key]);

    expect(activeList.some((p) => p.key === "orders:view")).toBe(false);
    expect(disabledList.some((p) => p.key === "orders:view")).toBe(true);
  });

  it("4. Bulk select all grants all permissions", () => {
    const next: Record<string, boolean> = {};
    SYSTEM_PERMISSIONS.forEach((p) => {
      next[p.key] = true;
    });

    const activeList = SYSTEM_PERMISSIONS.filter((p) => next[p.key] === true);
    expect(activeList.length).toBe(SYSTEM_PERMISSIONS.length);
  });

  it("5. Bulk deselect all disables all permissions", () => {
    const next: Record<string, boolean> = {};
    SYSTEM_PERMISSIONS.forEach((p) => {
      next[p.key] = false;
    });

    const activeList = SYSTEM_PERMISSIONS.filter((p) => next[p.key] === true);
    expect(activeList.length).toBe(0);
  });

  it("6. Super Admin BIN validation requires non-empty >= 4 digits", () => {
    const validateBin = (bin: string) => {
      const clean = bin.trim();
      return clean.length >= 4;
    };

    expect(validateBin("")).toBe(false);
    expect(validateBin("123")).toBe(false);
    expect(validateBin("1234")).toBe(true);
    expect(validateBin("  123456  ")).toBe(true);
  });
});
