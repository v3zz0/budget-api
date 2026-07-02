'use strict';

const fs = require('fs');
const pdfParse = require('pdf-parse');

module.exports = () => ({
  async estraiTesto(filePath) {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  },

  // Cerca un periodo nel testo nel formato "dal DD/MM/YYYY al DD/MM/YYYY"
  // o varianti tipiche degli estratti conto italiani.
  estraiPeriodo(testo) {
    const patterns = [
      /dal\s+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s+al\s+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/i,
      /periodo[:\s]+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s*[-–]\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/i,
    ];
    for (const re of patterns) {
      const m = testo.match(re);
      if (m) {
        const [, gd, gm, gy, fd, fm, fy] = m;
        const norm = (y) => (y.length === 2 ? `20${y}` : y);
        return {
          dal: `${norm(gy)}-${gm.padStart(2, '0')}-${gd.padStart(2, '0')}`,
          al: `${norm(fy)}-${fm.padStart(2, '0')}-${fd.padStart(2, '0')}`,
        };
      }
    }
    return null;
  },
});
