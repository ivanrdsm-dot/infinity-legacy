-- ========================================================
-- INFINITY LEGACY CHATBOT — SCHEMA SUPABASE
-- Version: 1.0
-- Fecha: 2026-05-16
-- Mantenido por: Iván Cadavieeco
-- ========================================================
-- Cómo aplicar:
--   1. Crear proyecto Supabase nuevo en supabase.com (free tier)
--   2. Database → SQL Editor → New query → pegar este archivo → Run
--   3. Variables de entorno necesarias en Vercel:
--      - SUPABASE_URL
--      - SUPABASE_SERVICE_ROLE_KEY (server-side only, NUNCA expose)
--      - SUPABASE_ANON_KEY (solo si dashboard frontend la necesita)
-- ========================================================

-- Extensiones útiles
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────
-- TABLA: leads
-- Cada lead que escribe al WhatsApp
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wa_phone        TEXT UNIQUE NOT NULL,            -- ej. 525519385348 (sin +)
  wa_name         TEXT,                            -- nombre del perfil de WhatsApp
  full_name       TEXT,                            -- nombre real, capturado en conversación
  email           TEXT,
  city            TEXT,
  country         TEXT DEFAULT 'MX',
  age_range       TEXT,                            -- "30-40", "40-50", etc.

  -- Origen del lead
  source          TEXT,                            -- 'meta', 'web', 'organic', 'referral', 'direct'
  campaign        TEXT,                            -- el utm_campaign / il-ref cmp
  ad_id           TEXT,                            -- el ad específico que generó (ej. image_narrativa5pct_v07)
  landing_url     TEXT,                            -- donde aterrizó si vino de web
  calc_amount     INTEGER,                         -- monto de la calculadora si la usó
  calc_plan       TEXT,                            -- plan calculado (BRONZE/SILVER/GOLD/BLACK/BLACK_MORE_PLUS)
  calc_months     INTEGER,                         -- 12 o 24

  -- Estado del lead
  stage           TEXT NOT NULL DEFAULT 'INITIAL', -- INITIAL/QUALIFYING/EDUCATING/PRESENTING/CLOSING/SCHEDULED/POST_SESSION/NURTURING/WON/LOST
  matched_plan    TEXT,                            -- BRONZE/SILVER/GOLD/BLACK/BLACK_MORE_PLUS
  lead_score      INTEGER DEFAULT 0,               -- 0-100, computado
  priority        TEXT DEFAULT 'normal',           -- 'urgent', 'high', 'normal', 'low'

  -- Takeover (control humano vs bot)
  bot_paused      BOOLEAN DEFAULT FALSE,           -- true = humano contesta, false = bot contesta
  paused_at       TIMESTAMPTZ,
  paused_by       TEXT,                            -- quién pausó (ej. "ivan")

  -- Metadatos
  first_message_at  TIMESTAMPTZ DEFAULT NOW(),
  last_message_at   TIMESTAMPTZ DEFAULT NOW(),
  last_outbound_at  TIMESTAMPTZ,                   -- última vez que NOSOTROS le escribimos
  message_count     INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_leads_wa_phone ON leads (wa_phone);
CREATE INDEX idx_leads_stage    ON leads (stage);
CREATE INDEX idx_leads_priority ON leads (priority);
CREATE INDEX idx_leads_last_msg ON leads (last_message_at DESC);
CREATE INDEX idx_leads_paused   ON leads (bot_paused);

-- ─────────────────────────────────────────────────────────
-- TABLA: messages
-- Historial completo de todas las conversaciones
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

  -- Dirección
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_type     TEXT NOT NULL,                   -- 'lead' / 'bot' / 'ivan' / 'system'

  -- Contenido
  body            TEXT NOT NULL,
  message_type    TEXT DEFAULT 'text',             -- text/image/audio/document/template
  template_name   TEXT,                            -- si fue plantilla WA aprobada por Meta
  media_url       TEXT,

  -- Tracking
  wa_message_id   TEXT,                            -- ID que devuelve Meta WA API
  il_ref          TEXT,                            -- el [il-ref:...] parseado si venía pre-fill
  llm_model       TEXT,                            -- 'claude-sonnet-4-5' si fue bot
  llm_tokens_in   INTEGER,
  llm_tokens_out  INTEGER,
  llm_cost_usd    NUMERIC(10,5),

  -- Status delivery
  delivery_status TEXT DEFAULT 'sent',             -- sent / delivered / read / failed
  failed_reason   TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_lead_id    ON messages (lead_id, created_at DESC);
CREATE INDEX idx_messages_direction  ON messages (direction);
CREATE INDEX idx_messages_unprocessed ON messages (created_at DESC) WHERE direction = 'inbound';

-- ─────────────────────────────────────────────────────────
-- TABLA: follow_ups
-- Cola de follow-ups pendientes
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follow_ups (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  scheduled_for   TIMESTAMPTZ NOT NULL,
  followup_type   TEXT NOT NULL,                   -- '5min', '10min', '30min', '1day', '3day', '7day', '14day', 'custom'
  status          TEXT NOT NULL DEFAULT 'pending', -- pending / sent / cancelled / failed
  message_preview TEXT,                            -- preview de lo que se va a mandar
  sent_at         TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancelled_reason TEXT,                           -- 'lead_responded' / 'manual_cancel' / 'lead_won' / 'lead_lost'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_followups_scheduled ON follow_ups (scheduled_for) WHERE status = 'pending';
CREATE INDEX idx_followups_lead      ON follow_ups (lead_id);

-- ─────────────────────────────────────────────────────────
-- TABLA: escalations
-- Cuando bot escala a Iván
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escalations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL,                   -- 'black_more_plus' / 'legal_threat' / 'human_requested' / 'unknown_question' / 'ready_to_buy'
  urgency         TEXT NOT NULL DEFAULT 'normal',  -- 'urgent' / 'high' / 'normal'
  context         TEXT,                            -- mensaje original que disparó la escalación
  notified_at     TIMESTAMPTZ DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  resolution_notes TEXT
);

