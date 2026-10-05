/**
 * Central Application Identity & Global Brand Logo Repository
 *
 * Architecture:
 * 1. Global App Identity (Central Source of Truth in Supabase).
 * 2. Local Storage is strictly a FAST LOCAL CACHE for offline & zero-flicker rendering.
 * 3. Multi-device reactive propagation: Devices fetch latest metadata without continuous polling.
 * 4. Distinct 2-version brand asset model:
 *    - White Logo: Canonical White Logo used for Light Theme UI & ALL QR codes (strictly theme-invariant).
 *    - Dark Logo: used exclusively for Dark Theme UI.
 * 5. Server-Authoritative Super Admin permissions for updates.
 */

import { useState, useEffect } from "react";
import {
  rpcGetGlobalAppIdentity,
  rpcUpdateGlobalAppIdentity,
  uploadAppIdentityLogo,
  deleteAppIdentityObject,
} from "../supabase/client";

export interface GlobalAppIdentity {
  id: string;
  appName: string;
  whiteLogoUrl: string | null;
  darkLogoUrl: string | null;
  version: number;
  updatedAt: string;
  updatedBy?: string | null;
  isDefault?: boolean;
}

export interface AppLogoItem {
  id: string;
  name: string;
  whiteDataUrl?: string; // Canonical White Logo (Light Theme UI & all QR codes)
  darkDataUrl?: string;  // Dark Theme Logo (Dark Theme UI)
  dataUrl?: string; // Legacy fallback single image
  lightDataUrl?: string; // Backwards-compatible alias mapped to whiteDataUrl
  isDefault?: boolean;
  isLegacy?: boolean;
  version?: number;
  updatedAt?: string;
  createdAt?: string;
}

export interface SaveLogoSetParams {
  name: string;
  whiteDataUrl?: string;
  darkDataUrl: string;
  lightDataUrl?: string; // Backwards-compatible parameter
}

export interface SaveGlobalIdentityParams {
  appName?: string;
  whiteLogoFile?: Blob | File;
  darkLogoFile?: Blob | File;
  whiteLogoUrl?: string | null;
  darkLogoUrl?: string | null;
  // Legacy aliases for backward compatibility
  lightLogoFile?: Blob | File;
  lightLogoUrl?: string | null;
  qrWhiteLogoFile?: Blob | File;
  qrWhiteLogoUrl?: string | null;
}

const GLOBAL_IDENTITY_CACHE_KEY = "app_global_identity_cache_v1";
const LOGOS_STORAGE_KEY = "app_application_logos_v1";
const ACTIVE_LOGO_KEY = "app_active_logo_id_v1";
const LOGO_CHANGE_EVENT = "app_logo_changed";

export const DEFAULT_APP_LOGO: AppLogoItem = {
  id: "default",
  name: "الشعار الافتراضي",
  isDefault: true,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const inMemoryStore = new Map<string, string>();

const getStorage = () => {
  if (typeof localStorage !== "undefined") return localStorage;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  return {
    getItem: (key: string) => inMemoryStore.get(key) ?? null,
    setItem: (key: string, val: string) => inMemoryStore.set(key, val),
    removeItem: (key: string) => inMemoryStore.delete(key),
    clear: () => inMemoryStore.clear(),
  };
};

export const resetLogoStorageForTesting = () => {
  inMemoryStore.clear();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(GLOBAL_IDENTITY_CACHE_KEY);
      localStorage.removeItem(LOGOS_STORAGE_KEY);
      localStorage.removeItem(ACTIVE_LOGO_KEY);
    }
  } catch {}
};

/**
 * Optimizes an uploaded logo file to prevent memory/storage bloat.
 * - Resizes image down to max dimension (default 512px) if larger.
 * - Retains original aspect ratio without distortion or cropping.
 * - Preserves PNG transparency.
 * - Outputs clean base64 data URL.
 * - Strictly rejects Promise on failure without falling back to oversized raw image.
 */
