import { beforeEach } from 'vitest';

beforeEach(() => {
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    });
  }
});