CREATE INDEX idx_escalations_unack ON escalations (notified_at DESC) WHERE acknowledged_at IS NULL;
CREATE INDEX idx_escalations_lead  ON escalations (lead_id);

-- ─────────────────────────────────────────────────────────
-- TABLA: notes
-- Notas internas sobre cada lead (no se envían al lead)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author          TEXT NOT NULL,                   -- 'ivan', 'bot', 'system'
  body            TEXT NOT NULL,
  tag             TEXT,                            -- 'intent', 'objection', 'context', 'compliance', 'reminder'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notes_lead ON notes (lead_id, created_at DESC);

-- ─────────────────────────────────────────────────────────
-- TABLA: appointments
-- Sesiones de 60 minutos agendadas
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  duration_min    INTEGER DEFAULT 60,
  status          TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled / completed / no_show / cancelled / rescheduled
  source          TEXT,                            -- 'calendly' / 'manual' / 'bot'
  calendly_event_id TEXT,
  google_event_id   TEXT,
  meeting_link    TEXT,                            -- zoom / meet link
  notes           TEXT,
  outcome         TEXT,                            -- 'signed' / 'follow_up_needed' / 'lost' / 'thinking'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_appointments_lead     ON appointments (lead_id);
CREATE INDEX idx_appointments_upcoming ON appointments (scheduled_at) WHERE status = 'scheduled';

-- ─────────────────────────────────────────────────────────
-- TABLA: contracts (cuando lead se convierte en mandante)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contracts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  plan            TEXT NOT NULL CHECK (plan IN ('BRONZE', 'SILVER', 'GOLD', 'BLACK', 'BLACK_MORE_PLUS')),
  amount_mxn      NUMERIC(12,2) NOT NULL,
  vigencia_months INTEGER NOT NULL CHECK (vigencia_months IN (12, 24)),
  signed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  token_address   TEXT,                            -- dirección ERC-20 del token emitido
  status          TEXT NOT NULL DEFAULT 'active',  -- active / completed / cancelled
  ad_attribution  TEXT,                            -- copy del [il-ref] original que generó este lead
  source_lead_source TEXT,                         -- duplicado de leads.source para reporting
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_contracts_lead     ON contracts (lead_id);
CREATE INDEX idx_contracts_plan     ON contracts (plan);
CREATE INDEX idx_contracts_active   ON contracts (status) WHERE status = 'active';

-- ─────────────────────────────────────────────────────────
-- VIEW: lead_dashboard (para el dashboard de Iván)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW lead_dashboard AS
SELECT
  l.id,
  l.wa_phone,
  COALESCE(l.full_name, l.wa_name) AS name,
  l.stage,
  l.matched_plan,
  l.lead_score,
  l.priority,
  l.bot_paused,
  l.source,
  l.ad_id,
  l.calc_amount,
  l.calc_plan,
  l.last_message_at,
  l.message_count,
  (SELECT body FROM messages m WHERE m.lead_id = l.id ORDER BY created_at DESC LIMIT 1) AS last_message_body,
  (SELECT direction FROM messages m WHERE m.lead_id = l.id ORDER BY created_at DESC LIMIT 1) AS last_message_direction,
  (SELECT COUNT(*) FROM escalations e WHERE e.lead_id = l.id AND e.acknowledged_at IS NULL) AS pending_escalations,
  (SELECT COUNT(*) FROM appointments a WHERE a.lead_id = l.id AND a.status = 'scheduled') AS upcoming_appointments
FROM leads l
ORDER BY
  CASE l.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
  l.last_message_at DESC;

-- ─────────────────────────────────────────────────────────
-- FUNCIÓN: actualizar updated_at automáticamente
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY (RLS)
-- Importante: el service_role bypassa todas las RLS
-- ─────────────────────────────────────────────────────────
ALTER TABLE leads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups   ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts    ENABLE ROW LEVEL SECURITY;

-- Policy: service role tiene acceso total (lo que usa el webhook server-side)
-- Policy: authenticated users (Iván desde el dashboard) puede leer/escribir
CREATE POLICY "service_role_all" ON leads        FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON messages     FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON follow_ups   FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON escalations  FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON notes        FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON appointments FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON contracts    FOR ALL TO service_role USING (true);

-- Dashboard de Iván (authenticated)
CREATE POLICY "auth_read_all" ON leads        FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_all" ON messages     FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_all" ON follow_ups   FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_all" ON escalations  FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_all" ON notes        FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_all" ON appointments FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_all" ON contracts    FOR SELECT TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────
-- DATOS SEMILLA (opcional, para testing)
-- ─────────────────────────────────────────────────────────
-- INSERT INTO leads (wa_phone, wa_name, source, ad_id, stage) VALUES
--   ('525551234567', 'Test Lead 1', 'meta', 'image_narrativa5pct_v07', 'INITIAL');
