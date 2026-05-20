-- =============================================================
-- Infinity Legacy — Supabase Migrations
-- Run these in Supabase SQL Editor when needed.
-- =============================================================

-- ─── 2026-05-19 · Instagram channel support ───────────────────
-- Agregar columna `channel` a leads y messages para distinguir
-- entre WhatsApp e Instagram (y futuras integraciones).
-- Agregar `ig_user_id` a leads para identificadores de IG.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS ig_user_id TEXT,
  ADD COLUMN IF NOT EXISTS funnel_stage TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_ig_user_id ON leads(ig_user_id) WHERE ig_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads(channel);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'whatsapp';

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);

-- ─── Verificación ─────────────────────────────────────────────
-- Ejecuta esto para confirmar que las columnas existen:
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name IN ('leads','messages')
--   AND column_name IN ('channel','ig_user_id','funnel_stage');
