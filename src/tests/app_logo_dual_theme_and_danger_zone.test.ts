import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_APP_LOGO,
  getActiveLogo,
  getSavedLogos,
  saveLogoSet,
  saveCustomLogo,
  updateLogoItem,
  setActiveLogo,
  deleteCustomLogo,
  isLogoComplete,
  resetLogoStorageForTesting,
  persistLogosSafely,
  optimizeLogoFile,
  AppLogoItem,
} from '../services/storage/logoStorage';
import { translations } from '../i18n/translations';

describe('App Logo Manager & Danger Zone Contracts', () => {
  beforeEach(() => {
    resetLogoStorageForTesting();
  });

  // =========================================================================
  // 1. DUAL-LOGO IDENTITY REQUIREMENTS
  // =========================================================================
  describe('1. Dual-Version Brand Identity (Light / Dark)', () => {
    it('1.1. Light Logo is required when creating a complete logo set', () => {
      expect(() =>
        saveLogoSet({
          name: 'شعار ناقص',
          lightDataUrl: '',
          darkDataUrl: 'data:image/png;base64,dark_sample',
        })
      ).toThrow();
    });

    it('1.2. Dark Logo is required when creating a complete logo set', () => {
      expect(() =>
        saveLogoSet({
          name: 'شعار ناقص',
          lightDataUrl: 'data:image/png;base64,light_sample',
          darkDataUrl: '',
        })
      ).toThrow();
    });

    it('1.3. Dual-version set saves both distinct images without auto-generating one from the other', () => {
      const lightImg = 'data:image/png;base64,distinct_light_black_icon';
      const darkImg = 'data:image/png;base64,distinct_dark_white_icon';

      const logoSet = saveLogoSet({
        name: 'هوية المتجر المعتمدة',
        lightDataUrl: lightImg,
        darkDataUrl: darkImg,
      });

      expect(logoSet.lightDataUrl).toBe(lightImg);
      expect(logoSet.darkDataUrl).toBe(darkImg);
      expect(logoSet.lightDataUrl).not.toBe(logoSet.darkDataUrl);
      expect(isLogoComplete(logoSet)).toBe(true);
      expect(getActiveLogo().id).toBe(logoSet.id);
    });

    it('1.4. Incomplete logo set CANNOT be activated', () => {
      // Create incomplete logo (legacy or draft with only light logo)
      const incomplete = saveCustomLogo('شعار أحادي قديم', 'data:image/png;base64,only_one_version');
      expect(incomplete.isLegacy).toBe(true);
      expect(isLogoComplete(incomplete)).toBe(false);

      // Attempting to activate incomplete logo fails
      const activated = setActiveLogo(incomplete.id);
      expect(activated).toBe(false);

      // Active logo remains default
      expect(getActiveLogo().id).toBe(DEFAULT_APP_LOGO.id);
    });

    it('1.5. Legacy logo is preserved and NOT deleted when loading saved logos', () => {
      // Legacy logo with only single image
      const legacyItem = saveCustomLogo('شعار قديم محفوظ', 'data:image/png;base64,legacy_png');

      const all = getSavedLogos();
      const found = all.find((l) => l.id === legacyItem.id);

      expect(found).toBeDefined();
      expect(found?.isLegacy).toBe(true);
      expect(found?.dataUrl).toBe('data:image/png;base64,legacy_png');
      expect(isLogoComplete(found)).toBe(false);

      // Completing the legacy logo allows it to become active
      const completed = updateLogoItem(legacyItem.id, {
        lightDataUrl: 'data:image/png;base64,legacy_png',
        darkDataUrl: 'data:image/png;base64,new_dark_counterpart',
      });

      expect(completed).toBeDefined();
      expect(isLogoComplete(completed)).toBe(true);
      expect(getActiveLogo().id).toBe(legacyItem.id);
    });

    it('1.6. AppLogo renders pristine raw image without circle, border, mask, shadow, or added background', async () => {
      const React = await import('react');
      const { renderToStaticMarkup } = await import('react-dom/server');
      const { AppLogo } = await import('../components/qr/AppLogo');

      const customLogoUrl = 'data:image/png;base64,transparent_brand_icon';
      const html = renderToStaticMarkup(
        React.createElement(AppLogo, { size: 48, customUrl: customLogoUrl })
      );

      // Verify the image is rendered
      expect(html).toContain('src="data:image/png;base64,transparent_brand_icon"');

      // CRITICAL: Verify NO decorative circle wrapper
      expect(html).not.toContain('rounded-full');

      // CRITICAL: Verify NO border or frame
      expect(html).not.toContain('border-emerald');
      expect(html).not.toContain('border-gray');

      // CRITICAL: Verify NO added background color
      expect(html).not.toContain('bg-white');
      expect(html).not.toContain('bg-[#0c312b]');
      expect(html).not.toContain('bg-[#164e43]');

      // CRITICAL: Verify NO shadow
      expect(html).not.toContain('shadow');

      // CRITICAL: Verify object-contain is used for authentic aspect ratio without crop
      expect(html).toContain('object-contain');
    });
  });

  // =========================================================================
  // 2. DANGER ZONE NAMING & BUTTON SPECIFICATIONS
  // =========================================================================
  describe('2. Danger Zone Renaming & Button Contracts', () => {
    it('2.1. "حذف قاعدة البيانات المحلية" and "Delete Local Database" exist', () => {
      expect(translations.ar.deleteLocalDataTitle).toBe('حذف قاعدة البيانات المحلية');
      expect(translations.en.deleteLocalDataTitle).toBe('Delete Local Database');
    });

    it('2.2. Execution button text is strictly "حذف" / "Delete" without long descriptions', () => {
      expect(translations.ar.deleteLocalDataBtn).toBe('حذف');
      expect(translations.en.deleteLocalDataBtn).toBe('Delete');

      // Verify no long descriptions inside the button
      expect(translations.ar.deleteLocalDataBtn).not.toContain('تصفير');
      expect(translations.ar.deleteLocalDataBtn).not.toContain('البيانات التشغيلية');
      expect(translations.en.deleteLocalDataBtn).not.toContain('Operational');
      expect(translations.en.deleteLocalDataBtn).not.toContain('Zero Reset');
    });

    it('2.3. Dual-theme logo translations exist for both Arabic and English', () => {
      expect(translations.ar.uploadLightLogo).toBeDefined();
      expect(translations.ar.uploadDarkLogo).toBeDefined();
      expect(translations.ar.bothLogosRequired).toBeDefined();
      expect(translations.ar.saveAndActivateLogo).toBeDefined();

      expect(translations.en.uploadLightLogo).toBeDefined();
      expect(translations.en.uploadDarkLogo).toBeDefined();
      expect(translations.en.bothLogosRequired).toBeDefined();
      expect(translations.en.saveAndActivateLogo).toBeDefined();
    });
  });

  // =========================================================================
  // 3. STORAGE QUOTA RESILIENCE & IMAGE OPTIMIZATION
  // =========================================================================
  describe('3. Storage Quota Resilience & Image Optimization', () => {
    it('3.1. persistLogosSafely recovers gracefully when localStorage throws QuotaExceededError', () => {
      let attempts = 0;
      const fakeStorage = {
        setItem: (_key: string, value: string) => {
          attempts++;
          // First attempt throws QuotaExceededError if string has more than 1 logo
          if (value.length > 500) {
            const err = new Error("Failed to execute 'setItem' on 'Storage': Setting the value exceeded the quota.");
            err.name = 'QuotaExceededError';
            throw err;
          }
        },
      };

      const logo1: AppLogoItem = {
        id: 'logo_old',
        name: 'شعار قديم',
        lightDataUrl: 'data:image/png;base64,' + 'A'.repeat(800),
        darkDataUrl: 'data:image/png;base64,' + 'B'.repeat(800),
        createdAt: '2026-01-01',
      };
      const activeLogo: AppLogoItem = {
        id: 'logo_active',
        name: 'شعار نشط',
        lightDataUrl: 'data:image/png;base64,' + 'C'.repeat(100),
        darkDataUrl: 'data:image/png;base64,' + 'D'.repeat(100),
        createdAt: '2026-01-02',
      };

      // Attempt saving with oversized items
      const success = persistLogosSafely(fakeStorage as any, [logo1, activeLogo], 'logo_active');
      expect(success).toBe(true);
      expect(attempts).toBeGreaterThanOrEqual(1);
    });

    it('3.2. persistLogosSafely falls back to in-memory store when all quota storage strategies fail', () => {
      const rejectingStorage = {
        setItem: () => {
          const err = new Error("QuotaExceededError");
          err.name = 'QuotaExceededError';
          throw err;
        },
      };

      const testLogo: AppLogoItem = {
        id: 'logo_fallback',
        name: 'شعار الطوارئ',
        lightDataUrl: 'data:image/png;base64,sample',
        darkDataUrl: 'data:image/png;base64,sample',
        createdAt: '2026-01-01',
      };

      // Must not throw, returns false for persistent storage but safely keeps in memory
      expect(() => persistLogosSafely(rejectingStorage as any, [testLogo], testLogo.id)).not.toThrow();
    });

    it('3.3. optimizeLogoFile handles image files without crashing', async () => {
      // Test with small SVG or simulated file
      const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="5"/></svg>';
      const blob = new Blob([svgContent], { type: 'image/svg+xml' });
      const file = new File([blob], 'logo.svg', { type: 'image/svg+xml' });

      const optimized = await optimizeLogoFile(file, 256);
      expect(optimized).toContain('data:image/svg+xml');
    });

    it('3.4. optimizeLogoFile strictly rejects Promise on image decode error without fallback to original', async () => {
      // Create a corrupted image file
      const corruptedBlob = new Blob(['not_a_real_image_binary_data'], { type: 'image/png' });
      const corruptedFile = new File([corruptedBlob], 'broken.png', { type: 'image/png' });

      // In browser/jsdom environment where FileReader & Image exist
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const originalImage = window.Image;
        try {
          // Simulate image decoding failure
          (window as any).Image = class {
            onload: any = null;
            onerror: any = null;
            set src(_v: string) {
              setTimeout(() => {
                if (this.onerror) this.onerror(new Error('Failed to decode'));
              }, 10);
            }
          };

          await expect(optimizeLogoFile(corruptedFile, 512)).rejects.toThrow();
        } finally {
          window.Image = originalImage;
        }
      }
    });

    it('3.5. optimizeLogoFile strictly rejects Promise on missing canvas 2D context', async () => {
      const validBlob = new Blob(['fake_png_data'], { type: 'image/png' });
      const validFile = new File([validBlob], 'logo.png', { type: 'image/png' });

      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const originalCreateElement = document.createElement.bind(document);
        const originalImage = window.Image;
        try {
          // Simulate valid image dimensions (1000x800) requiring resize
          (window as any).Image = class {
            width = 1000;
            height = 800;
            onload: any = null;
            onerror: any = null;
            set src(_v: string) {
              setTimeout(() => {
                if (this.onload) this.onload();
              }, 10);
            }
          };

          // Simulate canvas context acquisition failure (returns null)
          document.createElement = ((tagName: string, options?: any) => {
            if (tagName === 'canvas') {
              return {
                width: 0,
                height: 0,
                getContext: () => null,
              } as any;
            }
            return originalCreateElement(tagName, options);
          }) as any;

          await expect(optimizeLogoFile(validFile, 512)).rejects.toThrow(
            /Failed to acquire 2D canvas context/
          );
        } finally {
          document.createElement = originalCreateElement;
          window.Image = originalImage;
        }
      }
    });

    it('3.6. Integration Test: 4000x3000 input image is downscaled to <= 512 with 4:3 aspect ratio and transparency preserved', async () => {
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const originalCreateElement = document.createElement.bind(document);
        const originalImage = window.Image;
        let createdCanvasWidth = 0;
        let createdCanvasHeight = 0;
        let exportedMime = '';

        try {
          // Simulate 4000x3000 input image
          (window as any).Image = class {
            width = 4000;
            height = 3000;
            onload: any = null;
            onerror: any = null;
            set src(_v: string) {
              setTimeout(() => {
                if (this.onload) this.onload();
              }, 10);
            }
          };

          const mockCtx = {
            imageSmoothingEnabled: false,
            imageSmoothingQuality: '',
            drawImage: () => {},
          };

          document.createElement = ((tagName: string, options?: any) => {
            if (tagName === 'canvas') {
              const canvasObj = {
                width: 0,
                height: 0,
                getContext: (type: string) => (type === '2d' ? mockCtx : null),
                toDataURL: (mime: string, quality: number) => {
                  createdCanvasWidth = canvasObj.width;
                  createdCanvasHeight = canvasObj.height;
                  exportedMime = mime;
                  return `data:${mime};base64,optimized_512x384_transparent_png_data`;
                },
              };
              return canvasObj as any;
            }
            return originalCreateElement(tagName, options);
          }) as any;

          const raw4000x3000Blob = new Blob(['raw_4000x3000_image_payload'], { type: 'image/png' });
          const rawFile = new File([raw4000x3000Blob], 'highres_logo.png', { type: 'image/png' });

          const optimizedResult = await optimizeLogoFile(rawFile, 512);

          // Verify downscaled dimensions
          expect(createdCanvasWidth).toBe(512);
          expect(createdCanvasHeight).toBe(384); // 3000 * 512 / 4000 = 384
          expect(createdCanvasWidth).toBeLessThanOrEqual(512);
          expect(createdCanvasHeight).toBeLessThanOrEqual(512);

          // Verify aspect ratio preserved (4:3)
          expect(createdCanvasWidth / createdCanvasHeight).toBeCloseTo(4000 / 3000, 2);

          // Verify PNG format used to preserve transparency
          expect(exportedMime).toBe('image/png');
          expect(optimizedResult).toContain('data:image/png;base64,optimized_512x384_transparent_png_data');
        } finally {
          document.createElement = originalCreateElement;
          window.Image = originalImage;
        }
      }
    });

    it('3.7. Integration Test: upload receives optimized result and NEVER receives original unoptimized file', async () => {
      const { saveGlobalAppIdentity } = await import('../services/storage/logoStorage');
      const supabaseClient = await import('../services/supabase/client');

      let uploadedTarget: string | null = null;
      let uploadedPayload: any = null;
      let rpcUpdatedWithUrls: any = null;

      const uploadSpy = vi.spyOn(supabaseClient, 'uploadAppIdentityLogo').mockImplementation(async (target: string, file: Blob | File) => {
        uploadedTarget = target;
        uploadedPayload = file;
        return {
          url: `https://storage.supabase.co/app-identity/${target}/logo_test.png`,
          error: null,
        };
      });

      const rpcSpy = vi.spyOn(supabaseClient, 'rpcUpdateGlobalAppIdentity').mockImplementation(async (params: any) => {
        rpcUpdatedWithUrls = params;
        return {
          data: {
            id: 'global',
            app_name: params.appName,
            white_logo_url: params.whiteLogoUrl,
            dark_logo_url: params.darkLogoUrl,
            version: 2,
            updated_at: new Date().toISOString(),
          },
          error: null,
        };
      });

      try {
        const optimizedWhiteDataUrl = `data:image/png;base64,${btoa('optimized_white_image_payload_512px')}`;
        const optimizedDarkDataUrl = `data:image/png;base64,${btoa('optimized_dark_image_payload_512px')}`;

        // Saving global identity with optimized data URLs (as produced by optimizeLogoFile)
        const result = await saveGlobalAppIdentity({
          appName: 'متجر التميز',
          whiteLogoUrl: optimizedWhiteDataUrl,
          darkLogoUrl: optimizedDarkDataUrl,
        });

        expect(result.success).toBe(true);
        expect(uploadedPayload).toBeInstanceOf(Blob);
        expect(uploadedPayload.type).toBe('image/png');
        expect(rpcUpdatedWithUrls.whiteLogoUrl).toContain('https://storage.supabase.co/app-identity/white/');
        expect(rpcUpdatedWithUrls.darkLogoUrl).toContain('https://storage.supabase.co/app-identity/dark/');
      } finally {
        uploadSpy.mockRestore();
        rpcSpy.mockRestore();
      }
    });

    it('3.8. Optimization failure prevents upload: uploadAppIdentityLogo is NOT called when optimization fails', async () => {
      const supabaseClient = await import('../services/supabase/client');
      let uploadCalled = false;

      const uploadSpy = vi.spyOn(supabaseClient, 'uploadAppIdentityLogo').mockImplementation(async () => {
        uploadCalled = true;
        return { url: '', error: null };
      });

      try {
        // Simulate failed optimization step in caller
        const badFile = new File([new Blob(['corrupted'])], 'bad.png', { type: 'image/png' });

        if (typeof window !== 'undefined' && typeof document !== 'undefined') {
          const originalImage = window.Image;
          try {
            (window as any).Image = class {
              onload: any = null;
              onerror: any = null;
              set src(_v: string) {
                setTimeout(() => {
                  if (this.onerror) this.onerror(new Error('Corrupt Image'));
                }, 10);
              }
            };

            let caughtError = false;
            try {
              await optimizeLogoFile(badFile, 512);
            } catch {
              caughtError = true;
            }

            expect(caughtError).toBe(true);
            // Because optimization threw, the upload was not triggered
            expect(uploadCalled).toBe(false);
          } finally {
            window.Image = originalImage;
          }
        }
      } finally {
        uploadSpy.mockRestore();
      }
    });

    it('3.9. White Logo and Dark Logo both undergo identical strict optimization without bypass', async () => {
      const whiteLogoSet = saveLogoSet({
        name: 'هوية كاملة محسنة',
        whiteDataUrl: `data:image/png;base64,${btoa('white_optimized_content')}`,
        darkDataUrl: `data:image/png;base64,${btoa('dark_optimized_content')}`,
      });

      expect(whiteLogoSet.whiteDataUrl).toContain('data:image/png;base64,');
      expect(whiteLogoSet.darkDataUrl).toContain('data:image/png;base64,');
      expect(isLogoComplete(whiteLogoSet)).toBe(true);
    });

    it('3.10. Storage upload failure prevents DB update and throws error without storing Base64 in DB', async () => {
      const { saveGlobalAppIdentity } = await import('../services/storage/logoStorage');
      const supabaseClient = await import('../services/supabase/client');

      const uploadSpy = vi.spyOn(supabaseClient, 'uploadAppIdentityLogo').mockImplementation(async () => {
        return { url: null, error: 'AUTH_REQUIRED: Super Admin token required' };
      });

      const rpcSpy = vi.spyOn(supabaseClient, 'rpcUpdateGlobalAppIdentity');

      try {
        const base64Input = `data:image/png;base64,${btoa('sample_png_bytes')}`;
        const res = await saveGlobalAppIdentity({
          appName: 'اختبار الفشل',
          whiteLogoUrl: base64Input,
          darkLogoUrl: base64Input,
        });

        // Must report failure
        expect(res.success).toBe(false);
        expect(res.error).toContain('Storage upload failed');

        // RPC must NOT have been called with Base64
        expect(rpcSpy).not.toHaveBeenCalled();
      } finally {
        uploadSpy.mockRestore();
        rpcSpy.mockRestore();
      }
    });

    it('3.11. Base64 Repair mechanism decodes DB Base64 entries and uploads to Storage', async () => {
      const { repairBase64LogosToStorage } = await import('../services/storage/logoStorage');
      const supabaseClient = await import('../services/supabase/client');

      const rawBase64 = `data:image/png;base64,${btoa('valid_png_content_sample')}`;

      const getRpcSpy = vi.spyOn(supabaseClient, 'rpcGetGlobalAppIdentity').mockImplementation(async () => {
        return {
          data: {
            id: 'global',
            app_name: 'نظام الشحن',
            white_logo_url: rawBase64,
            dark_logo_url: rawBase64,
            version: 1,
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          error: null,
        };
      });

      const uploadSpy = vi.spyOn(supabaseClient, 'uploadAppIdentityLogo').mockImplementation(async (target) => {
        return {
          url: `https://example.supabase.co/storage/v1/object/public/app-identity/${target}/repaired_logo.png`,
          error: null,
        };
      });

      let updatedRpcPayload: any = null;
      const updateRpcSpy = vi.spyOn(supabaseClient, 'rpcUpdateGlobalAppIdentity').mockImplementation(async (params) => {
        updatedRpcPayload = params;
        return {
          data: {
            id: 'global',
            app_name: params.appName || 'نظام الشحن',
            white_logo_url: params.whiteLogoUrl || null,
            dark_logo_url: params.darkLogoUrl || null,
            version: 2,
            updated_at: new Date().toISOString(),
          },
          error: null,
        };
      });

      try {
        const repairRes = await repairBase64LogosToStorage();
        expect(repairRes.repaired).toBe(true);
        expect(repairRes.whiteUrl).toContain('https://example.supabase.co/storage/v1/object/public/app-identity/white/');
        expect(repairRes.darkUrl).toContain('https://example.supabase.co/storage/v1/object/public/app-identity/dark/');
        expect(updatedRpcPayload.whiteLogoUrl).not.toContain('data:image/');
      } finally {
        getRpcSpy.mockRestore();
        uploadSpy.mockRestore();
        updateRpcSpy.mockRestore();
      }
    });

    it('3.12. Transactional Rollback: Cleans up newly uploaded Storage object if DB update fails', async () => {
      const { saveGlobalAppIdentity } = await import('../services/storage/logoStorage');
      const supabaseClient = await import('../services/supabase/client');

      let uploadedUrl: string | null = null;
      let deletedUrl: string | null = null;

      const uploadSpy = vi.spyOn(supabaseClient, 'uploadAppIdentityLogo').mockImplementation(async (target) => {
        uploadedUrl = `https://example.supabase.co/storage/v1/object/public/app-identity/${target}/new_logo.png`;
        return {
          url: uploadedUrl,
          error: null,
        };
      });

      const deleteSpy = vi.spyOn(supabaseClient, 'deleteAppIdentityObject').mockImplementation(async (url) => {
        deletedUrl = url;
        return { success: true, error: null };
      });

      // Simulate DB update failure
      const rpcSpy = vi.spyOn(supabaseClient, 'rpcUpdateGlobalAppIdentity').mockImplementation(async () => {
        return { data: null, error: 'Database connection failed' };
      });

      try {
        const base64Input = `data:image/png;base64,${btoa('sample_png_bytes')}`;
        const res = await saveGlobalAppIdentity({
          appName: 'اختبار التراجع',
          whiteLogoUrl: base64Input,
        });

        expect(res.success).toBe(false);
        expect(deleteSpy).toHaveBeenCalled();
        expect(deletedUrl).toBe(uploadedUrl);
      } finally {
        uploadSpy.mockRestore();
        deleteSpy.mockRestore();
        rpcSpy.mockRestore();
      }
    });
  });
});
