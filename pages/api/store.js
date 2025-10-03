// file: pdf-compress-app/pages/api/store.js
import { createClient } from '@supabase/supabase-js';

const REQUIRED_ENVS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_BUCKET'];
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const DEFAULT_BUCKET = process.env.SUPABASE_BUCKET || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''; // optional
const RAW_ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb', // allow large base64 uploads
    },
  },
};

// ---- CORS helpers ----
function isOriginAllowed(origin) {
  if (!origin) return false;
  return RAW_ALLOWED.some(pattern => {
    if (pattern === origin) return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // e.g. ".vercel.app"
      return origin.endsWith(suffix);
    }
    return false;
  });
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin)) {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// Create admin client lazily after env validation
function getAdminClientOrThrow() {
  const missing = REQUIRED_ENVS.filter(k => !process.env[k]);
  if (missing.length) {
    const msg = `Missing required env: ${missing.join(', ')}`;
    const err = new Error(msg);
    err.statusCode = 500;
    throw err;
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  try {
    if (applyCors(req, res)) return;

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed', hint: 'Use POST with JSON body.' });
    }

    // Optional bearer secret (extra protection for server-to-server calls)
    if (WEBHOOK_SECRET) {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized: invalid bearer token' });
      }
    }

    const supabase = getAdminClientOrThrow();

    // ---- Accept both legacy and new body shapes ----
    // Legacy: { fileBase64, fileName, writingUploadId }
    // New:    { bucket?, path, dataBase64, contentType?, upsert?, cacheControl? }
    const {
      bucket = DEFAULT_BUCKET,
      path,                 // desired storage key (e.g. "compressed/123.pdf" or "Lucy.pdf")
      fileName,             // legacy
      dataBase64,           // preferred
      fileBase64,           // legacy
      contentType = 'application/pdf',
      upsert,               // optional; default false (legacy behavior)
      cacheControl = '3600',
      writingUploadId,      // legacy optional DB link
    } = req.body || {};

    // Base64 (support data URL or plain base64)
    let b64 = dataBase64 || fileBase64;
    if (!b64) {
      return res.status(400).json({
        error: 'Missing data: provide dataBase64 (preferred) or fileBase64',
        expected: '{ bucket?, path?, dataBase64?, fileBase64?, fileName? }',
      });
    }
    const cleanB64 = b64.replace(/^data:.*;base64,/, '');
    let bytes;
    try {
      bytes = Buffer.from(cleanB64, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid base64 data', details: e?.message || String(e) });
    }

    // Determine storage key
    let key = path;
    if (!key) {
      if (!fileName) {
        return res.status(400).json({
          error: 'Missing path and fileName',
          hint: 'Provide "path" (recommended) or legacy "fileName" to build a key.',
        });
      }
      key = `compressed/${Date.now()}-${fileName}`; // legacy behavior
    }

    // Upload to Supabase Storage
    const shouldUpsert = typeof upsert === 'boolean' ? upsert : false;
    const { error: uploadError } = await supabase
      .storage
      .from(bucket)
      .upload(key, bytes, {
        contentType,
        upsert: shouldUpsert,
        cacheControl,
      });

    if (uploadError) {
      return res.status(500).json({
        error: 'Upload failed',
        details: uploadError.message,
        hint: shouldUpsert ? undefined : 'If you intended to overwrite, send upsert: true',
      });
    }

    const compressed_size_bytes = bytes.length;

    // Legacy: update Writing_Uploads if an id was provided
    let writingUploadUpdated = false;
    if (writingUploadId) {
      const { error: dbErr } = await supabase
        .from('Writing_Uploads')
        .update({
          compressed_status: 'done',
          compressed_path: key,
          compressed_size_bytes,
          compressed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', writingUploadId);

      if (dbErr) {
        console.warn('[store] Writing_Uploads update failed:', dbErr.message);
      } else {
        writingUploadUpdated = true;
      }
    }

    return res.status(200).json({
      ok: true,
      bucket,
      path: key,
      bytes_written: compressed_size_bytes,
      contentType,
      upsert: shouldUpsert,
      writingUploadUpdated,
    });
  } catch (err) {
    console.error('[/api/store] Uncaught error', err);
    const status = err?.statusCode || 500;
    return res.status(status).json({
      error: 'Internal Server Error',
      details: err?.message || String(err),
    });
  }
}
