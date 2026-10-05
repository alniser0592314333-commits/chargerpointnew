import QRCode from 'qrcode';

export interface QrGeometryResult {
  moduleCount: number;
  margin: number;
  totalUnits: number;
  matrixCenterX: number;
  matrixCenterY: number;
}

/**
 * Computes precise QR matrix geometry using qrcode internal create API.
 */
export function getQrGeometry(
  value: string,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H' = 'H',
  margin: number = 1
): QrGeometryResult {
  let moduleCount = 21; // default fallback
  try {
    const qr = QRCode.create(value, { errorCorrectionLevel });
    if (qr && qr.modules && typeof qr.modules.size === 'number') {
      moduleCount = qr.modules.size;
    }
  } catch {
    // fallback if value is empty or invalid
  }

  const totalUnits = moduleCount + margin * 2;
  return {
    moduleCount,
    margin,
    totalUnits,
    matrixCenterX: 0.5, // 50% exact geometric center
    matrixCenterY: 0.5,
  };
}

export function calculateLogoPosition(
  qrX: number,
  qrY: number,
  qrSize: number,
  logoSize: number,
  value: string,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H' = 'H',
  margin: number = 1
): { logoX: number; logoY: number; matrixCenterX: number; matrixCenterY: number } {
  const geom = getQrGeometry(value, errorCorrectionLevel, margin);
  const matrixCenterX = qrX + qrSize * geom.matrixCenterX;
  const matrixCenterY = qrY + qrSize * geom.matrixCenterY;

  const logoX = matrixCenterX - logoSize / 2;
  const logoY = matrixCenterY - logoSize / 2;

  return { logoX, logoY, matrixCenterX, matrixCenterY };
}

export interface SafeZoneResult {
  safeZoneX: number;
  safeZoneY: number;
  safeZoneSize: number;
  matrixCenterX: number;
  matrixCenterY: number;
}

export function calculateLogoSafeZone(
  qrX: number,
  qrY: number,
  qrSize: number,
  logoSize: number,
  value: string,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H' = 'H',
  margin: number = 1,
  padding: number = 6
): SafeZoneResult {
  const pos = calculateLogoPosition(qrX, qrY, qrSize, logoSize, value, errorCorrectionLevel, margin);
  const safeZoneSize = logoSize + padding * 2;
  const safeZoneX = pos.matrixCenterX - safeZoneSize / 2;
  const safeZoneY = pos.matrixCenterY - safeZoneSize / 2;

  return {
    safeZoneX,
    safeZoneY,
    safeZoneSize,
    matrixCenterX: pos.matrixCenterX,
    matrixCenterY: pos.matrixCenterY,
  };
}

export interface CircularSafeZoneGeometry {
  centerX: number;
  centerY: number;
  radius: number;
}

export function getCircularSafeZone(
  canvasSize: number,
  logoSize: number,
  safeMargin: number = 4
): CircularSafeZoneGeometry {
  const centerX = canvasSize / 2;
  const centerY = canvasSize / 2;
  const radius = (logoSize / 2) + safeMargin;
  return {
    centerX,
    centerY,
    radius,
  };
}

export interface RenderMatrixResult {
  matrix: boolean[][]; // true = render dark module, false = background/knockout
  size: number;
  moduleCount: number;
  margin: number;
}

/**
 * Creates True QR Render Matrix with conditional True Circular Module Knockout.
 * Knockout is applied ONLY when logoVisible is true.
 */
export function createQrRenderMatrix(
  value: string,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H' = 'H',
  margin: number = 1,
  logoCircleSize: number = 56,
  displaySize: number = 220,
  logoVisible: boolean = false
): RenderMatrixResult {
  let moduleCount = 21;
  let rawModules: ArrayLike<number> | null = null;
  try {
    const qr = QRCode.create(value, { errorCorrectionLevel });
    if (qr && qr.modules) {
      if (typeof qr.modules.size === 'number') {
        moduleCount = qr.modules.size;
      }
      if (qr.modules.data) {
        rawModules = qr.modules.data;
      }
    }
  } catch {
    // fallback
  }

  const totalUnits = moduleCount + margin * 2;
  const matrix: boolean[][] = [];

  const centerX = totalUnits / 2;
  const centerY = totalUnits / 2;

  const unitSize = displaySize / totalUnits;
  const radiusInPixels = logoCircleSize / 2;
  const radiusInUnits = radiusInPixels / unitSize;

  for (let r = 0; r < totalUnits; r++) {
    matrix[r] = [];
    for (let c = 0; c < totalUnits; c++) {
      const moduleRow = r - margin;
      const moduleCol = c - margin;

      let isDark = false;
      if (moduleRow >= 0 && moduleRow < moduleCount && moduleCol >= 0 && moduleCol < moduleCount && rawModules) {
        const idx = moduleRow * moduleCount + moduleCol;
        isDark = Boolean(rawModules[idx]);
      }

      // ONLY apply True Module Knockout if logoVisible is true!
      if (logoVisible) {
        const modCenterX = c + 0.5;
        const modCenterY = r + 0.5;
        const distX = modCenterX - centerX;
        const distY = modCenterY - centerY;
        const distFromCenter = Math.sqrt(distX * distX + distY * distY);

        if (distFromCenter <= radiusInUnits) {
          isDark = false;
        }
      }

      matrix[r][c] = isDark;
    }
  }

  return {
    matrix,
    size: totalUnits,
    moduleCount,
    margin,
  };
}
