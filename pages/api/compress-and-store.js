// file: pdf-compress-app/pages/api/compress-and-store.js

import { createClient } from '@supabase/supabase-js';

const REQUIRED_ENVS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_BUCKET'];

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const DEFAULT_BUCKET = process.env.SUPABASE_BUCKET || '';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DELETE_ORIGINAL_AFTER_COMPRESS = process.env.DELETE_ORIGINAL_AFTER_COMPRESS === '1';
const RAW_ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb', // keep current limit
    },
  },
};

// ---- CORS helpers ----
function isOriginAllowed(origin) {
  if (!origin) return false;
  return RAW_ALLOWED.some(pattern => {
    if (pattern === origin) return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// ---- Supabase admin client ----
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

// ---- Placeholder compression (pass-through) ----
async function compressPdfPlaceholder(buffer) {
  console.info('[compress-and-store] Using placeholder compression (pass-through).');
  return buffer;
}

// ---- Helper: extract record from webhook payload ----
function extractRecordFromWebhook(body) {
  if (!body) return null;
  if (body.record) return body.record;
  if (body.new) return body.new;
  return null;
}

export default async function handler(req, res) {
  try {
    if (applyCors(req, res)) return;

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json({ error: 'Method Not Allowed', hint: 'Use POST with JSON body.' });
    }

    const supabase = getAdminClientOrThrow();
    const MIN_BYTES = 200 * 1024; // 200KB

    const record = extractRecordFromWebhook(req.body);
    const isWebhook = !!record;

    // Webhook authentication if enabled
    if (isWebhook && WEBHOOK_SECRET) {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized: invalid bearer token for webhook' });
      }
    }

    // ---------- Webhook mode ----------
    if (isWebhook) {
      const bucket = record.bucket_id || DEFAULT_BUCKET;
      const name = record.name;
      const size = (typeof record?.metadata?.size === 'number')
        ? record.metadata.size
        : (typeof record?.size === 'number' ? record.size : null);

      if (!bucket || !name) {
        return res.status(400).json({ error: 'Missing bucket_id or name in webhook record', record });
      }

      if (typeof size === 'number' && size <= MIN_BYTES) {
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: `size <= 200KB (${size} bytes)`,
          bucket,
          name,
        });
      }

      // Download original
      const { data: originalFile, error: dlError } = await supabase.storage.from(bucket).download(name);
      if (dlError) {
        return res.status(500).json({ error: 'Failed to download original', details: dlError.message, bucket, name });
      }

      const originalBuffer = Buffer.from(await originalFile.arrayBuffer());

      // Compress (placeholder)
      const compressedBuffer = await compressPdfPlaceholder(originalBuffer);

      // Upload compressed copy
      const destPath = `compressed/${name}`;
      const { error: upErr } = await supabase.storage.from(bucket).upload(destPath, compressedBuffer, {
        contentType: 'application/pdf',
        upsert: true,
        cacheControl: '3600',
      });

      if (upErr) {
        return res.status(500).json({ error: 'Failed to upload compressed copy', details: upErr.message, bucket, destPath });
      }

      // Optionally delete original
      let deletedOriginal = false;
      if (DELETE_ORIGINAL_AFTER_COMPRESS) {
        const { error: rmErr } = await supabase.storage.from(bucket).remove([name]);
        if (!rmErr) deletedOriginal = true;
      }

      return res.status(200).json({
        ok: true,
        mode: 'webhook',
        bucket,
        original_path: name,
        compressed_path: destPath,
        original_size_bytes: originalBuffer.length,
        compressed_size_bytes: compressedBuffer.length,
        compression_ratio: +(compressedBuffer.length / originalBuffer.length).toFixed(3),
        deleted_original: deletedOriginal,
        note: 'Compression is currently a placeholder pass-through.',
      });
    }

    // ---------- Manual mode (UploadButton.js) ----------
    const { supabasePath, fileBase64, writingUploadId } = req.body || {};
    if (!supabasePath && !fileBase64) {
      return res.status(400).json({ error: 'Provide supabasePath or fileBase64' });
    }

    let inputBuf;
    if (supabasePath) {
      const { data, error } = await supabase.storage.from(DEFAULT_BUCKET).download(supabasePath);
      if (error) {
        return res.status(500).json({
          error: 'Failed to download from Storage',
          details: error.message,
          bucket: DEFAULT_BUCKET,
          supabasePath,
        });
      }
      inputBuf = Buffer.from(await data.arrayBuffer());
    } else {
      const raw = fileBase64.replace(/^data:.*;base64,/, '');
      try {
        inputBuf = Buffer.from(raw, 'base64');
      } catch (e) {
        return res.status(400).json({ error: 'Invalid base64 data', details: e?.message || String(e) });
      }
    }

    const original_size_bytes = inputBuf.length;

    if (original_size_bytes <= MIN_BYTES) {
      return res.status(200).json({
        ok: true,
        mode: 'manual',
        skipped: true,
        reason: 'File under 0.2 MB threshold',
        original_size_bytes,
      });
    }

    // Compress
    const compressedBuf = await compressPdfPlaceholder(inputBuf);
    const compressed_size_bytes = compressedBuf.length;
    const compression_ratio = +(compressed_size_bytes / original_size_bytes).toFixed(3);

    const key = `compressed/${Date.now()}-auto.pdf`;
    const { error: uploadErr } = await supabase
      .storage
      .from(DEFAULT_BUCKET)
      .upload(key, compressedBuf, { contentType: 'application/pdf', upsert: true });

    if (uploadErr) {
      return res.status(500).json({ error: 'Failed to upload compressed file', details: uploadErr.message, bucket: DEFAULT_BUCKET, path: key });
    }

    // Optional DB update
    let writingUploadUpdated = false;
    if (writingUploadId) {
      const { error: dbErr } = await supabase.from('Writing_Uploads').update({
        compressed_status: 'done',
        original_size_bytes,
        compressed_size_bytes,
        compression_ratio,
        compressed_path: key,
        compressed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', writingUploadId);

      if (!dbErr) writingUploadUpdated = true;
    }

    return res.status(200).json({
      ok: true,
      mode: 'manual',
      bucket: DEFAULT_BUCKET,
      compressed_path: key,
      original_size_bytes,
      compressed_size_bytes,
      compression_ratio,
      writingUploadUpdated,
      note: 'Compression is currently a placeholder pass-through.',
    });

  } catch (e) {
    console.error('[/api/compress-and-store] Uncaught error', e);
    const status = e?.statusCode || 500;
    return res.status(status).json({
      error: 'Internal Server Error',
      details: e?.message || String(e),
    });
  }
}
