/**
 * OCR Data Extractor for Romanian Business Documents
 * Extracts structured data from:
 *   - Certificat Constatator (company registration certificate)
 *   - Carte de Identitate (CI / national ID card)
 *   - Certificat CUI (tax registration certificate)
 *
 * Uses Tesseract.js (pure JS, no native deps) for OCR.
 * Handles PDF input by converting to images via pdftoppm.
 */
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');

// Singleton scheduler for better performance (reuses workers)
let scheduler = null;
let schedulerReady = false;

async function getScheduler() {
  if (scheduler && schedulerReady) return scheduler;
  scheduler = Tesseract.createScheduler();
  // Create 1 worker for Romanian + English
  const worker = await Tesseract.createWorker('ron+eng');
  scheduler.addWorker(worker);
  schedulerReady = true;
  return scheduler;
}

/**
 * Convert PDF buffer to PNG image buffer (first page only)
 */
function pdfToImage(pdfBuffer) {
  const tmpDir = os.tmpdir();
  const tmpPdf = path.join(tmpDir, `ocr_${Date.now()}.pdf`);
  const tmpOut = path.join(tmpDir, `ocr_${Date.now()}`);
  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);
    // pdftoppm converts PDF to PPM/PNG images; -png -r 300 for 300 DPI
    execSync(`pdftoppm -png -r 300 -f 1 -l 1 "${tmpPdf}" "${tmpOut}"`, { timeout: 30000 });
    // pdftoppm outputs as tmpOut-1.png or tmpOut-01.png
    const candidates = [
      `${tmpOut}-1.png`, `${tmpOut}-01.png`, `${tmpOut}-001.png`,
      `${tmpOut}-1.ppm`, `${tmpOut}-01.ppm`
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const imgBuf = fs.readFileSync(c);
        fs.unlinkSync(c);
        fs.unlinkSync(tmpPdf);
        return imgBuf;
      }
    }
    // Try glob approach
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(path.basename(tmpOut)));
    if (files.length > 0) {
      const imgPath = path.join(tmpDir, files[0]);
      const imgBuf = fs.readFileSync(imgPath);
      fs.unlinkSync(imgPath);
      fs.unlinkSync(tmpPdf);
      return imgBuf;
    }
    throw new Error('pdftoppm produced no output');
  } catch (e) {
    // Cleanup
    try { fs.unlinkSync(tmpPdf); } catch (_) {}
    throw new Error(`PDF to image conversion failed: ${e.message}`);
  }
}

/**
 * Detect if buffer is a PDF
 */
function isPDF(buffer) {
  return buffer && buffer.length > 4 && buffer.slice(0, 5).toString() === '%PDF-';
}

/**
 * Pre-process image for better OCR accuracy
 */
async function preprocessImage(imageBuffer) {
  try {
    return await sharp(imageBuffer)
      .greyscale()
      .normalize()
      .sharpen()
      .toBuffer();
  } catch (e) {
    // If sharp fails, return original
    return imageBuffer;
  }
}

/**
 * Crop center of image (remove decorative borders) for CUI certificates.
 * Removes ~10% from each edge.
 */
async function cropCenter(imageBuffer) {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const cropX = Math.floor(meta.width * 0.10);
    const cropY = Math.floor(meta.height * 0.10);
    return await sharp(imageBuffer)
      .extract({
        left: cropX,
        top: cropY,
        width: meta.width - 2 * cropX,
        height: meta.height - 2 * cropY
      })
      .toBuffer();
  } catch (e) {
    return imageBuffer;
  }
}

/**
 * Run OCR on an image buffer (or PDF buffer - auto-converted)
 * If initialOCR produces garbage, tries rotating 90/270 degrees.
 */