export const optimizeLogoFile = async (file: File, maxDimension: number = 512): Promise<string> => {
  // Universal Node/SSR fallback when window or FileReader is not present
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof FileReader === 'undefined') {
    try {
      const buffer = await file.arrayBuffer();
      const base64 = typeof Buffer !== 'undefined'
        ? Buffer.from(buffer).toString('base64')
        : btoa(String.fromCharCode(...new Uint8Array(buffer)));
      return `data:${file.type || 'image/png'};base64,${base64}`;
    } catch {
      throw new Error('Failed to read image buffer during optimization');
    }
  }

  // If SVG, keep as vector data URL
  if (file.type === 'image/svg+xml') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const res = e.target?.result as string;
        if (!res) {
          reject(new Error('Failed to read SVG file as data URL'));
          return;
        }
        resolve(res);
      };
      reader.onerror = () => reject(new Error('Failed to read SVG file'));
      reader.readAsDataURL(file);
    });
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const rawDataUrl = event.target?.result as string;
      if (!rawDataUrl) {
        reject(new Error('Failed to read file as data URL'));
        return;
      }

      const img = new Image();
      img.onload = () => {
        const { width, height } = img;
        if (width <= 0 || height <= 0) {
          reject(new Error('Invalid image dimensions'));
          return;
        }

        if (width <= maxDimension && height <= maxDimension) {
          resolve(rawDataUrl);
          return;
        }

        let newWidth = width;
        let newHeight = height;
        if (width > height) {
          if (width > maxDimension) {
            newHeight = Math.round((height * maxDimension) / width);
            newWidth = maxDimension;
          }
        } else {
          if (height > maxDimension) {
            newWidth = Math.round((width * maxDimension) / height);
            newHeight = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = newWidth;
        canvas.height = newHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to acquire 2D canvas context for image optimization'));
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, newWidth, newHeight);

        // Export with PNG format preserving transparency
        try {
          const optimized = canvas.toDataURL('image/png', 0.92);
          if (!optimized || optimized === 'data:,') {
            reject(new Error('Failed to export optimized canvas image'));
            return;
          }
          resolve(optimized);
        } catch (canvasErr) {
          reject(canvasErr instanceof Error ? canvasErr : new Error('Canvas export failed'));
        }
      };
      img.onerror = () => reject(new Error('Failed to decode image file for optimization'));
      img.src = rawDataUrl;
    };
    reader.onerror = () => reject(new Error('FileReader error occurred during logo optimization'));
    reader.readAsDataURL(file);
  });
};

/**
 * Validates whether a logo item is complete (both White and Dark versions present).
 */
export const isLogoComplete = (logo?: AppLogoItem | null): boolean => {
  if (!logo) return false;
  if (logo.isDefault) return true;
  const hasWhite = Boolean(logo.whiteDataUrl || logo.lightDataUrl || logo.dataUrl);
  const hasDark = Boolean(logo.darkDataUrl);
  return Boolean(hasWhite && hasDark);
};

export const getCachedGlobalIdentity = (): GlobalAppIdentity | null => {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(GLOBAL_IDENTITY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      id: parsed.id || 'global',
      appName: parsed.appName || 'نظام إدارة شحن الأجهزة',
      whiteLogoUrl: parsed.whiteLogoUrl || parsed.lightLogoUrl || parsed.qrWhiteLogoUrl || null,
      darkLogoUrl: parsed.darkLogoUrl || null,
      version: parsed.version || 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      updatedBy: parsed.updatedBy,
      isDefault: Boolean(parsed.isDefault),
    };
  } catch {
    return null;
  }
};

export const setCachedGlobalIdentity = (identity: GlobalAppIdentity | null) => {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (identity) {
      storage.setItem(GLOBAL_IDENTITY_CACHE_KEY, JSON.stringify(identity));
    } else {
      storage.removeItem(GLOBAL_IDENTITY_CACHE_KEY);
    }
  } catch {}
};

/**
 * Returns saved custom logos list from local storage.
 * Supports backwards compatibility by reading legacy lightDataUrl into whiteDataUrl.
 */
