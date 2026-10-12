const { app, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaociyuan-tray-probe-'));
app.setPath('userData', profile);
app.dock?.hide();
app.whenReady().then(() => {
  try {
    const root = path.resolve(__dirname, '../..');
    const logo = nativeImage.createFromPath(path.join(root, 'apps/desktop/renderer/public/brand/logo.png'));
    assert.equal(logo.isEmpty(), false);
    const icon = logo.resize({ width: 22, height: 22 });
    icon.addRepresentation({ scaleFactor: 2, dataURL: logo.resize({ width: 44, height: 44 }).toDataURL() });
    icon.setTemplateImage(true);
    assert.equal(icon.isTemplateImage(), true);
    assert.deepEqual(icon.getScaleFactors(), [1, 2]);
    const sizes = [1, 2].map((scaleFactor) => {
      const png = icon.toPNG({ scaleFactor });
      assert.equal(png.readUInt32BE(16), 22 * scaleFactor);
      assert.equal(png.readUInt32BE(20), 22 * scaleFactor);
      const pixels = icon.toBitmap({ scaleFactor });
      let visible = 0;
      for (let n = 3; n < pixels.length; n += 4) if (pixels[n] > 16) visible++;
      assert.ok(visible > 50 * scaleFactor * scaleFactor);
      return { scaleFactor, width: png.readUInt32BE(16), height: png.readUInt32BE(20), visiblePixels: visible };
    });
    console.log(JSON.stringify({ passed: true, template: icon.isTemplateImage(), sizes, nativeTrayUI: 'not inspected; no tray or window was created' }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