async function ocrImage(imageBuffer) {
  let imgBuf = imageBuffer;
  // Convert PDF to image if needed
  if (isPDF(imageBuffer)) {
    console.log('[OCR] Detected PDF input, converting to image...');
    imgBuf = pdfToImage(imageBuffer);
    console.log(`[OCR] PDF converted to image (${imgBuf.length} bytes)`);
  }
  const processed = await preprocessImage(imgBuf);
  const sched = await getScheduler();
  const { data } = await sched.addJob('recognize', processed);
  const text = data.text;

  // Check if OCR text contains recognizable Romanian words — if not, try rotations
  const hasRoWords = /(?:ROMANIA|MINISTERUL|OFICIUL|CERTIFICAT|denumire|firma|sediu|administratr|QUATRO|S\.R\.L|SRL|judet)/i.test(text);
  const letterRatio = (text.match(/[a-zA-ZăâîșțĂÂÎȘȚ]/g) || []).length / Math.max(text.length, 1);
  if ((!hasRoWords || letterRatio < 0.3) && text.length > 50) {
    console.log(`[OCR] No recognizable words or low letter ratio (${(letterRatio*100).toFixed(1)}%), trying rotations...`);
    const roWordPattern = /(?:ROMANIA|MINISTERUL|OFICIUL|CERTIFICAT|denumire|firma|sediu|administrator|S\.R\.L|SRL|judet|inregistrare|comert)/i;
    // Try 90° rotation
    try {
      const rotated90 = await sharp(imgBuf).rotate(90).greyscale().normalize().sharpen().toBuffer();
      const { data: data90 } = await sched.addJob('recognize', rotated90);
      if (roWordPattern.test(data90.text)) {
        console.log(`[OCR] 90° rotation has Romanian words — using it`);
        return data90.text;
      }
    } catch(e) { console.log('[OCR] 90° rotation failed:', e.message); }
    // Try 270° rotation
    try {
      const rotated270 = await sharp(imgBuf).rotate(270).greyscale().normalize().sharpen().toBuffer();
      const { data: data270 } = await sched.addJob('recognize', rotated270);
      if (roWordPattern.test(data270.text)) {
        console.log(`[OCR] 270° rotation has Romanian words — using it`);
        return data270.text;
      }
    } catch(e) { console.log('[OCR] 270° rotation failed:', e.message); }
  }
  return text;
}

// ============================================
// REGEX PATTERNS FOR ROMANIAN DOCUMENTS
// ============================================

/**
 * Extract data from Certificat Constatator text
 */
