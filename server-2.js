// ══════════════════════════════════════════════════════
// منظومة انتخابات عائلة أبو طه — خادم OCR المدمج
// OCR.space (Primary) + Google Vision (Fallback)
// Arabic-optimized | Production-ready
// ══════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3001;
const OCR_SPACE_KEY = process.env.OCR_SPACE_KEY || 'K83406693888957';
const GOOGLE_VISION_KEY = process.env.GOOGLE_VISION_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://elections-abotaha.vercel.app';

// ══════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════
app.use(cors({
  origin: (origin, cb) => {
    const allowed = [ALLOWED_ORIGIN, 'http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'];
    if (!origin || allowed.includes(origin)) return cb(null, true);
    cb(null, true); // Allow all for now - restrict in production
  },
  methods: ['GET', 'POST', 'OPTIONS'],
}));
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/jpg','image/png','image/webp','image/gif','image/tiff'];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('نوع الملف غير مدعوم'));
  },
});

// ══════════════════════════════════════════════════════
// ARABIC NORMALIZER
// ══════════════════════════════════════════════════════
function normalizeArabicText(text) {
  if (!text) return '';
  return text
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670]/g, '') // Remove diacritics
    .replace(/[أإآٱ]/g, 'ا')   // Normalize Alef
    .replace(/ى/g, 'ي')         // Normalize Ya
    .replace(/ة/g, 'ه')         // Normalize Ta Marbuta
    .replace(/ؤ/g, 'و')         // Normalize Waw
    .replace(/ئ/g, 'ي')         // Normalize Ya Hamza
    .replace(/أبو\s*طه|أبوطه|ابوطه/g, 'ابو طه') // Abu Taha variants
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function levenshtein(a, b) {
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  let prev = Array.from({length: n+1}, (_, i) => i);
  let curr = new Array(n+1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i-1]===b[j-1] ? prev[j-1] : 1+Math.min(prev[j-1], prev[j], curr[j-1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function wordSimilarity(a, b) {
  const wa = a.split(/\s+/).filter(Boolean);
  const wb = b.split(/\s+/).filter(Boolean);
  if (!wa.length || !wb.length) return 0;
  let total = 0;
  wa.forEach(w => {
    let best = 0;
    wb.forEach(x => {
      const maxL = Math.max(w.length, x.length);
      if (!maxL) return;
      const score = ((maxL - levenshtein(w, x)) / maxL) * 100;
      if (score > best) best = score;
    });
    total += best;
  });
  return Math.round(total / wa.length);
}

function calcSimilarity(input, extracted) {
  const a = normalizeArabicText(input);
  const b = normalizeArabicText(extracted);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const maxL = Math.max(a.length, b.length);
  const charSim = Math.round(((maxL - levenshtein(a, b)) / maxL) * 100);
  const wSim = wordSimilarity(a, b);
  return Math.round(wSim * 0.65 + charSim * 0.35);
}

// ══════════════════════════════════════════════════════
// ID PARSER
// ══════════════════════════════════════════════════════
function extractIDNumber(text) {
  const cleaned = text.replace(/[oO]/g,'0').replace(/[lI]/g,'1');
  const direct = cleaned.match(/\b\d{9}\b/g);
  if (direct) return direct[0];
  const spaced = cleaned.match(/\b\d[\d ]{8,14}\d\b/g) || [];
  for (const m of spaced) {
    const d = m.replace(/\s/g,'');
    if (d.length === 9) return d;
  }
  const any = cleaned.match(/\d{9}/g);
  return any ? any[0] : '';
}

function extractName(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  
  // Method 0: Look for any line containing Abu Taha (most reliable for our family)
  const abuTahaRe = /أبو\s*طه|ابو\s*طه|أبوطه|ابوطه|أبو\s*طا|ابو\s*طا/i;
  for (const line of lines) {
    if (abuTahaRe.test(line)) {
      const arWords = line.match(/[\u0600-\u06FF]+/g) || [];
      if (arWords.length >= 2) return arWords.join(' ');
    }
  }

  // Method 1: Structured PA ID fields
  const fields = {};
  const patterns = [
    {key:'first', re:/الاسم\s*الشخصي|الاسم\s*الفردي|الاسم\s*الأول|الاسم/i},
    {key:'father', re:/اسم\s*الأب|اسم\s*الاب|الأب/i},
    {key:'grand', re:/اسم\s*الجد|الجد/i},
    {key:'family', re:/اسم\s*العائلة|العائلة|اللقب/i},
  ];
  lines.forEach(line => {
    patterns.forEach(({key, re}) => {
      if (re.test(line)) {
        const ci = line.search(/[:：]/);
        const val = ci !== -1 ? line.slice(ci+1).trim() : line.replace(re,'').trim();
        if (val && val.length > 1) fields[key] = val;
      }
    });
  });
  if (Object.keys(fields).length >= 2) {
    const parts = [fields.first, fields.father, fields.grand, fields.family].filter(Boolean);
    if (parts.length >= 2) return parts.join(' ');
  }

  // Method 2: Abu Taha in line  
  const abt = /اب[وu][\s-]*ط[هh]|ابوطه|أبوطه/i;
  for (const line of lines) {
    if (abt.test(line) && /[\u0600-\u06FF]/.test(line)) {
      const words = line.match(/[\u0600-\u06FF]+/g) || [];
      if (words.length >= 3) return words.join(' ');
    }
  }

  // Method 3: Arabic line with 3-6 words
  const arLines = lines.filter(l => {
    const arChars = (l.match(/[\u0600-\u06FF]/g)||[]).length;
    const total = l.replace(/[\s\d]/g,'').length;
    const words = l.split(/\s+/).filter(w => /[\u0600-\u06FF]/.test(w)).length;
    return total > 0 && arChars/total > 0.65 && words >= 3 && words <= 7 && !/\d{4,}/.test(l);
  });
  if (arLines.length) {
    arLines.sort((a,b) => Math.abs(a.split(/\s+/).length-4) - Math.abs(b.split(/\s+/).length-4));
    return arLines[0];
  }
  return '';
}

function detectDocType(text) {
  if (/جواز\s*سفر|passport/i.test(text)) return 'passport';
  if (/رخصة\s*قيادة|driving\s*licen/i.test(text)) return 'driving_license';
  if (/شهادة\s*ميلاد|birth\s*certif/i.test(text)) return 'birth_certificate';
  if (/مؤقتة|temporary/i.test(text)) return 'temp_id';
  if (/תעודת|הרשות/i.test(text)) return 'id_48';
  return 'pa_id';
}

function parseID(text) {
  return {
    name: extractName(text),
    idNumber: extractIDNumber(text),
    docType: detectDocType(text),
  };
}

// ══════════════════════════════════════════════════════
// OCR.SPACE SERVICE (Primary — 25,000/month free)
// ══════════════════════════════════════════════════════
async function ocrSpace(buffer, mime) {
  try {
    const form = new FormData();
    form.append('file', buffer, { filename:'id.jpg', contentType: mime });
    form.append('apikey', OCR_SPACE_KEY);
    form.append('language', 'ara');
    form.append('detectOrientation', 'true');
    form.append('scale', 'true');
    form.append('OCREngine', '2');

    const res = await axios.post('https://api.ocr.space/parse/image', form, {
      headers: form.getHeaders(), timeout: 20000,
    });
    const data = res.data;
    if (data.IsErroredOnProcessing) return { ok:false, text:'', conf:0, err: data.ErrorMessage?.[0] };
    const results = data.ParsedResults || [];
    const text = results.map(r => r.ParsedText||'').join('\n').trim();
    if (!text) return { ok:false, text:'', conf:0, err:'No text found' };
    const conf = results.reduce((s,r) => s + (parseFloat(r.TextOverlay?.MeanConfidence)||50), 0) / results.length;
    return { ok:true, text, conf: Math.round(conf), err:null };
  } catch(e) {
    return { ok:false, text:'', conf:0, err: e.message };
  }
}

// ══════════════════════════════════════════════════════
// GOOGLE VISION SERVICE (Fallback — 1,000/month free)
// ══════════════════════════════════════════════════════
async function googleVision(buffer) {
  if (!GOOGLE_VISION_KEY) return { ok:false, text:'', conf:0, err:'Not configured' };
  try {
    const b64 = buffer.toString('base64');
    const res = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_KEY}`,
      { requests:[{ image:{content:b64}, features:[{type:'DOCUMENT_TEXT_DETECTION'}], imageContext:{languageHints:['ar','he','en']} }] },
      { timeout:20000 }
    );
    const result = res.data?.responses?.[0];
    if (!result || result.error) return { ok:false, text:'', conf:0, err: result?.error?.message||'Error' };
    const text = result.fullTextAnnotation?.text?.trim() || result.textAnnotations?.[0]?.description?.trim() || '';
    if (!text) return { ok:false, text:'', conf:0, err:'No text' };
    return { ok:true, text, conf:80, err:null };
  } catch(e) {
    return { ok:false, text:'', conf:0, err: e.message };
  }
}

// ══════════════════════════════════════════════════════
// VERIFICATION LOGIC
// ══════════════════════════════════════════════════════
function getStatus(sim, idMatch) {
  if (sim >= 70 && idMatch) return 'verified';
  if (sim >= 50 || idMatch) return 'needs_review';
  if (sim > 0) return 'needs_review';
  return 'needs_review'; // Never auto-reject
}

function buildResult(text, name, id, service, conf) {
  const parsed = parseID(text);
  const sim = calcSimilarity(name, parsed.name);
  const idMatch = !!parsed.idNumber && parsed.idNumber === id;
  const status = getStatus(sim, idMatch);
  
  let message;
  if (status === 'verified') {
    message = `✅ تم التحقق — تطابق ${sim}%`;
  } else if (idMatch && sim >= 50) {
    message = `⚠️ رقم الهوية مطابق وتطابق الاسم ${sim}% — ستُراجع`;
  } else if (idMatch) {
    message = `⚠️ رقم الهوية مطابق لكن الاسم مختلف — ستُراجع`;
  } else if (sim >= 70) {
    message = `⚠️ الاسم متطابق ${sim}% لكن رقم الهوية مختلف — ستُراجع`;
  } else {
    message = `⚠️ تطابق ${sim}% — ستُراجع يدوياً من اللجنة`;
  }
  
  return {
    status,
    extracted_name: parsed.name,
    extracted_id: parsed.idNumber,
    doc_type: parsed.docType,
    confidence: sim,
    id_matched: idMatch,
    name_similarity: sim,
    ocr_service: service,
    ocr_confidence: conf,
    raw_text: text.substring(0, 500), // First 500 chars for debug
    message,
  };
}

// ══════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ status:'ok', name:'Abu Taha OCR Server', version:'2.0' }));

app.get('/api/health', (req, res) => res.json({
  status:'ok',
  ocr_space: !!OCR_SPACE_KEY,
  google_vision: !!GOOGLE_VISION_KEY,
  thresholds: { verified:'>=70%+ID', needs_review:'50-69%', never_auto_reject:true },
}));

app.post('/api/verify-id', upload.single('image'), async (req, res) => {
  const t = Date.now();
  try {
    const name = (req.body.entered_name||'').trim();
    const id = (req.body.entered_id||'').replace(/\s/g,'').trim();

    if (!req.file) return res.status(400).json({ status:'error', message:'يجب رفع صورة الهوية', extracted_name:'', extracted_id:'', confidence:0 });
    if (!name) return res.status(400).json({ status:'error', message:'الاسم مطلوب', extracted_name:'', extracted_id:'', confidence:0 });
    if (!/^\d{9}$/.test(id)) return res.status(400).json({ status:'error', message:'رقم الهوية يجب أن يكون 9 أرقام', extracted_name:'', extracted_id:'', confidence:0 });

    const {buffer, mimetype} = req.file;
    console.log(`[OCR] "${name}" | ID:${id} | ${buffer.length}b`);

    // Try OCR.space first
    const r1 = await ocrSpace(buffer, mimetype);
    console.log(`[OCR.space] ok:${r1.ok} conf:${r1.conf} len:${r1.text.length}`);

    if (r1.ok && r1.text.length >= 15 && r1.conf >= 25) {
      const result = buildResult(r1.text, name, id, 'ocr.space', r1.conf);
      if (result.name_similarity > 0 || result.id_matched) {
        console.log(`[OCR.space] ${result.status} ${result.name_similarity}% ${Date.now()-t}ms`);
        return res.json({...result, ms: Date.now()-t});
      }
    }

    // Fallback to Google Vision
    console.log('[OCR] Trying Google Vision...');
    const r2 = await googleVision(buffer);
    console.log(`[Google] ok:${r2.ok} conf:${r2.conf} len:${r2.text.length}`);

    if (r2.ok && r2.text.length >= 15) {
      const result = buildResult(r2.text, name, id, 'google_vision', r2.conf);
      console.log(`[Google] ${result.status} ${result.name_similarity}% ${Date.now()-t}ms`);
      return res.json({...result, ms: Date.now()-t});
    }

    // Both failed
    return res.json({
      status:'needs_review', extracted_name:'', extracted_id:'', doc_type:'unknown',
      confidence:0, id_matched:false, name_similarity:0,
      ocr_service:'none', ocr_confidence:0,
      message:'⚠️ تعذّرت القراءة — الصورة محفوظة وستُراجع يدوياً من اللجنة',
      errors:{ ocr_space:r1.err, google_vision:r2.err }, ms: Date.now()-t,
    });

  } catch(e) {
    console.error('[OCR Error]', e.message);
    return res.status(500).json({ status:'needs_review', message:'خطأ في الخادم', extracted_name:'', extracted_id:'', confidence:0 });
  }
});

// Error handler
app.use((err, req, res, next) => {
  res.status(400).json({ status:'error', message: err.message||'خطأ', extracted_name:'', extracted_id:'', confidence:0 });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════╗
║  Abu Taha OCR Server v2.0        ║
║  Port: ${PORT}                      ║
║  OCR.space:  ${OCR_SPACE_KEY ? '✅' : '❌'}                ║
║  G.Vision:   ${GOOGLE_VISION_KEY ? '✅' : '⚠️  Optional'}          ║
╚══════════════════════════════════╝`);
});

module.exports = app;