export const getSavedLogos = (): AppLogoItem[] => {
  const storage = getStorage();
  if (!storage) return [DEFAULT_APP_LOGO];
  try {
    const raw = storage.getItem(LOGOS_STORAGE_KEY);
    if (!raw) return [DEFAULT_APP_LOGO];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [DEFAULT_APP_LOGO];
    
    const customLogos: AppLogoItem[] = parsed
      .filter((l: any) => l && l.id !== "default" && (l.dataUrl || l.lightDataUrl || l.whiteDataUrl || l.darkDataUrl))
      .map((l: any) => {
        const whiteDataUrl = l.whiteDataUrl || l.lightDataUrl || l.dataUrl;
        const darkDataUrl = l.darkDataUrl;
        const complete = Boolean(whiteDataUrl && darkDataUrl);
        return {
          id: l.id,
          name: l.name || "شعار مخصص",
          whiteDataUrl,
          darkDataUrl,
          lightDataUrl: whiteDataUrl, // Backwards-compatible alias
          dataUrl: whiteDataUrl,
          isDefault: false,
          isLegacy: !complete,
          createdAt: l.createdAt || new Date().toISOString(),
        };
      });

    return [DEFAULT_APP_LOGO, ...customLogos];
  } catch (err) {
    return [DEFAULT_APP_LOGO];
  }
};

export const getActiveLogoId = (): string => {
  const storage = getStorage();
  if (!storage) return DEFAULT_APP_LOGO.id;
  try {
    const id = storage.getItem(ACTIVE_LOGO_KEY);
    return id || DEFAULT_APP_LOGO.id;
  } catch {
    return DEFAULT_APP_LOGO.id;
  }
};

/**
 * Returns currently active brand logo.
 * Priority 1: Central Global App Identity (cached or in-memory).
 * Priority 2: Local custom logos (legacy backwards compatibility).
 * Priority 3: DEFAULT_APP_LOGO.
 */
export const getActiveLogo = (): AppLogoItem => {
  // 1. Check Central Global App Identity Cache
  const globalIdentity = getCachedGlobalIdentity();
  if (globalIdentity && (globalIdentity.whiteLogoUrl || globalIdentity.darkLogoUrl)) {
    const whiteUrl = globalIdentity.whiteLogoUrl || undefined;
    const darkUrl = globalIdentity.darkLogoUrl || undefined;
    return {
      id: "global",
      name: globalIdentity.appName || "الهوية المركزية للتطبيق",
      whiteDataUrl: whiteUrl,
      darkDataUrl: darkUrl,
      lightDataUrl: whiteUrl, // Backwards-compatible alias
      dataUrl: whiteUrl,
      isDefault: false,
      isLegacy: !Boolean(whiteUrl && darkUrl),
      version: globalIdentity.version,
      updatedAt: globalIdentity.updatedAt,
      createdAt: globalIdentity.updatedAt,
    };
  }

  // 2. Fallback: Check local legacy logos
  const activeId = getActiveLogoId();
  if (activeId !== DEFAULT_APP_LOGO.id) {
    const all = getSavedLogos();
    const found = all.find((l) => l.id === activeId);
    if (found && isLogoComplete(found)) {
      return found;
    }
  }

  return DEFAULT_APP_LOGO;
};

/**
 * Fetches Central Global App Identity from Supabase.
 * If server version is newer or cache is missing, updates local cache and broadcasts change.
 */
