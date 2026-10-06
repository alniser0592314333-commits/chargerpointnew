import React, { useMemo } from 'react';
import { createQrRenderMatrix } from './qrGeometry';

export interface QrCodeRendererProps {
  value: string;
  size?: number;
  centerLogo?: React.ReactNode;
  logoSize?: number;
  logoCircleSize?: number;
  logoVisible?: boolean;
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  margin?: number;
  className?: string;
  id?: string;
}

export const QrCodeRenderer: React.FC<QrCodeRendererProps> = ({
  value,
  size = 220,
  centerLogo,
  logoSize: _logoSize,
  logoCircleSize = 56,
  logoVisible,
  errorCorrectionLevel = 'H',
  margin = 1,
  className = '',
  id = 'qr-code-canvas',
}) => {
  const hasLogo = logoVisible ?? Boolean(centerLogo);
  const renderResult = useMemo(() => {
    if (!value) return null;
    return createQrRenderMatrix(value, errorCorrectionLevel as 'L' | 'M' | 'Q' | 'H', margin, logoCircleSize || 56, size, hasLogo);
  }, [value, errorCorrectionLevel, margin, logoCircleSize, size, hasLogo]);

  return (
    <div
      id={id}
      style={{ width: size, height: size }}
      className={`relative bg-white flex items-center justify-center select-none overflow-hidden ${className}`}
    >
      <div className="relative w-full h-full flex items-center justify-center">
        {renderResult ? (
          <svg
            viewBox={`0 0 ${renderResult.size} ${renderResult.size}`}
            className="w-full h-full block"
          >
            <rect width={renderResult.size} height={renderResult.size} fill="#ffffff" />
            {renderResult.matrix.map((row, r) =>
              row.map((isDark, c) =>
                isDark ? (
                  <rect
                    key={`m-${r}-${c}`}
                    x={c}
                    y={r}
                    width={1}
                    height={1}
                    fill="#000000"
                  />
                ) : null
              )
            )}
          </svg>
        ) : (
          <div className="w-full h-full bg-gray-100 animate-pulse rounded-lg flex items-center justify-center text-xs text-gray-400">
            QR...
          </div>
        )}

        {/* Center Logo Overlay - Rendered only when logo is visible */}
        {centerLogo && hasLogo && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="flex items-center justify-center">
              {centerLogo}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
