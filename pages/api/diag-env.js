// pages/api/diag-env.js
export default function handler(req, res) {
  res.status(200).json({
    hasUrl: !!process.env.SUPABASE_URL,
    hasRole: !!process.env.SUPABASE_SERVICE_ROLE,
    bucket: process.env.SUPABASE_BUCKET || null,
    node: process.version,
  });
}