export const fetchGlobalAppIdentity = async (force: boolean = false): Promise<GlobalAppIdentity | null> => {
  try {
    const { data, error } = await rpcGetGlobalAppIdentity();
    if (error || !data) {
      return getCachedGlobalIdentity();
    }

    const whiteUrl = data.white_logo_url || data.light_logo_url || data.qr_white_logo_url || null;
    const darkUrl = data.dark_logo_url || null;

    const serverIdentity: GlobalAppIdentity = {
      id: data.id || 'global',
      appName: data.app_name || 'نظام إدارة شحن الأجهزة',
      whiteLogoUrl: whiteUrl,
      darkLogoUrl: darkUrl,
      version: data.version || 1,
      updatedAt: data.updated_at || new Date().toISOString(),
      updatedBy: data.updated_by,
      isDefault: !whiteUrl && !darkUrl,
    };

    const currentCached = getCachedGlobalIdentity();
    const shouldUpdate =
      force ||
      !currentCached ||
      serverIdentity.version > currentCached.version ||
      serverIdentity.updatedAt !== currentCached.updatedAt;

    if (shouldUpdate) {
      setCachedGlobalIdentity(serverIdentity);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(LOGO_CHANGE_EVENT, { detail: { id: "global", identity: serverIdentity } }));
      }
    }

    return serverIdentity;
  } catch (err) {
    console.warn("[LOGO_STORAGE] Failed to fetch central global identity, using cached", err);
    return getCachedGlobalIdentity();
  }
};

const dataUrlToBlob = (dataUrl: string): Blob => {
  const arr = dataUrl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
};

/**
 * Saves and updates Central Global App Identity (Super Admin operation).
 * 1. Uploads binary image assets to Supabase Storage:
 *    - app-identity/white/
 *    - app-identity/dark/
 * 2. Updates Supabase metadata with URLs + increments version counter.
 * 3. Updates local cache and notifies all listeners.
 * Strict invariant: NEVER saves Base64 data URLs in PostgreSQL database!
 * Transactional safety: Cleans up newly created Storage objects if DB update fails.
 */
