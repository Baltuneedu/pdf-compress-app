
// pages/api/compress-and-store.js
// Receives Supabase DB webhook on INSERT into pdf_storage
// Derives bucket/path, calls Render microservice, updates status & metrics

import { createClient } from '@supabase/supabase-js';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const DEFAULT_PDF_BUCKET = process.env.DEFAULT_PDF_BUCKET || process.env.SUPABASE_BUCKET || 'Teacher Writing Uploads';
const PDF_COMPRESSOR_URL = (process.env.PDF_COMPRESSOR_URL || '').replace(/\/+$/, '');
const PDF_COMPRESSOR_SECRET = process.env.PDF_COMPRESSOR_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

function unauthorized(res, msg = 'Unauthorized') {
  res.status(401).json({ ok: false, error: msg });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Verify webhook secret
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!WEBHOOK_SECRET || token !== WEBHOOK_SECRET) {
    return unauthorized(res);
  }

  try {
    const payload = req.body || {};
    const record = payload.record || payload.new || payload || {};
    const id = record.id;

    // Derive bucket & object path
    const bucket = record.bucket || DEFAULT_PDF_BUCKET;
    const name =
      record.file_path ||
      record.path ||
      record.object_path ||
      record.name ||
      record.file_name ||
      null;

    if (!bucket || !name) {
      return res.status(400).json({ ok: false, error: 'Missing bucket or object path from record' });
    }

    // 1) Mark as pending + start time (per-file; independent)
    await supabase
      .from('pdf_storage')
      .update({
        status: 'pending',
        processing_started_at: new Date().toISOString(),
      })
      .eq('id', id);

    // 2) Call microservice
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000); // 120s safety (you can raise if desired)
    const resp = await fetch(`${PDF_COMPRESSOR_URL}/compress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PDF_COMPRESSOR_SECRET}`,
      },
      body: JSON.stringify({ bucket, name }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    const body = await resp.json().catch(() => ({}));

    // Special case: too large (red cross in UI)
    if (body?.error === 'too_large') {
      await supabase
        .from('pdf_storage')
        .update({
          status: 'error',
          processing_finished_at: new Date().toISOString(),
          // processing_error: 'too_large', // uncomment and add column if you want
        })
        .eq('id', id);

      return res.status(200).json({ ok: false, error: 'too_large', ...body });
    }

    if (!resp.ok || !body.ok) {
      // 3a) Mark error for this file (independent of others)
      await supabase
        .from('pdf_storage')
        .update({
          status: 'error',
          processing_finished_at: new Date().toISOString(),
        })
        .eq('id', id);

      return res
        .status(502)
        .json({ ok: false, error: body.error || `compressor-service HTTP ${resp.status}` });
    }

    // 3b) Mark done + metrics (per-file; immediate)
    await supabase
      .from('pdf_storage')
      .update({
        status: 'done',
        processing_finished_at: new Date().toISOString(),
        compressed_size_bytes: body.compressed_bytes ?? null,
        compression_ratio: body.ratio ?? null,
        // New metrics fields for UI
        hit_target: body.hit_target ?? null,
        overwrote: body.overwrote ?? null,
        pass_used: body.pass_used ?? null,
      })
      .eq('id', id);

    return res.status(200).json({ ok: true, ...body });
  } catch (err) {
    // 4) Ensure error status is recorded for this file
    try {
      const payload = req.body || {};
      const record = payload.record || payload.new || payload || {};
      if (record?.id) {
        await supabase
          .from('pdf_storage')
          .update({
            status: 'error',
            processing_finished_at: new Date().toISOString(),
          })
          .eq('id', record.id);
      }
    } catch {}
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
