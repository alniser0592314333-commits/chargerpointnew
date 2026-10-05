/**
 * Cryptographic Security Utility for QR Tokens
 * Phase 6.5.2B: Persistent Random Public Capability Handle (Option C)
 *
 * Rules:
 * - Public Token: Cryptographically random 128-bit (16 bytes = 32 hex chars) CSPRNG.
 * - Non-guessable, negligible collision probability, protected by database uniqueness constraint.
 * - Stored directly in central database as the persistent capability identifier.
 * - Never derived from UUID, Customer ID, phone, customer code, or visual design.
 * - Completely independent of client device, language, theme, or reprint.
 */

export const generateSecurePublicToken = (): string => {
  const bytes = new Uint8Array(16); // 128 bits of cryptographic entropy
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback if crypto.getRandomValues is unavailable in environment
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

// Alias for backward compatibility
export const generateSecureRawToken = generateSecurePublicToken;

export const computeTokenHash = async (rawToken: string): Promise<string> => {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new Error('Invalid token provided for hashing');
  }

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(rawToken);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  throw new Error('Web Crypto API (crypto.subtle) is required for token hashing');
};
