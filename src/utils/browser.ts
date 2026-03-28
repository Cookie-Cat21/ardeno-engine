/**
 * Returns Puppeteer launch options that work both locally (Windows)
 * and in a Linux container (Railway/Docker).
 *
 * On Railway: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium is set in the Dockerfile.
 * Locally: Puppeteer uses its own bundled Chromium (no env var needed).
 */
export function getBrowserConfig() {
  return {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ]
  }
}