export const saveGlobalAppIdentity = async (
  params: SaveGlobalIdentityParams
): Promise<{ success: boolean; data?: GlobalAppIdentity; error?: string }> => {
  let newlyUploadedWhiteUrl: string | null = null;
  let newlyUploadedDarkUrl: string | null = null;

  try {
    let whiteLogoUrl = params.whiteLogoUrl || params.lightLogoUrl || params.qrWhiteLogoUrl || null;
    let darkLogoUrl = params.darkLogoUrl || null;

    // 1. Upload White Logo if File/Blob provided or base64 provided
    const whiteFile = params.whiteLogoFile || params.lightLogoFile || params.qrWhiteLogoFile;
    if (whiteFile) {
      const uploadRes = await uploadAppIdentityLogo('white', whiteFile);
      if (uploadRes.error || !uploadRes.url) {
        throw new Error(`[LOGO_UPLOAD_ERROR:white] Storage upload failed: ${uploadRes.error || 'Null URL returned'}`);
      }
      whiteLogoUrl = uploadRes.url;
      newlyUploadedWhiteUrl = uploadRes.url;
    } else if (whiteLogoUrl && whiteLogoUrl.startsWith('data:image/')) {
      const blob = dataUrlToBlob(whiteLogoUrl);
      const uploadRes = await uploadAppIdentityLogo('white', blob);
      if (uploadRes.error || !uploadRes.url) {
        throw new Error(`[LOGO_UPLOAD_ERROR:white] Storage upload failed: ${uploadRes.error || 'Null URL returned'}`);
      }
      whiteLogoUrl = uploadRes.url;
      newlyUploadedWhiteUrl = uploadRes.url;
    }

    // 2. Upload Dark Logo if File/Blob provided or base64 provided
    if (params.darkLogoFile) {
      const uploadRes = await uploadAppIdentityLogo('dark', params.darkLogoFile);
      if (uploadRes.error || !uploadRes.url) {
        throw new Error(`[LOGO_UPLOAD_ERROR:dark] Storage upload failed: ${uploadRes.error || 'Null URL returned'}`);
      }
      darkLogoUrl = uploadRes.url;
      newlyUploadedDarkUrl = uploadRes.url;
    } else if (darkLogoUrl && darkLogoUrl.startsWith('data:image/')) {
      const blob = dataUrlToBlob(darkLogoUrl);
      const uploadRes = await uploadAppIdentityLogo('dark', blob);
      if (uploadRes.error || !uploadRes.url) {
        throw new Error(`[LOGO_UPLOAD_ERROR:dark] Storage upload failed: ${uploadRes.error || 'Null URL returned'}`);
      }
      darkLogoUrl = uploadRes.url;
      newlyUploadedDarkUrl = uploadRes.url;
    }

    // STRICT SAFETY CHECK: Base64 data URLs must NEVER be stored in the database!
    if (whiteLogoUrl && whiteLogoUrl.startsWith('data:image/')) {
      throw new Error('[LOGO_STORAGE_ERROR] Base64 image storage in PostgreSQL is prohibited. Image must be uploaded to Supabase Storage.');
    }
    if (darkLogoUrl && darkLogoUrl.startsWith('data:image/')) {
      throw new Error('[LOGO_STORAGE_ERROR] Base64 image storage in PostgreSQL is prohibited. Image must be uploaded to Supabase Storage.');
    }

    // 3. Update Server-Authoritative Metadata via RPC
    const { data, error } = await rpcUpdateGlobalAppIdentity({
      appName: params.appName,
      whiteLogoUrl,
      darkLogoUrl,
    });

    if (error || !data) {
      throw new Error(error || 'Failed to update central global app identity record in database');
    }

    const updatedIdentity: GlobalAppIdentity = {
      id: data.id || 'global',
      appName: data.app_name || params.appName || 'نظام إدارة شحن الأجهزة',
      whiteLogoUrl: data.white_logo_url || whiteLogoUrl,
      darkLogoUrl: data.dark_logo_url || darkLogoUrl,
      version: data.version,
      updatedAt: data.updated_at,
      isDefault: false,
    };

    // 4. Update local cache
    setCachedGlobalIdentity(updatedIdentity);

    // 5. Broadcast reactive event
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(LOGO_CHANGE_EVENT, { detail: { id: "global", identity: updatedIdentity } }));
    }

    return { success: true, data: updatedIdentity };
  } catch (err: any) {
    // Transactional rollback: Clean up newly uploaded storage objects if DB update failed
    if (newlyUploadedWhiteUrl) {
      deleteAppIdentityObject(newlyUploadedWhiteUrl).catch(() => {});
    }
    if (newlyUploadedDarkUrl) {
      deleteAppIdentityObject(newlyUploadedDarkUrl).catch(() => {});
    }

    const sanitizedError = err?.message || 'Failed to update global identity';
    console.warn("[LOGO_STORAGE] Failed to save global identity:", sanitizedError);
    return { success: false, error: sanitizedError };
  }
};

/**
 * One-time repair mechanism:
 * Scans DB row in `global_app_identity`. If `white_logo_url` or `dark_logo_url` contains inline Base64 data,
 * decodes and uploads binary file to `app-identity` storage bucket, then updates DB with HTTPS Public URLs.
 */