function parseCertificatConstatator(text) {
  const result = {};
  const t = text.replace(/\r\n/g, '\n');

  let m;

  // ---- DENUMIRE SOCIETATE ----
  // Primary: Look for standalone "COMPANY_NAME S.R.L." on its own line (all caps company names)
  m = t.match(/\n\s*([A-ZȘȚĂÎÂ][A-ZȘȚĂÎÂ0-9\s\.\-&]+(?:S\.?\s*R\.?\s*L\.?|S\.?\s*A\.?))\s*[,.\n]/);
  if (m) result.denumire_societate = m[1].trim().replace(/\s+/g, ' ');

  // Fallback: "Firma:" or "Denumire:" pattern
  if (!result.denumire_societate) {
    m = t.match(/(?:firma|denumire)\s*[:\-]?\s*([A-ZȘȚĂÎÂa-zșțăîâ0-9\s\.\-&]+(?:S\.?R\.?L\.?|S\.?A\.?))/i);
    if (m) result.denumire_societate = m[1].trim().replace(/\s+/g, ' ');
  }

  // Fallback: any "WORD WORD S.R.L." pattern (at least 2 words before SRL)
  if (!result.denumire_societate) {
    m = t.match(/([A-ZȘȚĂÎÂ][A-ZȘȚĂÎÂ0-9\s\.\-&]{3,50})\s+S\.?\s*R\.?\s*L\.?\s*\.?/);
    if (m) {
      let name = m[1].trim().replace(/\s+/g, ' ');
      // Remove any leading OCR garbage (numbers, single chars)
      name = name.replace(/^[\d\s\.]+/, '').trim();
      if (name.length > 3) result.denumire_societate = name + ' SRL';
    }
  }

  // ---- CUI ----
  // "Cod unic de inregistrare: 25148833" or "C.U.I.: RO25148833"
  m = t.match(/(?:cod\s*(?:unic|fiscal)|C\.?\s*U\.?\s*I\.?|cod\s*de\s*[iîi]nregistrare)\s*[:\-]?\s*(?:RO\s*)?(\d{5,10})/i);
  if (m) result.cui = 'RO' + m[1];
  if (!result.cui) {
    m = t.match(/(?:RO\s?)(\d{5,10})/);
    if (m) result.cui = 'RO' + m[1];
  }
  // Also try: just "25148833" followed by "din data" pattern from certificat format
  if (!result.cui) {
    m = t.match(/(?:nregistrare|fiscal)\s*[:\-]?\s*(\d{5,10})\s/i);
    if (m) result.cui = 'RO' + m[1];
  }

  // ---- Nr. ORC / J__/___/____ ----
  m = t.match(/(J\s*\d{1,2}\s*\/\s*\d{1,5}\s*\/\s*\d{4})/i);
  if (m) result.orc_nr = m[1].replace(/\s/g, '');

  // ---- SEDIU SOCIAL ----
  // Primary: "Sediu social: Municipiul lasi, Sos. PACURARI, Nr. 35, Bloc 543A, Etaj 2, Ap. 1, Judet lasi."
  // OCR reads Iasi as "laşi" or "lași" (lowercase L instead of I) — be very flexible
  m = t.match(/[Ss]ediu\s+social\s*[:\-]?\s*(.+?)(?:\.\s*\n|\.\s*$)/i);
  if (m) {
    let addr = m[1].trim().replace(/\s+/g, ' ').replace(/[,.\s]+$/, '');
    // Fix OCR: "laşi" or "lasi" → "Iași"
    addr = addr.replace(/\bl[aă][sşș][iî]\b/gi, 'Iași');
    result.sediu_social = addr;
  }

  // Fallback: "Sediu social:" until "Cod" or newline
  if (!result.sediu_social) {
    m = t.match(/[Ss]ediu\s+social\s*[:\-]?\s*(.+?)(?:Cod\s|Tel|Fax|\n)/i);
    if (m) {
      let addr = m[1].trim().replace(/\s+/g, ' ').replace(/[,.\s]+$/, '');
      addr = addr.replace(/\bl[aă][sşș][iî]\b/gi, 'Iași');
      result.sediu_social = addr;
    }
  }

  // Fallback: Look for "Sos. PACURARI" or "Str. X" pattern with Nr, Bloc etc. — but NOT in header area (skip first 200 chars)
  if (!result.sediu_social) {
    const bodyText = t.length > 300 ? t.substring(200) : t;
    m = bodyText.match(/((?:Sos|Str|Bd|Cal|Spl|Piata|Șos|[ŞȘ]os)\.\s*[A-ZȘȚĂÎÂ][A-Za-zșțăîâĂÂÎȘȚ\s\-]+,?\s*Nr\.?\s*\d+[A-Za-z]?(?:\s*,?\s*(?:Bloc|Bl\.?|Sc\.?|Et\.?|Ap\.?|Etaj)\s*[A-Za-z0-9\s,\.\-]+)*)/i);
    if (m) result.sediu_social = m[1].trim().replace(/\s+/g, ' ');
  }

  // ---- ADRESA PUNCT DE LUCRU = SEDIU SECUNDAR ----
  // From certificat constatator: "la sediul secundar din Municipiul lasi, Strada VASILE LUPU, Nr. 110, Judet lasi(Punct de lucru)"
  // OCR uses "laşi" (lowercase L) - be flexible with [lI]a[sşș]i
  m = t.match(/sedi(?:ul|u)\s+secundar\s+(?:din\s+)?(.+?)(?:\(Punct|\n\n|specifice|$)/i);
  if (m) {
    let addr = m[1].trim().replace(/\s+/g, ' ').replace(/[,.\s]+$/, '');
    addr = addr.replace(/\bl[aă][sşș][iî]\b/gi, 'Iași');
    result.adresa_punct_lucru = addr;
  }
  // Also try: "Punct de lucru" pattern
  if (!result.adresa_punct_lucru) {
    m = t.match(/[Pp]unct\s+de\s+lucru\s*[:\-]?\s*(.+?)(?:\n|$|specifice)/i);
    if (m) {
      let addr = m[1].trim().replace(/\s+/g, ' ').replace(/[,.\s]+$/, '');
      addr = addr.replace(/\bl[aă][sşș][iî]\b/gi, 'Iași');
      result.adresa_punct_lucru = addr;
    }
  }

  // ---- JUDET ----
  m = t.match(/(?:jude[tț](?:ul)?|Jud\.?)\s*[:\-]?\s*([A-ZȘȚĂÎÂ][a-zșțăîâ]{2,15})/i);
  if (m) result.judet = m[1].trim();
  // Fallback: "Judet Iasi" in address
  if (!result.judet) {
    m = t.match(/[Jj]ude[tț]\s+([A-ZȘȚĂÎÂ][a-zșțăîâ]+)/);
    if (m) result.judet = m[1].trim();
  }
  // Fallback: "Jude Iasi" or "lași" (common OCR error)
  if (!result.judet) {
    if (/Ia[sș]i|lași|iaşi/i.test(t)) result.judet = 'Iași';
  }

  // NOTE: Administrator is now extracted from Carte de Identitate (buletin), not from certificat.
  // The CI parseCarteIdentitate() sets result.administrator = fidejusor_nume.

  return result;
}

/**
 * Extract data from Carte de Identitate (CI) text
 * Uses both visual text and MRZ (Machine Readable Zone) parsing
 */
function parseCarteIdentitate(text) {
  const result = {};
  const t = text.replace(/\r\n/g, '\n');

  // ---- TRY MRZ PARSING FIRST (more reliable) ----
  // Romanian CI MRZ line 1: IDROU<SURNAME<<FIRSTNAME<<<<<<
  // MRZ line 2: CNP_CHECK + other data
  let m;
  const mrzLine1 = t.match(/IDROU([A-Z<]+)/);
  if (mrzLine1) {
    const mrzNames = mrzLine1[1].split('<<').filter(Boolean);
    if (mrzNames.length >= 2) {
      result.nume = mrzNames[0].replace(/</g, ' ').trim();
      result.prenume = mrzNames[1].replace(/</g, ' ').trim();
    } else if (mrzNames.length === 1) {
      // All in one segment, split by single <
      const parts = mrzLine1[1].replace(/<<+/g, '|').replace(/<$/g, '').split('|').filter(Boolean);
      if (parts.length >= 2) {
        result.nume = parts[0].replace(/</g, ' ').trim();
        result.prenume = parts[1].replace(/</g, ' ').trim();
      }
    }
  }

  // ---- FALLBACK: Visual text parsing ----
  if (!result.nume) {
    m = t.match(/(?:Nume|Last\s*Name|Numele)\s*[\/:\-]?\s*([A-ZȘȚĂÎÂ\-\s]{2,30})/i);
    if (m) result.nume = m[1].trim();
  }
  if (!result.prenume) {
    m = t.match(/(?:Prenume|First\s*Name|Prenumele)\s*[\/:\-]?\s*([A-ZȘȚĂÎÂa-zșțăîâ\-\s]{2,40})/i);
    if (m) result.prenume = m[1].trim();
  }

  // Also try to find POPA or any ALL-CAPS name right after "Nume" label
  if (!result.nume) {
    m = t.match(/(?:Nume[\/\s])[^\n]*?([A-ZȘȚĂÎÂ]{2,20})\b/);
    if (m) result.nume = m[1].trim();
  }
  if (!result.prenume) {
    m = t.match(/(?:Prenume)[^\n]*?([A-ZȘȚĂÎÂ][A-ZȘȚĂÎÂa-zșțăîâ\-]+(?:\s*[\-]\s*[A-ZȘȚĂÎÂa-zșțăîâ]+)*)/);
    if (m) result.prenume = m[1].trim();
  }

  // Full name — format prenume with hyphen if it has multiple parts from MRZ
  // MRZ uses < as separator: STEFANITA<PANTELIMON → STEFANITA-PANTELIMON
  if (result.nume && result.prenume) {
    // If prenume has spaces and came from MRZ (all caps, no hyphens), join with hyphen
    let prenume = result.prenume;
    if (/^[A-Z\s]+$/.test(prenume) && prenume.includes(' ')) {
      prenume = prenume.split(/\s+/).join('-');
      result.prenume = prenume;
    }
    result.fidejusor_nume = result.nume + ' ' + result.prenume;
    // Administrator = same person from CI (user confirmed: "datele administratorului se extrag din CI")
    result.administrator = result.fidejusor_nume;
  }

  // Seria + Nr — prefer MRZ line 2 (most reliable): IZ105517<0ROU...
  // MRZ line 2 format: SERIAL_NR<CHECK_DIGIT ROU ...
  const mrzLine2 = t.match(/([A-Z]{2})(\d{5,7})<\d/);
  if (mrzLine2) {
    result.fidejusor_ci_seria = mrzLine2[1];
    result.fidejusor_ci_nr = mrzLine2[2];
  }

  // Fallback: visual text patterns
  if (!result.fidejusor_ci_seria) {
    m = t.match(/(?:[Ss]eri[ae])\s*[:\-]?\s*([A-Z]{2})\s*[,.\s]*(?:[Nn]r\.?)\s*[:\-]?\s*(\d{5,7})/);
    if (!m) m = t.match(/([A-Z]{2})\s*[,.\s]*(?:nr|Nr|NR)\.?\s*[:\-]?\s*(\d{5,7})/);
    if (!m) m = t.match(/(?:sera|serie)\s+([A-Z]{2})\s*[,.\s]*(?:ye|nr|ne)\s+(\d{5,7})/i);
    if (m) {
      result.fidejusor_ci_seria = m[1];
      result.fidejusor_ci_nr = m[2];
    }
  }

  // Domiciliu / Address
  // Try visual text patterns
  m = t.match(/(?:Domicili(?:ul|u)?|Adresa?|Address)\s*[\/:\-]?\s*((?:(?:Mun|Str|Sos|Bd|loc|sat|com|jud|oras)\.\s*)?[A-ZȘȚĂÎÂa-zșțăîâ0-9\s\.,\-\/]+?)(?:\n\n|\n(?:CNP|Val|Emis|Sex))/i);
  if (m) result.fidejusor_domiciliu = m[1].trim().replace(/\s+/g, ' ').replace(/\s*,\s*$/, '');

  // Try: "Jud.IS Sat.Valea..." or "Jud.1S Sat.Vale..." (OCR garbles IS as 1S)
  if (!result.fidejusor_domiciliu) {
    m = t.match(/Jud\.?\s*([A-Z0-9]{2})\s+((?:Mun|Sat|Com|Loc|Str|Sos)\.[A-Za-zșțăîâĂÂÎȘȚ0-9\s\.,\-\/()]+)/i);
    if (m) result.fidejusor_domiciliu = ('Jud.' + m[1].replace(/[01]/g, c => c === '1' ? 'I' : 'O') + ' ' + m[2]).trim().replace(/\s+/g, ' ');
  }

  // Fallback: grab everything between "Jud." and next known field (SPCLEP, Emis, Valid)
  if (!result.fidejusor_domiciliu) {
    m = t.match(/Jud\.?\s*[A-Z0-9]{2}\s+[^\n]+(?:\n[^\n]*?(?:Str|nr|Mai|Com|Sat)[^\n]+)?/i);
    if (m) {
      let addr = m[0].trim().replace(/\s+/g, ' ').replace(/\s*,\s*$/, '');
      // Fix OCR: "1S" → "IS"
      addr = addr.replace(/Jud\.?\s*1S\b/, 'Jud. IS');
      result.fidejusor_domiciliu = addr;
    }
  }

  // CNP (personal identification number) - 13 digits
  m = t.match(/(?:CNP|Cod\s*numeric)\s*[:\-]?\s*(\d{13})/i);
  if (m) result.cnp = m[1];
  if (!result.cnp) {
    // Look in MRZ line 2 — format: 13digits<check...
    m = t.match(/(\d{13})\s*[<]/);
    if (m) result.cnp = m[1];
  }
  if (!result.cnp) {
    // Just find 13 consecutive digits
    m = t.match(/(?<!\d)(\d{13})(?!\d)/);
    if (m) result.cnp = m[1];
  }

  return result;
}

/**
 * Extract data from CUI certificate (Certificat de Inregistrare)
 * Note: These certificates are often rotated 90° — auto-rotation handles this.
 */
function parseCertificatCUI(text) {
  const result = {};
  const t = text.replace(/\r\n/g, '\n');

  let m;

  // ---- CUI ----
  // OCR may garble "Cod Unic de Inregistrare" as "Cod Umc de Integistrare" etc.
  // Be very flexible: look for "Cod" + any word + "de" + any word + ": DIGITS"
  m = t.match(/[Cc]od\s+\w+\s+de\s+\w+\s*[:\-;]\s*(\d{5,10})/);
  if (m) result.cui = 'RO' + m[1];
  if (!result.cui) {
    m = t.match(/(?:cod\s*(?:unic|fiscal)|C\.?\s*U\.?\s*I\.?)\s*[:\-]?\s*(?:RO\s*)?(\d{5,10})/i);
    if (m) result.cui = 'RO' + m[1];
  }
  if (!result.cui) {
    m = t.match(/(?:RO\s?)(\d{5,10})/);
    if (m) result.cui = 'RO' + m[1];
  }
  // Fallback: nregistrare near digits
  if (!result.cui) {
    m = t.match(/(?:gistrare|nregistrare|fiscal)\s*[:\-;]?\s*(\d{7,10})/i);
    if (m) result.cui = 'RO' + m[1];
  }

  // ---- DENUMIRE ----
  // OCR may read "Firma:" as "Fitma:", "Fîrma:", or "Firmă" etc.
  // Also match across OCR noise: "QUATRO GRUP DISTRIBUTION S" on fragmented lines
  m = t.match(/(?:F[iîl][rt]m[aăă]|Denumire|firma)\s*[:\-,;.]?\s*([A-ZȘȚĂÎÂa-zșțăîâ0-9\s\.\-&]+?)\s*[-–]?\s*S[:\.\s]?\s*R[:\.\s]?\s*[LI][:\.]?/i);
  if (m) {
    let name = m[1].trim().replace(/\s+/g, ' ');
    name = name.replace(/^[\d\s\.\-~]+/, '').trim();
    if (name.length > 3) result.denumire_societate = name + ' SRL';
  }
  // Also try: "Firma: QUATRO GRUP DISTRIBUTION SRL" with flexible SRL matching
  if (!result.denumire_societate) {
    m = t.match(/[Ff][iîl][rt]m[aăă]\s*[:\-,;.]?\s*([A-ZȘȚĂÎÂ][A-ZȘȚĂÎÂa-zșțăîâ0-9\s\.\-&]{3,50}?)(?:\s+S(?:RL|\.R\.L|[:\s]*R[:\s]*L)|\s*$)/i);
    if (m) {
      let name = m[1].trim().replace(/\s+/g, ' ');
      if (name.length > 3) result.denumire_societate = name + ' SRL';
    }
  }

  // Fallback: ALL-CAPS company name + SRL-like ending
  if (!result.denumire_societate) {
    m = t.match(/([A-ZȘȚĂÎÂ][A-ZȘȚĂÎÂ0-9\s\.\-&]{3,50})\s*S[:\.]?\s*R[:\.]?\s*[LI][:\.]?/);
    if (m) {
      let name = m[1].trim().replace(/\s+/g, ' ').replace(/^[\d\s\.\-~]+/, '').trim();
      if (name.length > 3) result.denumire_societate = name + ' SRL';
    }
  }

  // ---- ORC NUMBER ----
  m = t.match(/(J\s*\d{1,2}\s*\/\s*\d{1,5}\s*\/\s*[\d.]+\d{4})/i);
  if (m) {
    // Clean: J22/409/20.02.2009 → J22/409/2009
    let orc = m[1].replace(/\s/g, '');
    // Remove date part if present (keep only J22/409/2009 format)
    orc = orc.replace(/\/(\d{2}\.\d{2}\.)(\d{4})$/, '/$2');
    result.orc_nr = orc;
  }

  // ---- SEDIU SOCIAL ----
  // OCR may read "Sediu" as "Sedju" etc.
  // Match: "Sediu social: Jud. Iasi, Municipiul Iasi, Sos. PACURARI..."
  m = t.match(/[Ss]ed[ijl]u\s*(?:social)?\s*[:\-;,]?\s*((?:Jud\.?\s*[A-Za-zșțăîâ]+[,;]?\s*)?(?:MUNICIPIUL|MUN\.?|Municipiul|SOS\.?|Sos[:\.]?|STR\.?|Str\.?|BD\.?)\s*[A-ZȘȚĂÎÂa-zșțăîâ0-9\s\.,;:\-\/()]+?)(?:\n|[Cc]od\s|Acti)/i);
  if (m) {
    let addr = m[1].trim().replace(/\s+/g, ' ');
    addr = addr.replace(/Sos:/g, 'Sos.').replace(/;/g, ',').replace(/[,.\s]+$/, '');
    // Fix OCR: "fasi" → "Iasi"
    addr = addr.replace(/\bfasi\b/gi, 'Iasi').replace(/\blaşi\b/gi, 'Iași');
    result.sediu_social = addr;
  }
  // Fallback: "Jud. X, Municipiul Y, Sos./Str. ..."
  if (!result.sediu_social) {
    m = t.match(/(Jud\.?\s*[A-Za-zșțăîâ]+[,;]\s*Municipiul\s*[A-Za-zșțăîâ]+[,;]\s*(?:Sos|Str|Bd)\.\s*[A-ZȘȚĂÎÂa-zșțăîâ0-9\s\.,;:\-\/]+?)(?:\n|Cod|Acti)/i);
    if (m) result.sediu_social = m[1].trim().replace(/\s+/g, ' ').replace(/;/g, ',').replace(/[,.\s]+$/, '');
  }

  // ---- JUDET (from address) ----
  m = t.match(/[Jj]ude[tțţ]ul?\s+([A-ZȘȚĂÎÂ][A-Za-zșțăîâ]+)/);
  if (m) result.judet = m[1].trim();
  if (!result.judet && /IA[SŞȘ]I/i.test(t)) result.judet = 'Iași';

  return result;
}

/**
 * Main extraction function - processes an uploaded image and returns structured data
 * @param {Buffer} imageBuffer - The image file buffer
 * @param {string} docType - 'certificat', 'buletin', or 'cui'
 * @returns {Object} Extracted data fields
 */
async function extractFromDocument(imageBuffer, docType) {
  console.log(`[OCR] Starting extraction for: ${docType}`);
  const startTime = Date.now();

  // Convert PDF to image once, then use imgBuf for everything
  let imgBuf = imageBuffer;
  if (isPDF(imageBuffer)) {
    console.log('[OCR] Detected PDF input, converting to image...');
    imgBuf = pdfToImage(imageBuffer);
    console.log(`[OCR] PDF converted to image (${imgBuf.length} bytes)`);
  }

  const text = await ocrImage(imgBuf);
  console.log(`[OCR] Text extracted in ${Date.now() - startTime}ms (${text.length} chars)`);
  console.log(`[OCR] Raw text preview: ${text.substring(0, 300)}...`);

  let extracted = {};

  switch (docType) {
    case 'certificat':
      extracted = parseCertificatConstatator(text);
      break;
    case 'buletin':
      extracted = parseCarteIdentitate(text);
      break;
    case 'cui':
      extracted = parseCertificatCUI(text);
      break;
    default:
      // Try all parsers and merge
      extracted = {
        ...parseCertificatConstatator(text),
        ...parseCarteIdentitate(text),
        ...parseCertificatCUI(text),
      };
  }

  // If CUI doc type and extraction was poor, try with cropped image (remove decorative borders)
  if (docType === 'cui' && Object.keys(extracted).length < 2) {
    console.log(`[OCR] CUI extraction poor (${Object.keys(extracted).length} fields), retrying with cropped image...`);
    try {
      const cropped = await cropCenter(imgBuf);
      const croppedProcessed = await preprocessImage(cropped);
      const sched = await getScheduler();
      const { data: croppedData } = await sched.addJob('recognize', croppedProcessed);
      console.log(`[OCR] Cropped text (${croppedData.text.length} chars): ${croppedData.text.substring(0, 300)}...`);
      const croppedExtracted = parseCertificatCUI(croppedData.text);
      // Merge: use cropped data where original was empty
      for (const [k, v] of Object.entries(croppedExtracted)) {
        if (!extracted[k]) extracted[k] = v;
      }
      console.log(`[OCR] After crop retry: ${Object.keys(extracted).length} fields`);
    } catch(e) {
      console.log(`[OCR] Cropped retry failed: ${e.message}`);
    }
  }

  // If certificat extraction was poor, also try cropped
  if (docType === 'certificat' && Object.keys(extracted).length < 3) {
    console.log(`[OCR] Certificat extraction poor, retrying with cropped image...`);
    try {
      const cropped = await cropCenter(imgBuf);
      const croppedProcessed = await preprocessImage(cropped);
      const sched = await getScheduler();
      const { data: croppedData } = await sched.addJob('recognize', croppedProcessed);
      const croppedExtracted = parseCertificatConstatator(croppedData.text);
      for (const [k, v] of Object.entries(croppedExtracted)) {
        if (!extracted[k]) extracted[k] = v;
      }
    } catch(e) { console.log(`[OCR] Cropped retry failed: ${e.message}`); }
  }

  console.log(`[OCR] Extracted fields:`, JSON.stringify(extracted));
  return { extracted, rawText: text };
}

/**
 * Cleanup - terminate scheduler when shutting down
 */
async function terminateOCR() {
  if (scheduler) {
    await scheduler.terminate();
    scheduler = null;
    schedulerReady = false;
  }
}

module.exports = { extractFromDocument, terminateOCR };