export const repairBase64LogosToStorage = async (): Promise<{
  repaired: boolean;
  whiteUrl?: string | null;
  darkUrl?: string | null;
  error?: string | null;
}> => {
  try {
    const { data, error } = await rpcGetGlobalAppIdentity();
    if (error || !data) {
      return { repaired: false, error: error || 'Failed to fetch global identity for repair' };
    }

    const currentWhite = data.white_logo_url || data.light_logo_url || data.qr_white_logo_url || null;
    const currentDark = data.dark_logo_url || null;

    const whiteNeedsRepair = Boolean(currentWhite && currentWhite.startsWith('data:image/'));
    const darkNeedsRepair = Boolean(currentDark && currentDark.startsWith('data:image/'));

    if (!whiteNeedsRepair && !darkNeedsRepair) {
      return { repaired: false, whiteUrl: currentWhite, darkUrl: currentDark };
    }

    let repairedWhiteUrl: string | null = currentWhite;
    let repairedDarkUrl: string | null = currentDark;

    if (whiteNeedsRepair && currentWhite) {
      const blob = dataUrlToBlob(currentWhite);
      const uploadRes = await uploadAppIdentityLogo('white', blob);
      if (uploadRes.error || !uploadRes.url) {
        throw new Error(`Failed to upload repaired White Logo: ${uploadRes.error}`);
      }
      repairedWhiteUrl = uploadRes.url;
    }

    if (darkNeedsRepair && currentDark) {
      const blob = dataUrlToBlob(currentDark);
      const uploadRes = await uploadAppIdentityLogo('dark', blob);
      if (uploadRes.error || !uploadRes.url) {
        throw new Error(`Failed to upload repaired Dark Logo: ${uploadRes.error}`);
      }
      repairedDarkUrl = uploadRes.url;
    }

    // Verify both are HTTP URLs
    if (repairedWhiteUrl && repairedWhiteUrl.startsWith('data:image/')) {
      throw new Error('Repaired White Logo URL is still Base64');
    }
    if (repairedDarkUrl && repairedDarkUrl.startsWith('data:image/')) {
      throw new Error('Repaired Dark Logo URL is still Base64');
    }

    const updateRes = await rpcUpdateGlobalAppIdentity({
      appName: data.app_name,
      whiteLogoUrl: repairedWhiteUrl,
      darkLogoUrl: repairedDarkUrl,
    });

    if (updateRes.error || !updateRes.data) {
      throw new Error(updateRes.error || 'Failed to update database with repaired Storage URLs');
    }

    const repairedIdentity: GlobalAppIdentity = {
      id: updateRes.data.id || 'global',
      appName: updateRes.data.app_name || data.app_name || 'نظام إدارة شحن الأجهزة',
      whiteLogoUrl: updateRes.data.white_logo_url || repairedWhiteUrl,
      darkLogoUrl: updateRes.data.dark_logo_url || repairedDarkUrl,
      version: updateRes.data.version,
      updatedAt: updateRes.data.updated_at,
      isDefault: false,
    };

    setCachedGlobalIdentity(repairedIdentity);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(LOGO_CHANGE_EVENT, { detail: { id: "global", identity: repairedIdentity } }));
    }

    return {
      repaired: true,
      whiteUrl: repairedIdentity.whiteLogoUrl,
      darkUrl: repairedIdentity.darkLogoUrl,
    };
  } catch (err: any) {
    console.warn("[LOGO_REPAIR] Base64 logo repair failed:", err?.message || err);
    return { repaired: false, error: err?.message || 'Repair failed' };
  }
};

export const persistLogosSafely = (storage: any, logos: AppLogoItem[], activeId?: string): boolean => {
  if (!storage) return false;
  try {
    storage.setItem(LOGOS_STORAGE_KEY, JSON.stringify(logos));
    if (activeId) {
      storage.setItem(ACTIVE_LOGO_KEY, activeId);
    }
    return true;
  } catch (err: any) {
    if (err?.name === 'QuotaExceededError' || err?.message?.includes('quota') || err?.code === 22) {
      try {
        const activeLogo = logos.find((l) => l.id === activeId) || logos[logos.length - 1];
        const minimalLogos = activeLogo && !activeLogo.isDefault ? [activeLogo] : [];
        storage.setItem(LOGOS_STORAGE_KEY, JSON.stringify(minimalLogos));
        if (activeId) {
          storage.setItem(ACTIVE_LOGO_KEY, activeId);
        }
        return true;
      } catch {
        inMemoryStore.set(LOGOS_STORAGE_KEY, JSON.stringify(logos));
        if (activeId) {
          inMemoryStore.set(ACTIVE_LOGO_KEY, activeId);
        }
        return false;
      }
    }
    inMemoryStore.set(LOGOS_STORAGE_KEY, JSON.stringify(logos));
    if (activeId) {
      inMemoryStore.set(ACTIVE_LOGO_KEY, activeId);
    }
    return false;
  }
};

/**
 * Saves a complete dual-version logo set (White & Dark) locally and synchronizes as Global Identity.
 */
export const saveLogoSet = ({ name, whiteDataUrl, darkDataUrl, lightDataUrl }: SaveLogoSetParams): AppLogoItem => {
  const resolvedWhite = whiteDataUrl || lightDataUrl;
  if (!resolvedWhite || !darkDataUrl) {
    throw new Error("Both White and Dark logos are required to save a complete logo set");
  }

  const storage = getStorage();
  const all = getSavedLogos();
  const newLogo: AppLogoItem = {
    id: "logo_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
    name: name.trim() || ("شعار " + all.length),
    whiteDataUrl: resolvedWhite, // Canonical White Logo for Light Theme & QR
    darkDataUrl,
    lightDataUrl: resolvedWhite, // Backwards-compatible alias
    dataUrl: resolvedWhite, // Backwards compatibility for single-url consumers
    isDefault: false,
    isLegacy: false,
    createdAt: new Date().toISOString(),
  };

  const updated = [...all.filter((l) => !l.isDefault), newLogo];
  persistLogosSafely(storage, updated, newLogo.id);

  // Update central Global App Identity in background if network available
  saveGlobalAppIdentity({
    appName: newLogo.name,
    whiteLogoUrl: resolvedWhite,
    darkLogoUrl: darkDataUrl,
  }).catch((e) => console.warn("[LOGO_STORAGE] Background cloud sync deferred:", e));

  // Activate the newly added complete logo set
  setActiveLogo(newLogo.id);
  return newLogo;
};

/**
 * Convenience helper supporting backwards compatibility.
 */
export const saveCustomLogo = (name: string, whiteOrDataUrl: string, darkDataUrl?: string): AppLogoItem => {
  if (darkDataUrl) {
    return saveLogoSet({ name, whiteDataUrl: whiteOrDataUrl, darkDataUrl });
  }

  const storage = getStorage();
  const all = getSavedLogos();
  const newLogo: AppLogoItem = {
    id: "logo_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
    name: name.trim() || ("شعار " + all.length),
    dataUrl: whiteOrDataUrl,
    whiteDataUrl: whiteOrDataUrl,
    lightDataUrl: whiteOrDataUrl,
    darkDataUrl: undefined,
    isDefault: false,
    isLegacy: true,
    createdAt: new Date().toISOString(),
  };

  const updated = [...all.filter((l) => !l.isDefault), newLogo];
  persistLogosSafely(storage, updated, getActiveLogoId());

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LOGO_CHANGE_EVENT, { detail: { id: getActiveLogoId() } }));
  }
  return newLogo;
};

/**
 * Updates an existing logo item.
 */
export const updateLogoItem = (
  id: string,
  updates: Partial<Pick<AppLogoItem, 'name' | 'whiteDataUrl' | 'darkDataUrl' | 'lightDataUrl'>>
): AppLogoItem | null => {
  if (id === DEFAULT_APP_LOGO.id) return null;
  const storage = getStorage();
  const all = getSavedLogos();
  const current = all.find((l) => l.id === id);
  if (!current) return null;

  const whiteDataUrl = updates.whiteDataUrl !== undefined 
    ? updates.whiteDataUrl 
    : (updates.lightDataUrl !== undefined ? updates.lightDataUrl : (current.whiteDataUrl || current.lightDataUrl));
  const darkDataUrl = updates.darkDataUrl !== undefined ? updates.darkDataUrl : current.darkDataUrl;
  const complete = Boolean(whiteDataUrl && darkDataUrl);

  const updatedItem: AppLogoItem = {
    ...current,
    ...updates,
    whiteDataUrl,
    darkDataUrl,
    lightDataUrl: whiteDataUrl,
    dataUrl: whiteDataUrl || current.dataUrl,
    isLegacy: !complete,
  };

  const filtered = all.filter((l) => !l.isDefault && l.id !== id);
  const updatedList = [...filtered, updatedItem];

  persistLogosSafely(storage, updatedList, complete ? updatedItem.id : getActiveLogoId());

  if (complete && whiteDataUrl && darkDataUrl) {
    saveGlobalAppIdentity({
      appName: updatedItem.name,
      whiteLogoUrl: whiteDataUrl,
      darkLogoUrl: darkDataUrl,
    }).catch((e) => console.warn("[LOGO_STORAGE] Background cloud sync deferred:", e));

    setActiveLogo(updatedItem.id);
  } else if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LOGO_CHANGE_EVENT, { detail: { id: getActiveLogoId() } }));
  }

  return updatedItem;
};

/**
 * Sets active logo by ID.
 */
export const setActiveLogo = (id: string): boolean => {
  const storage = getStorage();
  if (id === DEFAULT_APP_LOGO.id) {
    if (storage) {
      try {
        storage.setItem(ACTIVE_LOGO_KEY, id);
      } catch {}
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(LOGO_CHANGE_EVENT, { detail: { id } }));
    }
    return true;
  }

  const all = getSavedLogos();
  const found = all.find((l) => l.id === id);
  if (!found) {
    return false;
  }

  if (!isLogoComplete(found)) {
    return false;
  }

  if (storage) {
    try {
      storage.setItem(ACTIVE_LOGO_KEY, id);
    } catch {}
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LOGO_CHANGE_EVENT, { detail: { id } }));
  }
  return true;
};

export const deleteCustomLogo = (id: string): boolean => {
  if (id === "default") return false;
  const activeId = getActiveLogoId();
  const all = getSavedLogos();
  const filtered = all.filter((l) => l.id !== id && !l.isDefault);
  
  const storage = getStorage();
  const nextActiveId = activeId === id ? DEFAULT_APP_LOGO.id : activeId;
  persistLogosSafely(storage, filtered, nextActiveId);

  if (activeId === id) {
    setActiveLogo(DEFAULT_APP_LOGO.id);
  } else if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LOGO_CHANGE_EVENT, { detail: { id: activeId } }));
  }
  return true;
};

export const subscribeToLogoChanges = (callback: () => void): (() => void) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(LOGO_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener(LOGO_CHANGE_EVENT, callback);
  };
};

/**
 * React Hook to subscribe to active application logo updates.
 * Automatically checks central identity on mount in the background.
 */
export const useActiveLogo = (): AppLogoItem => {
  const [logo, setLogo] = useState<AppLogoItem>(() => getActiveLogo());

  useEffect(() => {
    const update = () => {
      setLogo(getActiveLogo());
    };
    const unsubscribe = subscribeToLogoChanges(update);
    update();

    // Trigger low-cost background check on mount
    fetchGlobalAppIdentity().catch(() => {});

    return unsubscribe;
  }, []);

  return logo;
};

/**
 * Canonical QR Logo Resolver:
 * Always returns the canonical White Logo configured in Global App Identity.
 * Strictly decoupled from current application UI theme (never switches based on Dark/Light theme).
 * Strict invariant: NEVER returns or falls back to Dark Logo.
 */
export const getCanonicalQrLogo = (item?: AppLogoItem | null): string | undefined => {
  const logo = item !== undefined ? item : getActiveLogo();
  if (!logo || logo.isDefault) return undefined;
  return logo.whiteDataUrl || logo.lightDataUrl || logo.dataUrl;
};

/**
 * Returns the White Logo (canonical QR logo and Light Theme UI logo) from the specified logo item or active logo.
 */
export const getWhiteLogo = (item?: AppLogoItem | null): string | undefined => {
  return getCanonicalQrLogo(item);
};

/**
 * Returns the Dark Logo (Dark Theme UI logo) from the specified logo item or active logo.
 */
export const getDarkLogo = (item?: AppLogoItem | null): string | undefined => {
  const logo = item !== undefined ? item : getActiveLogo();
  if (!logo || logo.isDefault) return undefined;
  return logo.darkDataUrl;
};

/**
 * Backwards-compatible alias for getWhiteLogo (as Light Theme uses White Logo).
 */
export const getLightLogo = (item?: AppLogoItem | null): string | undefined => {
  return getWhiteLogo(item);
};
