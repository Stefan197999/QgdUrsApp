require("dotenv").config();
const express = require("express");
const Database = require("better-sqlite3");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const emailReports = require("./emailReports");
const { generateContract, generateGDPR, generateContractB2B, generateGDPRB2B, generateContractB2C, generateGDPRB2C } = require("./docxGenerator");
const { extractFromDocument } = require("./ocrExtractor");
const XLSX_LIB = require("xlsx");

const app = express();

/* ───────── Security Headers (helmet) ───────── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org", "blob:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      connectSrc: ["'self'", "https://webservicesp.anaf.ro", "https://nominatim.openstreetmap.org"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

/* Extra security headers */
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self), camera=(self)");
  next();
});

/* ───────── Rate Limiting ───────── */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: "Prea multe cereri. Încearcă din nou în 15 minute." },
  standardHeaders: true, legacyHeaders: false
});
app.use(generalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Prea multe încercări de login. Blocat 15 minute." },
  standardHeaders: true, legacyHeaders: false
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Prea multe upload-uri. Încearcă în 1 oră." },
  standardHeaders: true, legacyHeaders: false
});

/* ── Input validation helpers ── */
function validateMonthFormat(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  const [year, m] = month.split("-").map(Number);
  return year >= 2020 && year <= 2099 && m >= 1 && m <= 12;
}

const ALLOWED_ROLES = ["admin", "spv", "agent", "upload"];

/* ───────── HTTPS redirect (self-hosted) ───────── */
const SELF_HOSTED = process.env.SELF_HOSTED === "true";
const SSL_CERT = process.env.SSL_CERT_PATH || "";
const SSL_KEY = process.env.SSL_KEY_PATH || "";

if (SELF_HOSTED) {
  app.use((req, res, next) => {
    if (!req.secure && req.headers["x-forwarded-proto"] !== "https" && SSL_CERT) {
      return res.redirect(301, "https://" + req.headers.host + req.url);
    }
    next();
  });
}

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

/* ───────── No-cache headers on static files ───────── */
app.use((req, res, next) => {
  if (/\.(js|css|html)$/i.test(req.path)) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});
app.use(express.static("public", { maxAge: 0, etag: false, lastModified: false }));

/* ───────── Config ───────── */
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

/* ───────── Database ───────── */
const DB_PATH = process.env.DB_PATH || "./data/app.db";
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/* ───────── Schema ───────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent',
    sales_rep TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT, firma TEXT, nume_poc TEXT, cif TEXT,
    adresa TEXT, oras TEXT, judet TEXT, municipality TEXT,
    agent TEXT, stare_poc TEXT, sales_rep TEXT,
    format TEXT, subformat TEXT, canal TEXT,
    lat REAL, lon REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    visited_at TEXT DEFAULT (datetime('now')),
    visited_by TEXT NOT NULL,
    photo_path TEXT DEFAULT '',
    photo_lat REAL, photo_lon REAL,
    photo_time TEXT DEFAULT '',
    note TEXT DEFAULT '',
    closed_at TEXT DEFAULT '',
    products_json TEXT DEFAULT '[]',
    total_required INTEGER DEFAULT 0,
    total_present INTEGER DEFAULT 0,
    score REAL DEFAULT 0,
    UNIQUE(client_id, visited_at)
  );

  CREATE INDEX IF NOT EXISTS idx_visits_client ON visits(client_id);
  CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visited_at);
  CREATE INDEX IF NOT EXISTS idx_visits_by ON visits(visited_by);
`);

/* ───────── Add csrf_token column to sessions ───────── */
try { db.exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT DEFAULT ''"); } catch(e) {}

/* ───────── Additional performance indexes ───────── */
try { db.exec("CREATE INDEX IF NOT EXISTS idx_deliveries_datadoc ON client_deliveries(datadoc)"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_deliveries_code ON client_deliveries(client_code)"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_proposals_client ON status_proposals(client_id)"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_proposals_status ON status_proposals(status)"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(username)"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_escalations_agent ON escalations(agent_username)"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_client_alerts_agent ON client_alerts(agent_username)"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_gps_user ON gps_locations(username)"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_gps_time ON gps_locations(recorded_at)"); } catch(e) {}

/* ───────── Add extra columns if missing ───────── */
try { db.exec("ALTER TABLE clients ADD COLUMN email TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE clients ADD COLUMN telefon TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE clients ADD COLUMN client_activ_quatro INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE clients ADD COLUMN on_component TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE clients ADD COLUMN numar_vitrine INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE clients ADD COLUMN numar_dozatoare INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE clients ADD COLUMN contact_person TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE clients ADD COLUMN agent_jti TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE clients ADD COLUMN sursa TEXT DEFAULT 'BB'"); } catch(e) {}

/* ═══════════ GT URSUS — Tables ═══════════ */
db.exec(`
  CREATE TABLE IF NOT EXISTS sku_mapping (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    denumire_dtr TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sku_bb TEXT NOT NULL,
    sku_local TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_sku_map_den ON sku_mapping(denumire_dtr COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS gt_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku_bb TEXT NOT NULL UNIQUE,
    gt_hl REAL DEFAULT 0,
    brand TEXT DEFAULT '',
    grupa_obiectiv TEXT DEFAULT '',
    impachetare TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_gt_prices_sku ON gt_prices(sku_bb);

  CREATE TABLE IF NOT EXISTS gt_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    target_core REAL DEFAULT 0,
    target_abi REAL DEFAULT 0,
    target_total REAL DEFAULT 0,
    UNIQUE(month, agent_name)
  );
  CREATE INDEX IF NOT EXISTS idx_gt_targets_month ON gt_targets(month);
`);

/* Add realizat columns to gt_targets (for centralizator import) */
try { db.exec("ALTER TABLE gt_targets ADD COLUMN real_core REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE gt_targets ADD COLUMN real_abi REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE gt_targets ADD COLUMN real_total REAL DEFAULT 0"); } catch(e) {}

/* GT columns on sales_data */
try { db.exec("ALTER TABLE sales_data ADD COLUMN gt_core_total REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE sales_data ADD COLUMN gt_abi_total REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE sales_data ADD COLUMN gt_other_total REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE sales_data ADD COLUMN gt_grand_total REAL DEFAULT 0"); } catch(e) {}

/* ───────── Sales targets & imports tables ───────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS sales_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    app_sales_rep TEXT NOT NULL,
    bb_total_val REAL DEFAULT 0,
    bb_core_val REAL DEFAULT 0,
    bb_abi_val REAL DEFAULT 0,
    bb_total_hl REAL DEFAULT 0,
    clienti_2sku INTEGER DEFAULT 0,
    UNIQUE(month, agent_name)
  );
  CREATE INDEX IF NOT EXISTS idx_targets_month ON sales_targets(month);

  CREATE TABLE IF NOT EXISTS sales_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    agent_report_name TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    total_valoare REAL DEFAULT 0,
    total_hl REAL DEFAULT 0,
    total_clienti INTEGER DEFAULT 0,
    clienti_2sku INTEGER DEFAULT 0,
    last_import TEXT DEFAULT (datetime('now')),
    import_file TEXT DEFAULT '',
    UNIQUE(month, agent_name)
  );
  CREATE INDEX IF NOT EXISTS idx_sales_month ON sales_data(month);

  CREATE TABLE IF NOT EXISTS client_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    client_code TEXT NOT NULL,
    codintern TEXT NOT NULL,
    denumire TEXT NOT NULL,
    cantitate REAL DEFAULT 0,
    valoare REAL DEFAULT 0,
    datadoc TEXT DEFAULT '',
    UNIQUE(month, client_code, codintern, datadoc)
  );
  CREATE INDEX IF NOT EXISTS idx_deliveries_client ON client_deliveries(month, client_code);
`);

/* ───────── Daily sales (raw, non-duplicated) ───────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    datadoc TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL DEFAULT '',
    total_hl REAL DEFAULT 0,
    total_valoare REAL DEFAULT 0,
    UNIQUE(month, datadoc, agent, client_id)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_sales_month ON daily_sales(month, datadoc);
`);

/* ───────── Status proposals table ───────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS status_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    proposed_status TEXT NOT NULL DEFAULT 'inactiv',
    reason TEXT DEFAULT '',
    proposed_by TEXT NOT NULL,
    proposed_at TEXT DEFAULT (datetime('now')),
    reviewed_by TEXT DEFAULT '',
    reviewed_at TEXT DEFAULT '',
    decision TEXT DEFAULT 'pending',
    review_note TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_client ON status_proposals(client_id);
  CREATE INDEX IF NOT EXISTS idx_proposals_decision ON status_proposals(decision);
`);

/* ───────── Add datadoc column to client_deliveries if missing ───────── */
try { db.exec("ALTER TABLE client_deliveries ADD COLUMN datadoc TEXT DEFAULT ''"); } catch(e) {}
// Create datadoc index (after column exists)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_deliveries_datadoc ON client_deliveries(datadoc)"); } catch(e) {}
// Recreate unique index to include datadoc
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_unique_datadoc ON client_deliveries(month, client_code, codintern, datadoc)"); } catch(e) {}

/* ───────── Add rename columns to proposals if missing ───────── */
try { db.exec("ALTER TABLE status_proposals ADD COLUMN new_firma TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE status_proposals ADD COLUMN new_nume_poc TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE status_proposals ADD COLUMN new_cif TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE status_proposals ADD COLUMN new_contact TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE status_proposals ADD COLUMN new_telefon TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE status_proposals ADD COLUMN new_email TEXT DEFAULT ''"); } catch(e) {}

/* ═══════════ SECȚIUNEA CLIENȚI TABLES ═══════════ */

/* ── Solduri Critice ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS critical_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_code TEXT NOT NULL,
    client_name TEXT DEFAULT '',
    agent TEXT DEFAULT '',
    balance REAL DEFAULT 0,
    overdue_days INTEGER DEFAULT 0,
    due_date TEXT DEFAULT '',
    upload_date TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_critbal_agent ON critical_balances(agent);
  CREATE INDEX IF NOT EXISTS idx_critbal_upload ON critical_balances(upload_date);
  CREATE INDEX IF NOT EXISTS idx_critbal_code ON critical_balances(client_code);
`);

/* ── Escaladări SPV ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id),
    agent_username TEXT NOT NULL,
    agent_name TEXT DEFAULT '',
    message TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_by TEXT DEFAULT '',
    resolved_at TEXT DEFAULT '',
    checkin_photo TEXT DEFAULT '',
    checkin_lat REAL,
    checkin_lon REAL,
    checkin_note TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_esc_agent ON escalations(agent_username);
  CREATE INDEX IF NOT EXISTS idx_esc_status ON escalations(status);
`);

/* ── Alertă Client (risc operațional/financiar) ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS client_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id),
    alert_type TEXT NOT NULL DEFAULT 'other',
    reason TEXT DEFAULT '',
    reported_by TEXT NOT NULL,
    reported_at TEXT DEFAULT (datetime('now')),
    acknowledged_by TEXT DEFAULT '',
    acknowledged_at TEXT DEFAULT '',
    status TEXT DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS idx_calert_status ON client_alerts(status);
  CREATE INDEX IF NOT EXISTS idx_calert_reporter ON client_alerts(reported_by);
`);

/* ── Alertă Risc Financiar (Coface) ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS financial_risks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_code TEXT DEFAULT '',
    client_name TEXT DEFAULT '',
    risk_score TEXT DEFAULT '',
    risk_details TEXT DEFAULT '',
    upload_date TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_finrisk_code ON financial_risks(client_code);
  CREATE INDEX IF NOT EXISTS idx_finrisk_upload ON financial_risks(upload_date);
`);

/* ── Verificare CUI ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS cui_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id),
    cui TEXT NOT NULL,
    company_name TEXT DEFAULT '',
    address TEXT DEFAULT '',
    administrator TEXT DEFAULT '',
    guarantor TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    id_series TEXT DEFAULT '',
    id_number TEXT DEFAULT '',
    email TEXT DEFAULT '',
    verified_by TEXT NOT NULL,
    verified_at TEXT DEFAULT (datetime('now')),
    gdpr_accepted INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cui_client ON cui_verifications(client_id);
  CREATE INDEX IF NOT EXISTS idx_cui_code ON cui_verifications(cui);
`);

/* ═══════════ SECȚIUNEA PERFORMANȚĂ TABLES ═══════════ */

/* ── Performanță Targete (by producer) ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS producer_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    producer TEXT NOT NULL DEFAULT 'BB',
    target_val REAL DEFAULT 0,
    target_hl REAL DEFAULT 0,
    target_clienti INTEGER DEFAULT 0,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT DEFAULT (datetime('now')),
    UNIQUE(month, agent_name, producer)
  );
  CREATE INDEX IF NOT EXISTS idx_ptargets_month ON producer_targets(month);
`);

/* ── Add target_unit column (valoare/bucati) to producer_targets ── */
try { db.exec("ALTER TABLE producer_targets ADD COLUMN target_unit TEXT DEFAULT 'valoare'"); } catch(e) {}

/* ── Vânzări ALL — fișier zilnic complet cu toate produsele ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS sales_all (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    datadoc TEXT DEFAULT '',
    agent_name TEXT NOT NULL,
    gama TEXT NOT NULL DEFAULT '',
    denumire TEXT DEFAULT '',
    dci TEXT DEFAULT '',
    cant REAL DEFAULT 0,
    canthl REAL DEFAULT 0,
    valoare REAL DEFAULT 0,
    client TEXT DEFAULT '',
    codfiscal TEXT DEFAULT '',
    nrdoc TEXT DEFAULT '',
    pret_disc REAL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sales_all_month ON sales_all(month);
  CREATE INDEX IF NOT EXISTS idx_sales_all_agent ON sales_all(agent_name);
  CREATE INDEX IF NOT EXISTS idx_sales_all_gama ON sales_all(gama);
`);

/* ── Target Calculator — config sezonier + pondere agenți ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS target_calc_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_key TEXT NOT NULL UNIQUE,
    config_value TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS target_calc_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    producer TEXT NOT NULL DEFAULT 'BB',
    weight_pct REAL DEFAULT 0,
    target_val REAL DEFAULT 0,
    target_hl REAL DEFAULT 0,
    manual_adj_pct REAL DEFAULT 0,
    final_target_val REAL DEFAULT 0,
    final_target_hl REAL DEFAULT 0,
    calculated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(month, agent_name, producer)
  );
  CREATE INDEX IF NOT EXISTS idx_tcalc_month ON target_calc_results(month);
`);

/* ── Ranking Agenți ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_rankings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    app_sales_rep TEXT DEFAULT '',
    kpi_val_pct REAL DEFAULT 0,
    kpi_hl_pct REAL DEFAULT 0,
    kpi_clienti_pct REAL DEFAULT 0,
    kpi_visits INTEGER DEFAULT 0,
    kpi_audit_score REAL DEFAULT 0,
    total_score REAL DEFAULT 0,
    rank_position INTEGER DEFAULT 0,
    computed_at TEXT DEFAULT (datetime('now')),
    UNIQUE(month, agent_name)
  );
  CREATE INDEX IF NOT EXISTS idx_rankings_month ON agent_rankings(month);
`);

/* ── Control Discounturi ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS discount_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    agent TEXT NOT NULL,
    client_code TEXT DEFAULT '',
    client_name TEXT DEFAULT '',
    product TEXT DEFAULT '',
    list_price REAL DEFAULT 0,
    sold_price REAL DEFAULT 0,
    discount_pct REAL DEFAULT 0,
    quantity REAL DEFAULT 0,
    total_loss REAL DEFAULT 0,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_disc_month ON discount_alerts(month);
  CREATE INDEX IF NOT EXISTS idx_disc_agent ON discount_alerts(agent);
`);

/* ═══════════ SECȚIUNEA CONTRACTE TABLES ═══════════ */

/* ── Contracte Clienți ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS client_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id),
    cui TEXT DEFAULT '',
    company_name TEXT DEFAULT '',
    address TEXT DEFAULT '',
    orc_number TEXT DEFAULT '',
    administrator TEXT DEFAULT '',
    guarantor TEXT DEFAULT '',
    guarantor_address TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    id_series TEXT DEFAULT '',
    id_number TEXT DEFAULT '',
    email TEXT DEFAULT '',
    contract_date TEXT DEFAULT '',
    gdpr_accepted INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_contracts_client ON client_contracts(client_id);
  CREATE INDEX IF NOT EXISTS idx_contracts_cui ON client_contracts(cui);
`);
try { db.exec("ALTER TABLE client_contracts ADD COLUMN orc_number TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE client_contracts ADD COLUMN guarantor_address TEXT DEFAULT ''"); } catch(e) {}

/* ═══════════ CONTRACTE B2C (Evenimente PF) ═══════════ */
db.exec(`
  CREATE TABLE IF NOT EXISTS contracts_b2c (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nume_complet TEXT DEFAULT '',
    cnp TEXT DEFAULT '',
    ci_seria TEXT DEFAULT '',
    ci_nr TEXT DEFAULT '',
    ci_emitent TEXT DEFAULT '',
    ci_data TEXT DEFAULT '',
    localitate TEXT DEFAULT '',
    strada TEXT DEFAULT '',
    nr_strada TEXT DEFAULT '',
    bloc TEXT DEFAULT '',
    scara TEXT DEFAULT '',
    apartament TEXT DEFAULT '',
    judet TEXT DEFAULT '',
    telefon TEXT DEFAULT '',
    email TEXT DEFAULT '',
    tip_eveniment TEXT DEFAULT '',
    data_eveniment TEXT DEFAULT '',
    pret_total TEXT DEFAULT '',
    adresa_livrare TEXT DEFAULT '',
    suporta_transport TEXT DEFAULT 'Cumpărător',
    data_livrare TEXT DEFAULT '',
    interval_orar TEXT DEFAULT '',
    iban_retur TEXT DEFAULT '',
    ci_photo TEXT DEFAULT '',
    gdpr_accepted INTEGER DEFAULT 0,
    email_sent INTEGER DEFAULT 0,
    email_sent_at TEXT DEFAULT '',
    status TEXT DEFAULT 'draft',
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

/* ═══════════ SECȚIUNEA OBIECTIVE LUNARE TABLES ═══════════ */

/* ── Setare Targete SMART ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS smart_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    app_sales_rep TEXT DEFAULT '',
    prev_year_val REAL DEFAULT 0,
    prev_month_val REAL DEFAULT 0,
    producer_target REAL DEFAULT 0,
    seasonal_coeff REAL DEFAULT 1.0,
    growth_coeff REAL DEFAULT 1.0,
    computed_target_val REAL DEFAULT 0,
    computed_target_hl REAL DEFAULT 0,
    computed_target_clienti INTEGER DEFAULT 0,
    manual_adjustment REAL DEFAULT 0,
    final_target_val REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    set_by TEXT NOT NULL,
    set_at TEXT DEFAULT (datetime('now')),
    UNIQUE(month, agent_name)
  );
  CREATE INDEX IF NOT EXISTS idx_smart_month ON smart_targets(month);
`);

/* ═══════════ SECȚIUNEA BUGETE PROMO TABLES ═══════════ */

/* ── Monitorizare Bugete Promo ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS promo_budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    promo_name TEXT NOT NULL,
    producer TEXT DEFAULT 'Ursus',
    total_budget REAL DEFAULT 0,
    allocated_budget REAL DEFAULT 0,
    spent_budget REAL DEFAULT 0,
    agent TEXT DEFAULT '',
    agent_budget REAL DEFAULT 0,
    agent_spent REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_promobudg_month ON promo_budgets(month);
  CREATE INDEX IF NOT EXISTS idx_promobudg_agent ON promo_budgets(agent);
`);

/* ═══════════ NOTIFICĂRI IN-APP ═══════════ */
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT DEFAULT '',
    title TEXT NOT NULL,
    message TEXT DEFAULT '',
    type TEXT DEFAULT 'info',
    link_tab TEXT DEFAULT '',
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(username);
  CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(is_read);
`);

/* ═══════════ APP CHANGELOG (Ce e nou?) ═══════════ */
db.exec(`
  CREATE TABLE IF NOT EXISTS app_changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    change_date TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    module TEXT DEFAULT '',
    change_type TEXT DEFAULT 'feature',
    visibility TEXT DEFAULT 'all'
  );
`);


/* ── Add last_login to users ── */
try { db.exec("ALTER TABLE users ADD COLUMN last_login TEXT DEFAULT ''"); } catch(e) {}

/* ── Add division column to users — for SPV filtering on dashboard ── */
try { db.exec("ALTER TABLE users ADD COLUMN division TEXT DEFAULT ''"); } catch(e) {}

/* ═══════════ NEW MODULES TABLES ═══════════ */

/* ── 1. COMUNICARE / ANUNȚURI ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    priority TEXT DEFAULT 'normal',
    target_role TEXT DEFAULT 'all',
    target_agent TEXT DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT DEFAULT '',
    pinned INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ann_created ON announcements(created_at);
`);

/* ── 2. TASKURI / SARCINI ZILNICE ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    assigned_to TEXT NOT NULL DEFAULT '',
    assigned_by TEXT NOT NULL,
    due_date TEXT DEFAULT '',
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'pending',
    completed_at TEXT DEFAULT '',
    completed_note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
`);

/* ── 3. GPS TRACKING ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS gps_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    agent_name TEXT DEFAULT '',
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    accuracy REAL DEFAULT 0,
    speed REAL DEFAULT 0,
    recorded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gps_user ON gps_locations(username);
  CREATE INDEX IF NOT EXISTS idx_gps_time ON gps_locations(recorded_at);
`);

/* ── GPS data compression: keep 1 point per 10 min for data older than 7 days ── */
function compressGpsData() {
  try {
    const deleted = db.prepare(`
      DELETE FROM gps_locations WHERE id NOT IN (
        SELECT MIN(id) FROM gps_locations
        WHERE recorded_at < datetime('now', '-7 days')
        GROUP BY username, strftime('%Y-%m-%d %H', recorded_at), CAST(strftime('%M', recorded_at) AS INTEGER) / 10
      ) AND recorded_at < datetime('now', '-7 days')
    `).run();
    if (deleted.changes > 0) console.log(`[GPS] Compressed: removed ${deleted.changes} old entries`);
  } catch (e) { console.error("[GPS] Compression error:", e.message); }
}
// Run compression daily
compressGpsData();
setInterval(compressGpsData, 24 * 60 * 60 * 1000);

/* ── CLIENT NOU (B2B) ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS client_nou (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Company info (from OCR CUI)
    denumire_societate TEXT NOT NULL DEFAULT '',
    sediu_social TEXT DEFAULT '',
    strada TEXT DEFAULT '',
    numar TEXT DEFAULT '',
    judet TEXT DEFAULT '',
    orc_nr TEXT DEFAULT '',
    cui TEXT DEFAULT '',
    -- Admin info (from OCR CI)
    administrator TEXT DEFAULT '',
    cnp TEXT DEFAULT '',
    fidejusor_ci_seria TEXT DEFAULT '',
    fidejusor_ci_nr TEXT DEFAULT '',
    fidejusor_domiciliu TEXT DEFAULT '',
    -- Contact & bank (agent edits)
    telefon TEXT DEFAULT '',
    email TEXT DEFAULT '',
    iban TEXT DEFAULT '',
    banca TEXT DEFAULT '',
    -- Location
    adresa_punct_lucru TEXT DEFAULT '',
    foto_magazin TEXT DEFAULT '',
    foto_lat REAL,
    foto_lon REAL,
    lat REAL,
    lon REAL,
    -- Scanned docs
    scan_cui TEXT DEFAULT '',
    scan_ci TEXT DEFAULT '',
    -- Contract status
    contract_b2b_complet INTEGER DEFAULT 0,
    gdpr_complet INTEGER DEFAULT 0,
    -- Status & tracking
    status TEXT DEFAULT 'draft',
    notificare_trimisa INTEGER DEFAULT 0,
    email_trimis INTEGER DEFAULT 0,
    created_by TEXT DEFAULT '',
    agent TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_client_nou_agent ON client_nou(agent);
  CREATE INDEX IF NOT EXISTS idx_client_nou_status ON client_nou(status);
  CREATE INDEX IF NOT EXISTS idx_client_nou_cui ON client_nou(cui);
`);

/* ── 4. COMPETIȚIE / INTELLIGENCE ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS competition_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id),
    reported_by TEXT NOT NULL,
    competitor_brand TEXT DEFAULT '',
    competitor_product TEXT DEFAULT '',
    competitor_price REAL DEFAULT 0,
    competitor_promo TEXT DEFAULT '',
    shelf_presence TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    photo_url TEXT DEFAULT '',
    reported_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_comp_client ON competition_reports(client_id);
  CREATE INDEX IF NOT EXISTS idx_comp_date ON competition_reports(reported_at);
`);

/* ── 5. STOC FRIGIDER / MERCHANDISING ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS fridge_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id),
    audited_by TEXT NOT NULL,
    fridge_present INTEGER DEFAULT 0,
    fridge_functional INTEGER DEFAULT 0,
    fridge_clean INTEGER DEFAULT 0,
    fridge_branded INTEGER DEFAULT 0,
    stock_level TEXT DEFAULT 'normal',
    sku_count INTEGER DEFAULT 0,
    competitor_products INTEGER DEFAULT 0,
    photo_before TEXT DEFAULT '',
    photo_after TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    audited_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_fridge_client ON fridge_audits(client_id);
  CREATE INDEX IF NOT EXISTS idx_fridge_date ON fridge_audits(audited_at);
`);

/* ── 6. PROMOȚII ACTIVE ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    products TEXT DEFAULT '',
    target_canal TEXT DEFAULT '',
    target_format TEXT DEFAULT '',
    mechanic TEXT DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    active INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_promo_dates ON promotions(start_date, end_date);

  CREATE TABLE IF NOT EXISTS promo_activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promo_id INTEGER REFERENCES promotions(id),
    client_id INTEGER REFERENCES clients(id),
    activated_by TEXT NOT NULL,
    activated_at TEXT DEFAULT (datetime('now')),
    notes TEXT DEFAULT '',
    UNIQUE(promo_id, client_id)
  );
`);

/* ── 7. CALENDAR / PLANIFICARE RUTE ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS beat_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_username TEXT NOT NULL,
    client_id INTEGER REFERENCES clients(id),
    day_of_week TEXT NOT NULL,
    visit_frequency TEXT DEFAULT 'weekly',
    priority INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agent_username, client_id, day_of_week)
  );
  CREATE INDEX IF NOT EXISTS idx_beat_agent ON beat_plans(agent_username);
  CREATE INDEX IF NOT EXISTS idx_beat_day ON beat_plans(day_of_week);
`);

/* ── 8. EXPIRĂRI / FRESHNESS ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS expiry_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id),
    reported_by TEXT NOT NULL,
    product_name TEXT NOT NULL,
    batch_number TEXT DEFAULT '',
    expiry_date TEXT NOT NULL,
    quantity INTEGER DEFAULT 0,
    action_needed TEXT DEFAULT 'collect',
    status TEXT DEFAULT 'reported',
    resolved_by TEXT DEFAULT '',
    resolved_at TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    reported_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_expiry_client ON expiry_reports(client_id);
  CREATE INDEX IF NOT EXISTS idx_expiry_date ON expiry_reports(expiry_date);
  CREATE INDEX IF NOT EXISTS idx_expiry_status ON expiry_reports(status);
`);

/* ───────── Vizite check-in table (Faza 1 + Faza 2) ───────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS visits_checkin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    client_type TEXT DEFAULT 'census',
    username TEXT,
    agent TEXT,
    client_name TEXT,
    localitate TEXT,
    judet TEXT,
    lat REAL,
    lon REAL,
    photo_url TEXT,
    notes TEXT DEFAULT '',
    visit_date TEXT,
    visit_day TEXT,
    visit_time TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_vcheckin_agent ON visits_checkin(agent);
  CREATE INDEX IF NOT EXISTS idx_vcheckin_date ON visits_checkin(visit_date);
  CREATE INDEX IF NOT EXISTS idx_vcheckin_client ON visits_checkin(client_id);
`);

/* ───────── Rute Predefinite (imported from Excel) ───────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    route_day TEXT NOT NULL,
    cod_unic TEXT,
    client_name TEXT,
    adresa TEXT,
    cod_fiscal TEXT,
    incredere TEXT,
    vizite INTEGER DEFAULT 0,
    distributie_zile TEXT,
    ultima_factura TEXT,
    client_id INTEGER DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_aroutes_agent ON agent_routes(agent_name);
  CREATE INDEX IF NOT EXISTS idx_aroutes_day ON agent_routes(route_day);
`);

/* ───────── Încasări (daily cash collections) table ───────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS incasari (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    agent_dtr TEXT NOT NULL,
    suma REAL NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, data)
  );
  CREATE INDEX IF NOT EXISTS idx_incasari_data ON incasari(data);
  CREATE INDEX IF NOT EXISTS idx_incasari_agent ON incasari(agent_dtr);

  CREATE TABLE IF NOT EXISTS scadentar_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    import_date TEXT NOT NULL,
    total_rows INTEGER DEFAULT 0,
    total_rest_plata REAL DEFAULT 0,
    imported_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scadentar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER,
    nr_crt INTEGER,
    partener TEXT,
    valoare REAL DEFAULT 0,
    rest REAL DEFAULT 0,
    document TEXT,
    depasire_termen INTEGER DEFAULT 0,
    agent TEXT,
    serie_document TEXT,
    cifra_afaceri_curent REAL DEFAULT 0,
    cifra_afaceri_prec REAL DEFAULT 0,
    cod_fiscal TEXT,
    blocat TEXT DEFAULT 'NU',
    divizie TEXT DEFAULT 'NECUNOSCUT',
    FOREIGN KEY (import_id) REFERENCES scadentar_imports(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_scadentar_import ON scadentar(import_id);
  CREATE INDEX IF NOT EXISTS idx_scadentar_agent ON scadentar(agent);
  CREATE INDEX IF NOT EXISTS idx_scadentar_partener ON scadentar(partener);
  CREATE INDEX IF NOT EXISTS idx_scadentar_divizie ON scadentar(divizie);
  CREATE INDEX IF NOT EXISTS idx_scadentar_depasire ON scadentar(depasire_termen);

  CREATE TABLE IF NOT EXISTS agent_divisions (
    agent_name TEXT PRIMARY KEY,
    division TEXT NOT NULL
  );
`);

/* ───────── Seed agent_divisions if empty ───────── */
const agentDivCount = db.prepare("SELECT COUNT(*) as c FROM agent_divisions").get().c;
if (agentDivCount === 0) {
  const insAD = db.prepare("INSERT OR IGNORE INTO agent_divisions (agent_name, division) VALUES (?,?)");
  const seedAD = db.transaction(() => {
    // URSUS (9 agents)
    for (const a of ['APOSTOL IONELA ELENA','BUTNARU IONUT','SMOCHINA COSTEL-PETRONEL','TODICA CONSTANTIN','APETREI CLAUDIU DANIEL','AVRAM LAVINIA ANDREEA','CAZACU SERGIU IOAN','MOCANU MIHAI','PALADE ANDREI COSMIN']) insAD.run(a, 'URSUS');
    // SPV
    insAD.run('IBRIAN BENONE', 'SPV');
  });
  seedAD();
  console.log("Seeded agent_divisions with URSUS agents");
}

/* ───────── Seed default users if table is empty ───────── */
const userCount = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
if (userCount === 0) {
  console.log("Creating default users...");
  const insUser = db.prepare("INSERT INTO users (username, password, display_name, role, sales_rep) VALUES (?,?,?,?,?)");
  const seedTx = db.transaction(() => {
    // Admin
    insUser.run("admin", "admin2026", "Administrator", "admin", "");
    // Supervisor
    insUser.run("ibrian", "spv2026", "Ibrian Benone (SPV)", "spv", "");
    // URSUS Agents
    insUser.run("apostol_urs1", "agent2026", "Apostol Ionela Elena URS1", "agent", "APOSTOL IONELA ELENA");
    insUser.run("butnaru_urs2", "agent2026", "Butnaru Ionut URS2", "agent", "BUTNARU IONUT");
    insUser.run("smochina_urs3", "agent2026", "Smochina Costel-Petronel URS3", "agent", "SMOCHINA COSTEL-PETRONEL");
    insUser.run("todica_urs4", "agent2026", "Todica Constantin URS4", "agent", "TODICA CONSTANTIN");
    insUser.run("apetrei_urs5", "agent2026", "Apetrei Claudiu Daniel URS5", "agent", "APETREI CLAUDIU DANIEL");
    insUser.run("avram_urs6", "agent2026", "Avram Lavinia Andreea URS6", "agent", "AVRAM LAVINIA ANDREEA");
    insUser.run("cazacu_urs7", "agent2026", "Cazacu Sergiu Ioan URS7", "agent", "CAZACU SERGIU IOAN");
    insUser.run("mocanu_urs8", "agent2026", "Mocanu Mihai URS8", "agent", "MOCANU MIHAI");
    insUser.run("palade_urs9", "agent2026", "Palade Andrei Cosmin URS9", "agent", "PALADE ANDREI COSMIN");
  });
  seedTx();
  console.log("Created 11 default users (admin, spv, 9 URSUS agents)");
}

/* ───────── Add SPV users (robqgd, mihqgd, gmqgd) ───────── */
{
  const addSpv = db.prepare("INSERT OR IGNORE INTO users (username, password, display_name, role, sales_rep) VALUES (?,?,?,?,?)");
  addSpv.run("robqgd", "Ursus2026!", "robqgd (SPV)", "spv", "");
  addSpv.run("mihqgd", "Ursus2026!", "mihqgd (SPV)", "spv", "");
  addSpv.run("gmqgd", "Ursus2026!", "gmqgd (SPV)", "spv", "");
  addSpv.run("mireqgd", "mireqgd2026", "mireqgd (SPV)", "spv", "");
  addSpv.run("qgdrapoarte", "qgdrapoarte2026", "QGD Rapoarte", "upload", "");
}

/* ───────── Migrate existing qgdrapoarte to upload role ───────── */
db.prepare("UPDATE users SET role='upload' WHERE username='qgdrapoarte'").run();

/* ───────── Set divisions for all agents/SPV ───────── */
{
  const setDiv = db.prepare("UPDATE users SET division=? WHERE username=?");
  // SPV Ibrian
  setDiv.run("URSUS", "ibrian");
  // URSUS Agents
  setDiv.run("URSUS", "apostol_urs1");
  setDiv.run("URSUS", "butnaru_urs2");
  setDiv.run("URSUS", "smochina_urs3");
  setDiv.run("URSUS", "todica_urs4");
  setDiv.run("URSUS", "apetrei_urs5");
  setDiv.run("URSUS", "avram_urs6");
  setDiv.run("URSUS", "cazacu_urs7");
  setDiv.run("URSUS", "mocanu_urs8");
  setDiv.run("URSUS", "palade_urs9");
  console.log("Divisions assigned to all URSUS agents/SPV");
}

/* ───────── Producer targets: upload manually via admin interface ───────── */
/* Targets for producer_targets table should be uploaded via the admin interface. */
/* No seed data is loaded for Februarie 2026 to allow clean manual upload. */

/* ───────── Migrate plain-text passwords to bcrypt hashes ───────── */
{
  const allUsers = db.prepare("SELECT id, password FROM users").all();
  const updatePw = db.prepare("UPDATE users SET password=? WHERE id=?");
  let migrated = 0;
  for (const u of allUsers) {
    /* If password doesn't start with $2a$ or $2b$, it's plain text */
    if (u.password && !u.password.startsWith("$2a$") && !u.password.startsWith("$2b$")) {
      const hash = bcrypt.hashSync(u.password, 10);
      updatePw.run(hash, u.id);
      migrated++;
    }
  }
  if (migrated > 0) console.log(`[Security] Migrated ${migrated} passwords to bcrypt hashes`);
}

/* ───────── Session expiration: add expires_at column if missing ───────── */
try {
  db.prepare("SELECT expires_at FROM sessions LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT");
  db.exec("UPDATE sessions SET expires_at = datetime(created_at, '+30 days') WHERE expires_at IS NULL");
  console.log("[Security] Added expires_at column to sessions table");
}

/* Cleanup expired sessions on startup and every hour */
function cleanupExpiredSessions() {
  const deleted = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run().changes;
  if (deleted > 0) console.log(`[Security] Cleaned up ${deleted} expired sessions`);
}
cleanupExpiredSessions();
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);

/* Index for faster session lookups */
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)");

/* ───────── One-time cleanup: remove test visits ───────── */
const CLEANUP_FLAG = "./data/.cleanup_done_v1";
if (!fs.existsSync(CLEANUP_FLAG)) {
  const delCount = db.prepare("DELETE FROM visits").run().changes;
  console.log(`CLEANUP: Removed ${delCount} test visits`);
  fs.writeFileSync(CLEANUP_FLAG, new Date().toISOString());
}

/* ───────── Seed sales targets from JSON ───────── */
const targetsPath = "./seed/targets.json";
if (fs.existsSync(targetsPath)) {
  const targetsData = JSON.parse(fs.readFileSync(targetsPath, "utf8"));
  const existingTargets = db.prepare("SELECT COUNT(*) as c FROM sales_targets WHERE month=?").get(targetsData.month).c;
  if (existingTargets === 0) {
    console.log(`Seeding targets for ${targetsData.month}...`);
    const insTarget = db.prepare("INSERT OR REPLACE INTO sales_targets (month, agent_name, app_sales_rep, bb_total_val, bb_core_val, bb_abi_val, bb_total_hl, clienti_2sku) VALUES (?,?,?,?,?,?,?,?)");
    const targetTx = db.transaction(() => {
      for (const [name, t] of Object.entries(targetsData.agents)) {
        insTarget.run(targetsData.month, name, t.app_sales_rep, t.bb_total_val, t.bb_core_val, t.bb_abi_val, t.bb_total_hl, t.clienti_2sku);
      }
    });
    targetTx();
    console.log(`Seeded ${Object.keys(targetsData.agents).length} agent targets for ${targetsData.month}`);
  }
}

/* ───────── Agent name mapping for sales import ───────── */
function normalizeAgentName(name) {
  if (!name) return "";
  return name.toUpperCase().replace(/\s+/g, " ").trim();
}

// Map from sales report agent names to app agent names
// Sales reports may have typos (AGAFITE vs AGAFITEI, double spaces, etc.)
function matchSalesAgentToApp(salesName) {
  const norm = normalizeAgentName(salesName);
  // Get all users with role=agent
  const agents = db.prepare("SELECT display_name, sales_rep FROM users WHERE role='agent'").all();

  // Try exact match on sales_rep without BB suffix
  for (const ag of agents) {
    const srBase = ag.sales_rep.replace(/\s*BB\w*\d*$/i, "").trim().toUpperCase();
    if (norm === srBase) return { agent_name: srBase, app_sales_rep: ag.sales_rep };
  }

  // Fuzzy matching: handle typos (AGAFITE→AGAFITEI), double spaces, MIHAIL→MIHAI etc.
  const normParts = norm.split(" ");
  for (const ag of agents) {
    const srBase = ag.sales_rep.replace(/\s*BB\w*\d*$/i, "").trim().toUpperCase();
    const srParts = srBase.split(" ");

    // Last name must match (first 5 chars at least)
    if (normParts[0].substring(0, 5) !== srParts[0].substring(0, 5)) continue;

    // Check remaining name parts with tolerance
    let matchScore = 0;
    const minParts = Math.min(normParts.length, srParts.length);
    for (let i = 0; i < minParts; i++) {
      const a = normParts[i];
      const b = srParts[i];
      if (a === b) matchScore += 2;
      else if (a.startsWith(b.substring(0, 4)) || b.startsWith(a.substring(0, 4))) matchScore += 1;
    }
    // Need good match score relative to name parts
    if (matchScore >= minParts) return { agent_name: srBase, app_sales_rep: ag.sales_rep };
  }

  return null;
}

/* ───────── Product matching: audit products ↔ sales DENUMIRE ───────── */
function normalizeProductForMatch(name) {
  if (!name) return { brand: "", container: "", volume: "", isNA: false, isUnfiltered: false, isFresh: false };
  let s = name.toUpperCase().trim();
  // Remove SGR, PROMO, PRET PROMO, 99%, FREE BEER, OW suffixes
  s = s.replace(/\s+SGR\b/g, "").replace(/\s+PROMO\b.*$/g, "").replace(/\s+FREE BEER\b/g, "").replace(/\s+OW\b/g, "");
  // Detect package: strip "PACH." prefix and "XBUC" suffix
  const isPack = /^PACH\.?\s+/i.test(s);
  if (isPack) {
    s = s.replace(/^PACH\.?\s+/i, "");
    // Remove "24BUC", "6BUC", "12BUC", "*12BUC", "312 BUC" etc
    s = s.replace(/\s*\*?\d+\s*BUC\b/gi, "");
    // Remove year like "2026"
    s = s.replace(/\s+20\d{2}\b/g, "");
  }
  s = s.trim();

  // Detect non-alcoholic
  const isNA = /\bF\.?\s*ALCOOL\b/i.test(s) || /\bNA\b/i.test(s) || /\b0\.0%/i.test(s) || /\bF\.?\s*ALC\b/i.test(s);
  // Detect unfiltered
  const isUnfiltered = /\bUNFILTERED\b/i.test(s);
  // Detect Fresh (brand)
  const isFresh = /\bFRESH\b/i.test(s);

  // Detect container type
  let container = "";
  if (/\bKEG\b/i.test(s)) container = "keg";
  else if (/\bDOZA\b/i.test(s) || /\bCAN\b/i.test(s)) container = "doza";
  else if (/\bPET\b/i.test(s)) container = "pet";
  else if (/\bNRGB\b/i.test(s)) container = "nrgb";
  else if (/\bRGB\b/i.test(s) || /\bSTICLA\b/i.test(s)) container = "sticla";

  // Extract volume (e.g. 0.5L, 0.33L, 2.5L, 30L, 1L)
  let volume = "";
  const volMatch = s.match(/(\d+(?:\.\d+)?)\s*L\b/i);
  if (volMatch) volume = volMatch[1];
  // Handle "2.5" without L (e.g. "Timisoreana PET 2.5 6 BUC")
  if (!volume) {
    const volMatch2 = s.match(/\bPET\s+(\d+(?:\.\d+)?)\b/i);
    if (volMatch2) volume = volMatch2[1];
  }

  // Detect brand
  let brand = "";
  if (/\bURSUS\b/i.test(s) && !isFresh) brand = "ursus";
  else if (/\bBECK'?S\b/i.test(s)) brand = "becks";
  else if (/\bCARAIMAN\b/i.test(s)) brand = "timisoreana";
  else if (/\bSTELLA\s*ARTOIS\b/i.test(s)) brand = "stella";
  else if (/\bSTAROPRAMEN\b/i.test(s)) brand = "staropramen";
  else if (/\bMADRI\b/i.test(s)) brand = "madri";
  else if (isFresh) brand = "fresh";
  else if (/\bCORONA\b/i.test(s)) brand = "corona";
  else if (/\bHOEGAARDEN\b/i.test(s)) brand = "hoegaarden";
  else if (/\bLEFFE\b/i.test(s)) brand = "leffe";
  else if (/\bNOROC\b/i.test(s)) brand = "noroc";
  else if (/\bFRANZISKANER\b/i.test(s)) brand = "franziskaner";
  else if (/\bHEINEKEN\b/i.test(s)) brand = "heineken";
  else if (/\bGOLDEN\s*BRAU\b/i.test(s)) brand = "golden_brau";
  else if (/\bCIUCAS\b/i.test(s)) brand = "ciucas";
  else if (/\bCIUC\b/i.test(s)) brand = "ciuc";
  else if (/\bTUBORG\b/i.test(s)) brand = "tuborg";
  else if (/\bURSUS\b/i.test(s)) brand = "ursus";
  else if (/\bBIRRA\s*MORETTI\b/i.test(s)) brand = "birra_moretti";

  // Detect Fresh flavour for matching
  let freshFlavour = "";
  if (isFresh) {
    if (/RASPBERRY.*BLUEBERRY|RASP.*BLUE/i.test(s)) freshFlavour = "raspberry_blueberry";
    else if (/LEMON.*ORANGE/i.test(s)) freshFlavour = "lemon_orange";
    else if (/POMEGRANATE.*GRAPE/i.test(s)) freshFlavour = "pomegranate_grape";
    else if (/CHERRY.*LEMON/i.test(s)) freshFlavour = "cherry_lemon";
    else if (/GRAPEFRUIT/i.test(s)) freshFlavour = "grapefruit";
  }

  return { brand, container, volume, isNA, isUnfiltered, isFresh, freshFlavour, isPack: !!isPack };
}

function doesSalesProductMatchAudit(salesDenumire, auditProductName) {
  const sale = normalizeProductForMatch(salesDenumire);
  const audit = normalizeProductForMatch(auditProductName);

  // Brand must match
  if (!sale.brand || !audit.brand || sale.brand !== audit.brand) return false;

  // Special: Fresh products - match by flavour + container + volume
  if (audit.isFresh && sale.isFresh) {
    if (audit.freshFlavour && sale.freshFlavour) {
      if (audit.freshFlavour !== sale.freshFlavour) return false;
      // Also check container type compatibility
      if (audit.container && sale.container && audit.container !== sale.container) return false;
      // Check volume
      if (audit.volume && sale.volume && audit.volume !== sale.volume) return false;
      return true;
    }
    return false;
  }

  // Non-alcoholic must match
  if (audit.isNA !== sale.isNA) {
    // Special case: Ursus NA vs regular Ursus
    if (audit.brand === "ursus") return false;
  }

  // Unfiltered must match
  if (audit.isUnfiltered !== sale.isUnfiltered) return false;

  // Container type matching (with flexibility for packs)
  // KEG must match KEG
  if (audit.container === "keg" && sale.container !== "keg") return false;
  if (sale.container === "keg" && audit.container !== "keg") return false;

  // For non-KEG: match container type (doza↔doza, nrgb↔nrgb, pet↔pet, sticla↔sticla)
  if (audit.container && sale.container && audit.container !== "keg") {
    if (audit.container !== sale.container) return false;
  }

  // Volume should match (if both have it)
  if (audit.volume && sale.volume) {
    if (audit.volume !== sale.volume) return false;
  }

  return true;
}

// Get delivered products for a specific client in a month
function getClientDeliveries(clientCode, month) {
  if (!clientCode || !month) return [];
  return db.prepare("SELECT DISTINCT denumire, codintern FROM client_deliveries WHERE client_code=? AND month=?").all(clientCode, month);
}

// Check which audit products were delivered to a client
function matchDeliveriesToAudit(clientCode, month, auditProducts) {
  const deliveries = getClientDeliveries(clientCode, month);
  if (deliveries.length === 0) return {};

  const result = {}; // auditProductName → { delivered: true/false, salesNames: [] }
  for (const ap of auditProducts) {
    const matches = [];
    for (const del of deliveries) {
      if (doesSalesProductMatchAudit(del.denumire, ap.product)) {
        matches.push(del.denumire);
      }
    }
    result[ap.product] = {
      delivered: matches.length > 0,
      salesNames: matches
    };
  }
  return result;
}

/* ── Map sales report client → census client code (via CIF + location) ── */
function normCif(cif) {
  return String(cif || "").replace(/\s/g, "").replace(/^RO/i, "").trim();
}

function normTextForMatch(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCifToClientsMap() {
  const allClients = db.prepare("SELECT code, firma, nume_poc, cif, adresa, oras FROM clients").all();
  const cifMap = {};
  for (const c of allClients) {
    const nc = normCif(c.cif);
    if (nc) {
      if (!cifMap[nc]) cifMap[nc] = [];
      cifMap[nc].push(c);
    }
  }
  return cifMap;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => { const r = new Array(n + 1); r[0] = i; return r; });
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function fuzzyWordMatch(kw, words, maxDist) {
  for (const w of words) {
    if (w.length >= 4 && kw.length >= 4 && Math.abs(w.length - kw.length) <= maxDist) {
      if (levenshtein(kw, w) <= maxDist) return true;
    }
  }
  return false;
}

function matchSalesClientBestLocation(salesName, candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].code;

  const firma = candidates[0].firma || "";
  // Extract location keywords: remove firma words and stop words from sales name
  const firmaWords = new Set(normTextForMatch(firma).split(" ").filter(w => w.length > 0));
  const stopWords = new Set(["srl", "pfa", "ii", "if", "sa", "nr", "str", "sos", "bar", "magazin", "supermarket", "depozit", "cash", "carry"]);

  const salesNorm = normTextForMatch(salesName);
  const locKeywords = salesNorm.split(" ").filter(w => w.length >= 2 && !firmaWords.has(w) && !stopWords.has(w));

  if (locKeywords.length === 0) return null;

  let bestScore = 0;
  let bestCode = null;

  for (const c of candidates) {
    const pocNorm = normTextForMatch(c.nume_poc);
    const orasNorm = normTextForMatch(c.oras);
    const addrNorm = normTextForMatch(c.adresa);

    let score = 0;
    const pocWords = pocNorm.split(" ");
    const orasWords = orasNorm.split(" ");
    const addrWords = addrNorm.split(" ");

    for (const kw of locKeywords) {
      // Exact substring match (highest priority)
      if (pocNorm.includes(kw)) score += 3;
      else if (fuzzyWordMatch(kw, pocWords, 2)) score += 2;
      else {
        // Prefix match
        for (const pw of pocWords) {
          if (pw.length >= 4 && kw.length >= 4) {
            if (pw.startsWith(kw) || kw.startsWith(pw)) { score += 1.5; break; }
          }
        }
      }
      if (orasNorm.includes(kw)) score += 2;
      else if (fuzzyWordMatch(kw, orasWords, 2)) score += 1.5;
      else {
        for (const ow of orasWords) {
          if (ow.length >= 4 && kw.length >= 4) {
            if (ow.startsWith(kw) || kw.startsWith(ow)) { score += 1; break; }
          }
        }
      }
      if (addrNorm.includes(kw)) score += 1;
      else if (fuzzyWordMatch(kw, addrWords, 2)) score += 0.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestCode = c.code;
    }
  }

  return bestScore > 0 ? bestCode : null;
}

/**
 * Map a sales report client (identified by CODUNIC + CLIENT name + CODFISCAL)
 * to census client code(s). Returns an array of census codes.
 * - Single CIF match → [code]
 * - Multi-location with location match → [matched_code]
 * - Multi-location without match → ALL codes with that CIF (broadcast)
 * - No CIF match → []
 */
function mapSalesClientToCensusCodes(salesClientName, salesCodFiscal, cifMap) {
  const nc = normCif(salesCodFiscal);
  if (!nc) return [];

  const candidates = cifMap[nc];
  if (!candidates || candidates.length === 0) return [];
  if (candidates.length === 1) return [candidates[0].code];

  // Multi-location: try location match first
  const bestMatch = matchSalesClientBestLocation(salesClientName, candidates);
  if (bestMatch) return [bestMatch];

  // Fallback: broadcast to ALL locations with this CIF
  return candidates.map(c => c.code);
}

/* ───────── Import / sync clients from JSON ───────── */
const clientCount = db.prepare("SELECT COUNT(*) as c FROM clients").get().c;
const clientsData = JSON.parse(fs.readFileSync("./seed/clients.json", "utf8"));
// Check if deduplicated census loaded (2883 unique clients, not 3600+ duplicated)
let hasJtiOnly = false;
try { hasJtiOnly = db.prepare("SELECT count(*) as c FROM clients WHERE sursa='JTI'").get().c > 0; } catch(e) {}
const needReseed = clientCount > 5000; // Old bloated census with duplicates
if (clientCount > 0 && (!hasJtiOnly || needReseed)) {
  console.log(`[CENSUS] Re-seed: ${!hasJtiOnly ? 'fără sursa JTI' : `${clientCount} clienți (duplicate)`}. Șterg și reincarc cu ${clientsData.length} clienți unici...`);
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('DELETE FROM clients').run();
  db.exec('PRAGMA foreign_keys = ON');
}
const clientCountNow = db.prepare("SELECT COUNT(*) as c FROM clients").get().c;
if (clientCountNow === 0) {
  console.log("Importing clients from JSON...");
  const ins = db.prepare(`INSERT INTO clients (code,firma,nume_poc,cif,adresa,oras,judet,municipality,agent,stare_poc,sales_rep,format,subformat,canal,lat,lon,agent_jti,sursa,on_component,numar_vitrine,numar_dozatoare) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const c of clientsData) {
      ins.run(c.code, c.firma, c.nume_poc, c.cif, c.adresa, c.oras, c.judet || "IASI", c.municipality, c.agent, c.stare_poc, c.sales_rep, c.format, c.subformat, c.canal, c.lat, c.lon, c.agent_jti || '', c.sursa || 'URSUS', c.on_component || '', c.numar_vitrine || 0, c.numar_dozatoare || 0);
    }
  });
  tx();
  console.log(`Imported ${clientsData.length} clients`);
} else {
  // Sync: add any new codes from JSON that don't exist in DB yet
  const existingCodes = new Set(db.prepare("SELECT code FROM clients").all().map(r => r.code));
  // Also check by CIF for JTI-only clients that might already exist
  const existingCifs = new Set(db.prepare("SELECT REPLACE(UPPER(COALESCE(cif,'')),'RO','') as c FROM clients").all().map(r => r.c).filter(Boolean));
  const newClients = clientsData.filter(c => {
    if (existingCodes.has(c.code)) return false;
    const cleanCif = (c.cif || '').replace(/\D/g, '');
    if (cleanCif && existingCifs.has(cleanCif)) return false;
    return true;
  });
  if (newClients.length > 0) {
    console.log(`Syncing ${newClients.length} new clients from JSON...`);
    const ins = db.prepare(`INSERT INTO clients (code,firma,nume_poc,cif,adresa,oras,judet,municipality,agent,stare_poc,sales_rep,format,subformat,canal,lat,lon,agent_jti,sursa,on_component,numar_vitrine,numar_dozatoare) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      for (const c of newClients) {
        ins.run(c.code, c.firma, c.nume_poc, c.cif, c.adresa, c.oras, c.judet || "IASI", c.municipality, c.agent, c.stare_poc, c.sales_rep, c.format, c.subformat, c.canal, c.lat, c.lon, c.agent_jti || '', c.sursa || 'URSUS', c.on_component || '', c.numar_vitrine || 0, c.numar_dozatoare || 0);
      }
    });
    tx();
    console.log(`Synced ${newClients.length} new clients`);
  } else {
    console.log(`All ${clientCount} clients up to date`);
  }
  // Sync client_activ_quatro flag from JSON (if present)
  const updateActive = db.prepare("UPDATE clients SET client_activ_quatro=? WHERE code=?");
  const syncTx = db.transaction(() => {
    let updated = 0;
    for (const c of clientsData) {
      if (c.client_activ_quatro !== undefined) {
        updateActive.run(c.client_activ_quatro, c.code);
        updated++;
      }
    }
    if (updated > 0) console.log(`Synced client_activ_quatro flag for ${updated} clients from JSON`);
  });
  syncTx();

  // Auto-compute client_activ_quatro from client_deliveries if not set from JSON
  try {
    const hasDeliveries = db.prepare("SELECT count(*) as c FROM client_deliveries").get().c;
    if (hasDeliveries > 0) {
      const activeFromDeliveries = db.prepare(`
        UPDATE clients SET client_activ_quatro = 1
        WHERE code IN (SELECT DISTINCT client_code FROM client_deliveries WHERE valoare > 0)
        AND client_activ_quatro = 0
      `).run();
      if (activeFromDeliveries.changes > 0) {
        console.log(`[QUATRO] Auto-set client_activ_quatro=1 for ${activeFromDeliveries.changes} clients with deliveries`);
      }
    }
  } catch(e) { console.log('[QUATRO] client_deliveries check:', e.message); }
}

/* ── Migrație ANAF: marchează/elimină clienți cu CIF inactiv ──── */
(function migrateAnafInactiveBB() {
  try {
    const inactivePath = path.join(__dirname, 'seed', 'inactive_cifs.json');
    if (!fs.existsSync(inactivePath)) return;
    const inactiveCifs = JSON.parse(fs.readFileSync(inactivePath, 'utf8'));
    if (!inactiveCifs.length) return;
    // Check if stare_poc column has 'Inactiv ANAF' values already
    const alreadyDone = db.prepare("SELECT count(*) as c FROM clients WHERE stare_poc='Inactiv ANAF'").get().c;
    if (alreadyDone > 50) {
      console.log(`[ANAF] Migrație deja aplicată (${alreadyDone} clienți Inactiv ANAF)`);
      return;
    }
    console.log(`[ANAF] Marchez ${inactiveCifs.length} CUI-uri inactive...`);
    const upd = db.prepare("UPDATE clients SET stare_poc='Inactiv ANAF' WHERE REPLACE(UPPER(COALESCE(cif,'')),'RO','') = ? AND stare_poc != 'Inactiv ANAF'");
    const tx = db.transaction(() => {
      let cnt = 0;
      for (const cui of inactiveCifs) {
        const r = upd.run(cui);
        cnt += r.changes;
      }
      return cnt;
    });
    const affected = tx();
    console.log(`[ANAF] ${affected} clienți marcați 'Inactiv ANAF' din ${inactiveCifs.length} CUI-uri`);
  } catch(e) { console.log('[ANAF] Eroare migrație:', e.message); }
})();

/* ───────── Load matrix ───────── */
const matrix = JSON.parse(fs.readFileSync("./seed/matrix.json", "utf8"));

/* ───────── Load audit list (per-client product matrix) ───────── */
let auditList = {};
const auditListPath = "./seed/audit_list.json";
if (fs.existsSync(auditListPath)) {
  auditList = JSON.parse(fs.readFileSync(auditListPath, "utf8"));
  console.log(`Loaded audit list: ${Object.keys(auditList).length} clients`);
}

function getProductsForClient(canal, subformat, code) {
  // First check per-client matrix from audit_list
  if (code && auditList[code] && auditList[code].products && auditList[code].products.length > 0) {
    return auditList[code].products;
  }
  // Fallback to generic canal/subformat matrix
  if (!canal || !subformat) return [];
  const c = canal.toUpperCase();
  const sf = subformat.trim();
  if (c.includes("OFF")) {
    return matrix.off_trade[sf] || [];
  } else if (c.includes("ON")) {
    return matrix.on_trade[sf] || [];
  }
  return [];
}

/* ───────── Auth middleware ───────── */
function auth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Neautentificat" });
  const sess = db.prepare("SELECT user_id, username, role, csrf_token, expires_at FROM sessions WHERE token=?").get(token);
  if (!sess) return res.status(401).json({ error: "Sesiune expirată" });
  /* Check session expiration */
  if (sess.expires_at && new Date(sess.expires_at) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return res.status(401).json({ error: "Sesiune expirată. Te rog să te autentifici din nou." });
  }
  req.userId = sess.user_id;
  req.username = sess.username;
  req.role = sess.role;
  req.csrfToken = sess.csrf_token || "";
  // Get sales_rep (which stores agent DTR name for agents) for filtering
  const user = db.prepare("SELECT sales_rep, division FROM users WHERE id=?").get(sess.user_id);
  req.agentDtr = user ? user.sales_rep : "";
  req.division = user ? (user.division || "") : "";
  /* ── CSRF check on state-changing methods ── */
  if (["POST", "PUT", "DELETE"].includes(req.method)) {
    const csrfHeader = req.headers["x-csrf-token"] || "";
    if (!csrfHeader || csrfHeader !== req.csrfToken) {
      return res.status(403).json({ error: "Token CSRF invalid. Reîncarcă pagina." });
    }
  }
  next();
}

function adminOnly(req, res, next) {
  if (req.role !== "admin") return res.status(403).json({ error: "Acces interzis" });
  next();
}

/* ───────── Photo upload setup ───────── */
const uploadDir = process.env.UPLOAD_DIR || "./uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

/* Whitelist MIME types for image uploads */
const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const ALLOWED_IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];
function imageFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_IMAGE_MIMES.includes(file.mimetype) && ALLOWED_IMAGE_EXTS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Doar fișiere imagine (JPG, PNG, WEBP) sunt permise"), false);
  }
}

/* Whitelist MIME types for Excel uploads */
const ALLOWED_EXCEL_MIMES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream"
];
const ALLOWED_EXCEL_EXTS = [".xlsx", ".xls"];
function excelFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXCEL_EXTS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Doar fișiere Excel (.xlsx, .xls) sunt permise"), false);
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ALLOWED_IMAGE_EXTS.includes(ext) ? ext : ".jpg";
      cb(null, `photo_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${safeExt}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFileFilter
});

/* ═══════════ API ROUTES ═══════════ */

/* ── Login ── */
/* ───────── Health check (no auth) ───────── */
app.get("/healthz", (req, res) => res.json({ status: "ok" }));

app.post("/api/login", loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Completează utilizator și parolă" });

  const user = db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(username.trim().toLowerCase());
  if (!user) {
    return res.status(401).json({ error: "Utilizator sau parolă greșită" });
  }
  /* Compare with bcrypt hash only — plaintext passwords are migrated at startup */
  const pwMatch = bcrypt.compareSync(password, user.password);
  if (!pwMatch) {
    return res.status(401).json({ error: "Utilizator sau parolă greșită" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, username, role, csrf_token, expires_at) VALUES (?,?,?,?,?,?)").run(token, user.id, user.username, user.role, csrfToken, expiresAt);
  // Track last login for "Ce e nou?" feature
  const previousLogin = user.last_login || null;
  db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(user.id);
  const isProduction = process.env.NODE_ENV === "production" || process.env.RENDER === "true" || SELF_HOSTED;
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 30 * 24 * 3600 * 1000 });
  return res.json({ ok: true, username: user.username, display_name: user.display_name, role: user.role, previous_login: previousLogin, csrf_token: csrfToken });
});

app.post("/api/logout", (req, res) => {
  const token = req.cookies.token;
  if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
  res.clearCookie("token", { httpOnly: true, sameSite: "lax" });
  res.json({ ok: true, action: "clear_session" });
});

/* Version endpoint - no auth needed, for deployment verification */
app.get("/api/version", (req, res) => {
  res.json({ version: "2026-02-19-sheetjs", build: "no-exceljs", ts: Date.now() });
});

app.get("/api/me", auth, (req, res) => {
  const user = db.prepare("SELECT display_name, role, sales_rep FROM users WHERE id=?").get(req.userId);
  res.json({ username: req.username, display_name: user ? user.display_name : req.username, role: req.role, sales_rep: user ? user.sales_rep : "", division: user ? (user.division || "") : "", csrf_token: req.csrfToken || "" });
});

/* ── User management (admin only) ── */
app.get("/api/users", auth, adminOnly, (req, res) => {
  const users = db.prepare("SELECT id, username, display_name, role, sales_rep, active, created_at FROM users ORDER BY role, display_name").all();
  res.json(users);
});

app.post("/api/users", auth, adminOnly, (req, res) => {
  const { username, password, display_name, role, sales_rep } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: "Câmpuri obligatorii lipsă" });
  if (username.length < 3 || username.length > 50) return res.status(400).json({ error: "Utilizator: 3-50 caractere" });
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return res.status(400).json({ error: "Utilizator: doar litere, cifre, -, _, ." });
  if (password.length < 6 || password.length > 128) return res.status(400).json({ error: "Parolă: 6-128 caractere" });
  if (display_name.length > 100) return res.status(400).json({ error: "Nume afișat: max 100 caractere" });
  if (role && !ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: "Rol invalid" });
  try {
    const hashedPw = bcrypt.hashSync(password, 10);
    db.prepare("INSERT INTO users (username, password, display_name, role, sales_rep) VALUES (?,?,?,?,?)")
      .run(username.trim().toLowerCase(), hashedPw, display_name.substring(0, 100), role || "agent", (sales_rep || "").substring(0, 100));
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: "Utilizatorul există deja" });
  }
});

app.put("/api/users/:id", auth, adminOnly, (req, res) => {
  const { password, display_name, role, sales_rep, active } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User negăsit" });
  const hashedPw = password ? bcrypt.hashSync(password, 10) : null;
  db.prepare("UPDATE users SET password=COALESCE(?,password), display_name=COALESCE(?,display_name), role=COALESCE(?,role), sales_rep=COALESCE(?,sales_rep), active=COALESCE(?,active) WHERE id=?")
    .run(hashedPw, display_name || null, role || null, sales_rep || null, active !== undefined ? active : null, req.params.id);
  res.json({ ok: true });
});

/* ── Helper: create notification ── */
function createNotification(username, title, message, type, linkTab) {
  try {
    db.prepare("INSERT INTO notifications (username, title, message, type, link_tab) VALUES (?,?,?,?,?)")
      .run(username || '', title, message || '', type || 'info', linkTab || '');
  } catch(e) { console.error("[Notif] Error:", e.message); }
}
function notifyRole(role, title, message, type, linkTab) {
  const users = db.prepare("SELECT username FROM users WHERE role=? AND active=1").all(role);
  users.forEach(u => createNotification(u.username, title, message, type, linkTab));
}
function notifyAllExcept(excludeUsername, title, message, type, linkTab) {
  const users = db.prepare("SELECT username FROM users WHERE username!=? AND active=1").all(excludeUsername);
  users.forEach(u => createNotification(u.username, title, message, type, linkTab));
}

/* ── Notifications API ── */
app.get("/api/notifications", auth, (req, res) => {
  const notifs = db.prepare("SELECT * FROM notifications WHERE username=? OR username='' ORDER BY created_at DESC LIMIT 50").all(req.username);
  const unread = db.prepare("SELECT COUNT(*) as cnt FROM notifications WHERE (username=? OR username='') AND is_read=0").get(req.username);
  res.json({ notifications: notifs, unread_count: unread.cnt });
});

app.post("/api/notifications/:id/read", auth, (req, res) => {
  db.prepare("UPDATE notifications SET is_read=1 WHERE id=? AND (username=? OR username='')").run(req.params.id, req.username);
  res.json({ ok: true });
});

app.post("/api/notifications/read-all", auth, (req, res) => {
  db.prepare("UPDATE notifications SET is_read=1 WHERE (username=? OR username='') AND is_read=0").run(req.username);
  res.json({ ok: true });
});

/* ── Changelog API (Ce e nou?) ── */
app.get("/api/changelog", auth, (req, res) => {
  const since = req.query.since || "2000-01-01";
  let rows;
  if (req.role === "admin") {
    rows = db.prepare("SELECT * FROM app_changelog WHERE change_date > ? ORDER BY change_date DESC, id DESC").all(since);
  } else {
    rows = db.prepare("SELECT * FROM app_changelog WHERE change_date > ? AND visibility='all' ORDER BY change_date DESC, id DESC").all(since);
  }
  res.json(rows);
});

app.post("/api/changelog", auth, adminOnly, (req, res) => {
  const { version, change_date, title, description, module, change_type, visibility } = req.body;
  if (!version || !title) return res.status(400).json({ error: "Version și title obligatorii" });
  db.prepare("INSERT INTO app_changelog (version, change_date, title, description, module, change_type, visibility) VALUES (?,?,?,?,?,?,?)")
    .run(version, change_date || new Date().toISOString().slice(0,10), title, description||'', module||'', change_type||'feature', visibility||'all');
  res.json({ ok: true });
});

/* ── Geocodare adresă cu fallback progresiv ── */
async function geocodeAddress(address) {
  if (!address) return null;
  const clean = address
    .replace(/\b(Municipiul|Mun\.|Județul|Jud\.|Comuna|Com\.|Sat|Oraș|Oras)\b/gi, '')
    .replace(/\s+/g, ' ').trim();

  const parts = clean.split(',').map(p => p.trim()).filter(Boolean);
  const strategies = [
    clean,
    parts.length > 2 ? parts.slice(0, 2).join(', ') + ', Romania' : null,
    parts.length > 1 ? parts[parts.length - 1] + ', Romania' : null,
    parts.length > 0 ? parts[0] + ', Romania' : null
  ].filter(Boolean);

  for (const query of strategies) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=ro&limit=1`;
      const response = await fetch(url, { headers: { 'User-Agent': 'QgdSalesBB/1.0' } });
      const data = await response.json();
      if (data && data.length > 0) {
        return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), strategy: query };
      }
    } catch(e) { /* try next strategy */ }
    await new Promise(r => setTimeout(r, 1100)); // Nominatim rate limit
  }
  return null;
}

/* POST /api/geocode — geocode an address (admin/spv) */
app.post("/api/geocode", auth, async (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const { address, client_id } = req.body;
  if (!address) return res.status(400).json({ error: "Adresă lipsă" });
  const result = await geocodeAddress(address);
  if (!result) return res.json({ ok: false, error: "Nu s-a putut geocoda adresa" });
  if (client_id) {
    db.prepare("UPDATE clients SET lat=?, lon=? WHERE id=?").run(result.lat, result.lon, client_id);
  }
  res.json({ ok: true, lat: result.lat, lon: result.lon, strategy: result.strategy });
});

/* POST /api/geocode-batch — geocode all clients without coordinates */
app.post("/api/geocode-batch", auth, adminOnly, async (req, res) => {
  const clients = db.prepare("SELECT id, adresa, oras, judet FROM clients WHERE (lat IS NULL OR lat=0) AND adresa IS NOT NULL AND adresa != ''").all();
  let geocoded = 0, failed = 0;
  for (const c of clients) {
    const fullAddr = [c.adresa, c.oras, c.judet, 'Romania'].filter(Boolean).join(', ');
    const result = await geocodeAddress(fullAddr);
    if (result) {
      db.prepare("UPDATE clients SET lat=?, lon=? WHERE id=?").run(result.lat, result.lon, c.id);
      geocoded++;
    } else {
      failed++;
    }
  }
  res.json({ ok: true, total: clients.length, geocoded, failed });
});

/* ── Client purchases modal (achiziții HL + RON) ── */
app.get("/api/client-purchases/:clientCode", auth, (req, res) => {
  const code = req.params.clientCode;

  // Last purchase date for this client
  const lastDate = db.prepare("SELECT MAX(datadoc) as last_date FROM client_deliveries WHERE client_code=?").get(code);

  // Last purchase items
  const lastPurchase = lastDate && lastDate.last_date
    ? db.prepare("SELECT denumire, cantitate, valoare FROM client_deliveries WHERE client_code=? AND datadoc=? ORDER BY denumire").all(code, lastDate.last_date)
    : [];

  // Totals per product (all time for current month or last 3 months)
  const totals = db.prepare(`
    SELECT denumire,
           SUM(cantitate) as total_cant,
           SUM(valoare) as total_val,
           COUNT(*) as nr_livrari
    FROM client_deliveries WHERE client_code=?
    GROUP BY denumire ORDER BY SUM(valoare) DESC
  `).all(code);

  // Last report date (global)
  const lastReport = db.prepare("SELECT MAX(datadoc) as last_date FROM client_deliveries").get();

  res.json({
    client_code: code,
    last_purchase_date: lastDate ? lastDate.last_date : null,
    last_purchase: lastPurchase,
    totals,
    last_report_date: lastReport ? lastReport.last_date : null
  });
});

/* ── Helper: filter clients by role ── */
function getClientsForUser(req, includeInactive) {
  if (req.role === "agent" && req.agentDtr) {
    if (includeInactive) return db.prepare("SELECT * FROM clients WHERE agent=? AND UPPER(judet) LIKE '%IA%' ORDER BY firma, nume_poc").all(req.agentDtr);
    return db.prepare("SELECT * FROM clients WHERE agent=? AND stare_poc != 'Inactiv ANAF' AND UPPER(judet) LIKE '%IA%' ORDER BY firma, nume_poc").all(req.agentDtr);
  }
  if (includeInactive) return db.prepare("SELECT * FROM clients WHERE UPPER(judet) LIKE '%IA%' ORDER BY firma, nume_poc").all();
  return db.prepare("SELECT * FROM clients WHERE stare_poc != 'Inactiv ANAF' AND UPPER(judet) LIKE '%IA%' ORDER BY firma, nume_poc").all();
}

/* ── Clients ── */
app.get("/api/clients", auth, (req, res) => {
  res.json(getClientsForUser(req));
});

/* ── Nearby Clients (GPS proximity) ── */
app.get("/api/clients/nearby", auth, (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radius = Math.min(Math.max(parseInt(req.query.radius) || 200, 10), 5000);
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: "Coordonate invalide" });
    if (lat < -90 || lat > 90) return res.status(400).json({ error: "Latitudine invalidă" });
    if (lon < -180 || lon > 180) return res.status(400).json({ error: "Longitudine invalidă" });

    const clients = db.prepare("SELECT * FROM clients WHERE lat IS NOT NULL AND lon IS NOT NULL AND stare_poc != 'Inactiv ANAF' AND UPPER(judet) LIKE '%IA%' AND ABS(lat) <= 90 AND ABS(lon) <= 180").all();

    const toRad = (d) => d * Math.PI / 180;
    function haversine(lat1, lon1, lat2, lon2) {
      const R = 6371000;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    const nearby = clients
      .map(c => ({ ...c, distance: Math.round(haversine(lat, lon, c.lat, c.lon)) }))
      .filter(c => c.distance <= radius)
      .sort((a, b) => a.distance - b.distance);

    res.json({ ok: true, clients: nearby, total: nearby.length, radius, userLat: lat, userLon: lon });
  } catch(e) { console.error("[Error]", e.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." }); }
});

/* ── Purchase summary per client (current month from client_deliveries) ── */
app.get("/api/purchases/summary", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`
    SELECT client_code, SUM(valoare) as total_val, SUM(cantitate) as total_cant,
           COUNT(DISTINCT codintern) as sku_count
    FROM client_deliveries WHERE month = ?
    GROUP BY client_code
  `).all(month);
  const summary = {};
  rows.forEach(r => {
    summary[r.client_code] = {
      valoare: Math.round(r.total_val * 100) / 100,
      cantHL: Math.round(r.total_cant * 10000) / 10000,
      skuCount: r.sku_count
    };
  });
  res.json({ month, clients: summary });
});

/* ── Audit: get clients with today's visit info (filtered by audit_list) ── */
app.get("/api/audit/clients", auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  let clients = getClientsForUser(req, true); // include all for audit (auditList filters separately)

  // Filter: only clients present in audit_list
  const auditCodes = new Set(Object.keys(auditList));
  if (auditCodes.size > 0) {
    clients = clients.filter(c => auditCodes.has(c.code));
  }

  const visitStmt = db.prepare(`
    SELECT * FROM visits
    WHERE client_id = ? AND date(visited_at) = ?
    ORDER BY visited_at DESC LIMIT 1
  `);
  const monthVisitsStmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM visits
    WHERE client_id = ? AND strftime('%Y-%m', visited_at) = strftime('%Y-%m', 'now')
  `);

  const result = clients.map(c => {
    const todayVisit = visitStmt.get(c.id, today) || null;
    const monthCount = monthVisitsStmt.get(c.id).cnt;
    const products = getProductsForClient(c.canal, c.subformat, c.code);
    return {
      ...c,
      today_visit: todayVisit,
      visits_month: monthCount,
      required_products_count: products.length
    };
  });
  res.json(result);
});

/* ── Get products for a client (with delivery info) ── */
app.get("/api/audit/products/:clientId", auth, (req, res) => {
  const client = db.prepare("SELECT * FROM clients WHERE id=?").get(req.params.clientId);
  if (!client) return res.status(404).json({ error: "Client negăsit" });
  const products = getProductsForClient(client.canal, client.subformat, client.code);

  // Get current month delivery matching
  const currentMonth = new Date().toISOString().slice(0, 7);
  const deliveryMatch = matchDeliveriesToAudit(client.code, currentMonth, products);

  // Check if we have any delivery data for this month
  const hasDeliveryData = db.prepare("SELECT COUNT(*) as c FROM client_deliveries WHERE month=? LIMIT 1").get(currentMonth).c > 0;

  res.json({
    client: { id: client.id, nume_poc: client.nume_poc, format: client.format, subformat: client.subformat, canal: client.canal, code: client.code },
    products,
    deliveries: deliveryMatch,
    hasDeliveryData,
    note: "1 produs poate lipsi din oricare grup (condiție aplicabilă doar o dată). M-ul fiind și el un grup."
  });
});

/* ── Start visit (photo required for agents, optional for admin) ── */
app.post("/api/audit/start-visit", auth, upload.single("photo"), (req, res) => {
  const { client_id, lat, lon } = req.body;
  if (!client_id) return res.status(400).json({ error: "client_id lipsă" });

  const isAdmin = req.role === "admin";
  if (!isAdmin && !req.file) return res.status(400).json({ error: "Poza este obligatorie" });

  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare("SELECT id FROM visits WHERE client_id=? AND date(visited_at)=?").get(client_id, today);
  if (existing) return res.status(409).json({ error: "Vizită deja înregistrată azi", visit_id: existing.id });

  const now = new Date().toISOString();
  const photoPath = req.file ? req.file.filename : null;

  const result = db.prepare(`
    INSERT INTO visits (client_id, visited_at, visited_by, photo_path, photo_lat, photo_lon, photo_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(client_id, now, req.username, photoPath, parseFloat(lat) || null, parseFloat(lon) || null, photoPath ? now : null);

  res.json({ ok: true, visit_id: result.lastInsertRowid });
});

/* ── Save products (close visit) ── */
app.post("/api/audit/close-visit", auth, (req, res) => {
  const { visit_id, products_present } = req.body;
  if (!visit_id) return res.status(400).json({ error: "visit_id lipsă" });

  const visit = db.prepare("SELECT * FROM visits WHERE id=?").get(visit_id);
  if (!visit) return res.status(404).json({ error: "Vizită negăsită" });

  const client = db.prepare("SELECT * FROM clients WHERE id=?").get(visit.client_id);
  const allProducts = getProductsForClient(client.canal, client.subformat, client.code);
  const ownProducts = allProducts.filter(p => p.requirement.toUpperCase() !== "X");
  const totalRequired = ownProducts.length;
  const presentSet = new Set(products_present || []);
  const totalPresent = ownProducts.filter(p => presentSet.has(p.product)).length;
  const score = totalRequired > 0 ? Math.round((totalPresent / totalRequired) * 100) : 0;

  db.prepare(`
    UPDATE visits SET closed_at=datetime('now'), products_json=?, total_required=?, total_present=?, score=?
    WHERE id=?
  `).run(JSON.stringify(products_present || []), totalRequired, totalPresent, score, visit_id);

  res.json({ ok: true, total_required: totalRequired, total_present: totalPresent, score });
});

/* ── Upload photo for existing visit ── */
app.post("/api/audit/upload-photo", auth, upload.single("photo"), (req, res) => {
  const { visit_id, lat, lon } = req.body;
  if (!visit_id || !req.file) return res.status(400).json({ error: "visit_id și poză obligatorii" });

  db.prepare(`UPDATE visits SET photo_path=?, photo_lat=?, photo_lon=?, photo_time=datetime('now') WHERE id=?`)
    .run(req.file.filename, parseFloat(lat) || null, parseFloat(lon) || null, visit_id);
  res.json({ ok: true });
});

/* ── Serve photos ── */
app.get("/api/photos/:filename", auth, (req, res) => {
  /* Prevent path traversal — strict filename validation */
  const filename = req.params.filename;
  if (!/^[a-zA-Z0-9_.\-]+$/.test(filename)) {
    return res.status(400).json({ error: "Nume fișier invalid" });
  }
  const filePath = path.join(uploadDir, path.basename(filename));
  const realPath = path.resolve(filePath);
  const realUploadDir = path.resolve(uploadDir);
  if (!realPath.startsWith(realUploadDir + path.sep) && realPath !== realUploadDir) {
    return res.status(403).json({ error: "Acces interzis" });
  }
  if (!fs.existsSync(realPath)) return res.status(404).json({ error: "Poză negăsită" });
  res.sendFile(realPath);
});

/* ── Reports ── */
app.get("/api/reports/daily", auth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  let visits;
  let totalClients;
  if (req.role === "agent" && req.agentDtr) {
    visits = db.prepare(`
      SELECT v.*, c.code, c.firma, c.nume_poc, c.oras, c.agent, c.sales_rep,
             c.format, c.subformat, c.canal
      FROM visits v JOIN clients c ON v.client_id = c.id
      WHERE date(v.visited_at) = ? AND c.agent = ?
      ORDER BY c.agent, v.visited_at
    `).all(date, req.agentDtr);
    totalClients = db.prepare("SELECT COUNT(*) as c FROM clients WHERE agent=?").get(req.agentDtr).c;
  } else {
    visits = db.prepare(`
      SELECT v.*, c.code, c.firma, c.nume_poc, c.oras, c.agent, c.sales_rep,
             c.format, c.subformat, c.canal
      FROM visits v JOIN clients c ON v.client_id = c.id
      WHERE date(v.visited_at) = ?
      ORDER BY c.agent, v.visited_at
    `).all(date);
    totalClients = db.prepare("SELECT COUNT(*) as c FROM clients").get().c;
  }

  const summary = {
    date,
    total_visits: visits.length,
    total_clients: totalClients,
    coverage_pct: Math.round((visits.length / totalClients) * 100 * 10) / 10,
    with_photo: visits.filter(v => v.photo_path).length,
    closed_visits: visits.filter(v => v.closed_at).length,
    avg_score: visits.filter(v => v.closed_at).length > 0
      ? Math.round(visits.filter(v => v.closed_at).reduce((s, v) => s + v.score, 0) / visits.filter(v => v.closed_at).length)
      : 0,
    by_agent: {},
    visits
  };

  for (const v of visits) {
    const ag = v.agent || "NEALOCATI";
    if (!summary.by_agent[ag]) {
      summary.by_agent[ag] = { visits: 0, with_photo: 0, closed: 0, avg_score: 0, scores: [] };
    }
    summary.by_agent[ag].visits++;
    if (v.photo_path) summary.by_agent[ag].with_photo++;
    if (v.closed_at) {
      summary.by_agent[ag].closed++;
      summary.by_agent[ag].scores.push(v.score);
    }
  }
  for (const ag of Object.keys(summary.by_agent)) {
    const s = summary.by_agent[ag];
    s.avg_score = s.scores.length > 0 ? Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length) : 0;
    delete s.scores;
  }

  res.json(summary);
});

app.get("/api/reports/monthly", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);

  let visits, totalClients;
  if (req.role === "agent" && req.agentDtr) {
    visits = db.prepare(`
      SELECT v.*, c.code, c.firma, c.nume_poc, c.oras, c.agent, c.sales_rep,
             c.format, c.subformat, c.canal
      FROM visits v JOIN clients c ON v.client_id = c.id
      WHERE strftime('%Y-%m', v.visited_at) = ? AND c.agent = ?
      ORDER BY c.agent, v.visited_at
    `).all(month, req.agentDtr);
    totalClients = db.prepare("SELECT COUNT(*) as c FROM clients WHERE agent=?").get(req.agentDtr).c;
  } else {
    visits = db.prepare(`
      SELECT v.*, c.code, c.firma, c.nume_poc, c.oras, c.agent, c.sales_rep,
             c.format, c.subformat, c.canal
      FROM visits v JOIN clients c ON v.client_id = c.id
      WHERE strftime('%Y-%m', v.visited_at) = ?
      ORDER BY c.agent, v.visited_at
    `).all(month);
    totalClients = db.prepare("SELECT COUNT(*) as c FROM clients").get().c;
  }
  const visitedClientIds = new Set(visits.map(v => v.client_id));

  // Per-client best score
  const clientScores = {};
  for (const v of visits) {
    if (v.closed_at) {
      if (!clientScores[v.client_id] || v.score > clientScores[v.client_id]) {
        clientScores[v.client_id] = v.score;
      }
    }
  }

  // Missing products analysis
  const missingByClient = [];
  for (const v of visits) {
    if (!v.closed_at) continue;
    const client = db.prepare("SELECT * FROM clients WHERE id=?").get(v.client_id);
    const allProducts = getProductsForClient(client.canal, client.subformat, client.code);
    const ownProducts = allProducts.filter(p => p.requirement.toUpperCase() !== "X");
    const presentSet = new Set(JSON.parse(v.products_json || "[]"));
    const missing = ownProducts.filter(p => !presentSet.has(p.product)).map(p => p.product);
    if (missing.length > 0) {
      missingByClient.push({
        client_id: v.client_id, code: v.code, firma: v.firma, nume_poc: v.nume_poc,
        oras: v.oras, agent: v.agent, format: v.format, subformat: v.subformat,
        missing_products: missing, score: v.score
      });
    }
  }

  res.json({
    month,
    total_clients: totalClients,
    visited_clients: visitedClientIds.size,
    coverage_pct: Math.round((visitedClientIds.size / totalClients) * 100 * 10) / 10,
    total_visits: visits.length,
    closed_visits: visits.filter(v => v.closed_at).length,
    avg_score: Object.values(clientScores).length > 0
      ? Math.round(Object.values(clientScores).reduce((a, b) => a + b, 0) / Object.values(clientScores).length)
      : 0,
    clients_100pct: Object.values(clientScores).filter(s => s === 100).length,
    clients_below_100: Object.values(clientScores).filter(s => s < 100).length,
    missing_products: missingByClient,
    visits
  });
});

/* ── Export Excel (Professional format) ── */
app.get("/api/reports/export-excel", auth, (req, res, next) => {
  if (req.role === "agent") return res.status(403).json({ error: "Agenții nu au acces la export" });
  next();
}, async (req, res) => {
  try {
    const ExcelJS = require("exceljs");
    const date = req.query.date;
    const month = req.query.month;
    let visits;

    if (date) {
      visits = db.prepare(`
        SELECT v.*, c.code, c.firma, c.nume_poc, c.oras, c.agent, c.sales_rep, c.format, c.subformat, c.canal, c.email, c.telefon
        FROM visits v JOIN clients c ON v.client_id=c.id WHERE date(v.visited_at)=? ORDER BY c.agent, v.visited_at
      `).all(date);
    } else {
      const m = month || new Date().toISOString().slice(0, 7);
      visits = db.prepare(`
        SELECT v.*, c.code, c.firma, c.nume_poc, c.oras, c.agent, c.sales_rep, c.format, c.subformat, c.canal, c.email, c.telefon
        FROM visits v JOIN clients c ON v.client_id=c.id WHERE strftime('%Y-%m',v.visited_at)=? ORDER BY c.agent, v.visited_at
      `).all(m);
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = "QMaps Audit Ursus";
    wb.created = new Date();

    const CLR = {
      headerBg: "1B4F72", headerFg: "FFFFFF",
      altRow: "EBF5FB",
      green: "27AE60", yellow: "F39C12", red: "E74C3C",
      borderColor: "BDC3C7",
      photoDa: "D5F5E3", photoNu: "FADBD8"
    };
    const thinBorder = { style: "thin", color: { argb: CLR.borderColor } };
    const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };

    const ws = wb.addWorksheet("Raport Audit", {
      views: [{ state: "frozen", ySplit: 2 }],
      autoFilter: { from: "A2", to: "Q2" }
    });

    // Title row
    ws.mergeCells("A1:Q1");
    const titleCell = ws.getCell("A1");
    const period = date || month || new Date().toISOString().slice(0, 7);
    titleCell.value = `RAPORT AUDIT DN — ${period}`;
    titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: CLR.headerBg } };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(1).height = 35;

    // Headers
    const headers = ["Cod", "Firma", "Nume POC", "Oraș", "Agent DTR", "Email", "Telefon", "Canal", "Format", "SubFormat", "Data Vizită", "Ora Vizită", "Poză", "Score %", "Obligatorii", "Prezente", "Produse Lipsă"];
    const headerRow = ws.getRow(2);
    headers.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: CLR.headerFg } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.headerBg } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = allBorders;
    });
    headerRow.height = 28;

    // Data
    for (let idx = 0; idx < visits.length; idx++) {
      const v = visits[idx];
      const present = JSON.parse(v.products_json || "[]");
      const client = db.prepare("SELECT * FROM clients WHERE id=?").get(v.client_id);
      const allProds = getProductsForClient(client.canal, client.subformat, client.code);
      const own = allProds.filter(p => p.requirement.toUpperCase() !== "X");
      const missing = own.filter(p => !present.includes(p.product)).map(p => p.product);
      const visitDate = v.visited_at ? v.visited_at.slice(0, 10) : "";
      const visitTime = v.visited_at ? v.visited_at.slice(11, 19) : "";
      const score = v.score != null ? Number(v.score) : 0;
      const hasPhoto = v.photo_path ? "DA" : "NU";

      const row = ws.getRow(idx + 3);
      row.values = [
        v.code, v.firma, v.nume_poc, v.oras, v.agent,
        client.email || "", client.telefon || "",
        v.canal, v.format, v.subformat, visitDate, visitTime,
        hasPhoto, score / 100, v.total_required, v.total_present,
        missing.join("; ")
      ];

      const bgColor = idx % 2 === 1 ? CLR.altRow : "FFFFFF";
      for (let c = 1; c <= 17; c++) {
        const cell = row.getCell(c);
        cell.font = { name: "Calibri", size: 9 };
        cell.border = allBorders;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };

        if (c === 13) { // Poză DA/NU
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: hasPhoto === "DA" ? CLR.photoDa : CLR.photoNu } };
          cell.alignment = { horizontal: "center" };
          cell.font = { name: "Calibri", size: 9, bold: true, color: { argb: hasPhoto === "DA" ? CLR.green : CLR.red } };
        }
        if (c === 14) { // Score
          cell.numFmt = "0%";
          cell.alignment = { horizontal: "center" };
          const sv = score;
          if (sv >= 80) cell.font = { name: "Calibri", size: 9, bold: true, color: { argb: CLR.green } };
          else if (sv >= 50) cell.font = { name: "Calibri", size: 9, color: { argb: CLR.yellow } };
          else cell.font = { name: "Calibri", size: 9, color: { argb: CLR.red } };
        }
        if (c === 15 || c === 16) cell.alignment = { horizontal: "center" };
        if (c === 17) cell.alignment = { wrapText: true };
      }
      row.height = 16;
    }

    // Summary row
    const sumRow = ws.getRow(visits.length + 3);
    ws.mergeCells(`A${visits.length + 3}:L${visits.length + 3}`);
    sumRow.getCell(1).value = `TOTAL VIZITE: ${visits.length}`;
    sumRow.getCell(1).font = { name: "Calibri", size: 11, bold: true, color: { argb: CLR.headerFg } };
    sumRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.headerBg } };
    sumRow.getCell(1).border = allBorders;
    const avgScore = visits.length > 0 ? visits.reduce((s, v) => s + (v.score || 0), 0) / visits.length : 0;
    sumRow.getCell(13).value = `${visits.filter(v => v.photo_path).length} foto`;
    sumRow.getCell(14).value = avgScore / 100;
    sumRow.getCell(14).numFmt = "0%";
    for (let c = 13; c <= 17; c++) {
      const cell = sumRow.getCell(c);
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: CLR.headerFg } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.headerBg } };
      cell.border = allBorders;
      cell.alignment = { horizontal: "center" };
    }
    sumRow.height = 22;

    // Data bar on score column
    if (visits.length > 0) {
      ws.addConditionalFormatting({
        ref: `N3:N${visits.length + 2}`,
        rules: [{ type: "dataBar", minLength: 0, maxLength: 100, gradient: true,
          color: { argb: "2E86C1" },
          cfvo: [{ type: "num", value: 0 }, { type: "num", value: 1 }] }]
      });
    }

    // Column widths
    ws.columns = [
      { width: 10 }, { width: 22 }, { width: 18 }, { width: 14 }, { width: 28 },
      { width: 20 }, { width: 14 }, { width: 10 }, { width: 12 }, { width: 12 },
      { width: 12 }, { width: 10 }, { width: 8 }, { width: 10 }, { width: 10 },
      { width: 10 }, { width: 35 }
    ];

    const buf = await wb.xlsx.writeBuffer();
    const fname = `raport_audit_${date || month || "all"}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=${fname}`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("Export Excel error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

/* ── Update client contact info (email/phone) ── */
app.post("/api/clients/:id/contact", auth, (req, res) => {
  const { email, telefon } = req.body;
  const id = req.params.id;
  const client = db.prepare("SELECT id FROM clients WHERE id=?").get(id);
  if (!client) return res.status(404).json({ error: "Client not found" });
  db.prepare("UPDATE clients SET email=?, telefon=? WHERE id=?").run(email || '', telefon || '', id);
  res.json({ ok: true });
});

/* ── Status proposals (agent proposes inactive, SPV/admin approves) ── */
app.post("/api/clients/:id/propose-inactive", auth, (req, res) => {
  const clientId = req.params.id;
  const { reason } = req.body;
  const client = db.prepare("SELECT id, firma, nume_poc FROM clients WHERE id=?").get(clientId);
  if (!client) return res.status(404).json({ error: "Client negăsit" });

  // Check if there's already a pending proposal for this client
  const existing = db.prepare("SELECT id FROM status_proposals WHERE client_id=? AND decision='pending'").get(clientId);
  if (existing) return res.status(409).json({ error: "Există deja o propunere în așteptare pentru acest client" });

  db.prepare(`INSERT INTO status_proposals (client_id, proposed_status, reason, proposed_by) VALUES (?,?,?,?)`)
    .run(clientId, "inactiv", reason || "", req.username);
  res.json({ ok: true, message: "Propunere trimisă spre aprobare" });
});

/* ── Propose rename (agent proposes new firma/nume_poc, SPV/admin approves) ── */
app.post("/api/clients/:id/propose-rename", auth, (req, res) => {
  const clientId = req.params.id;
  const { new_firma, new_nume_poc, new_cif, new_contact, new_telefon, new_email, reason } = req.body;
  const client = db.prepare("SELECT id, firma, nume_poc FROM clients WHERE id=?").get(clientId);
  if (!client) return res.status(404).json({ error: "Client negăsit" });

  if (!new_firma && !new_nume_poc && !new_cif && !new_contact && !new_telefon && !new_email) {
    return res.status(400).json({ error: "Completează cel puțin un câmp de modificat" });
  }

  // Check if there's already a pending rename proposal for this client
  const existing = db.prepare("SELECT id FROM status_proposals WHERE client_id=? AND proposed_status='redenumire' AND decision='pending'").get(clientId);
  if (existing) return res.status(409).json({ error: "Există deja o propunere de redenumire în așteptare" });

  db.prepare(`INSERT INTO status_proposals (client_id, proposed_status, reason, proposed_by, new_firma, new_nume_poc, new_cif, new_contact, new_telefon, new_email) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(clientId, "redenumire", reason || "", req.username, new_firma || "", new_nume_poc || "", new_cif || "", new_contact || "", new_telefon || "", new_email || "");
  res.json({ ok: true, message: "Propunere de modificare trimisă spre aprobare" });
});

app.get("/api/proposals", auth, (req, res) => {
  // Agents see only their own proposals; SPV/admin see all
  let proposals;
  if (req.role === "agent") {
    proposals = db.prepare(`
      SELECT p.*, c.code, c.firma, c.nume_poc, c.oras, c.agent, c.canal, c.format
      FROM status_proposals p JOIN clients c ON p.client_id = c.id
      WHERE p.proposed_by = ?
      ORDER BY p.proposed_at DESC
    `).all(req.username);
  } else {
    proposals = db.prepare(`
      SELECT p.*, c.code, c.firma, c.nume_poc, c.oras, c.agent, c.canal, c.format
      FROM status_proposals p JOIN clients c ON p.client_id = c.id
      ORDER BY CASE p.decision WHEN 'pending' THEN 0 ELSE 1 END, p.proposed_at DESC
    `).all();
  }
  res.json(proposals);
});

app.post("/api/proposals/:id/review", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Doar SPV/Admin pot aproba propuneri" });
  const { decision, review_note } = req.body;
  if (!["approved", "rejected"].includes(decision)) return res.status(400).json({ error: "Decizie invalidă" });

  const proposal = db.prepare("SELECT * FROM status_proposals WHERE id=?").get(req.params.id);
  if (!proposal) return res.status(404).json({ error: "Propunere negăsită" });
  if (proposal.decision !== "pending") return res.status(409).json({ error: "Propunerea a fost deja procesată" });

  db.prepare(`UPDATE status_proposals SET decision=?, reviewed_by=?, reviewed_at=datetime('now'), review_note=? WHERE id=?`)
    .run(decision, req.username, review_note || "", req.params.id);

  if (decision === "approved") {
    if (proposal.proposed_status === "redenumire") {
      // Update changed fields
      if (proposal.new_firma) db.prepare("UPDATE clients SET firma=? WHERE id=?").run(proposal.new_firma, proposal.client_id);
      if (proposal.new_nume_poc) db.prepare("UPDATE clients SET nume_poc=? WHERE id=?").run(proposal.new_nume_poc, proposal.client_id);
      if (proposal.new_cif) db.prepare("UPDATE clients SET cif=? WHERE id=?").run(proposal.new_cif, proposal.client_id);
      if (proposal.new_contact) db.prepare("UPDATE clients SET contact_person=? WHERE id=?").run(proposal.new_contact, proposal.client_id);
      if (proposal.new_telefon) db.prepare("UPDATE clients SET telefon=? WHERE id=?").run(proposal.new_telefon, proposal.client_id);
      if (proposal.new_email) db.prepare("UPDATE clients SET email=? WHERE id=?").run(proposal.new_email, proposal.client_id);
    } else {
      // Inactiv proposal
      db.prepare("UPDATE clients SET stare_poc='Inactiv - Aprobat' WHERE id=?").run(proposal.client_id);
    }
  }

  res.json({ ok: true, decision });
});

/* ── Bootstrap (initial data load) ── */
app.get("/api/bootstrap", auth, (req, res) => {
  const clients = getClientsForUser(req);
  const user = db.prepare("SELECT display_name, role, sales_rep FROM users WHERE id=?").get(req.userId);
  res.json({
    username: req.username,
    display_name: user ? user.display_name : req.username,
    role: req.role,
    sales_rep: user ? user.sales_rep : "",
    clients,
    matrix
  });
});

/* ── Email report API (admin only) ── */
app.get("/api/email/config", auth, adminOnly, (req, res) => {
  res.json({
    enabled: emailReports.CFG.enabled,
    timezone: emailReports.CFG.timezone,
    targetHour: emailReports.CFG.targetHour,
    monthlyEnabled: emailReports.CFG.monthlyEnabled,
    monthlyHour: emailReports.CFG.monthlyHour,
    emailFrom: emailReports.CFG.emailFrom,
    emailTo: emailReports.CFG.emailTo,
    smtpHost: emailReports.CFG.smtpHost,
    smtpPort: emailReports.CFG.smtpPort,
    smtpConfigured: !!(emailReports.CFG.smtpHost && emailReports.CFG.smtpUser && emailReports.CFG.smtpPass)
  });
});

app.post("/api/email/test-daily", auth, adminOnly, async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().slice(0, 10);
    const result = await emailReports.sendDailyReport(db, getProductsForClient, date);
    res.json(result);
  } catch (err) {
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

app.post("/api/email/test-monthly", auth, adminOnly, async (req, res) => {
  try {
    const month = req.body.month || new Date().toISOString().slice(0, 7);
    const result = await emailReports.sendMonthlyReport(db, getProductsForClient, month);
    res.json(result);
  } catch (err) {
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── GPS email endpoints removed — GPS is now sent as part of daily/monthly reports ──
   GPS goes to CFG.gpsEmailTo (popa.stefan@quatrogrup.com)
   Audit+Încasări+Expirări goes to CFG.emailTo (raportzilnic, ibrian, florin.rata)
   Use /api/email/test-daily and /api/email/test-monthly to trigger both emails ── */

/* ═══════════ OBIECTIVE (Target vs Realizat) ═══════════ */

/* ── Get targets + realized for current month (or specified month) ── */
app.get("/api/obiective", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);

  // Get targets for this month
  let targets;
  if (req.role === "agent" && req.agentDtr) {
    targets = db.prepare("SELECT * FROM sales_targets WHERE month=? AND app_sales_rep=?").all(month, req.agentDtr);
  } else {
    targets = db.prepare("SELECT * FROM sales_targets WHERE month=? ORDER BY agent_name").all(month);
  }

  // Get realized sales for this month
  let sales;
  if (req.role === "agent" && req.agentDtr) {
    const agentBase = req.agentDtr.replace(/\s*BB\w*\d*$/i, "").trim().toUpperCase();
    sales = db.prepare("SELECT * FROM sales_data WHERE month=? AND agent_name=?").all(month, agentBase);
  } else {
    sales = db.prepare("SELECT * FROM sales_data WHERE month=? ORDER BY agent_name").all(month);
  }

  // Merge targets with realized (fuzzy: first 4 chars of each name part to handle AGAFITE↔AGAFITEI etc.)
  function fuzzyKey(n) { return normalizeAgentName(n).split(" ").map(p => p.substring(0, 4)).join(" "); }
  const salesMap = {};
  for (const s of sales) {
    salesMap[normalizeAgentName(s.agent_name)] = s;
    salesMap[fuzzyKey(s.agent_name)] = s; // also index by fuzzy key
  }

  const result = targets.map(t => {
    const s = salesMap[normalizeAgentName(t.agent_name)] || salesMap[fuzzyKey(t.agent_name)] || {};
    const pctVal = t.bb_total_val > 0 ? Math.round(((s.total_valoare || 0) / t.bb_total_val) * 1000) / 10 : 0;
    const pctHl = t.bb_total_hl > 0 ? Math.round(((s.total_hl || 0) / t.bb_total_hl) * 1000) / 10 : 0;
    const pctClienti = t.clienti_2sku > 0 ? Math.round(((s.clienti_2sku || 0) / t.clienti_2sku) * 1000) / 10 : 0;

    return {
      agent_name: t.agent_name,
      app_sales_rep: t.app_sales_rep,
      target_val: t.bb_total_val,
      target_core_val: t.bb_core_val,
      target_abi_val: t.bb_abi_val,
      target_hl: t.bb_total_hl,
      target_clienti: t.clienti_2sku,
      realizat_val: s.total_valoare || 0,
      realizat_hl: s.total_hl || 0,
      realizat_clienti: s.total_clienti || 0,
      realizat_clienti_2sku: s.clienti_2sku || 0,
      pct_val: pctVal,
      pct_hl: pctHl,
      pct_clienti: pctClienti,
      last_import: s.last_import || null,
      import_file: s.import_file || null
    };
  });

  // Compute totals
  const totals = {
    target_val: targets.reduce((s, t) => s + t.bb_total_val, 0),
    target_hl: targets.reduce((s, t) => s + t.bb_total_hl, 0),
    target_clienti: targets.reduce((s, t) => s + t.clienti_2sku, 0),
    realizat_val: result.reduce((s, r) => s + r.realizat_val, 0),
    realizat_hl: result.reduce((s, r) => s + r.realizat_hl, 0),
    realizat_clienti_2sku: result.reduce((s, r) => s + r.realizat_clienti_2sku, 0)
  };
  totals.pct_val = totals.target_val > 0 ? Math.round((totals.realizat_val / totals.target_val) * 1000) / 10 : 0;
  totals.pct_hl = totals.target_hl > 0 ? Math.round((totals.realizat_hl / totals.target_hl) * 1000) / 10 : 0;
  totals.pct_clienti = totals.target_clienti > 0 ? Math.round((totals.realizat_clienti_2sku / totals.target_clienti) * 1000) / 10 : 0;

  // Working days info
  const now = new Date();
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  let workingDays = 0;
  let workedDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay();
    if (dow !== 0 && dow !== 6) {
      workingDays++;
      if (dt <= now) workedDays++;
    }
  }

  // ── GT data for OBIECTIVE section (reads from gt_targets which has both target + realizat) ──
  let gtData = null;
  try {
    const gtRows = db.prepare("SELECT agent_name, target_core, target_abi, target_total, real_core, real_abi, real_total FROM gt_targets WHERE month=?").all(month);

    /* Also check sales_data for GT calculated from daily sales import */
    const gtSales = db.prepare("SELECT agent_name, gt_core_total, gt_abi_total, gt_other_total, gt_grand_total FROM sales_data WHERE month=?").all(month);
    const gtSalesMap = {};
    for (const s of gtSales) gtSalesMap[normalizeAgentName(s.agent_name)] = s;

    const buildAgent = (t, s) => {
      const rCore = (t.real_core || 0) > 0 ? t.real_core : (s.gt_core_total || 0);
      const rAbi = (t.real_abi || 0) > 0 ? t.real_abi : (s.gt_abi_total || 0);
      const rTotal = (t.real_total || 0) > 0 ? t.real_total : (s.gt_grand_total || 0);
      const rOther = Math.max(rTotal - rCore - rAbi, 0);
      const tOther = Math.max((t.target_total || 0) - (t.target_core || 0) - (t.target_abi || 0), 0);
      return {
        agent: t.agent_name,
        target_core: t.target_core || 0, target_abi: t.target_abi || 0,
        target_other: Math.round(tOther * 100) / 100, target_total: t.target_total || 0,
        real_core: Math.round(rCore * 100) / 100, real_abi: Math.round(rAbi * 100) / 100,
        real_other: Math.round(rOther * 100) / 100, real_total: Math.round(rTotal * 100) / 100,
        pct_core: t.target_core ? Math.round(rCore / t.target_core * 10000) / 100 : 0,
        pct_abi: t.target_abi ? Math.round(rAbi / t.target_abi * 10000) / 100 : 0,
        pct_other: tOther ? Math.round(rOther / tOther * 10000) / 100 : 0,
        pct_total: t.target_total ? Math.round(rTotal / t.target_total * 10000) / 100 : 0
      };
    };

    if (req.role === "agent" && req.agentDtr) {
      const agentBase = req.agentDtr.replace(/\s*BB\w*\d*$/i, "").trim().toUpperCase();
      const myTarget = gtRows.find(t => normalizeAgentName(t.agent_name) === normalizeAgentName(agentBase));
      const mySale = gtSalesMap[normalizeAgentName(agentBase)] || { gt_core_total: 0, gt_abi_total: 0, gt_other_total: 0, gt_grand_total: 0 };
      if (myTarget) {
        gtData = { agents: [buildAgent(myTarget, mySale)], totals: null };
      }
    } else {
      // Merge gt_targets + sales_data by NORMALIZED name to avoid duplicates
      // Uses fuzzy matching: first 4 chars of each name part (handles MIHAIL↔MIHAI, double-spaces, etc.)
      function fuzzyNormName(n) {
        return normalizeAgentName(n).split(" ").map(p => p.substring(0, 4)).join(" ");
      }
      const normMap = {}; // fuzzy_key → { target, sale, displayName }
      for (const r of gtRows) {
        const key = fuzzyNormName(r.agent_name);
        if (!normMap[key]) normMap[key] = { target: null, sale: null, displayName: r.agent_name };
        normMap[key].target = r;
      }
      for (const s of gtSales) {
        const key = fuzzyNormName(s.agent_name);
        if (!normMap[key]) normMap[key] = { target: null, sale: null, displayName: s.agent_name };
        normMap[key].sale = s;
      }
      const gtAgents = [];
      for (const [norm, entry] of Object.entries(normMap)) {
        const t = entry.target || { agent_name: entry.displayName, target_core: 0, target_abi: 0, target_total: 0, real_core: 0, real_abi: 0, real_total: 0 };
        const s = entry.sale || { gt_core_total: 0, gt_abi_total: 0, gt_other_total: 0, gt_grand_total: 0 };
        gtAgents.push(buildAgent(t, s));
      }
      gtAgents.sort((a, b) => a.agent.localeCompare(b.agent));
      const gtTotals = {
        target_core: gtAgents.reduce((s, a) => s + a.target_core, 0),
        target_abi: gtAgents.reduce((s, a) => s + a.target_abi, 0),
        target_other: gtAgents.reduce((s, a) => s + a.target_other, 0),
        target_total: gtAgents.reduce((s, a) => s + a.target_total, 0),
        real_core: gtAgents.reduce((s, a) => s + a.real_core, 0),
        real_abi: gtAgents.reduce((s, a) => s + a.real_abi, 0),
        real_other: gtAgents.reduce((s, a) => s + a.real_other, 0),
        real_total: gtAgents.reduce((s, a) => s + a.real_total, 0)
      };
      gtTotals.pct_core = gtTotals.target_core ? Math.round(gtTotals.real_core / gtTotals.target_core * 10000) / 100 : 0;
      gtTotals.pct_abi = gtTotals.target_abi ? Math.round(gtTotals.real_abi / gtTotals.target_abi * 10000) / 100 : 0;
      gtTotals.pct_other = gtTotals.target_other ? Math.round(gtTotals.real_other / gtTotals.target_other * 10000) / 100 : 0;
      gtTotals.pct_total = gtTotals.target_total ? Math.round(gtTotals.real_total / gtTotals.target_total * 10000) / 100 : 0;
      gtData = { agents: gtAgents, totals: gtTotals };
    }
  } catch (e) { console.error("GT in obiective:", e); }

  res.json({
    month,
    agents: result,
    totals,
    working_days: workingDays,
    worked_days: Math.min(workedDays, workingDays),
    days_remaining: Math.max(workingDays - workedDays, 0),
    gt: gtData
  });
});

/* ── Agent Dashboard (post-login ranking) ── */
app.get("/api/agent-dashboard", auth, (req, res) => {
  const month = new Date().toISOString().slice(0, 7);

  // Get ALL targets + sales for this month (all agents)
  const targets = db.prepare("SELECT * FROM sales_targets WHERE month=? ORDER BY agent_name").all(month);
  const sales = db.prepare("SELECT * FROM sales_data WHERE month=? ORDER BY agent_name").all(month);
  const salesMap = {};
  for (const s of sales) salesMap[normalizeAgentName(s.agent_name)] = s;

  // Build rankings for all agents
  const agents = targets.map(t => {
    const s = salesMap[normalizeAgentName(t.agent_name)] || {};
    const pctVal = t.bb_total_val > 0 ? Math.round(((s.total_valoare || 0) / t.bb_total_val) * 1000) / 10 : 0;
    const pctHl = t.bb_total_hl > 0 ? Math.round(((s.total_hl || 0) / t.bb_total_hl) * 1000) / 10 : 0;
    const pctClienti = t.clienti_2sku > 0 ? Math.round(((s.clienti_2sku || 0) / t.clienti_2sku) * 1000) / 10 : 0;
    return {
      agent_name: t.agent_name,
      app_sales_rep: t.app_sales_rep,
      realizat_val: s.total_valoare || 0,
      target_val: t.bb_total_val,
      realizat_hl: s.total_hl || 0,
      target_hl: t.bb_total_hl,
      realizat_clienti_2sku: s.clienti_2sku || 0,
      target_clienti: t.clienti_2sku,
      pct_val: pctVal,
      pct_hl: pctHl,
      pct_clienti: pctClienti
    };
  });

  const totalAgents = agents.length;

  // Sort by pct_val descending → rank + compute deltas
  const byVal = [...agents].sort((a, b) => b.pct_val - a.pct_val);
  byVal.forEach((a, i) => {
    a.rank_val = i + 1;
    // Delta to position above
    if (i === 0) {
      a.delta_next = byVal.length > 1 ? Math.round((a.pct_val - byVal[1].pct_val) * 10) / 10 : 0;
    } else {
      a.delta_prev = Math.round((byVal[i - 1].pct_val - a.pct_val) * 10) / 10;
    }
    // Delta to podium (rank 3) for ranks 4+
    if (i >= 3) {
      a.delta_podium = Math.round((byVal[2].pct_val - a.pct_val) * 10) / 10;
    }
  });

  // Sort by pct_hl descending → rank
  const byHL = [...agents].sort((a, b) => b.pct_hl - a.pct_hl);
  byHL.forEach((a, i) => a.rank_hl = i + 1);

  // Sort by pct_clienti descending → rank
  const byCl = [...agents].sort((a, b) => b.pct_clienti - a.pct_clienti);
  byCl.forEach((a, i) => a.rank_clienti = i + 1);

  // Build lookup
  const agentMap = {};
  for (const a of agents) agentMap[normalizeAgentName(a.agent_name)] = a;

  // Find current agent
  let myData = null;
  if (req.role === "agent" && req.agentDtr) {
    const agentBase = req.agentDtr.replace(/\s*BB\w*\d*$/i, "").trim().toUpperCase();
    myData = agentMap[normalizeAgentName(agentBase)] || null;
  }

  // Working days info
  const now = new Date();
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  let workingDays = 0, workedDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay();
    if (dow !== 0 && dow !== 6) {
      workingDays++;
      if (dt <= now) workedDays++;
    }
  }

  // Full ranking list for SPV/admin; for agents just the sorted array for delta computation
  const ranking = (req.role === "spv" || req.role === "admin")
    ? byVal.map(a => ({
        agent_name: a.agent_name,
        pct_val: a.pct_val,
        pct_hl: a.pct_hl,
        pct_clienti: a.pct_clienti,
        rank_val: a.rank_val,
        rank_hl: a.rank_hl,
        rank_clienti: a.rank_clienti,
        realizat_val: a.realizat_val,
        target_val: a.target_val,
        realizat_hl: a.realizat_hl,
        target_hl: a.target_hl,
        realizat_clienti_2sku: a.realizat_clienti_2sku,
        target_clienti: a.target_clienti,
        delta_next: a.delta_next,
        delta_prev: a.delta_prev,
        delta_podium: a.delta_podium
      }))
    : null;

  // Get last import date from sales_data
  const lastImportRow = db.prepare("SELECT last_import, import_file FROM sales_data WHERE month=? ORDER BY last_import DESC LIMIT 1").get(month);
  const lastImport = lastImportRow ? lastImportRow.last_import : null;
  const importFile = lastImportRow ? lastImportRow.import_file : null;

  res.json({
    month,
    total_agents: totalAgents,
    my: myData,
    ranking,
    last_import: lastImport,
    import_file: importFile,
    working_days: workingDays,
    worked_days: Math.min(workedDays, workingDays),
    days_remaining: Math.max(workingDays - workedDays, 0)
  });
});

/* ── Daily sales history (per-day breakdown from daily_sales — raw, non-duplicated) ── */
app.get("/api/sales/daily-history", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);

  // Build list of monitored agent names (those in sales_targets for this month)
  const targetAgents = db.prepare("SELECT agent_name FROM sales_targets WHERE month=?").all(month).map(r => r.agent_name);
  // Build matching set: use normalized names + fuzzy keys for matching report agents
  const monitoredSet = new Set();
  for (const name of targetAgents) {
    monitoredSet.add(normalizeAgentName(name));
    monitoredSet.add(normalizeAgentName(name).split(" ").map(p => p.substring(0, 4)).join(" "));
  }
  // Also get sales_data agent_report_name → agent_name mapping for this month
  const salesAgentMap = {};
  const salesRows2 = db.prepare("SELECT agent_report_name, agent_name FROM sales_data WHERE month=?").all(month);
  for (const sr of salesRows2) {
    if (sr.agent_report_name && sr.agent_name) {
      const normTarget = normalizeAgentName(sr.agent_name);
      const fuzzyTarget = normTarget.split(" ").map(p => p.substring(0, 4)).join(" ");
      if (monitoredSet.has(normTarget) || monitoredSet.has(fuzzyTarget)) {
        salesAgentMap[sr.agent_report_name.toUpperCase()] = true;
      }
    }
  }

  // Check if daily_sales has data for this month; fallback to client_deliveries for backward compat
  const hasDailySales = db.prepare("SELECT COUNT(*) as cnt FROM daily_sales WHERE month=?").get(month);
  const useRawTable = hasDailySales && hasDailySales.cnt > 0;

  const hasTeamFilter = Object.keys(salesAgentMap).length > 0;

  let allRows, teamRows;
  if (useRawTable) {
    // ALL agents (total including engros)
    allRows = db.prepare(`
      SELECT datadoc,
             SUM(total_valoare) as total_valoare,
             SUM(total_hl) as total_hl,
             COUNT(DISTINCT client_id) as unique_clients
      FROM daily_sales
      WHERE month = ? AND datadoc != ''
      GROUP BY datadoc
      ORDER BY datadoc ASC
    `).all(month);

    // TEAM only (monitored agents from targets)
    if (hasTeamFilter) {
      const agentList = Object.keys(salesAgentMap);
      const placeholders = agentList.map(() => "?").join(",");
      teamRows = db.prepare(`
        SELECT datadoc,
               SUM(total_valoare) as total_valoare,
               SUM(total_hl) as total_hl,
               COUNT(DISTINCT client_id) as unique_clients
        FROM daily_sales
        WHERE month = ? AND datadoc != '' AND UPPER(agent) IN (${placeholders})
        GROUP BY datadoc
        ORDER BY datadoc ASC
      `).all(month, ...agentList);
    }
  } else {
    // Fallback: old client_deliveries
    allRows = db.prepare(`
      SELECT datadoc,
             SUM(valoare) as total_valoare,
             SUM(cantitate) as total_hl,
             COUNT(DISTINCT client_code) as unique_clients
      FROM client_deliveries
      WHERE month = ? AND datadoc != ''
      GROUP BY datadoc
      ORDER BY datadoc ASC
    `).all(month);
  }

  // Index team rows by date
  const teamByDate = {};
  if (teamRows) {
    for (const tr of teamRows) teamByDate[tr.datadoc] = tr;
  }

  // Build cumulative totals (using ALL data = team + engros)
  let cumVal = 0, cumHL = 0;
  let cumTeamVal = 0, cumTeamHL = 0;
  const daily = [];

  for (const row of allRows) {
    cumVal += row.total_valoare;
    cumHL += row.total_hl;

    const teamDay = teamByDate[row.datadoc];
    const teamValoare = teamDay ? teamDay.total_valoare : row.total_valoare;
    const teamHL = teamDay ? teamDay.total_hl : row.total_hl;
    const teamClients = teamDay ? teamDay.unique_clients : row.unique_clients;
    cumTeamVal += teamValoare;
    cumTeamHL += teamHL;

    const engrosVal = row.total_valoare - teamValoare;
    const engrosHL = row.total_hl - teamHL;

    daily.push({
      date: row.datadoc,
      // Total (echipă + engros)
      valoare: Math.round(row.total_valoare * 100) / 100,
      hl: Math.round(row.total_hl * 100) / 100,
      unique_clients: row.unique_clients,
      cum_valoare: Math.round(cumVal * 100) / 100,
      cum_hl: Math.round(cumHL * 100) / 100,
      // Echipă (doar agenți monitorizați)
      team_valoare: Math.round(teamValoare * 100) / 100,
      team_hl: Math.round(teamHL * 100) / 100,
      team_clients: teamClients,
      cum_team_valoare: Math.round(cumTeamVal * 100) / 100,
      cum_team_hl: Math.round(cumTeamHL * 100) / 100,
      // En-gros (diferența)
      engros_valoare: Math.round(engrosVal * 100) / 100,
      engros_hl: Math.round(engrosHL * 100) / 100
    });
  }

  // Grand totals
  const totals = {
    valoare: Math.round(cumVal * 100) / 100,
    hl: Math.round(cumHL * 100) / 100,
    team_valoare: Math.round(cumTeamVal * 100) / 100,
    team_hl: Math.round(cumTeamHL * 100) / 100,
    engros_valoare: Math.round((cumVal - cumTeamVal) * 100) / 100,
    engros_hl: Math.round((cumHL - cumTeamHL) * 100) / 100
  };

  // Engros agents list (for reference)
  const engrosAgents = [];
  for (const sr of salesRows2) {
    if (sr.agent_report_name && !salesAgentMap[sr.agent_report_name.toUpperCase()]) {
      engrosAgents.push(sr.agent_report_name);
    }
  }

  res.json({ month, daily, totals, engros_agents: engrosAgents });
});

/* ═══════════ RANKING AGENȚI ═══════════ */
app.get("/api/ranking", auth, (req, res) => {
  try {
    const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);

    const targets = db.prepare("SELECT * FROM sales_targets WHERE month=? ORDER BY agent_name").all(month);
    if (!targets.length) return res.json({ ranking: [], myPosition: null, totalAgents: 0, month });

    const sales = db.prepare("SELECT * FROM sales_data WHERE month=? ORDER BY agent_name").all(month);
    const salesMap = {};
    for (const s of sales) salesMap[normalizeAgentName(s.agent_name)] = s;

    const agentScores = targets.map(t => {
      const s = salesMap[normalizeAgentName(t.agent_name)] || {};
      const pctVal = t.bb_total_val > 0 ? ((s.total_valoare || 0) / t.bb_total_val) * 100 : 0;
      const pctClienti = t.clienti_2sku > 0 ? ((s.clienti_2sku || 0) / t.clienti_2sku) * 100 : 0;
      const pctHl = t.bb_total_hl > 0 ? ((s.total_hl || 0) / t.bb_total_hl) * 100 : 0;
      const score = Math.round(((pctVal + pctClienti) / 2) * 10) / 10;
      return {
        agent_name: t.agent_name, app_sales_rep: t.app_sales_rep,
        pct_val: Math.round(pctVal * 10) / 10, pct_clienti: Math.round(pctClienti * 10) / 10, pct_hl: Math.round(pctHl * 10) / 10,
        realizat_val: s.total_valoare || 0, target_val: t.bb_total_val,
        realizat_clienti: s.clienti_2sku || 0, target_clienti: t.clienti_2sku,
        realizat_hl: s.total_hl || 0, target_hl: t.bb_total_hl, score
      };
    });

    agentScores.sort((a, b) => b.score - a.score);
    let pos = 1;
    for (let i = 0; i < agentScores.length; i++) {
      if (i > 0 && agentScores[i].score < agentScores[i - 1].score) pos = i + 1;
      agentScores[i].position = pos;
    }

    let myPosition = null, myAgent = null;
    if (req.agentDtr) {
      myAgent = agentScores.find(a => a.app_sales_rep === req.agentDtr);
      if (myAgent) myPosition = myAgent.position;
    }

    res.json({ ranking: agentScores, myPosition, myAgent, totalAgents: agentScores.length, month });
  } catch (e) {
    console.error("ranking error:", e.message);
    console.error("[Error]", e.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── Import sales XLSX (admin only) ── */
const salesUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      cb(null, `sales_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.xlsx`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: excelFileFilter
});

app.post("/api/obiective/import-sales", auth, adminOnly, salesUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });

  try {

    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("Fișierul nu conține niciun sheet");

    // Parse rows as array of arrays
    const rows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!rows || rows.length === 0) throw new Error("Fișierul nu conține date");

    // Find column indices by header names (first row)
    const headers = {};
    const firstRow = rows[0];
    firstRow.forEach((val, idx) => {
      if (val) headers[String(val).toUpperCase().trim()] = idx;
    });

    const colAgent = headers["AGENT"];
    const colValoare = headers["VALOARE"];
    const colCantHL = headers["CANTHL"];
    const colCodIntern = headers["CODINTERN"];
    const colClientName = headers["CLIENT"];
    const colCodUnic = headers["CODUNIC"];
    const colClient = colCodUnic !== undefined ? colCodUnic : colClientName; // prefer CODUNIC as unique ID
    const colCodFiscal = headers["CODFISCAL"];

    if (colAgent === undefined || colValoare === undefined) {
      throw new Error("Coloane obligatorii lipsă: AGENT, VALOARE. Verifică headerul.");
    }

    // Build CIF→clients map for delivery matching
    const cifMap = buildCifToClientsMap();
    // Cache: sales CODUNIC → census code (avoid re-computing per row)
    const salesCodeCache = {};

    // ── GT: Build SKU mapping + price caches ──
    // Use sku_local (col C = SKU Name Local) for price lookup, NOT sku_bb (col B = SKU_BBSA with MPK prefix)
    const gtSkuMap = {}; // DENUMIRE (lowercase) → sku_local
    const gtSkuAll = db.prepare("SELECT denumire_dtr, sku_bb, sku_local FROM sku_mapping").all();
    for (const m of gtSkuAll) {
      const local = (m.sku_local || "").trim();
      gtSkuMap[m.denumire_dtr.toLowerCase()] = local || m.sku_bb; // fallback to sku_bb if sku_local empty
    }

    // Price map: case-insensitive lookup by SKU name
    const gtPriceMap = {}; // sku_name (lowercase) → { gt_hl, grupa, brand }
    const gtPriceAll = db.prepare("SELECT sku_bb, gt_hl, grupa_obiectiv, brand FROM gt_prices").all();
    for (const p of gtPriceAll) gtPriceMap[p.sku_bb.toLowerCase()] = { gt_hl: p.gt_hl, grupa: p.grupa_obiectiv, brand: p.brand || "" };

    // Brand-based fallback for grupa classification
    function getGrupaByBrand(skuName) {
      const lower = (skuName || "").toLowerCase();
      if (lower.startsWith("ursus") || lower.startsWith("timisoreana")) return "Core Segment";
      if (lower.startsWith("stella") || lower.startsWith("beck") || lower.startsWith("staropramen") ||
          lower.startsWith("leffe") || lower.startsWith("hoegaarden") || lower.startsWith("corona") ||
          lower.startsWith("franziskaner") || lower.startsWith("fresh 0.0%") || lower.startsWith("fresh na") ||
          lower.startsWith("praha") || lower.startsWith("miller") || lower.startsWith("madri")) return "ABI";
      return "";
    }

    const gtAgentData = {}; // agent_name → { core: 0, abi: 0, other: 0, total: 0 }
    const gtUnmatched = new Set();

    // Parse rows
    const agentData = {}; // agent_name → { valoare, hl, clients: Set, clientSkus: {client→Set(sku)} }
    const clientProducts = {}; // "census_client_code|datadoc" → { codintern → { denumire, cant, val, datadoc } }
    const rawDailySales = {}; // "datadoc|agent|clientId" → { hl, valoare } — raw data, no multi-loc duplication
    let rowCount = 0;
    let mappedClients = 0, unmappedClients = 0;

    const colDenumire = headers["DENUMIRE"];
    const colCant = headers["CANT"];
    const colDateDoc = headers["DATADOC"];

    // Helper to parse DATADOC → YYYY-MM-DD (handles: Date objects, Excel serial numbers, DD.MM.YYYY strings)
    function parseDateDoc(raw) {
      if (!raw) return "";
      // JS Date object (xlsx parses date-formatted cells as Date)
      if (raw instanceof Date && !isNaN(raw)) {
        return raw.toISOString().slice(0, 10);
      }
      // Excel serial number (e.g. 46054 = 2026-02-03)
      if (typeof raw === "number" && raw > 30000 && raw < 60000) {
        // Excel epoch: 1900-01-01, with the infamous leap year bug (+1 day offset for dates > 1900-02-28)
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const msPerDay = 86400000;
        const d = new Date(excelEpoch.getTime() + raw * msPerDay);
        return d.toISOString().slice(0, 10);
      }
      const s = String(raw).trim();
      // DD.MM.YYYY
      const dotMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (dotMatch) return `${dotMatch[3]}-${dotMatch[2].padStart(2, "0")}-${dotMatch[1].padStart(2, "0")}`;
      // YYYY-MM-DD already
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      // Try JS Date string parsing
      const d = new Date(s);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
      return "";
    }

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const agent = String(row[colAgent] || "").trim();
      if (!agent) continue;

      const valoare = parseFloat(row[colValoare]) || 0;
      const hl = colCantHL !== undefined ? (parseFloat(row[colCantHL]) || 0) : 0;
      const codIntern = colCodIntern !== undefined ? String(row[colCodIntern] || "").trim() : "";
      const clientId = colClient !== undefined ? String(row[colClient] || "").trim() : "";
      const denumire = colDenumire !== undefined ? String(row[colDenumire] || "").trim() : "";
      const cant = colCant !== undefined ? (parseFloat(row[colCant]) || 0) : 0;
      const datadoc = colDateDoc !== undefined ? parseDateDoc(row[colDateDoc]) : "";

      if (!agentData[agent]) {
        agentData[agent] = { valoare: 0, hl: 0, clients: new Set(), clientSkus: {} };
      }
      agentData[agent].valoare += valoare;
      agentData[agent].hl += hl;

      // Track raw daily sales (BEFORE multi-loc broadcast — no duplication)
      if (datadoc) {
        const rawKey = `${datadoc}|${agent}|${clientId || "unknown"}`;
        if (!rawDailySales[rawKey]) rawDailySales[rawKey] = { hl: 0, valoare: 0 };
        rawDailySales[rawKey].hl += hl;
        rawDailySales[rawKey].valoare += valoare;
      }

      if (clientId) {
        agentData[agent].clients.add(clientId);
        if (!agentData[agent].clientSkus[clientId]) agentData[agent].clientSkus[clientId] = new Set();
        if (codIntern) agentData[agent].clientSkus[clientId].add(codIntern);
      }

      // Track per-client product deliveries (map sales client → census codes)
      if (clientId && codIntern && denumire) {
        let censusCodes = salesCodeCache[clientId];
        if (censusCodes === undefined) {
          const salesName = colClientName !== undefined ? String(row[colClientName] || "").trim() : clientId;
          const salesCif = colCodFiscal !== undefined ? String(row[colCodFiscal] || "").trim() : "";
          censusCodes = mapSalesClientToCensusCodes(salesName, salesCif, cifMap);
          salesCodeCache[clientId] = censusCodes;
          if (censusCodes.length > 0) mappedClients++; else unmappedClients++;
        }
        // Save delivery for all matched census codes (broadcast for multi-loc)
        const codes = censusCodes.length > 0 ? censusCodes : [clientId];
        const dateKey = datadoc || "unknown";
        for (const useCode of codes) {
          const productKey = `${useCode}|${dateKey}`;
          if (!clientProducts[productKey]) clientProducts[productKey] = {};
          if (!clientProducts[productKey][codIntern]) {
            clientProducts[productKey][codIntern] = { denumire, cant: 0, val: 0, datadoc: datadoc };
          }
          clientProducts[productKey][codIntern].cant += hl;  // HL (hectolitri) din coloana CANTHL, NU bucăți
          clientProducts[productKey][codIntern].val += valoare;
        }
      }

      // ── GT: calculate per-row GT and aggregate per agent ──
      if (denumire && hl) {
        const skuLocal = gtSkuMap[denumire.toLowerCase()];
        if (skuLocal) {
          const price = gtPriceMap[skuLocal.toLowerCase()]; // case-insensitive lookup
          if (price && price.gt_hl) {
            const gtVal = hl * price.gt_hl;
            if (!gtAgentData[agent]) gtAgentData[agent] = { core: 0, abi: 0, other: 0, total: 0 };
            gtAgentData[agent].total += gtVal;
            // Determine grupa: use price.grupa from GT HL right side, fallback to brand-based
            let gr = (price.grupa || "").toUpperCase();
            if (!gr) gr = getGrupaByBrand(skuLocal).toUpperCase();
            if (gr.includes("CORE")) {
              gtAgentData[agent].core += gtVal;
            } else if (gr.includes("ABI")) {
              gtAgentData[agent].abi += gtVal;
            } else {
              gtAgentData[agent].other += gtVal;
            }
          }
        } else if (!/reducere|discount/i.test(denumire)) {
          gtUnmatched.add(denumire);
        }
      }

      rowCount++;
    }

    // Determine month from filename or req.body
    let importMonth = req.body.month || "";
    if (!importMonth) {
      // Try to extract from data (DATADOC column)
      const colDate = headers["DATADOC"];
      if (colDate !== undefined && rows.length > 1) {
        const firstDate = String(rows[1][colDate] || "").trim();
        if (firstDate) {
          // Handle DD.MM.YYYY format (Romanian date format)
          const dotMatch = firstDate.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
          if (dotMatch) {
            importMonth = `${dotMatch[3]}-${dotMatch[2].padStart(2, "0")}`;
          } else {
            const d = new Date(firstDate);
            if (!isNaN(d)) importMonth = d.toISOString().slice(0, 7);
          }
        }
      }
    }
    if (!importMonth) importMonth = new Date().toISOString().slice(0, 7);

    // Save to DB (includes GT columns)
    const insStmt = db.prepare(`INSERT OR REPLACE INTO sales_data
      (month, agent_report_name, agent_name, total_valoare, total_hl, total_clienti, clienti_2sku, last_import, import_file,
       gt_core_total, gt_abi_total, gt_other_total, gt_grand_total)
      VALUES (?,?,?,?,?,?,?,datetime('now'),?,?,?,?,?)`);

    const importResults = [];
    const unmatchedAgents = [];

    // Prepare client deliveries insert (now with datadoc)
    const insDelivery = db.prepare(`INSERT OR REPLACE INTO client_deliveries
      (month, client_code, codintern, denumire, cantitate, valoare, datadoc)
      VALUES (?,?,?,?,?,?,?)`);

    // Prepare daily_sales insert
    const insDailySales = db.prepare(`INSERT OR REPLACE INTO daily_sales
      (month, datadoc, agent, client_id, total_hl, total_valoare)
      VALUES (?,?,?,?,?,?)`);

    const importTx = db.transaction(() => {
      // Clear old data for this month before re-importing
      db.prepare("DELETE FROM client_deliveries WHERE month=?").run(importMonth);
      db.prepare("DELETE FROM sales_data WHERE month=?").run(importMonth);
      db.prepare("DELETE FROM daily_sales WHERE month=?").run(importMonth);

      for (const [reportName, data] of Object.entries(agentData)) {
        const match = matchSalesAgentToApp(reportName);
        if (match) {
          const clienti2sku = Object.values(data.clientSkus).filter(skus => skus.size >= 2).length;
          // GT values for this agent (use report name because gtAgentData is keyed by sales agent name)
          const gt = gtAgentData[reportName] || { core: 0, abi: 0, other: 0, total: 0 };
          insStmt.run(importMonth, reportName, match.agent_name,
            Math.round(data.valoare * 100) / 100,
            Math.round(data.hl * 100) / 100,
            data.clients.size, clienti2sku, req.file.originalname,
            Math.round(gt.core * 100) / 100,
            Math.round(gt.abi * 100) / 100,
            Math.round(gt.other * 100) / 100,
            Math.round(gt.total * 100) / 100);
          importResults.push({
            report_name: reportName,
            matched_to: match.agent_name,
            valoare: Math.round(data.valoare * 100) / 100,
            hl: Math.round(data.hl * 100) / 100,
            clienti: data.clients.size,
            clienti_2sku: clienti2sku,
            gt_core: Math.round(gt.core * 100) / 100,
            gt_abi: Math.round(gt.abi * 100) / 100,
            gt_total: Math.round(gt.total * 100) / 100
          });
        } else {
          unmatchedAgents.push(reportName);
        }
      }

      // Save per-client product deliveries (filter out non-product rows like discounts)
      let deliveryCount = 0;
      for (const [productKey, products] of Object.entries(clientProducts)) {
        const [clientCode] = productKey.split("|");
        for (const [codintern, info] of Object.entries(products)) {
          // Include all lines (including discounts - they reduce sale value)
          insDelivery.run(importMonth, clientCode, codintern, info.denumire,
            Math.round(info.cant * 100) / 100,
            Math.round(info.val * 100) / 100,
            info.datadoc || "");
          deliveryCount++;
        }
      }
      console.log(`Saved ${deliveryCount} client-product delivery records for ${importMonth} (${mappedClients} clients mapped, ${unmappedClients} unmapped)`);

      // Save raw daily sales (non-duplicated)
      let dailyCount = 0;
      for (const [rawKey, data] of Object.entries(rawDailySales)) {
        const [datadoc, agent, clientId] = rawKey.split("|");
        insDailySales.run(importMonth, datadoc, agent, clientId,
          Math.round(data.hl * 100) / 100,
          Math.round(data.valoare * 100) / 100);
        dailyCount++;
      }
      console.log(`Saved ${dailyCount} raw daily sales records for ${importMonth}`);
    });
    importTx();

    // Verify daily_sales was saved
    const dailySalesVerify = db.prepare("SELECT COUNT(*) as cnt, SUM(total_hl) as hl FROM daily_sales WHERE month=?").get(importMonth);

    res.json({
      ok: true,
      month: importMonth,
      rows_processed: rowCount,
      agents_imported: importResults.length,
      unmatched_agents: unmatchedAgents,
      delivery_clients_mapped: mappedClients,
      delivery_clients_unmapped: unmappedClients,
      gt_unmatched_products: [...gtUnmatched],
      gt_unmatched_count: gtUnmatched.size,
      raw_daily_entries: Object.keys(rawDailySales).length,
      daily_sales_saved: dailySalesVerify?.cnt || 0,
      daily_sales_hl: Math.round((dailySalesVerify?.hl || 0) * 100) / 100,
      results: importResults
    });
  } catch (err) {
    console.error("Sales import error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── Import Clienți 2 SKU pe 2 luni (upload fișier vânzări pe 2 luni) ── */
app.post("/api/obiective/import-clienti-2luni", auth, adminOnly, salesUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  const month = req.body.month;
  if (!month || !validateMonthFormat(month)) return res.status(400).json({ error: "Format lună invalid (ex: 2026-02)" });

  try {

    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("Fișierul nu conține niciun sheet");

    // Parse rows
    const rows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!rows || rows.length === 0) throw new Error("Fișierul nu conține date");

    // Find column indices
    const headers = {};
    const firstRow = rows[0];
    firstRow.forEach((val, idx) => {
      if (val) headers[String(val).toUpperCase().trim()] = idx;
    });

    const colAgent = headers["AGENT"];
    const colCodIntern = headers["CODINTERN"];
    const colCodUnic = headers["CODUNIC"];
    const colClientName = headers["CLIENT"];
    const colClient = colCodUnic !== undefined ? colCodUnic : colClientName;
    const colDenumire = headers["DENUMIRE"];

    if (colAgent === undefined) throw new Error("Coloana AGENT lipsește din header");
    if (colClient === undefined) throw new Error("Coloana CLIENT sau CODUNIC lipsește din header");

    /* SKU column: prefer CODINTERN, fallback to DENUMIRE (product name) */
    const colSku = colCodIntern !== undefined ? colCodIntern : colDenumire;
    if (colSku === undefined) throw new Error("Coloana CODINTERN sau DENUMIRE lipsește din header");

    const colCantHL = headers["CANT HL"];
    const colDci    = headers["DCI"];

    /* ── 2SKU HL-based activation ──
       Nomenclator BB: fiecare SKU are un prag minim în HL (cantitate minimă).
       Un SKU e "activat" per client dacă total CANT HL ≥ prag minim pe 2 luni.
       Client activat 2SKU = minim 2 SKU-uri activate (fiecare cu cantitate minimă îndeplinită).

       Praguri minime per DCI (format container) — din nomenclatorul BB "cantitate minima":
    */
    const DCI_MIN_HL = {
      "CAN 0.5L":       0.12,   "CAN 0.55L":      0.132,
      "CAN MPK 4*0.5L": 0.02,   "CAN MPK 6*0.5L": 0.03,
      "CAN MPK 12*0.5L":0.06,   "CAN MPK 24*0.5L":0.12,
      "CAN MPK 6x0.33L":0.0198,
      "KEG 20L":        0.2,    "KEG 30L":         0.3,   "KEG 50L": 0.5,
      "NRGB 0.33L":     0.0792, "NRGB 0.5L":       0.1,
      "NRGB 0.66L":     0.0792, "NRGB 0.75L":      0.09,
      "NRGB MPK 4*0.33L":  0.0132, "NRGB MPK 5*0.33L":  0.0165,
      "NRGB MPK 6*0.33L":  0.0198, "NRGB MPK 6*0.355L": 0.0213,
      "NRGB MPK 6*0.75L":  0.045,  "NRGB MPK 8*0.5L":   0.04,
      "NRGB MPK 12*0.33L": 0.0396, "NRGB MPK 12*0.75L": 0.09,
      "NRGB MPK 24*0.33L": 0.0792,
      "PET 0.5L":       0.06,   "PET 0.75L":       0.0675,
      "PET 1L":          0.09,  "PET 2L":           0.12,
      "PET 2.5L":        0.15,  "PET 3L":           0.18,
      "RGB 0.5L":        0.1,   "RGB MPK 20*0.5L":  0.1,
    };
    const DEFAULT_MIN_HL = 0.1; /* fallback for unknown DCI */

    function getMinHL(dci) {
      if (!dci) return DEFAULT_MIN_HL;
      const d = String(dci).trim();
      if (DCI_MIN_HL[d] !== undefined) return DCI_MIN_HL[d];
      /* Fuzzy: try prefix match */
      for (const [key, val] of Object.entries(DCI_MIN_HL)) {
        if (d.toUpperCase().startsWith(key.toUpperCase().slice(0, 8))) return val;
      }
      return DEFAULT_MIN_HL;
    }

    /* Normalize product name: strip "Pach." prefix, piece counts, SGR, PROMO → base product + DCI */
    function normalizeProduct(denumire, dci) {
      let n = String(denumire)
        .replace(/^pach\.?\s*/i, "")
        .replace(/\*?\d+\s*buc\b/i, "")
        .replace(/\s+SGR\b/i, "")
        .replace(/\s+PROMO\b.*/i, "")
        .replace(/\s+FREE\s+BEER\b/i, "")
        .replace(/\s+202\d\b/i, "")
        .replace(/^DOZA\s+/i, "")
        .replace(/^1\*/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
      /* Append DCI for uniqueness: "URSUS" + "PET 1L" → distinct from "URSUS" + "CAN 0.5L" */
      const d = String(dci || "").trim().toUpperCase();
      return d ? `${n}|${d}` : n;
    }

    /*  Aggregate: agent → { client → { normalizedProduct → { totalHL, minHL } } }  */
    const agentClientProducts = {};
    let skippedReducere = 0, processedRows = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const agent = String(row[colAgent] || "").trim();
      if (!agent || agent.includes("TOTAL")) continue;
      const clientId = String(row[colClient] || "").trim();
      if (!clientId) continue;
      const denumire = String(row[colSku] || "").trim();
      /* Skip empty SKUs and discount/reduction lines (not separate SKUs) */
      if (!denumire || /reducere|discount/i.test(denumire)) { skippedReducere++; continue; }

      const cantHL = colCantHL !== undefined ? (parseFloat(row[colCantHL]) || 0) : 0;
      if (cantHL <= 0) continue;
      const dci = colDci !== undefined ? String(row[colDci] || "").trim() : "";
      const minHL = getMinHL(dci);
      const normProd = normalizeProduct(denumire, dci);

      if (!agentClientProducts[agent]) agentClientProducts[agent] = {};
      if (!agentClientProducts[agent][clientId]) agentClientProducts[agent][clientId] = {};
      if (!agentClientProducts[agent][clientId][normProd]) {
        agentClientProducts[agent][clientId][normProd] = { totalHL: 0, minHL };
      }
      agentClientProducts[agent][clientId][normProd].totalHL += cantHL;
      processedRows++;
    }

    console.log(`[2SKU HL] Processed ${processedRows} rows, skipped ${skippedReducere} reducere/discount lines`);

    /* Calculate clienti_2sku per agent:
       client is "activated" if they have >= 2 distinct products each meeting min HL threshold */
    const updStmt = db.prepare("UPDATE sales_data SET clienti_2sku=? WHERE month=? AND agent_name=?");
    const upsertStmt = db.prepare(`INSERT INTO sales_data (month, agent_name, agent_report_name, clienti_2sku, last_import)
      VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(month, agent_name) DO UPDATE SET clienti_2sku=excluded.clienti_2sku, last_import=excluded.last_import`);
    let updated = 0;
    const results = [];

    /* Build a map of target agent names for fuzzy matching */
    const targetAgents = db.prepare("SELECT agent_name FROM sales_targets WHERE month=?").all(month);
    function normalizeUp(n) { return String(n||"").toUpperCase().replace(/\s+/g," ").trim(); }
    function fuzzyMatch(reportName) {
      const norm = normalizeUp(reportName);
      /* Direct */
      for (const ta of targetAgents) { if (normalizeUp(ta.agent_name) === norm) return ta.agent_name; }
      /* First word match */
      const firstName = norm.split(" ")[0];
      for (const ta of targetAgents) { if (normalizeUp(ta.agent_name).startsWith(firstName)) return ta.agent_name; }
      /* Try existing in sales_data */
      const existing = db.prepare("SELECT agent_name FROM sales_data WHERE month=? AND (UPPER(agent_name) LIKE ? OR UPPER(agent_report_name) LIKE ?) LIMIT 1")
        .get(month, `%${firstName}%`, `%${firstName}%`);
      return existing ? existing.agent_name : null;
    }

    const tx = db.transaction(() => {
      for (const [reportName, clientProducts] of Object.entries(agentClientProducts)) {
        /* Count clients with >= 2 products that each meet their min HL threshold */
        const clienti2sku = Object.values(clientProducts).filter(products => {
          const activatedSkus = Object.values(products).filter(p => p.totalHL >= p.minHL).length;
          return activatedSkus >= 2;
        }).length;
        const totalClients = Object.keys(clientProducts).length;

        /* Try UPDATE first on existing sales_data rows */
        let upd = updStmt.run(clienti2sku, month, reportName);
        if (upd.changes === 0) {
          /* Try matching to a known target agent name */
          const matchedAgent = fuzzyMatch(reportName);
          if (matchedAgent) {
            upd = updStmt.run(clienti2sku, month, matchedAgent);
            /* If still no row, INSERT one */
            if (upd.changes === 0) {
              upsertStmt.run(month, matchedAgent, reportName, clienti2sku);
              upd = { changes: 1 };
            }
          } else {
            /* No target found — create sales_data row with report name */
            upsertStmt.run(month, reportName, reportName, clienti2sku);
            upd = { changes: 1 };
          }
        }
        if (upd.changes > 0) updated++;
        results.push({ agent: reportName, clienti_2sku: clienti2sku, total_clienti: totalClients, updated: upd.changes > 0 });
      }
    });
    tx();

    console.log(`[Clienti 2 luni] Updated ${updated}/${Object.keys(agentClientProducts).length} agents for ${month}`);
    res.json({ ok: true, month, agents_processed: Object.keys(agentClientProducts).length, agents_updated: updated, results });
  } catch (err) {
    console.error("Clienti 2 luni import error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── Sales Data diagnostics (admin only) ── */
app.get("/api/debug/sales-data", auth, adminOnly, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const salesRows = db.prepare("SELECT * FROM sales_data WHERE month=? ORDER BY agent_name").all(month);
  const targetRows = db.prepare("SELECT agent_name, app_sales_rep, clienti_2sku FROM sales_targets WHERE month=? ORDER BY agent_name").all(month);
  const dailySalesCount = db.prepare("SELECT COUNT(*) as cnt FROM daily_sales WHERE month=?").get(month);
  const dailySalesAgents = db.prepare("SELECT DISTINCT agent FROM daily_sales WHERE month=?").all(month);
  const dailySalesTotal = db.prepare("SELECT SUM(total_hl) as hl, SUM(total_valoare) as val FROM daily_sales WHERE month=?").get(month);
  res.json({ month, sales_data: salesRows, sales_targets: targetRows, daily_sales: { count: dailySalesCount?.cnt || 0, agents: dailySalesAgents.map(a => a.agent), total_hl: dailySalesTotal?.hl || 0, total_val: dailySalesTotal?.val || 0 } });
});

/* ── Delivery diagnostics (admin only) ── */
app.get("/api/debug/deliveries", auth, adminOnly, (req, res) => {
  const months = db.prepare("SELECT month, COUNT(*) as cnt FROM client_deliveries GROUP BY month ORDER BY month").all();
  const currentMonth = new Date().toISOString().slice(0, 7);
  const sample = db.prepare("SELECT client_code, denumire, cantitate FROM client_deliveries WHERE month=? LIMIT 10").all(currentMonth);
  res.json({ currentMonth, months, sample_current_month: sample });
});

/* ── Update targets (admin only) ── */
app.post("/api/obiective/update-targets", auth, adminOnly, (req, res) => {
  const { month, targets } = req.body;
  if (!month || !targets || !Array.isArray(targets)) {
    return res.status(400).json({ error: "month și targets[] obligatorii" });
  }
  const stmt = db.prepare(`INSERT OR REPLACE INTO sales_targets
    (month, agent_name, app_sales_rep, bb_total_val, bb_core_val, bb_abi_val, bb_total_hl, clienti_2sku)
    VALUES (?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const t of targets) {
      stmt.run(month, t.agent_name, t.app_sales_rep || "", t.bb_total_val || 0, t.bb_core_val || 0, t.bb_abi_val || 0, t.bb_total_hl || 0, t.clienti_2sku || 0);
    }
  });
  tx();
  res.json({ ok: true, count: targets.length });
});

/* ═══════════ GT URSUS — Endpoints ═══════════ */

/* ── Upload SKU Mapping (Mapare denumiri Quatro → SKU Ursus) ── */
const gtUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `gt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.xlsx`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: excelFileFilter
});

/* ══════════ UNIFIED GT UPLOAD: all 3 sheets from one file ══════════ */
app.post("/api/gt/upload-all", auth, adminOnly, gtUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  const month = req.body.month;
  if (!month || !validateMonthFormat(month)) return res.status(400).json({ error: "Format lună invalid (ex: 2026-02)" });
  try {

    const wb = XLSX_LIB.readFile(req.file.path);

    const results = { sku: 0, prices: 0, targets: 0, sales_updated: 0 };

    // ── 1. MAPARE SKU (sheet "Mapare SKU") ──
    let wsSku = null;
    for (const sheetName of wb.SheetNames) {
      if (sheetName.toLowerCase().includes("mapare")) {
        wsSku = wb.Sheets[sheetName];
        break;
      }
    }
    if (wsSku) {
      const skuRows = XLSX_LIB.utils.sheet_to_json(wsSku, { header: 1, defval: "" });
      if (skuRows && skuRows.length > 0) {
        const headers = {};
        const firstRow = skuRows[0];
        firstRow.forEach((val, idx) => {
          if (val) headers[String(val).trim().toUpperCase()] = idx;
        });
        const colDen = headers["NUMEINTERNEDTR"] !== undefined ? headers["NUMEINTERNEDTR"] : (headers["NUMEINTERN_DTR"] !== undefined ? headers["NUMEINTERN_DTR"] : (headers["NUMEINTERNDTR"] !== undefined ? headers["NUMEINTERNDTR"] : (headers["DENUMIRE"] !== undefined ? headers["DENUMIRE"] : (headers["DENUMIRE_DTR"] !== undefined ? headers["DENUMIRE_DTR"] : 0))));
        const colSku = headers["SKU_BBSA"] !== undefined ? headers["SKU_BBSA"] : (headers["SKU_BB"] !== undefined ? headers["SKU_BB"] : (headers["SKU"] !== undefined ? headers["SKU"] : 1));
        const colLocal = headers["SKU NAME LOCAL"] !== undefined ? headers["SKU NAME LOCAL"] : (headers["SKU_LOCAL"] !== undefined ? headers["SKU_LOCAL"] : (headers["SKUNAMELOCAL"] !== undefined ? headers["SKUNAMELOCAL"] : 2));
        const ins = db.prepare("INSERT OR REPLACE INTO sku_mapping (denumire_dtr, sku_bb, sku_local) VALUES (?,?,?)");
        const tx = db.transaction(() => {
          db.prepare("DELETE FROM sku_mapping").run();
          for (let i = 1; i < skuRows.length; i++) {
            const row = skuRows[i];
            const den = String(row[colDen] || "").trim();
            const sku = String(row[colSku] || "").trim();
            if (!den || !sku) continue;
            ins.run(den, sku, String(row[colLocal] || "").trim());
            results.sku++;
          }
        });
        tx();
      }
    }

    // ── 2. GT HL (sheet "GT HL") ──
    let wsGt = null;
    for (const sheetName of wb.SheetNames) {
      const sn = sheetName.toUpperCase();
      if (sn.includes("GT") && sn.includes("HL")) {
        wsGt = wb.Sheets[sheetName];
        break;
      }
    }
    if (!wsGt) {
      for (const sheetName of wb.SheetNames) {
        if (sheetName.toUpperCase().includes("GT")) {
          wsGt = wb.Sheets[sheetName];
          break;
        }
      }
    }
    if (wsGt) {
      const gtRows = XLSX_LIB.utils.sheet_to_json(wsGt, { header: 1, defval: "" });
      if (gtRows && gtRows.length > 0) {
        const allHeaders = {};
        for (let r = 0; r < Math.min(3, gtRows.length); r++) {
          const row = gtRows[r];
          row.forEach((val, col) => {
            if (val) allHeaders[String(val).trim().toUpperCase()] = col;
          });
        }
        const isDualTable = allHeaders["MAPARE SKU URSUS"] !== undefined || allHeaders["PREMIUM"] !== undefined || allHeaders["SKU NAME CF FVS"] !== undefined;
        let priceData = {}, classData = {};

        if (isDualTable) {
          const colSkuLeft = 1;
          let colGtNew = 3;
          const row1 = gtRows[1] || [];
          row1.forEach((val, col) => {
            const v = String(val || "").toUpperCase();
            if (v.includes("NOU") && v.includes("GT/HL")) colGtNew = col;
          });
          const colSkuRight = allHeaders["MAPARE SKU URSUS"] !== undefined ? allHeaders["MAPARE SKU URSUS"] : 4;
          const colBrand = allHeaders["BRAND"] !== undefined ? allHeaders["BRAND"] : 5;
          const colPack = allHeaders["IMPACHETARE"] !== undefined ? allHeaders["IMPACHETARE"] : 6;
          const colGrupa = allHeaders["PREMIUM"] !== undefined ? allHeaders["PREMIUM"] : 7;

          for (let i = 2; i < gtRows.length; i++) {
            const row = gtRows[i];
            const skuL = String(row[colSkuLeft] || "").trim();
            if (skuL && skuL !== "0" && !skuL.toUpperCase().includes("SKU")) {
              const gt = parseFloat(row[colGtNew]) || 0;
              if (gt > 0) priceData[skuL] = gt;
            }
            const skuR = String(row[colSkuRight] || "").trim();
            if (skuR && skuR !== "0" && !skuR.toUpperCase().includes("SKU") && !skuR.toUpperCase().includes("MAPARE")) {
              classData[skuR] = {
                brand: String(row[colBrand] || "").trim(),
                pack: String(row[colPack] || "").trim(),
                grupa: String(row[colGrupa] || "").trim()
              };
            }
          }
        } else {
          const colSku = allHeaders["SKU"] !== undefined ? allHeaders["SKU"] : (allHeaders["SKU_BB"] !== undefined ? allHeaders["SKU_BB"] : (allHeaders["SKU_BBSA"] !== undefined ? allHeaders["SKU_BBSA"] : 0));
          const colGt = allHeaders["GT/HL"] !== undefined ? allHeaders["GT/HL"] : (allHeaders["GT_HL"] !== undefined ? allHeaders["GT_HL"] : 1);
          const colBrand = allHeaders["BRAND"] !== undefined ? allHeaders["BRAND"] : 2;
          const colGrupa = allHeaders["GRUPA OBIECTIV"] !== undefined ? allHeaders["GRUPA OBIECTIV"] : (allHeaders["GRUPA_OBIECTIV"] !== undefined ? allHeaders["GRUPA_OBIECTIV"] : (allHeaders["PREMIUM"] !== undefined ? allHeaders["PREMIUM"] : 3));
          const colPack = allHeaders["IMPACHETARE"] !== undefined ? allHeaders["IMPACHETARE"] : 4;
          for (let i = 1; i < gtRows.length; i++) {
            const row = gtRows[i];
            const sku = String(row[colSku] || "").trim();
            if (!sku || sku === "0") continue;
            priceData[sku] = parseFloat(row[colGt]) || 0;
            classData[sku] = {
              brand: String(row[colBrand] || "").trim(),
              pack: String(row[colPack] || "").trim(),
              grupa: String(row[colGrupa] || "").trim()
            };
          }
        }

        const allSkus = new Set([...Object.keys(priceData), ...Object.keys(classData)]);
        const ins = db.prepare("INSERT OR REPLACE INTO gt_prices (sku_bb, gt_hl, brand, grupa_obiectiv, impachetare) VALUES (?,?,?,?,?)");
        const tx = db.transaction(() => {
          db.prepare("DELETE FROM gt_prices").run();
          for (const sku of allSkus) {
            if (!sku || sku === "0") continue;
            const gt = priceData[sku] || 0;
            const cls = classData[sku] || { brand: "", pack: "", grupa: "" };
            ins.run(sku, gt, cls.brand, cls.grupa, cls.pack);
            results.prices++;
          }
        });
        tx();
      }
    }

    // ── 3. CENTRALIZATOR REALIZAT (sheet "centralizator realizat") ──
    let wsCentr = null;
    for (const sheetName of wb.SheetNames) {
      if (sheetName.toLowerCase().includes("centralizator")) {
        wsCentr = wb.Sheets[sheetName];
        break;
      }
    }
    if (wsCentr) {
      const centrRows = XLSX_LIB.utils.sheet_to_json(wsCentr, { header: 1, defval: "" });
      if (centrRows && centrRows.length > 0) {
        const insTarget = db.prepare("INSERT OR REPLACE INTO gt_targets (month, agent_name, target_core, target_abi, target_total) VALUES (?,?,?,?,?)");
        const insSales = db.prepare(`UPDATE sales_data SET gt_core_total=?, gt_abi_total=?, gt_other_total=?, gt_grand_total=? WHERE month=? AND agent_name=?`);

        const tx = db.transaction(() => {
          db.prepare("DELETE FROM gt_targets WHERE month=?").run(month);
          for (let i = 2; i < centrRows.length; i++) {
            const row = centrRows[i];
            const agent = String(row[0] || "").trim();
            if (!agent || agent.toUpperCase() === "GRAND TOTAL" || agent.toUpperCase() === "TOTAL") continue;

            const tCore = parseFloat(row[1]) || 0;
            const tAbi = parseFloat(row[2]) || 0;
            const tTotal = parseFloat(row[3]) || 0;
            const rCore = parseFloat(row[4]) || 0;
            const rAbi = parseFloat(row[5]) || 0;
            const rTotal = parseFloat(row[6]) || 0;

            insTarget.run(month, agent, Math.round(tCore * 100) / 100, Math.round(tAbi * 100) / 100, Math.round(tTotal * 100) / 100);
            results.targets++;

            const otherGt = Math.round((rTotal - rCore - rAbi) * 100) / 100;
            const updated = insSales.run(Math.round(rCore * 100) / 100, Math.round(rAbi * 100) / 100, otherGt > 0 ? otherGt : 0, Math.round(rTotal * 100) / 100, month, agent);
            if (updated.changes > 0) results.sales_updated++;
            else {
              const salesAgent = db.prepare("SELECT agent_name FROM sales_data WHERE month=? AND (agent_name LIKE ? OR agent_report_name LIKE ?) LIMIT 1")
                .get(month, `%${agent.split(" ")[0]}%`, `%${agent.split(" ")[0]}%`);
              if (salesAgent) {
                insSales.run(Math.round(rCore * 100) / 100, Math.round(rAbi * 100) / 100, otherGt > 0 ? otherGt : 0, Math.round(rTotal * 100) / 100, month, salesAgent.agent_name);
                results.sales_updated++;
              }
            }
          }
        });
        tx();
      }
    }

    // Summary of sheets found
    const sheetsFound = [];
    if (wsSku) sheetsFound.push(`Mapare SKU (${results.sku} rânduri)`);
    if (wsGt) sheetsFound.push(`GT HL (${results.prices} prețuri)`);
    if (wsCentr) sheetsFound.push(`Centralizator (${results.targets} targeturi, ${results.sales_updated} vânzări actualizate)`);

    console.log(`[GT upload-all] Processed: ${sheetsFound.join(", ")}`);
    res.json({ ok: true, ...results, sheets_found: sheetsFound });
  } catch (err) {
    console.error("GT upload-all error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

app.post("/api/gt/upload-sku-mapping", auth, adminOnly, gtUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  try {

    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("Sheet-ul lipsește");

    const rows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!rows || rows.length === 0) throw new Error("Fișierul nu conține date");

    const headers = {};
    const firstRow = rows[0];
    firstRow.forEach((val, idx) => {
      if (val) headers[String(val).trim().toUpperCase()] = idx;
    });

    // Support multiple header formats
    const colDen = headers["NUMEINTERNEDTR"] !== undefined ? headers["NUMEINTERNEDTR"] : (headers["NUMEINTERN_DTR"] !== undefined ? headers["NUMEINTERN_DTR"] : (headers["NUMEINTERNDTR"] !== undefined ? headers["NUMEINTERNDTR"] : (headers["DENUMIRE"] !== undefined ? headers["DENUMIRE"] : (headers["DENUMIRE_DTR"] !== undefined ? headers["DENUMIRE_DTR"] : 0))));
    const colSku = headers["SKU_BBSA"] !== undefined ? headers["SKU_BBSA"] : (headers["SKU_BB"] !== undefined ? headers["SKU_BB"] : (headers["SKU"] !== undefined ? headers["SKU"] : 1));
    const colLocal = headers["SKU NAME LOCAL"] !== undefined ? headers["SKU NAME LOCAL"] : (headers["SKU_LOCAL"] !== undefined ? headers["SKU_LOCAL"] : (headers["SKUNAMELOCAL"] !== undefined ? headers["SKUNAMELOCAL"] : 2));

    const ins = db.prepare("INSERT OR REPLACE INTO sku_mapping (denumire_dtr, sku_bb, sku_local) VALUES (?,?,?)");
    let count = 0;
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM sku_mapping").run();
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const den = String(row[colDen] || "").trim();
        const sku = String(row[colSku] || "").trim();
        if (!den || !sku) continue;
        ins.run(den, sku, String(row[colLocal] || "").trim());
        count++;
      }
    });
    tx();
    res.json({ ok: true, count });
  } catch (err) {
    console.error("GT SKU mapping import error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── Upload GT Prices (prețuri GT/HL per SKU + clasificare grupă) ── */
app.post("/api/gt/upload-gt-prices", auth, adminOnly, gtUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  try {

    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("Sheet-ul lipsește");

    const rows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!rows || rows.length === 0) throw new Error("Fișierul nu conține date");

    const headers = {};
    const firstRow = rows[0];
    firstRow.forEach((val, idx) => {
      if (val) headers[String(val).trim().toUpperCase()] = idx;
    });

    // GT HL sheet has 2 side-by-side tables:
    // LEFT  (cols 1-4): SKU description | SKU Name cf FVS | old price | new price (GT/HL)
    // RIGHT (cols 5-8): Mapare SKU Ursus | Brand | Impachetare | Premium (grupa)
    // Detect structure by scanning headers
    const allHeaders = {};
    for (let r = 0; r < Math.min(3, rows.length); r++) {
      const row = rows[r];
      row.forEach((val, col) => {
        if (val) allHeaders[String(val).trim().toUpperCase()] = col;
      });
    }

    // Check if this is the known dual-table format
    const isDualTable = allHeaders["MAPARE SKU URSUS"] !== undefined || allHeaders["PREMIUM"] !== undefined || allHeaders["SKU NAME CF FVS"] !== undefined;

    let priceData = {}; // sku → { gt_hl }
    let classData = {}; // sku → { brand, grupa, pack }

    if (isDualTable) {
      // LEFT table: col 1 or 2 = SKU name, col 4 = new GT/HL price (col 3 = old price)
      const colSkuLeft = 1; // "SKU Name cf FVS" is the short standard name
      let colGtNew = 3;
      // Find the column with "NOU" in row 2
      const row1 = rows[1] || [];
      row1.forEach((val, col) => {
        const v = String(val || "").toUpperCase();
        if (v.includes("NOU") && v.includes("GT/HL")) colGtNew = col;
      });

      // RIGHT table: col 5 = SKU, col 6 = Brand, col 7 = Impachetare, col 8 = Premium
      const colSkuRight = allHeaders["MAPARE SKU URSUS"] !== undefined ? allHeaders["MAPARE SKU URSUS"] : 4;
      const colBrand = allHeaders["BRAND"] !== undefined ? allHeaders["BRAND"] : 5;
      const colPack = allHeaders["IMPACHETARE"] !== undefined ? allHeaders["IMPACHETARE"] : 6;
      const colGrupa = allHeaders["PREMIUM"] !== undefined ? allHeaders["PREMIUM"] : 7;

      // Read both tables
      for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        // Left table: prices
        const skuL = String(row[colSkuLeft] || "").trim();
        if (skuL && skuL !== "0" && !skuL.toUpperCase().includes("SKU")) {
          const gt = parseFloat(row[colGtNew]) || 0;
          if (gt > 0) priceData[skuL] = gt;
        }
        // Right table: classification
        const skuR = String(row[colSkuRight] || "").trim();
        if (skuR && skuR !== "0" && !skuR.toUpperCase().includes("SKU") && !skuR.toUpperCase().includes("MAPARE")) {
          classData[skuR] = {
            brand: String(row[colBrand] || "").trim(),
            pack: String(row[colPack] || "").trim(),
            grupa: String(row[colGrupa] || "").trim()
          };
        }
      }
    } else {
      // Simple single-table format (user-created file with standard headers)
      const colSku = allHeaders["SKU"] !== undefined ? allHeaders["SKU"] : (allHeaders["SKU_BB"] !== undefined ? allHeaders["SKU_BB"] : (allHeaders["SKU_BBSA"] !== undefined ? allHeaders["SKU_BBSA"] : 0));
      const colGt = allHeaders["GT/HL"] !== undefined ? allHeaders["GT/HL"] : (allHeaders["GT_HL"] !== undefined ? allHeaders["GT_HL"] : 1);
      const colBrand = allHeaders["BRAND"] !== undefined ? allHeaders["BRAND"] : 2;
      const colGrupa = allHeaders["GRUPA OBIECTIV"] !== undefined ? allHeaders["GRUPA OBIECTIV"] : (allHeaders["GRUPA_OBIECTIV"] !== undefined ? allHeaders["GRUPA_OBIECTIV"] : (allHeaders["PREMIUM"] !== undefined ? allHeaders["PREMIUM"] : 3));
      const colPack = allHeaders["IMPACHETARE"] !== undefined ? allHeaders["IMPACHETARE"] : 4;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const sku = String(row[colSku] || "").trim();
        if (!sku || sku === "0") continue;
        priceData[sku] = parseFloat(row[colGt]) || 0;
        classData[sku] = {
          brand: String(row[colBrand] || "").trim(),
          pack: String(row[colPack] || "").trim(),
          grupa: String(row[colGrupa] || "").trim()
        };
      }
    }

    // Merge both tables by SKU name and insert into DB
    const allSkus = new Set([...Object.keys(priceData), ...Object.keys(classData)]);
    const ins = db.prepare("INSERT OR REPLACE INTO gt_prices (sku_bb, gt_hl, brand, grupa_obiectiv, impachetare) VALUES (?,?,?,?,?)");
    let count = 0;
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM gt_prices").run();
      for (const sku of allSkus) {
        if (!sku || sku === "0") continue;
        const gt = priceData[sku] || 0;
        const cls = classData[sku] || { brand: "", pack: "", grupa: "" };
        ins.run(sku, gt, cls.brand, cls.grupa, cls.pack);
        count++;
      }
    });
    tx();
    console.log(`[GT prices] Imported ${count} SKUs (${Object.keys(priceData).length} with prices, ${Object.keys(classData).length} with classification)`);
    res.json({ ok: true, count });
  } catch (err) {
    console.error("GT prices import error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── Upload GT Targets (targeturi GT lunare pe agenți) ── */
app.post("/api/gt/upload-targets", auth, adminOnly, gtUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  const month = req.body.month;
  if (!month || !validateMonthFormat(month)) return res.status(400).json({ error: "Format lună invalid (ex: 2026-02)" });
  try {

    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("Sheet-ul lipsește");

    const rows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!rows || rows.length === 0) throw new Error("Fișierul nu conține date");

    const headers = {};
    const firstRow = rows[0];
    firstRow.forEach((val, idx) => {
      if (val) headers[String(val).trim().toUpperCase()] = idx;
    });

    const colAgent = headers["AGENT"] !== undefined ? headers["AGENT"] : (headers["AGENT NAME"] !== undefined ? headers["AGENT NAME"] : 0);
    const colCore = headers["TARGET CORE"] !== undefined ? headers["TARGET CORE"] : (headers["CORE"] !== undefined ? headers["CORE"] : (headers["TARGET_CORE"] !== undefined ? headers["TARGET_CORE"] : (headers["CORE SEGMENT"] !== undefined ? headers["CORE SEGMENT"] : 1)));
    const colAbi = headers["TARGET ABI"] !== undefined ? headers["TARGET ABI"] : (headers["ABI"] !== undefined ? headers["ABI"] : (headers["TARGET_ABI"] !== undefined ? headers["TARGET_ABI"] : 2));
    const colTotal = headers["TARGET TOTAL"] !== undefined ? headers["TARGET TOTAL"] : (headers["TOTAL"] !== undefined ? headers["TOTAL"] : (headers["TARGET_TOTAL"] !== undefined ? headers["TARGET_TOTAL"] : 3));

    const ins = db.prepare("INSERT OR REPLACE INTO gt_targets (month, agent_name, target_core, target_abi, target_total) VALUES (?,?,?,?,?)");
    let count = 0;
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM gt_targets WHERE month=?").run(month);
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const agent = String(row[colAgent] || "").trim();
        if (!agent) continue;
        const core = parseFloat(row[colCore]) || 0;
        const abi = parseFloat(row[colAbi]) || 0;
        let total = parseFloat(row[colTotal]) || 0;
        if (!total) total = core + abi;
        ins.run(month, agent, core, abi, total);
        count++;
      }
    });
    tx();
    res.json({ ok: true, count, month });
  } catch (err) {
    console.error("GT targets import error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── GT Centralizator (target vs realizat per agent) ── */
app.get("/api/gt/centralizator", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    /* gt_targets now holds both targets AND realizat (from centralizator import) */
    const rows = db.prepare("SELECT agent_name, target_core, target_abi, target_total, real_core, real_abi, real_total FROM gt_targets WHERE month=?").all(month);

    /* Also check sales_data for GT calculated from daily sales import */
    const sales = db.prepare("SELECT agent_name, gt_core_total, gt_abi_total, gt_other_total, gt_grand_total FROM sales_data WHERE month=?").all(month);
    const salesMap = {};
    for (const s of sales) salesMap[s.agent_name] = s;

    const agents = [];
    // Merge by fuzzy normalized name to avoid duplicates (double-spaces, MIHAIL↔MIHAI, etc.)
    function fuzzyNorm(n) {
      return normalizeAgentName(n).split(" ").map(p => p.substring(0, 4)).join(" ");
    }
    const normMerge = {};
    for (const r of rows) {
      const key = fuzzyNorm(r.agent_name);
      if (!normMerge[key]) normMerge[key] = { target: null, sale: null, displayName: r.agent_name };
      normMerge[key].target = r;
    }
    for (const s of sales) {
      const key = fuzzyNorm(s.agent_name);
      if (!normMerge[key]) normMerge[key] = { target: null, sale: null, displayName: s.agent_name };
      normMerge[key].sale = s;
    }
    for (const [norm, entry] of Object.entries(normMerge)) {
      const name = entry.displayName;
      const t = entry.target || { target_core: 0, target_abi: 0, target_total: 0, real_core: 0, real_abi: 0, real_total: 0 };
      const s = entry.sale || { gt_core_total: 0, gt_abi_total: 0, gt_other_total: 0, gt_grand_total: 0 };

      /* Use centralizator realizat if available, otherwise use sales_data GT */
      const rCore = (t.real_core || 0) > 0 ? t.real_core : (s.gt_core_total || 0);
      const rAbi = (t.real_abi || 0) > 0 ? t.real_abi : (s.gt_abi_total || 0);
      const rTotal = (t.real_total || 0) > 0 ? t.real_total : (s.gt_grand_total || 0);
      const rOther = Math.max(rTotal - rCore - rAbi, 0);

      const tOther = Math.max((t.target_total || 0) - (t.target_core || 0) - (t.target_abi || 0), 0);
      agents.push({
        agent: name,
        target_core: t.target_core || 0,
        target_abi: t.target_abi || 0,
        target_other: Math.round(tOther * 100) / 100,
        target_total: t.target_total || 0,
        real_core: Math.round(rCore * 100) / 100,
        real_abi: Math.round(rAbi * 100) / 100,
        real_other: Math.round(rOther * 100) / 100,
        real_total: Math.round(rTotal * 100) / 100,
        pct_core: t.target_core ? Math.round(rCore / t.target_core * 10000) / 100 : 0,
        pct_abi: t.target_abi ? Math.round(rAbi / t.target_abi * 10000) / 100 : 0,
        pct_other: tOther ? Math.round(rOther / tOther * 10000) / 100 : 0,
        pct_total: t.target_total ? Math.round(rTotal / t.target_total * 10000) / 100 : 0
      });
    }
    agents.sort((a, b) => a.agent.localeCompare(b.agent));

    // Role-based filtering (same as sales-all dashboard)
    const FULL_ACCESS_USERS = ["admin", "gmqgd", "robqgd", "mihqgd"];
    if (!FULL_ACCESS_USERS.includes(req.username)) {
      if (req.role === "agent" && req.agentDtr) {
        const agentUpper = req.agentDtr.toUpperCase();
        agents = agents.filter(a => a.agent.toUpperCase().includes(agentUpper));
      } else if (req.role === "spv" && req.division) {
        const divAgents = db.prepare("SELECT sales_rep FROM users WHERE division=? AND role='agent' AND sales_rep != ''").all(req.division);
        const divSet = new Set(divAgents.map(d => normalizeAgentName(d.sales_rep)));
        agents = agents.filter(a => divSet.has(normalizeAgentName(a.agent)));
      }
    }

    const totals = {
      target_core: agents.reduce((s, a) => s + a.target_core, 0),
      target_abi: agents.reduce((s, a) => s + a.target_abi, 0),
      target_other: agents.reduce((s, a) => s + a.target_other, 0),
      target_total: agents.reduce((s, a) => s + a.target_total, 0),
      real_core: agents.reduce((s, a) => s + a.real_core, 0),
      real_abi: agents.reduce((s, a) => s + a.real_abi, 0),
      real_other: agents.reduce((s, a) => s + a.real_other, 0),
      real_total: agents.reduce((s, a) => s + a.real_total, 0)
    };
    totals.pct_core = totals.target_core ? Math.round(totals.real_core / totals.target_core * 10000) / 100 : 0;
    totals.pct_abi = totals.target_abi ? Math.round(totals.real_abi / totals.target_abi * 10000) / 100 : 0;
    totals.pct_other = totals.target_other ? Math.round(totals.real_other / totals.target_other * 10000) / 100 : 0;
    totals.pct_total = totals.target_total ? Math.round(totals.real_total / totals.target_total * 10000) / 100 : 0;

    const skuCount = db.prepare("SELECT COUNT(*) as cnt FROM sku_mapping").get().cnt;
    const priceCount = db.prepare("SELECT COUNT(*) as cnt FROM gt_prices").get().cnt;

    res.json({ ok: true, month, agents, totals, config: { sku_mapping: skuCount, gt_prices: priceCount } });
  } catch (err) {
    console.error("GT centralizator error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── GT Unmatched products (produse din vânzări fără mapare SKU) ── */
app.get("/api/gt/unmatched", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    // Get all distinct product names from client_deliveries for this month
    const deliveries = db.prepare("SELECT DISTINCT denumire FROM client_deliveries WHERE month=?").all(month);
    const unmatched = [];
    for (const d of deliveries) {
      const den = d.denumire;
      // Check exact match (case insensitive)
      const exact = db.prepare("SELECT sku_bb FROM sku_mapping WHERE denumire_dtr=? COLLATE NOCASE").get(den);
      if (!exact) {
        // Check partial match (product name contained in mapping)
        const partial = db.prepare("SELECT sku_bb, denumire_dtr FROM sku_mapping WHERE ? LIKE '%' || denumire_dtr || '%' COLLATE NOCASE OR denumire_dtr LIKE '%' || ? || '%' COLLATE NOCASE LIMIT 1").get(den, den);
        if (!partial) {
          unmatched.push(den);
        }
      }
    }
    res.json({ ok: true, month, unmatched, count: unmatched.length });
  } catch (err) {
    console.error("GT unmatched error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ══════════ GT TEMPLATES: Download pre-filled Excel templates ══════════ */

/* ── Template 1: Mapare SKU + Prețuri GT/HL ── */
app.get("/api/gt/template-mapare", auth, adminOnly, (req, res) => {
  try {
    const data = [["DENUMIRE_DTR", "SKU_BB", "GT/HL (lei)", "GRUPA OBIECTIV", "BRAND", "IMPACHETARE"]];

    const mappings = db.prepare("SELECT denumire_dtr, sku_bb, sku_local FROM sku_mapping ORDER BY denumire_dtr").all();
    const prices = db.prepare("SELECT sku_bb, gt_hl, brand, grupa_obiectiv, impachetare FROM gt_prices").all();
    const priceMap = {};
    for (const p of prices) priceMap[p.sku_bb] = p;

    if (mappings.length > 0) {
      for (const m of mappings) {
        const p = priceMap[m.sku_bb] || {};
        data.push([m.denumire_dtr, m.sku_bb, p.gt_hl || 0, p.grupa_obiectiv || "", p.brand || "", p.impachetare || ""]);
      }
    } else {
      data.push(["Exemplu: Ursus Sticla 0.5L", "BERG 0.5L BTL", 25.5, "Core Segment", "Ursus", "Sticla"]);
      data.push(["Exemplu: Lowenbrau Doza 0.5L", "LOW 0.5L CAN", 30.0, "ABI", "Lowenbrau", "Doza"]);
    }

    const instrData = [
      ["INSTRUCȚIUNI COMPLETARE TEMPLATE MAPARE + PREȚURI GT"],
      [""],
      ["Coloane obligatorii:"],
      ["  DENUMIRE_DTR = Denumirea produsului exact cum apare în raportul de vânzări QGD"],
      ["  SKU_BB = Codul SKU Ursus corespunzător"],
      ["  GT/HL (lei) = Prețul Gross Turnover per hectolitru"],
      ["  GRUPA OBIECTIV = 'Core Segment' sau 'ABI' (dacă e gol, produsul intră la 'Altele')"],
      [""],
      ["Coloane opționale:"],
      ["  BRAND = Marca produsului"],
      ["  IMPACHETARE = Tipul ambalajului (sticlă, doză, PET etc.)"],
      [""],
      ["După completare, încarcă acest fișier în secțiunea BUGET GT → Import Mapare + Prețuri"]
    ];

    const wb = XLSX_LIB.utils.book_new();
    const ws = XLSX_LIB.utils.aoa_to_sheet(data);
    ws["!cols"] = [{ wch: 35 }, { wch: 30 }, { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 20 }];
    XLSX_LIB.utils.book_append_sheet(wb, ws, "Mapare + Prețuri GT");

    const wsInfo = XLSX_LIB.utils.aoa_to_sheet(instrData);
    wsInfo["!cols"] = [{ wch: 80 }];
    XLSX_LIB.utils.book_append_sheet(wb, wsInfo, "INSTRUCȚIUNI");

    const buf = XLSX_LIB.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="Template_Mapare_Preturi_GT.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("GT template mapare error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── Template 2: Targeturi GT lunare ── */
app.get("/api/gt/template-targeturi", auth, adminOnly, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    const data = [
      ["AGENT", "Target", "", "", "Realizat", "", ""],
      ["", "Core Segment", "ABI", "Total SO", "Core Segment", "ABI", "Total SO"]
    ];

    const existingTargets = db.prepare("SELECT agent_name, target_core, target_abi, target_total FROM gt_targets WHERE month=? ORDER BY agent_name").all(month);
    const salesData = db.prepare("SELECT agent_name, gt_core_total, gt_abi_total, gt_grand_total FROM sales_data WHERE month=? ORDER BY agent_name").all(month);
    const salesMap = {};
    for (const s of salesData) salesMap[s.agent_name] = s;

    const rows = [];
    if (existingTargets.length > 0) {
      for (const t of existingTargets) {
        const s = salesMap[t.agent_name] || {};
        rows.push([t.agent_name, t.target_core, t.target_abi, t.target_total,
          s.gt_core_total || 0, s.gt_abi_total || 0, s.gt_grand_total || 0]);
      }
    } else {
      const agents = db.prepare("SELECT DISTINCT sales_rep FROM users WHERE role='agent' AND sales_rep IS NOT NULL AND sales_rep != '' ORDER BY sales_rep").all();
      for (const a of agents) {
        const s = salesMap[a.sales_rep] || {};
        rows.push([a.sales_rep, 0, 0, 0, s.gt_core_total || 0, s.gt_abi_total || 0, s.gt_grand_total || 0]);
      }
    }
    data.push(...rows);

    // Add TOTAL row with SUM formulas
    const lastRow = data.length;
    const totalRow = ["TOTAL"];
    for (let c = 1; c <= 6; c++) {
      const colLetter = String.fromCharCode(65 + c); // B,C,D,E,F,G
      totalRow.push({ f: `SUM(${colLetter}3:${colLetter}${lastRow})` });
    }
    data.push(totalRow);

    const instrData = [
      ["INSTRUCȚIUNI COMPLETARE TARGETURI GT - " + month],
      [""],
      ["Completează coloanele Target (B, C, D) cu valorile GT target pentru fiecare agent."],
      ["Coloanele Realizat (E, F, G) sunt pre-completate din datele existente (informativ)."],
      ["Total SO trebuie să fie >= Core Segment + ABI (diferența = Altele)."],
      [""],
      ["După completare, încarcă acest fișier în secțiunea BUGET GT → Import Targeturi"]
    ];

    const wb = XLSX_LIB.utils.book_new();
    const ws = XLSX_LIB.utils.aoa_to_sheet(data);
    ws["!cols"] = [{ wch: 35 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
    ws["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }, // A1:A2
      { s: { r: 0, c: 1 }, e: { r: 0, c: 3 } }, // B1:D1
      { s: { r: 0, c: 4 }, e: { r: 0, c: 6 } }  // E1:G1
    ];
    XLSX_LIB.utils.book_append_sheet(wb, ws, "Targeturi GT " + month);

    const wsInfo = XLSX_LIB.utils.aoa_to_sheet(instrData);
    wsInfo["!cols"] = [{ wch: 80 }];
    XLSX_LIB.utils.book_append_sheet(wb, wsInfo, "INSTRUCȚIUNI");

    const buf = XLSX_LIB.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Template_Targeturi_GT_${month}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("GT template targeturi error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── Upload simplified Mapare + Prețuri template ── */
app.post("/api/gt/upload-mapare-preturi", auth, adminOnly, gtUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  try {
    const wb = XLSX_LIB.readFile(req.file.path);
    const sheetNames = wb.SheetNames.map(n => n.toLowerCase());

    /* ── 1. Citește sheet "Mapare SKU": NumeInternDTR → SKU_BBSA → SKU Name Local ── */
    const mapIdx = sheetNames.findIndex(n => n.includes("mapare"));
    if (mapIdx < 0) throw new Error("Nu găsesc sheet-ul 'Mapare SKU' în fișier. Sheet-uri disponibile: " + wb.SheetNames.join(", "));
    const wsMap = wb.Sheets[wb.SheetNames[mapIdx]];
    const mapRows = XLSX_LIB.utils.sheet_to_json(wsMap, { header: 1, defval: "" });

    /* ── 2. Citește sheet "GT HL": prețuri GT/HL + brand/grupă ── */
    const gtIdx = sheetNames.findIndex(n => n.includes("gt") && n.includes("hl"));
    if (gtIdx < 0) throw new Error("Nu găsesc sheet-ul 'GT HL' în fișier. Sheet-uri disponibile: " + wb.SheetNames.join(", "));
    const wsGt = wb.Sheets[wb.SheetNames[gtIdx]];
    const gtRows = XLSX_LIB.utils.sheet_to_json(wsGt, { header: 1, defval: "" });

    /* ── 3. Parsează prețurile GT/HL din coloana stângă (col A-D) ── */
    // Row 0: header, Row 1: sub-header cu "GT/HL pret de lista vechi/nou"
    // Row 2+: SKU Name (col B=1), GT/HL nou (col D=3)
    const priceMap = {};
    for (let i = 2; i < gtRows.length; i++) {
      const skuName = String(gtRows[i][1] || "").trim(); // col B = SKU Name cf FVS
      const gtNew = parseFloat(gtRows[i][3]) || 0;       // col D = GT/HL pret de lista nou
      if (skuName && gtNew > 0) priceMap[skuName] = gtNew;
    }

    /* ── 4. Parsează brand/grupă din coloana dreaptă (col E-H) ── */
    // Col E(4)=Mapare SKU Ursus, F(5)=Brand, G(6)=Impachetare, H(7)=Grupa (ABI/Core Segment)
    const brandMap = {};
    for (let i = 2; i < gtRows.length; i++) {
      const skuBB = String(gtRows[i][4] || "").trim();
      const brand = String(gtRows[i][5] || "").trim();
      const pack = String(gtRows[i][6] || "").trim();
      const grupa = String(gtRows[i][7] || "").trim();
      if (skuBB && (brand || grupa)) brandMap[skuBB] = { brand, pack, grupa };
    }

    const insSku = db.prepare("INSERT OR REPLACE INTO sku_mapping (denumire_dtr, sku_bb, sku_local) VALUES (?,?,?)");
    const insPrice = db.prepare("INSERT OR REPLACE INTO gt_prices (sku_bb, gt_hl, brand, grupa_obiectiv, impachetare) VALUES (?,?,?,?,?)");

    let countSku = 0, countPrices = 0;
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM sku_mapping").run();
      db.prepare("DELETE FROM gt_prices").run();

      /* Inserează mapare SKU: row 0=header, data starts at row 1 */
      for (let i = 1; i < mapRows.length; i++) {
        const den = String(mapRows[i][0] || "").trim();  // NumeInternDTR
        const skuBB = String(mapRows[i][1] || "").trim(); // SKU_BBSA
        if (!den || !skuBB) continue;
        insSku.run(den, skuBB, String(mapRows[i][2] || "").trim());
        countSku++;
      }

      /* Inserează prețuri GT: combinăm priceMap (preț) cu brandMap (brand/grupă) */
      const allSkus = new Set([...Object.keys(priceMap), ...Object.keys(brandMap)]);
      for (const sku of allSkus) {
        const gt = priceMap[sku] || 0;
        const info = brandMap[sku] || { brand: "", pack: "", grupa: "" };
        insPrice.run(sku, gt, info.brand, info.grupa, info.pack);
        countPrices++;
      }
    });
    tx();

    /* ── 5. Dacă fișierul conține și "centralizator realizat", importă Target+Realizat ── */
    let countCentralizator = 0;
    const centIdx = sheetNames.findIndex(n => n.includes("centralizator"));
    if (centIdx >= 0) {
      const month = req.body.month || new Date().toISOString().slice(0, 7);
      const wsCent = wb.Sheets[wb.SheetNames[centIdx]];
      const centRows = XLSX_LIB.utils.sheet_to_json(wsCent, { header: 1, defval: "" });
      const insTarget = db.prepare("INSERT OR REPLACE INTO gt_targets (month, agent_name, target_core, target_abi, target_total, real_core, real_abi, real_total) VALUES (?,?,?,?,?,?,?,?)");
      const txCent = db.transaction(() => {
        db.prepare("DELETE FROM gt_targets WHERE month=?").run(month);
        for (let i = 2; i < centRows.length; i++) {
          const agent = String(centRows[i][0] || "").trim();
          if (!agent || agent.toUpperCase() === "GRAND TOTAL" || agent.toUpperCase() === "TOTAL" || agent.toUpperCase() === "TRIM") continue;
          const tCore = parseFloat(centRows[i][1]) || 0;
          const tAbi = parseFloat(centRows[i][2]) || 0;
          const tTotal = parseFloat(centRows[i][3]) || 0;
          const rCore = parseFloat(centRows[i][4]) || 0;
          const rAbi = parseFloat(centRows[i][5]) || 0;
          const rTotal = parseFloat(centRows[i][6]) || 0;
          insTarget.run(month, agent,
            Math.round(tCore * 100) / 100, Math.round(tAbi * 100) / 100, Math.round(tTotal * 100) / 100,
            Math.round(rCore * 100) / 100, Math.round(rAbi * 100) / 100, Math.round(rTotal * 100) / 100);
          countCentralizator++;
        }
      });
      txCent();
    }

    res.json({ ok: true, sku_count: countSku, prices_count: countPrices, centralizator_count: countCentralizator });
  } catch (err) {
    console.error("GT mapare-preturi upload error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── Upload simplified Targeturi template ── */
app.post("/api/gt/upload-targeturi", auth, adminOnly, gtUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  const month = req.body.month;
  if (!month || !validateMonthFormat(month)) return res.status(400).json({ error: "Format lună invalid (ex: 2026-02)" });
  try {
    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("Sheet-ul lipsește");

    // Read as array of arrays (header has 2 rows, data starts at row 3 = index 2)
    const allRows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });

    const insTarget = db.prepare("INSERT OR REPLACE INTO gt_targets (month, agent_name, target_core, target_abi, target_total) VALUES (?,?,?,?,?)");
    let count = 0;

    const tx = db.transaction(() => {
      db.prepare("DELETE FROM gt_targets WHERE month=?").run(month);
      for (let i = 2; i < allRows.length; i++) { // skip 2-row header
        const row = allRows[i];
        const agent = String(row[0] || "").trim();
        if (!agent || agent.toUpperCase() === "TOTAL" || agent.toUpperCase() === "GRAND TOTAL") continue;

        const tCore = parseFloat(row[1]) || 0;
        const tAbi = parseFloat(row[2]) || 0;
        const tTotal = parseFloat(row[3]) || 0;

        insTarget.run(month, agent, Math.round(tCore * 100) / 100, Math.round(tAbi * 100) / 100, Math.round(tTotal * 100) / 100);
        count++;
      }
    });
    tx();

    res.json({ ok: true, month, count });
  } catch (err) {
    console.error("GT targeturi upload error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── GT Config status ── */
/* ── Export GT Report to Excel (Professional format with formatting + charts) ── */
app.get("/api/gt/export-excel", auth, async (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    const ExcelJS = require("exceljs");

    // ── Data preparation (same as before with fuzzy matching) ──
    const targets = db.prepare("SELECT agent_name, target_core, target_abi, target_total FROM gt_targets WHERE month=?").all(month);
    const salesRows = db.prepare("SELECT agent_name, gt_core_total, gt_abi_total, gt_other_total, gt_grand_total FROM sales_data WHERE month=?").all(month);
    function _fk(n) { return normalizeAgentName(n).split(" ").map(p => p.substring(0, 4)).join(" "); }
    const salesMap = {};
    for (const s of salesRows) { salesMap[normalizeAgentName(s.agent_name)] = s; salesMap[_fk(s.agent_name)] = s; }
    const normMap = {};
    for (const t of targets) {
      const key = _fk(t.agent_name);
      if (!normMap[key]) normMap[key] = { target: null, sale: null, displayName: t.agent_name };
      normMap[key].target = t;
    }
    for (const s of salesRows) {
      const key = _fk(s.agent_name);
      if (!normMap[key]) normMap[key] = { target: null, sale: null, displayName: s.agent_name };
      normMap[key].sale = s;
    }
    const agents = [];
    for (const entry of Object.values(normMap)) {
      const t = entry.target || { target_core: 0, target_abi: 0, target_total: 0, agent_name: entry.displayName };
      const s = entry.sale || { gt_core_total: 0, gt_abi_total: 0, gt_other_total: 0, gt_grand_total: 0 };
      const tOther = Math.max(t.target_total - t.target_core - t.target_abi, 0);
      agents.push({
        agent: entry.displayName || t.agent_name,
        tc: t.target_core, ta: t.target_abi, to: Math.round(tOther * 100) / 100, tt: t.target_total,
        rc: Math.round(s.gt_core_total * 100) / 100, ra: Math.round(s.gt_abi_total * 100) / 100,
        ro: Math.round(s.gt_other_total * 100) / 100, rt: Math.round(s.gt_grand_total * 100) / 100,
        pc: t.target_core ? s.gt_core_total / t.target_core : 0,
        pa: t.target_abi ? s.gt_abi_total / t.target_abi : 0,
        po: tOther ? s.gt_other_total / tOther : 0,
        pt: t.target_total ? s.gt_grand_total / t.target_total : 0
      });
    }
    agents.sort((a, b) => a.agent.localeCompare(b.agent));
    // Filter out agents with 0 target and negative realized
    const agentsFiltered = agents.filter(a => a.tt > 0 || a.rt > 0);

    const sums = agentsFiltered.reduce((s, a) => ({
      tc: s.tc + a.tc, ta: s.ta + a.ta, to: s.to + a.to, tt: s.tt + a.tt,
      rc: s.rc + a.rc, ra: s.ra + a.ra, ro: s.ro + a.ro, rt: s.rt + a.rt
    }), { tc: 0, ta: 0, to: 0, tt: 0, rc: 0, ra: 0, ro: 0, rt: 0 });

    const wb = new ExcelJS.Workbook();
    wb.creator = "QMaps Audit Ursus";
    wb.created = new Date();

    /* ── Color palette (green/gold theme for Ursus GT) ── */
    const CLR = {
      headerBg: "1A5276", headerFg: "FFFFFF",
      coreBg: "196F3D", coreFg: "FFFFFF",     // green for Core Segment
      abiBg: "B7950B", abiFg: "FFFFFF",       // gold for ABI
      otherBg: "6C3483", otherFg: "FFFFFF",   // purple for Others
      totalBg: "1A5276", totalFg: "FFFFFF",
      altRow: "EBF5FB",
      green: "27AE60", yellow: "F39C12", red: "E74C3C",
      borderColor: "BDC3C7"
    };
    const thinBorder = { style: "thin", color: { argb: CLR.borderColor } };
    const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };

    /* ══════════ SHEET 1: Centralizator GT ══════════ */
    const ws = wb.addWorksheet("Centralizator GT", { views: [{ state: "frozen", ySplit: 3 }] });

    // Title row
    ws.mergeCells("A1:M1");
    const titleCell = ws.getCell("A1");
    const [yy, mm] = month.split("-");
    const monthNames = ["", "Ianuarie", "Februarie", "Martie", "Aprilie", "Mai", "Iunie", "Iulie", "August", "Septembrie", "Octombrie", "Noiembrie", "Decembrie"];
    titleCell.value = `CENTRALIZATOR GT URSUS — ${monthNames[+mm]} ${yy}`;
    titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: CLR.headerBg } };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(1).height = 35;

    // Group headers row
    ws.getCell("A2").value = "";
    ws.getCell("A2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.headerBg } };
    ws.getCell("A2").border = allBorders;
    const groups = [
      { range: "B2:D2", label: "CORE SEGMENT", bg: CLR.coreBg, fg: CLR.coreFg },
      { range: "E2:G2", label: "ABI", bg: CLR.abiBg, fg: CLR.abiFg },
      { range: "H2:J2", label: "ALTELE", bg: CLR.otherBg, fg: CLR.otherFg },
      { range: "K2:M2", label: "TOTAL SO", bg: CLR.headerBg, fg: CLR.headerFg }
    ];
    for (const g of groups) {
      ws.mergeCells(g.range);
      const c = ws.getCell(g.range.split(":")[0]);
      c.value = g.label;
      c.font = { name: "Calibri", size: 11, bold: true, color: { argb: g.fg } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: g.bg } };
      c.alignment = { horizontal: "center", vertical: "middle" };
      c.border = allBorders;
    }
    ws.getRow(2).height = 22;

    // Column headers
    const headers = ["AGENT", "Target", "Realizat", "%", "Target", "Realizat", "%", "Target", "Realizat", "%", "Target", "Realizat", "%"];
    const headerRow = ws.getRow(3);
    const colGroupColors = [CLR.headerBg, CLR.coreBg, CLR.coreBg, CLR.coreBg, CLR.abiBg, CLR.abiBg, CLR.abiBg, CLR.otherBg, CLR.otherBg, CLR.otherBg, CLR.headerBg, CLR.headerBg, CLR.headerBg];
    headers.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colGroupColors[i] } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = allBorders;
    });
    headerRow.height = 22;

    // Data rows
    agentsFiltered.forEach((a, idx) => {
      const row = ws.getRow(idx + 4);
      row.values = [
        a.agent,
        Math.round(a.tc), Math.round(a.rc), a.pc,
        Math.round(a.ta), Math.round(a.ra), a.pa,
        Math.round(a.to), Math.round(a.ro), a.po,
        Math.round(a.tt), Math.round(a.rt), a.pt
      ];
      const bgColor = idx % 2 === 1 ? CLR.altRow : "FFFFFF";
      for (let c = 1; c <= 13; c++) {
        const cell = row.getCell(c);
        cell.font = { name: "Calibri", size: 10 };
        cell.border = allBorders;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
        if (c === 1) { cell.font = { name: "Calibri", size: 10, bold: true }; cell.alignment = { horizontal: "left" }; }
        else if (c === 4 || c === 7 || c === 10 || c === 13) {
          cell.numFmt = "0.0%";
          cell.alignment = { horizontal: "center" };
          const pct = cell.value || 0;
          if (pct >= 0.8) cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: CLR.green } };
          else if (pct >= 0.5) cell.font = { name: "Calibri", size: 10, color: { argb: CLR.yellow } };
          else cell.font = { name: "Calibri", size: 10, color: { argb: CLR.red } };
        } else {
          cell.numFmt = "#,##0";
          cell.alignment = { horizontal: "right" };
        }
      }
      row.height = 18;
    });

    // Total row
    const totalRowNum = agentsFiltered.length + 4;
    const totalRow = ws.getRow(totalRowNum);
    totalRow.values = [
      "TOTAL",
      Math.round(sums.tc), Math.round(sums.rc), sums.tc ? sums.rc / sums.tc : 0,
      Math.round(sums.ta), Math.round(sums.ra), sums.ta ? sums.ra / sums.ta : 0,
      Math.round(sums.to), Math.round(sums.ro), sums.to ? sums.ro / sums.to : 0,
      Math.round(sums.tt), Math.round(sums.rt), sums.tt ? sums.rt / sums.tt : 0
    ];
    for (let c = 1; c <= 13; c++) {
      const cell = totalRow.getCell(c);
      cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: CLR.totalFg } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.totalBg } };
      cell.border = allBorders;
      cell.alignment = { horizontal: c === 1 ? "left" : "center" };
      if (c === 4 || c === 7 || c === 10 || c === 13) cell.numFmt = "0.0%";
      else if (c > 1) cell.numFmt = "#,##0";
    }
    totalRow.height = 22;

    ws.columns = [
      { width: 32 }, { width: 12 }, { width: 14 }, { width: 10 },
      { width: 12 }, { width: 14 }, { width: 10 },
      { width: 12 }, { width: 14 }, { width: 10 },
      { width: 12 }, { width: 14 }, { width: 10 }
    ];

    // Data bars on % columns
    for (const col of ["D", "G", "J", "M"]) {
      ws.addConditionalFormatting({
        ref: `${col}4:${col}${totalRowNum - 1}`,
        rules: [{ type: "dataBar", minLength: 0, maxLength: 100, gradient: true,
          color: { argb: col === "D" ? CLR.coreBg : col === "G" ? CLR.abiBg : col === "J" ? CLR.otherBg : "2E86C1" },
          cfvo: [{ type: "num", value: 0 }, { type: "num", value: 1 }] }]
      });
    }

    /* ══════════ SHEET 2: % Realizare (with data bars) ══════════ */
    const cs = wb.addWorksheet("% Realizare", {});
    cs.getCell("A1").value = "Agent";
    cs.getCell("B1").value = "% Core";
    cs.getCell("C1").value = "% ABI";
    cs.getCell("D1").value = "% Altele";
    cs.getCell("E1").value = "% Total SO";
    for (let c = 1; c <= 5; c++) {
      const cell = cs.getRow(1).getCell(c);
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.headerBg } };
      cell.border = allBorders;
    }
    agentsFiltered.forEach((a, i) => {
      const row = cs.getRow(i + 2);
      row.values = [a.agent, Math.round(a.pc * 1000) / 10, Math.round(a.pa * 1000) / 10, Math.round(a.po * 1000) / 10, Math.round(a.pt * 1000) / 10];
      const bgColor = i % 2 === 1 ? CLR.altRow : "FFFFFF";
      for (let c = 1; c <= 5; c++) {
        const cell = row.getCell(c);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
        cell.border = allBorders;
        if (c > 1) {
          cell.numFmt = "0.0";
          const v = cell.value || 0;
          if (v >= 80) cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: CLR.green } };
          else if (v >= 50) cell.font = { name: "Calibri", size: 10, color: { argb: CLR.yellow } };
          else cell.font = { name: "Calibri", size: 10, color: { argb: CLR.red } };
        } else {
          cell.font = { name: "Calibri", size: 10, bold: true };
        }
      }
    });
    cs.columns = [{ width: 32 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
    for (const col of ["B", "C", "D", "E"]) {
      cs.addConditionalFormatting({
        ref: `${col}2:${col}${agentsFiltered.length + 1}`,
        rules: [{ type: "dataBar", minLength: 0, maxLength: 100, gradient: true,
          color: { argb: col === "B" ? CLR.coreBg : col === "C" ? CLR.abiBg : col === "D" ? CLR.otherBg : "2E86C1" },
          cfvo: [{ type: "num", value: 0 }, { type: "num", value: 100 }] }]
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Raport_GT_Ursus_${month}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("GT export error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── Export Obiective to Excel (Professional format with charts) ── */
app.get("/api/obiective/export-excel", auth, async (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    const ExcelJS = require("exceljs");

    const targets = db.prepare("SELECT * FROM sales_targets WHERE month=? ORDER BY agent_name").all(month);
    const sales = db.prepare("SELECT * FROM sales_data WHERE month=? ORDER BY agent_name").all(month);
    const salesMap = {};
    function _fk(n) { return normalizeAgentName(n).split(" ").map(p => p.substring(0, 4)).join(" "); }
    for (const s of sales) { salesMap[normalizeAgentName(s.agent_name)] = s; salesMap[_fk(s.agent_name)] = s; }

    const result = targets.map(t => {
      const s = salesMap[normalizeAgentName(t.agent_name)] || salesMap[_fk(t.agent_name)] || {};
      return {
        agent: t.agent_name,
        target_val: t.bb_total_val, realizat_val: s.total_valoare || 0,
        pct_val: t.bb_total_val > 0 ? (s.total_valoare || 0) / t.bb_total_val : 0,
        target_hl: t.bb_total_hl, realizat_hl: s.total_hl || 0,
        pct_hl: t.bb_total_hl > 0 ? (s.total_hl || 0) / t.bb_total_hl : 0,
        target_cl: t.clienti_2sku, realizat_cl: s.clienti_2sku || 0,
        pct_cl: t.clienti_2sku > 0 ? (s.clienti_2sku || 0) / t.clienti_2sku : 0
      };
    });

    const sums = result.reduce((s, a) => ({
      tv: s.tv + a.target_val, rv: s.rv + a.realizat_val,
      th: s.th + a.target_hl, rh: s.rh + a.realizat_hl,
      tc: s.tc + a.target_cl, rc: s.rc + a.realizat_cl
    }), { tv: 0, rv: 0, th: 0, rh: 0, tc: 0, rc: 0 });

    const wb = new ExcelJS.Workbook();
    wb.creator = "QMaps Audit Ursus";
    wb.created = new Date();

    /* ── Color palette ── */
    const CLR = {
      headerBg: "1B4F72", headerFg: "FFFFFF",        // dark blue header
      subHeaderBg: "2E86C1", subHeaderFg: "FFFFFF",   // lighter blue sub-header
      totalBg: "1B4F72", totalFg: "FFFFFF",           // dark blue total row
      altRow: "EBF5FB",                               // light blue zebra
      green: "27AE60", yellow: "F39C12", red: "E74C3C",
      borderColor: "BDC3C7"
    };
    const thinBorder = { style: "thin", color: { argb: CLR.borderColor } };
    const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };

    /* ══════════ SHEET 1: Obiective Ursus ══════════ */
    const ws = wb.addWorksheet("Obiective BB", { views: [{ state: "frozen", ySplit: 3 }] });

    // Title row
    ws.mergeCells("A1:J1");
    const titleCell = ws.getCell("A1");
    const [yy, mm] = month.split("-");
    const monthNames = ["", "Ianuarie", "Februarie", "Martie", "Aprilie", "Mai", "Iunie", "Iulie", "August", "Septembrie", "Octombrie", "Noiembrie", "Decembrie"];
    titleCell.value = `OBIECTIVE URSUS — ${monthNames[+mm]} ${yy}`;
    titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: CLR.headerBg } };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(1).height = 35;

    // Sub-header groups row
    ws.mergeCells("B2:D2"); ws.mergeCells("E2:G2"); ws.mergeCells("H2:J2");
    const groupHeaders = [
      { cell: "B2", label: "VALORIC (LEI)" },
      { cell: "E2", label: "HECTOLITRI (HL)" },
      { cell: "H2", label: "CLIENȚI 2 SKU" }
    ];
    for (const g of groupHeaders) {
      const c = ws.getCell(g.cell);
      c.value = g.label;
      c.font = { name: "Calibri", size: 11, bold: true, color: { argb: CLR.subHeaderFg } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.subHeaderBg } };
      c.alignment = { horizontal: "center", vertical: "middle" };
      c.border = allBorders;
    }
    ws.getCell("A2").value = "";
    ws.getCell("A2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.subHeaderBg } };
    ws.getCell("A2").border = allBorders;
    ws.getRow(2).height = 22;

    // Column headers
    const headers = ["AGENT", "Target", "Realizat", "%", "Target", "Realizat", "%", "Target", "Realizat", "%"];
    const headerRow = ws.getRow(3);
    headers.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: CLR.headerFg } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.headerBg } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = allBorders;
    });
    headerRow.height = 22;

    // Data rows
    result.forEach((a, idx) => {
      const row = ws.getRow(idx + 4);
      row.values = [
        a.agent,
        Math.round(a.target_val), Math.round(a.realizat_val), a.pct_val,
        Math.round(a.target_hl * 10) / 10, Math.round(a.realizat_hl * 10) / 10, a.pct_hl,
        a.target_cl, a.realizat_cl, a.pct_cl
      ];
      const bgColor = idx % 2 === 1 ? CLR.altRow : "FFFFFF";
      for (let c = 1; c <= 10; c++) {
        const cell = row.getCell(c);
        cell.font = { name: "Calibri", size: 10 };
        cell.border = allBorders;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
        if (c === 1) { cell.font = { name: "Calibri", size: 10, bold: true }; cell.alignment = { horizontal: "left" }; }
        else if (c === 4 || c === 7 || c === 10) {
          cell.numFmt = "0.0%";
          cell.alignment = { horizontal: "center" };
          const pct = cell.value || 0;
          if (pct >= 0.8) cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: CLR.green } };
          else if (pct >= 0.5) cell.font = { name: "Calibri", size: 10, color: { argb: CLR.yellow } };
          else cell.font = { name: "Calibri", size: 10, color: { argb: CLR.red } };
        } else {
          cell.numFmt = "#,##0";
          cell.alignment = { horizontal: "right" };
        }
      }
      row.height = 18;
    });

    // Total row
    const totalRowNum = result.length + 4;
    const totalRow = ws.getRow(totalRowNum);
    totalRow.values = [
      "TOTAL",
      Math.round(sums.tv), Math.round(sums.rv), sums.tv ? sums.rv / sums.tv : 0,
      Math.round(sums.th * 10) / 10, Math.round(sums.rh * 10) / 10, sums.th ? sums.rh / sums.th : 0,
      sums.tc, sums.rc, sums.tc ? sums.rc / sums.tc : 0
    ];
    for (let c = 1; c <= 10; c++) {
      const cell = totalRow.getCell(c);
      cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: CLR.totalFg } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.totalBg } };
      cell.border = allBorders;
      cell.alignment = { horizontal: c === 1 ? "left" : "center" };
      if (c === 4 || c === 7 || c === 10) cell.numFmt = "0.0%";
      else if (c > 1) cell.numFmt = "#,##0";
    }
    totalRow.height = 22;

    // Column widths
    ws.columns = [
      { width: 32 }, { width: 14 }, { width: 14 }, { width: 10 },
      { width: 12 }, { width: 12 }, { width: 10 },
      { width: 12 }, { width: 14 }, { width: 10 }
    ];

    // Conditional formatting: data bars on percentage columns
    for (const col of ["D", "G", "J"]) {
      const startRow = 4;
      const endRow = totalRowNum - 1;
      ws.addConditionalFormatting({
        ref: `${col}${startRow}:${col}${endRow}`,
        rules: [{ type: "dataBar", minLength: 0, maxLength: 100, gradient: true,
          color: { argb: "2E86C1" },
          cfvo: [{ type: "num", value: 0 }, { type: "num", value: 1 }] }]
      });
    }

    /* ══════════ SHEET 2: Grafice ══════════ */
    const cs = wb.addWorksheet("Grafice", {});

    // Chart data (% realizare per agent) — written as hidden helper data
    cs.getCell("A1").value = "Agent";
    cs.getCell("B1").value = "% Valoric";
    cs.getCell("C1").value = "% HL";
    cs.getCell("D1").value = "% Clienți";
    cs.getRow(1).font = { name: "Calibri", size: 10, bold: true, color: { argb: CLR.headerFg } };
    cs.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.headerBg } };
    result.forEach((a, i) => {
      const row = cs.getRow(i + 2);
      row.values = [a.agent, Math.round(a.pct_val * 1000) / 10, Math.round(a.pct_hl * 1000) / 10, Math.round(a.pct_cl * 1000) / 10];
      for (let c = 2; c <= 4; c++) {
        row.getCell(c).numFmt = "0.0";
        const v = row.getCell(c).value || 0;
        if (v >= 80) row.getCell(c).font = { name: "Calibri", size: 10, bold: true, color: { argb: CLR.green } };
        else if (v >= 50) row.getCell(c).font = { name: "Calibri", size: 10, color: { argb: CLR.yellow } };
        else row.getCell(c).font = { name: "Calibri", size: 10, color: { argb: CLR.red } };
      }
      const bgColor = i % 2 === 1 ? CLR.altRow : "FFFFFF";
      for (let c = 1; c <= 4; c++) {
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
        row.getCell(c).border = allBorders;
      }
    });
    for (let c = 1; c <= 4; c++) cs.getRow(1).getCell(c).border = allBorders;
    cs.columns = [{ width: 32 }, { width: 14 }, { width: 14 }, { width: 14 }];

    // Add data bars for chart sheet too
    for (const col of ["B", "C", "D"]) {
      cs.addConditionalFormatting({
        ref: `${col}2:${col}${result.length + 1}`,
        rules: [{ type: "dataBar", minLength: 0, maxLength: 100, gradient: true,
          color: { argb: col === "B" ? "2E86C1" : col === "C" ? "27AE60" : "F39C12" },
          cfvo: [{ type: "num", value: 0 }, { type: "num", value: 100 }] }]
      });
    }

    /* ══════════ SHEET 3: Istoric Zilnic (Daily History + Engros) ══════════ */
    const hasDailySales = db.prepare("SELECT COUNT(*) as cnt FROM daily_sales WHERE month=?").get(month);
    if (hasDailySales && hasDailySales.cnt > 0) {
      const ds = wb.addWorksheet("Istoric Zilnic", { views: [{ state: "frozen", ySplit: 2 }] });

      // Build monitored agent set (same logic as daily-history endpoint)
      const _targetAgents = db.prepare("SELECT agent_name FROM sales_targets WHERE month=?").all(month).map(r => r.agent_name);
      const _monSet = new Set();
      for (const n of _targetAgents) {
        _monSet.add(normalizeAgentName(n));
        _monSet.add(normalizeAgentName(n).split(" ").map(p => p.substring(0, 4)).join(" "));
      }
      const _salesAgMap = {};
      const _sr2 = db.prepare("SELECT agent_report_name, agent_name FROM sales_data WHERE month=?").all(month);
      for (const sr of _sr2) {
        if (sr.agent_report_name && sr.agent_name) {
          const nt = normalizeAgentName(sr.agent_name);
          const ft = nt.split(" ").map(p => p.substring(0, 4)).join(" ");
          if (_monSet.has(nt) || _monSet.has(ft)) _salesAgMap[sr.agent_report_name.toUpperCase()] = true;
        }
      }
      const agList = Object.keys(_salesAgMap);
      const ph = agList.map(() => "?").join(",");

      // Get ALL daily totals
      const allDaily = db.prepare(`SELECT datadoc, SUM(total_valoare) as tv, SUM(total_hl) as th, COUNT(DISTINCT client_id) as uc
        FROM daily_sales WHERE month=? AND datadoc!='' GROUP BY datadoc ORDER BY datadoc ASC`).all(month);

      // Get TEAM daily totals
      let teamDaily = [];
      if (agList.length > 0) {
        teamDaily = db.prepare(`SELECT datadoc, SUM(total_valoare) as tv, SUM(total_hl) as th, COUNT(DISTINCT client_id) as uc
          FROM daily_sales WHERE month=? AND datadoc!='' AND UPPER(agent) IN (${ph}) GROUP BY datadoc ORDER BY datadoc ASC`).all(month, ...agList);
      }
      const teamMap = {};
      for (const t of teamDaily) teamMap[t.datadoc] = t;

      // Engros agents
      const engrosNames = [];
      for (const sr of _sr2) {
        if (sr.agent_report_name && !_salesAgMap[sr.agent_report_name.toUpperCase()]) engrosNames.push(sr.agent_report_name);
      }

      // Title
      ds.mergeCells("A1:I1");
      const dsTitle = ds.getCell("A1");
      dsTitle.value = `ISTORIC VÂNZĂRI PE ZILE — ${monthNames[+mm]} ${yy}` + (engrosNames.length > 0 ? ` (En-gros: ${engrosNames.join(", ")})` : "");
      dsTitle.font = { name: "Calibri", size: 14, bold: true, color: { argb: CLR.headerBg } };
      dsTitle.alignment = { horizontal: "center", vertical: "middle" };
      ds.getRow(1).height = 30;

      // Headers
      const dHeaders = ["Data", "Echipă Val.", "Echipă HL", "Clienți", "Engros Val.", "Engros HL", "Total Val.", "Total HL", "Cum. Echipă HL"];
      const dRow2 = ds.getRow(2);
      dHeaders.forEach((h, i) => {
        const cell = dRow2.getCell(i + 1);
        cell.value = h;
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: CLR.headerFg } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.headerBg } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = allBorders;
      });
      dRow2.height = 22;

      // Data
      let cumTeamHL = 0;
      let totTeamV = 0, totTeamH = 0, totEngV = 0, totEngH = 0, totAllV = 0, totAllH = 0;
      allDaily.forEach((day, idx) => {
        const tm = teamMap[day.datadoc] || { tv: 0, th: 0, uc: 0 };
        const engV = day.tv - tm.tv;
        const engH = day.th - tm.th;
        cumTeamHL += tm.th;
        totTeamV += tm.tv; totTeamH += tm.th; totEngV += engV; totEngH += engH; totAllV += day.tv; totAllH += day.th;

        const r = ds.getRow(idx + 3);
        r.values = [
          day.datadoc,
          Math.round(tm.tv * 100) / 100, Math.round(tm.th * 100) / 100, tm.uc,
          Math.round(engV * 100) / 100, Math.round(engH * 100) / 100,
          Math.round(day.tv * 100) / 100, Math.round(day.th * 100) / 100,
          Math.round(cumTeamHL * 100) / 100
        ];
        const bg = idx % 2 === 1 ? CLR.altRow : "FFFFFF";
        for (let c = 1; c <= 9; c++) {
          const cell = r.getCell(c);
          cell.font = { name: "Calibri", size: 10 };
          cell.border = allBorders;
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
          if (c === 1) cell.alignment = { horizontal: "left" };
          else {
            cell.alignment = { horizontal: "right" };
            if (c === 4) cell.numFmt = "0";
            else cell.numFmt = "#,##0.00";
          }
          // Engros columns in orange
          if (c === 5 || c === 6) cell.font = { name: "Calibri", size: 10, italic: true, color: { argb: "E67E22" } };
        }
        r.height = 18;
      });

      // Total row
      const dtRowNum = allDaily.length + 3;
      const dtRow = ds.getRow(dtRowNum);
      dtRow.values = [
        "TOTAL",
        Math.round(totTeamV * 100) / 100, Math.round(totTeamH * 100) / 100, "",
        Math.round(totEngV * 100) / 100, Math.round(totEngH * 100) / 100,
        Math.round(totAllV * 100) / 100, Math.round(totAllH * 100) / 100,
        Math.round(cumTeamHL * 100) / 100
      ];
      for (let c = 1; c <= 9; c++) {
        const cell = dtRow.getCell(c);
        cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: CLR.totalFg } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CLR.totalBg } };
        cell.border = allBorders;
        cell.alignment = { horizontal: c === 1 ? "left" : "right" };
        if (c >= 2 && c !== 4) cell.numFmt = "#,##0.00";
      }
      dtRow.height = 22;

      ds.columns = [
        { width: 14 }, { width: 16 }, { width: 12 }, { width: 10 },
        { width: 16 }, { width: 12 }, { width: 16 }, { width: 12 }, { width: 14 }
      ];
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Raport_Obiective_BB_${month}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("Obiective export error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

app.get("/api/gt/config", auth, (req, res) => {
  const skuCount = db.prepare("SELECT COUNT(*) as cnt FROM sku_mapping").get().cnt;
  const priceCount = db.prepare("SELECT COUNT(*) as cnt FROM gt_prices").get().cnt;
  const months = db.prepare("SELECT DISTINCT month FROM gt_targets ORDER BY month DESC").all().map(r => r.month);
  res.json({ ok: true, sku_mapping: skuCount, gt_prices: priceCount, target_months: months });
});

/* ── GT Upload Centralizator (Upload "Baza calcul" and extract "centralizator realizat" sheet) ── */
app.post("/api/gt/upload-centralizator", auth, adminOnly, gtUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  const month = req.body.month;
  if (!month || !validateMonthFormat(month)) return res.status(400).json({ error: "Format lună invalid (ex: 2026-02)" });
  try {

    const wb = XLSX_LIB.readFile(req.file.path);

    // Find the "centralizator realizat" sheet
    let ws = null;
    for (const sheetName of wb.SheetNames) {
      if (sheetName.toLowerCase().includes("centralizator")) {
        ws = wb.Sheets[sheetName];
        break;
      }
    }
    if (!ws) throw new Error("Sheet-ul 'centralizator realizat' nu a fost găsit");

    // Parse rows
    const rows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!rows || rows.length === 0) throw new Error("Fișierul nu conține date");

    // Structure: Row 1 = main headers (AGENT, Target, _, _, Realizat, _, _, Procent realizat, _, _)
    // Row 2 = sub-headers (_, Core Segment, ABI, Total SO, Core Segment, ABI, Total SO, ...)
    // Data starts at row 3
    // Columns: 1=AGENT, 2=Target Core, 3=Target ABI, 4=Target Total, 5=Realizat Core, 6=Realizat ABI, 7=Realizat Total

    const insTarget = db.prepare("INSERT OR REPLACE INTO gt_targets (month, agent_name, target_core, target_abi, target_total, real_core, real_abi, real_total) VALUES (?,?,?,?,?,?,?,?)");

    let countTargets = 0;
    const agentsData = [];

    const tx = db.transaction(() => {
      db.prepare("DELETE FROM gt_targets WHERE month=?").run(month);

      for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        const agent = String(row[0] || "").trim();
        if (!agent || agent.toUpperCase() === "GRAND TOTAL" || agent.toUpperCase() === "TOTAL" || agent.toUpperCase() === "TRIM") continue;

        const tCore = parseFloat(row[1]) || 0;
        const tAbi = parseFloat(row[2]) || 0;
        const tTotal = parseFloat(row[3]) || 0;
        const rCore = parseFloat(row[4]) || 0;
        const rAbi = parseFloat(row[5]) || 0;
        const rTotal = parseFloat(row[6]) || 0;

        insTarget.run(month, agent,
          Math.round(tCore * 100) / 100, Math.round(tAbi * 100) / 100, Math.round(tTotal * 100) / 100,
          Math.round(rCore * 100) / 100, Math.round(rAbi * 100) / 100, Math.round(rTotal * 100) / 100);
        countTargets++;

        agentsData.push({ agent, target_core: tCore, target_abi: tAbi, target_total: tTotal, real_core: rCore, real_abi: rAbi, real_total: rTotal });
      }
    });
    tx();

    res.json({ ok: true, month, targets_imported: countTargets, agents: agentsData });
  } catch (err) {
    console.error("GT centralizator upload error:", err);
    console.error("[Error]", err.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ═══════════ ÎNCASĂRI (Daily Cash Collections) ═══════════ */

/* ── Agent saves today's cash amount (insert or update) ── */
app.post("/api/incasari", auth, (req, res) => {
  const { suma } = req.body;
  if (suma === undefined || suma === null || isNaN(Number(suma))) {
    return res.status(400).json({ error: "Suma este obligatorie" });
  }
  if (req.role !== "agent") {
    return res.status(403).json({ error: "Doar agenții pot raporta încasări" });
  }
  const today = new Date().toISOString().slice(0, 10);
  try {
    db.prepare(`INSERT INTO incasari (user_id, agent_dtr, suma, data) VALUES (?,?,?,?)
      ON CONFLICT(user_id, data) DO UPDATE SET suma=excluded.suma, created_at=datetime('now')`)
      .run(req.userId, req.agentDtr, Number(suma), today);
    res.json({ ok: true, message: "Încasare salvată" });
  } catch (e) {
    console.error("[Error]", e.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── Agent gets own collection for a given date ── */
app.get("/api/incasari", auth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  if (req.role === "agent") {
    const row = db.prepare("SELECT * FROM incasari WHERE user_id=? AND data=?").get(req.userId, date);
    res.json(row || null);
  } else {
    // SPV/Admin see all for that date
    const rows = db.prepare("SELECT * FROM incasari WHERE data=? ORDER BY agent_dtr").all(date);
    res.json(rows);
  }
});

/* ── SPV/Admin: all collections for a date ── */
app.get("/api/incasari/all", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = db.prepare("SELECT * FROM incasari WHERE data=? ORDER BY agent_dtr").all(date);
  // Also get all agents for completeness
  const agents = db.prepare("SELECT id, display_name, sales_rep FROM users WHERE role='agent' AND active=1 ORDER BY display_name").all();
  const incMap = {};
  for (const r of rows) incMap[r.agent_dtr] = r;
  const result = agents.map(a => ({
    agent_dtr: a.sales_rep,
    display_name: a.display_name,
    suma: incMap[a.sales_rep] ? incMap[a.sales_rep].suma : null,
    completat: !!incMap[a.sales_rep]
  }));
  const total = rows.reduce((s, r) => s + r.suma, 0);
  res.json({ date, agents: result, total, completati: rows.length, total_agenti: agents.length });
});

/* ── SPV/Admin: monthly summary ── */
app.get("/api/incasari/monthly", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`
    SELECT agent_dtr, SUM(suma) as total_suma, COUNT(*) as zile_raportate
    FROM incasari WHERE data LIKE ? || '%'
    GROUP BY agent_dtr ORDER BY agent_dtr
  `).all(month);
  // Get all agents
  const agents = db.prepare("SELECT display_name, sales_rep FROM users WHERE role='agent' AND active=1 ORDER BY display_name").all();
  const incMap = {};
  for (const r of rows) incMap[r.agent_dtr] = r;
  const result = agents.map(a => ({
    agent_dtr: a.sales_rep,
    display_name: a.display_name,
    total_suma: incMap[a.sales_rep] ? incMap[a.sales_rep].total_suma : 0,
    zile_raportate: incMap[a.sales_rep] ? incMap[a.sales_rep].zile_raportate : 0,
    media_zilnica: incMap[a.sales_rep] ? Math.round(incMap[a.sales_rep].total_suma / incMap[a.sales_rep].zile_raportate * 100) / 100 : 0
  }));
  const grandTotal = rows.reduce((s, r) => s + r.total_suma, 0);
  res.json({ month, agents: result, grand_total: grandTotal });
});

/* ── Agent: own last 7 days history ── */
app.get("/api/incasari/history", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT data, suma FROM incasari WHERE user_id=?
    ORDER BY data DESC LIMIT 7
  `).all(req.userId);
  res.json(rows);
});

/* ═══════════════════════════════════════════
   VIZITE CHECK-IN APIs
   ═══════════════════════════════════════════ */

/* ── Visit upload directory ── */
const visitUploadDir = path.join(uploadDir, "visits");
if (!fs.existsSync(visitUploadDir)) fs.mkdirSync(visitUploadDir, { recursive: true });
const visitUpload = multer({
  storage: multer.diskStorage({
    destination: visitUploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ALLOWED_IMAGE_EXTS.includes(ext) ? ext : ".jpg";
      cb(null, `visit_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${safeExt}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFileFilter
});

/* ── POST /api/visits/checkin ── */
app.post("/api/visits/checkin", auth, visitUpload.single("photo"), (req, res) => {
  const { client_id, notes } = req.body;
  if (!client_id) return res.status(400).json({ error: "client_id lipsă" });

  const client = db.prepare("SELECT * FROM clients WHERE id=?").get(client_id);
  if (!client) return res.status(404).json({ error: "Client negăsit" });

  if (!req.file && req.role !== "admin") return res.status(400).json({ error: "Poza este obligatorie" });

  let photoUrl = null;
  if (req.file) {
    photoUrl = `/uploads/visits/${req.file.filename}`;
  }

  // Date/time in Romania timezone
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Bucharest" }));
  const zileRo = ["Duminică", "Luni", "Marți", "Miercuri", "Joi", "Vineri", "Sâmbătă"];
  const visitDate = now.toISOString().split("T")[0];
  const visitDay = zileRo[now.getDay()];
  const visitTime = now.toTimeString().split(" ")[0].slice(0, 5);

  // Get agent display name
  const user = db.prepare("SELECT display_name, sales_rep FROM users WHERE id=?").get(req.userId);
  const agentName = user ? (user.sales_rep || user.display_name) : req.username;

  db.prepare(`INSERT INTO visits_checkin
    (client_id, client_type, username, agent, client_name, localitate, judet,
     lat, lon, photo_url, notes, visit_date, visit_day, visit_time)
    VALUES (?, 'census', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(client_id, req.username, agentName,
         client.nume_poc || client.firma, client.oras, client.judet || "IASI",
         client.lat, client.lon, photoUrl, notes || "",
         visitDate, visitDay, visitTime);

  res.json({ ok: true, message: "Check-in salvat!", visit: { client_id, visit_date: visitDate, visit_day: visitDay, visit_time: visitTime, photo_url: photoUrl } });
});

/* ── GET /api/visits ── List visits ── */
app.get("/api/visits/list", auth, (req, res) => {
  const { date, agent, client_id, limit: lim } = req.query;
  const maxRows = parseInt(lim) || 200;
  let sql = "SELECT v.*, c.firma, c.code, c.oras as client_oras, c.canal, c.format FROM visits_checkin v LEFT JOIN clients c ON v.client_id = c.id WHERE 1=1";
  const params = [];

  if (req.role === "agent") {
    sql += " AND v.username = ?";
    params.push(req.username);
  } else if (agent) {
    sql += " AND v.agent = ?";
    params.push(agent);
  }

  if (client_id) {
    sql += " AND v.client_id = ?";
    params.push(parseInt(client_id));
  }

  if (date) {
    sql += " AND v.visit_date = ?";
    params.push(date);
  }

  sql += " ORDER BY v.visit_date DESC, v.visit_time DESC LIMIT ?";
  params.push(maxRows);

  const rows = db.prepare(sql).all(...params);
  res.json({ visits: rows });
});

/* ── GET /api/visits/today-status ── Which clients visited/not visited today ── */
app.get("/api/visits/today-status", auth, (req, res) => {
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Bucharest" })).toISOString().split("T")[0];

  let clients;
  if (req.role === "agent" && req.agentDtr) {
    clients = db.prepare("SELECT id, firma, nume_poc, oras, lat, lon, agent FROM clients WHERE agent=? ORDER BY firma").all(req.agentDtr);
  } else {
    clients = db.prepare("SELECT id, firma, nume_poc, oras, lat, lon, agent FROM clients ORDER BY firma").all();
  }

  // Get today's visits
  let visitedSet;
  if (req.role === "agent") {
    const visited = db.prepare("SELECT DISTINCT client_id FROM visits_checkin WHERE username=? AND visit_date=?").all(req.username, today);
    visitedSet = new Set(visited.map(v => v.client_id));
  } else {
    const agentFilter = req.query.agent;
    if (agentFilter) {
      const visited = db.prepare("SELECT DISTINCT client_id FROM visits_checkin WHERE agent=? AND visit_date=?").all(agentFilter, today);
      visitedSet = new Set(visited.map(v => v.client_id));
    } else {
      const visited = db.prepare("SELECT DISTINCT client_id FROM visits_checkin WHERE visit_date=?").all(today);
      visitedSet = new Set(visited.map(v => v.client_id));
    }
  }

  // Also get visit times
  let visitRows;
  if (req.role === "agent") {
    visitRows = db.prepare("SELECT client_id, visit_time, notes, photo_url FROM visits_checkin WHERE username=? AND visit_date=? ORDER BY id DESC").all(req.username, today);
  } else {
    const agentFilter2 = req.query.agent;
    if (agentFilter2) {
      visitRows = db.prepare("SELECT client_id, visit_time, notes, photo_url, agent FROM visits_checkin WHERE agent=? AND visit_date=? ORDER BY id DESC").all(agentFilter2, today);
    } else {
      visitRows = db.prepare("SELECT client_id, visit_time, notes, photo_url, agent FROM visits_checkin WHERE visit_date=? ORDER BY id DESC").all(today);
    }
  }
  // Build map of client_id -> first visit
  const visitMap = {};
  visitRows.forEach(v => { if (!visitMap[v.client_id]) visitMap[v.client_id] = v; });

  const totalVisited = Object.keys(visitMap).length;
  res.json({ date: today, visits: visitRows, total: clients.length, visited: totalVisited });
});

/* ── GET /api/visits/routes ── Route patterns (Faza 2) ── */
app.get("/api/visits/routes", auth, (req, res) => {
  const agentFilter = req.query.agent;
  let agentName;

  if (req.role === "agent") {
    const user = db.prepare("SELECT sales_rep, display_name FROM users WHERE id=?").get(req.userId);
    agentName = user ? (user.sales_rep || user.display_name) : req.username;
  } else if (agentFilter) {
    agentName = agentFilter;
  }

  // Get all agents with visits
  const agents = db.prepare("SELECT DISTINCT agent FROM visits_checkin ORDER BY agent").all().map(r => r.agent);

  // Get patterns
  let patternSql = `
    SELECT client_id, client_name, localitate, judet, lat, lon, visit_day,
           COUNT(*) as visit_count, MAX(visit_date) as last_visit
    FROM visits_checkin
    WHERE visit_date >= date('now', '-28 days')
  `;
  const patternParams = [];
  if (agentName) {
    patternSql += " AND agent = ?";
    patternParams.push(agentName);
  }
  patternSql += " GROUP BY client_id, visit_day ORDER BY visit_day, visit_count DESC";

  const patterns = db.prepare(patternSql).all(...patternParams);

  // Per day summary
  let perDaySql = `
    SELECT visit_day, COUNT(DISTINCT client_id) as clienti, COUNT(*) as vizite
    FROM visits_checkin
    WHERE visit_date >= date('now', '-28 days')
  `;
  const perDayParams = [];
  if (agentName) {
    perDaySql += " AND agent = ?";
    perDayParams.push(agentName);
  }
  perDaySql += " GROUP BY visit_day";

  const perDay = db.prepare(perDaySql).all(...perDayParams);

  // Generate optimized routes per day
  const dayOrder = ["Luni", "Marți", "Miercuri", "Joi", "Vineri", "Sâmbătă", "Duminică"];

  // Group patterns by client, pick best day
  const clientBestDay = {};
  for (const p of patterns) {
    if (!clientBestDay[p.client_id] || p.visit_count > clientBestDay[p.client_id].visit_count) {
      clientBestDay[p.client_id] = p;
    }
  }

  // Group by day
  const routesByDay = {};
  for (const day of dayOrder) routesByDay[day] = [];
  for (const c of Object.values(clientBestDay)) {
    if (routesByDay[c.visit_day]) routesByDay[c.visit_day].push(c);
  }

  // Optimize order per day (nearest neighbor)
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function optimizeOrder(clients) {
    if (clients.length <= 1) return clients;
    const ordered = [clients[0]];
    const remaining = clients.slice(1);
    while (remaining.length > 0) {
      const last = ordered[ordered.length - 1];
      let nearestIdx = 0, nearestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = haversine(last.lat, last.lon, remaining[i].lat, remaining[i].lon);
        if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
      }
      ordered.push(remaining.splice(nearestIdx, 1)[0]);
    }
    return ordered;
  }

  const optimizedRoutes = {};
  for (const day of dayOrder) {
    if (routesByDay[day].length > 0) {
      optimizedRoutes[day] = optimizeOrder(routesByDay[day]);
    }
  }

  // Total visit count
  const totalVisits = db.prepare("SELECT COUNT(*) as c FROM visits_checkin").get().c;

  res.json({
    patterns,
    agents,
    perDay,
    routes: optimizedRoutes,
    total_visits: totalVisits,
    has_enough_data: totalVisits >= 50
  });
});

/* ── GET /api/visits/predefined-routes ── Rute prestabilite din Excel ── */
app.get("/api/visits/predefined-routes", auth, (req, res) => {
  const { agent, day } = req.query;
  let sql = "SELECT * FROM agent_routes WHERE 1=1";
  const params = [];

  if (req.role === "agent") {
    const user = db.prepare("SELECT sales_rep, display_name FROM users WHERE id=?").get(req.userId);
    const myName = user ? (user.sales_rep || user.display_name) : req.username;
    sql += " AND agent_name = ?";
    params.push(myName);
  } else if (agent) {
    sql += " AND agent_name = ?";
    params.push(agent);
  }

  if (day) {
    sql += " AND route_day = ?";
    params.push(day);
  }

  sql += " ORDER BY agent_name, route_day, client_name";
  const rows = db.prepare(sql).all(...params);

  // Get distinct agents
  const agents = db.prepare("SELECT DISTINCT agent_name FROM agent_routes ORDER BY agent_name").all().map(r => r.agent_name);

  // Summary per agent
  const summary = db.prepare(`
    SELECT agent_name, route_day, COUNT(*) as cnt
    FROM agent_routes
    GROUP BY agent_name, route_day
    ORDER BY agent_name, route_day
  `).all();

  res.json({ routes: rows, agents, summary });
});

/* ── POST /api/visits/import-routes ── Import rute din Excel ── */
app.post("/api/visits/import-routes", auth, multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }).single("file"), (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Doar admin/spv" });
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });

  try {
    const XLSX = require("xlsx");
    const wb = XLSX.read(req.file.buffer);

    // Skip "Sumar Rute" sheet - process only agent sheets
    const agentSheets = wb.SheetNames.filter(s => s !== "Sumar Rute");
    if (!agentSheets.length) return res.status(400).json({ error: "Nu s-au găsit sheet-uri de agenți" });

    // Clear existing routes
    db.prepare("DELETE FROM agent_routes").run();

    const insertStmt = db.prepare(`INSERT INTO agent_routes
      (agent_name, route_day, cod_unic, client_name, adresa, cod_fiscal, incredere, vizite, distributie_zile, ultima_factura, client_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    let totalInserted = 0;
    let agentsProcessed = 0;
    const agentStats = [];

    const insertMany = db.transaction((rows) => {
      for (const r of rows) insertStmt.run(...r);
    });

    for (const sheetName of agentSheets) {
      const ws = wb.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
      if (!data.length) continue;

      const agentName = sheetName.trim();
      let currentDay = "Necunoscut";
      const rows = [];

      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        if (!row || !row.length) continue;

        const cell0 = (row[0] || "").toString().trim().toUpperCase();

        // Detect day group headers
        if (cell0.includes("LUNI") && cell0.includes("JOI")) {
          currentDay = "Luni+Joi";
          continue;
        } else if (cell0.includes("MARȚ") && cell0.includes("VINERI")) {
          currentDay = "Marți+Vineri";
          continue;
        } else if (cell0.includes("MIERCURI") && !cell0.includes("AMBIG")) {
          currentDay = "Miercuri";
          continue;
        } else if (cell0.includes("AMBIG")) {
          currentDay = "Ambiguu";
          continue;
        } else if (cell0.includes("DATE INSUF")) {
          currentDay = "Date Insuficiente";
          continue;
        }

        // Skip header rows
        if (cell0 === "COD UNIC" || cell0 === "RUTE:" || cell0.startsWith("RUTE:") || cell0.startsWith("TOTAL CLI")) continue;

        // Skip empty or non-data rows
        const codUnic = (row[0] || "").toString().trim();
        const clientName = (row[1] || "").toString().trim();
        if (!codUnic || !clientName) continue;
        // Must have a numeric-ish cod unic
        if (!/\d/.test(codUnic)) continue;

        const adresa = (row[2] || "").toString().trim();
        const codFiscal = (row[3] || "").toString().trim();
        const incredere = (row[4] || "").toString().trim();
        const vizite = parseInt(row[5]) || 0;
        const distribZile = (row[6] || "").toString().trim();
        const ultimaFactura = (row[7] || "").toString().trim();

        // Try to match with existing client by cod_fiscal, then by name
        let clientId = null;
        if (codFiscal) {
          const cleanCif = codFiscal.replace(/^RO/i, "");
          // Match on CIF (agent name in DB has suffix like BB3, BB4 so we match broadly)
          const match = db.prepare("SELECT id FROM clients WHERE REPLACE(UPPER(cif), 'RO', '') = ? OR UPPER(cif) = ? LIMIT 1").get(cleanCif.toUpperCase(), codFiscal.toUpperCase());
          if (match) clientId = match.id;
        }
        // Fallback: match by firma name (fuzzy)
        if (!clientId && clientName) {
          const nameClean = clientName.replace(/\s+/g, "%").toUpperCase();
          const match2 = db.prepare("SELECT id FROM clients WHERE UPPER(firma) LIKE ? LIMIT 1").get("%" + nameClean + "%");
          if (match2) clientId = match2.id;
        }

        rows.push([agentName, currentDay, codUnic, clientName, adresa, codFiscal, incredere, vizite, distribZile, ultimaFactura, clientId]);
      }

      if (rows.length) {
        insertMany(rows);
        totalInserted += rows.length;
        agentsProcessed++;
        agentStats.push({ agent: agentName, count: rows.length });
      }
    }

    res.json({
      ok: true,
      message: `Import reușit: ${totalInserted} rute pentru ${agentsProcessed} agenți`,
      total: totalInserted,
      agents: agentStats
    });
  } catch (e) {
    console.error("[Import Routes] Error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ── Serve visit photos ── */
app.use("/uploads/visits", express.static(visitUploadDir));

/* ═══════════════════════════════════════════════════
   MODULE 1: COMUNICARE / ANUNȚURI
   ═══════════════════════════════════════════════════ */

/* ── POST /api/announcements ── Create (SPV/Admin) ── */
app.post("/api/announcements", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Doar SPV/Admin pot crea anunțuri" });
  const { title, body, priority, target_role, target_agent, expires_at, pinned } = req.body;
  if (!title) return res.status(400).json({ error: "Titlul este obligatoriu" });
  db.prepare(`INSERT INTO announcements (title, body, priority, target_role, target_agent, created_by, expires_at, pinned) VALUES (?,?,?,?,?,?,?,?)`)
    .run(title, body || "", priority || "normal", target_role || "all", target_agent || "", req.username, expires_at || "", pinned ? 1 : 0);
  res.json({ ok: true });
});

/* ── GET /api/announcements ── List ── */
app.get("/api/announcements", auth, (req, res) => {
  let rows = db.prepare(`SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT 100`).all();
  // Filter by role/agent for agents
  if (req.role === "agent") {
    rows = rows.filter(a => {
      if (a.target_role && a.target_role !== "all" && a.target_role !== "agent") return false;
      if (a.target_agent && a.target_agent !== req.username) return false;
      if (a.expires_at && a.expires_at < new Date().toISOString().slice(0, 10)) return false;
      return true;
    });
  }
  res.json(rows);
});

/* ── DELETE /api/announcements/:id ── Delete (SPV/Admin) ── */
app.delete("/api/announcements/:id", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  db.prepare("DELETE FROM announcements WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════
   MODULE 2: TASKURI / SARCINI ZILNICE
   ═══════════════════════════════════════════════════ */

/* ── POST /api/tasks ── Create task (SPV/Admin) ── */
app.post("/api/tasks", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Doar SPV/Admin pot crea sarcini" });
  const { title, description, assigned_to, due_date, priority } = req.body;
  if (!title) return res.status(400).json({ error: "Titlul este obligatoriu" });
  if (!assigned_to) return res.status(400).json({ error: "Selectează agentul" });
  db.prepare(`INSERT INTO tasks (title, description, assigned_to, assigned_by, due_date, priority) VALUES (?,?,?,?,?,?)`)
    .run(title, description || "", assigned_to, req.username, due_date || new Date().toISOString().slice(0, 10), priority || "normal");
  // Notify the assigned agent
  createNotification(assigned_to, "✅ Sarcină nouă", `${title}${due_date ? ' — Termen: ' + due_date : ''}`, "task", "taskuri");
  res.json({ ok: true });
});

/* ── GET /api/tasks ── List tasks ── */
app.get("/api/tasks", auth, (req, res) => {
  let tasks;
  if (req.role === "agent") {
    tasks = db.prepare(`SELECT * FROM tasks WHERE assigned_to=? ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, due_date ASC LIMIT 200`).all(req.username);
  } else {
    const agent = req.query.agent;
    if (agent) {
      tasks = db.prepare(`SELECT * FROM tasks WHERE assigned_to=? ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, due_date ASC LIMIT 200`).all(agent);
    } else {
      tasks = db.prepare(`SELECT * FROM tasks ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, due_date ASC LIMIT 500`).all();
    }
  }
  res.json(tasks);
});

/* ── PUT /api/tasks/:id ── Update task status ── */
app.put("/api/tasks/:id", auth, (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Task negăsit" });
  const { status, completed_note } = req.body;
  if (status === "completed") {
    db.prepare("UPDATE tasks SET status='completed', completed_at=datetime('now'), completed_note=? WHERE id=?")
      .run(completed_note || "", req.params.id);
  } else if (status) {
    db.prepare("UPDATE tasks SET status=? WHERE id=?").run(status, req.params.id);
  }
  res.json({ ok: true });
});

/* ── DELETE /api/tasks/:id ── Delete (SPV/Admin) ── */
app.delete("/api/tasks/:id", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  db.prepare("DELETE FROM tasks WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════
   MODULE 3: GPS TRACKING / MONITORIZARE LIVE
   ═══════════════════════════════════════════════════ */

/* ── Helper: check working hours (Romania timezone) ── */
function isWorkingHoursServer() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Bucharest" }));
  const day = now.getDay(); // 0=Sun, 1=Mon ... 6=Sat
  const h = now.getHours();
  const m = now.getMinutes();
  const time = h * 60 + m;
  if (day === 0) return false; // Duminică
  if (day === 6) return time >= 420 && time < 780; // Sâmbătă 7:00-13:00
  return time >= 420 && time < 1080; // Luni-Vineri 7:00-18:00
}

/* ── POST /api/gps/update ── Agent sends location ── */
app.post("/api/gps/update", auth, (req, res) => {
  if (!isWorkingHoursServer()) return res.json({ ok: false, reason: "outside_hours" });
  const { lat, lon, accuracy, speed } = req.body;
  if (!lat || !lon) return res.status(400).json({ error: "Coordonate lipsă" });
  const user = db.prepare("SELECT display_name, sales_rep FROM users WHERE id=?").get(req.userId);
  const agentName = user ? (user.sales_rep || user.display_name) : req.username;
  db.prepare(`INSERT INTO gps_locations (username, agent_name, lat, lon, accuracy, speed) VALUES (?,?,?,?,?,?)`)
    .run(req.username, agentName, lat, lon, accuracy || 0, speed || 0);
  res.json({ ok: true });
});

/* ── GET /api/gps/live ── Get latest locations (Admin only) ── */
app.get("/api/gps/live", auth, (req, res) => {
  if (req.role !== "admin") return res.status(403).json({ error: "Acces interzis — doar admin" });
  // Get latest location for each agent in last 2 hours
  const rows = db.prepare(`
    SELECT g1.* FROM gps_locations g1
    INNER JOIN (SELECT username, MAX(id) as max_id FROM gps_locations WHERE recorded_at >= datetime('now', '-2 hours') GROUP BY username) g2
    ON g1.id = g2.max_id
    ORDER BY g1.agent_name
  `).all();
  // Also count today's visits per agent
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Bucharest" })).toISOString().split("T")[0];
  const visitCounts = db.prepare(`SELECT agent, COUNT(DISTINCT client_id) as cnt FROM visits_checkin WHERE visit_date=? GROUP BY agent`).all(today);
  const vcMap = {};
  visitCounts.forEach(v => vcMap[v.agent] = v.cnt);
  const result = rows.map(r => ({ ...r, visits_today: vcMap[r.agent_name] || 0 }));
  res.json(result);
});

/* ── GET /api/gps/history ── Route history (Admin only) ── */
app.get("/api/gps/history", auth, (req, res) => {
  if (req.role !== "admin") return res.status(403).json({ error: "Acces interzis — doar admin" });
  const { username, date } = req.query;
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const targetUser = username || "";
  if (!targetUser) return res.json([]);
  const rows = db.prepare(`SELECT * FROM gps_locations WHERE username=? AND date(recorded_at)=? ORDER BY recorded_at`).all(targetUser, targetDate);
  res.json(rows);
});

/* ═══════════════════════════════════════════════════
   MODULE 4: COMPETIȚIE / INTELLIGENCE
   ═══════════════════════════════════════════════════ */

/* ── POST /api/competition ── Report competitor activity ── */
app.post("/api/competition", auth, upload.single("photo"), (req, res) => {
  const { client_id, competitor_brand, competitor_product, competitor_price, competitor_promo, shelf_presence, notes } = req.body;
  if (!client_id) return res.status(400).json({ error: "Selectează clientul" });
  const photoUrl = req.file ? `/uploads/visits/${req.file.filename}` : "";
  db.prepare(`INSERT INTO competition_reports (client_id, reported_by, competitor_brand, competitor_product, competitor_price, competitor_promo, shelf_presence, notes, photo_url) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(client_id, req.username, competitor_brand || "", competitor_product || "", parseFloat(competitor_price) || 0, competitor_promo || "", shelf_presence || "", notes || "", photoUrl);
  res.json({ ok: true });
});

/* ── GET /api/competition ── List reports ── */
app.get("/api/competition", auth, (req, res) => {
  let sql = `SELECT cr.*, c.firma, c.nume_poc, c.oras, c.agent FROM competition_reports cr LEFT JOIN clients c ON cr.client_id = c.id`;
  const params = [];
  if (req.role === "agent") {
    sql += " WHERE cr.reported_by=?";
    params.push(req.username);
  }
  sql += " ORDER BY cr.reported_at DESC LIMIT 200";
  res.json(db.prepare(sql).all(...params));
});

/* ═══════════════════════════════════════════════════
   MODULE 5: STOC FRIGIDER / MERCHANDISING
   ═══════════════════════════════════════════════════ */

/* ── POST /api/fridge ── Audit a fridge ── */
app.post("/api/fridge", auth, (req, res) => {
  const { client_id, fridge_present, fridge_functional, fridge_clean, fridge_branded, stock_level, sku_count, competitor_products, notes } = req.body;
  if (!client_id) return res.status(400).json({ error: "Selectează clientul" });
  db.prepare(`INSERT INTO fridge_audits (client_id, audited_by, fridge_present, fridge_functional, fridge_clean, fridge_branded, stock_level, sku_count, competitor_products, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(client_id, req.username, fridge_present ? 1 : 0, fridge_functional ? 1 : 0, fridge_clean ? 1 : 0, fridge_branded ? 1 : 0, stock_level || "normal", sku_count || 0, competitor_products || 0, notes || "");
  res.json({ ok: true });
});

/* ── GET /api/fridge ── List audits ── */
app.get("/api/fridge", auth, (req, res) => {
  let sql = `SELECT fa.*, c.firma, c.nume_poc, c.oras, c.agent FROM fridge_audits fa LEFT JOIN clients c ON fa.client_id = c.id`;
  const params = [];
  if (req.role === "agent") {
    sql += " WHERE fa.audited_by=?";
    params.push(req.username);
  }
  sql += " ORDER BY fa.audited_at DESC LIMIT 200";
  res.json(db.prepare(sql).all(...params));
});

/* ── GET /api/fridge/summary ── Summary stats ── */
app.get("/api/fridge/summary", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  const rows = db.prepare(`
    SELECT COUNT(*) as total, SUM(fridge_present) as with_fridge, SUM(fridge_functional) as functional,
           SUM(fridge_clean) as clean, SUM(fridge_branded) as branded, AVG(sku_count) as avg_sku
    FROM fridge_audits WHERE strftime('%Y-%m', audited_at) = ?
  `).get(month);
  res.json(rows);
});

/* ═══════════════════════════════════════════════════
   MODULE 6: PROMOȚII ACTIVE
   ═══════════════════════════════════════════════════ */

/* ── POST /api/promotions ── Create (SPV/Admin) ── */
app.post("/api/promotions", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Doar SPV/Admin pot crea promoții" });
  const { title, description, start_date, end_date, products, target_canal, target_format, mechanic } = req.body;
  if (!title || !start_date || !end_date) return res.status(400).json({ error: "Completează câmpurile obligatorii" });
  db.prepare(`INSERT INTO promotions (title, description, start_date, end_date, products, target_canal, target_format, mechanic, created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(title, description || "", start_date, end_date, products || "", target_canal || "", target_format || "", mechanic || "", req.username);
  res.json({ ok: true });
});

/* ── GET /api/promotions ── List active promotions ── */
app.get("/api/promotions", auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const showAll = req.query.all === "1";
  let rows;
  if (showAll) {
    rows = db.prepare(`SELECT * FROM promotions ORDER BY start_date DESC LIMIT 100`).all();
  } else {
    rows = db.prepare(`SELECT * FROM promotions WHERE active=1 AND start_date <= ? AND end_date >= ? ORDER BY end_date ASC`).all(today, today);
  }
  // Add activation count
  const activStmt = db.prepare("SELECT COUNT(*) as cnt FROM promo_activations WHERE promo_id=?");
  rows = rows.map(r => ({ ...r, activations: activStmt.get(r.id).cnt }));
  res.json(rows);
});

/* ── POST /api/promotions/:id/activate ── Activate for client ── */
app.post("/api/promotions/:id/activate", auth, (req, res) => {
  const { client_id, notes } = req.body;
  if (!client_id) return res.status(400).json({ error: "Selectează clientul" });
  try {
    db.prepare(`INSERT INTO promo_activations (promo_id, client_id, activated_by, notes) VALUES (?,?,?,?)`)
      .run(req.params.id, client_id, req.username, notes || "");
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: "Promoție deja activată pentru acest client" });
  }
});

/* ── GET /api/promotions/:id/activations ── List activations ── */
app.get("/api/promotions/:id/activations", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT pa.*, c.firma, c.nume_poc, c.oras, c.agent FROM promo_activations pa
    LEFT JOIN clients c ON pa.client_id = c.id WHERE pa.promo_id=? ORDER BY pa.activated_at DESC
  `).all(req.params.id);
  res.json(rows);
});

/* ── DELETE /api/promotions/:id ── Delete promo (SPV/Admin) ── */
app.delete("/api/promotions/:id", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  db.prepare("DELETE FROM promo_activations WHERE promo_id=?").run(req.params.id);
  db.prepare("DELETE FROM promotions WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════
   MODULE 7: CALENDAR / PLANIFICARE RUTE
   ═══════════════════════════════════════════════════ */

/* ── POST /api/beat-plan ── Add client to beat plan ── */
app.post("/api/beat-plan", auth, (req, res) => {
  const { client_id, day_of_week, visit_frequency, priority, notes, agent_username } = req.body;
  if (!client_id || !day_of_week) return res.status(400).json({ error: "Client și ziua sunt obligatorii" });
  const targetUser = (req.role !== "agent" && agent_username) ? agent_username : req.username;
  try {
    db.prepare(`INSERT OR REPLACE INTO beat_plans (agent_username, client_id, day_of_week, visit_frequency, priority, notes) VALUES (?,?,?,?,?,?)`)
      .run(targetUser, client_id, day_of_week, visit_frequency || "weekly", priority || 0, notes || "");
    res.json({ ok: true });
  } catch (e) {
    console.error("[Error]", e.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ── GET /api/beat-plan ── Get beat plan ── */
app.get("/api/beat-plan", auth, (req, res) => {
  const targetUser = (req.role === "agent") ? req.username : (req.query.agent || "");
  let rows;
  if (targetUser) {
    rows = db.prepare(`
      SELECT bp.*, c.firma, c.nume_poc, c.oras, c.lat, c.lon, c.agent FROM beat_plans bp
      LEFT JOIN clients c ON bp.client_id = c.id WHERE bp.agent_username=? ORDER BY bp.day_of_week, bp.priority DESC
    `).all(targetUser);
  } else {
    rows = db.prepare(`
      SELECT bp.*, c.firma, c.nume_poc, c.oras, c.lat, c.lon, c.agent FROM beat_plans bp
      LEFT JOIN clients c ON bp.client_id = c.id ORDER BY bp.agent_username, bp.day_of_week, bp.priority DESC
    `).all();
  }
  res.json(rows);
});

/* ── DELETE /api/beat-plan/:id ── Remove from beat plan ── */
app.delete("/api/beat-plan/:id", auth, (req, res) => {
  db.prepare("DELETE FROM beat_plans WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/* ── GET /api/beat-plan/unvisited ── Clients not visited in required period ── */
app.get("/api/beat-plan/unvisited", auth, (req, res) => {
  const targetUser = (req.role === "agent") ? req.username : (req.query.agent || "");
  if (!targetUser) return res.json([]);
  const dayNames = ["Duminică", "Luni", "Marți", "Miercuri", "Joi", "Vineri", "Sâmbătă"];
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Bucharest" }));
  const todayName = dayNames[today.getDay()];
  // Get planned clients for today
  const planned = db.prepare(`
    SELECT bp.*, c.firma, c.nume_poc, c.oras, c.lat, c.lon FROM beat_plans bp
    LEFT JOIN clients c ON bp.client_id = c.id WHERE bp.agent_username=? AND bp.day_of_week=?
  `).all(targetUser, todayName);
  // Check which were visited today
  const todayDate = today.toISOString().split("T")[0];
  const visitedSet = new Set(
    db.prepare("SELECT DISTINCT client_id FROM visits_checkin WHERE username=? AND visit_date=?").all(targetUser, todayDate).map(r => r.client_id)
  );
  const unvisited = planned.filter(p => !visitedSet.has(p.client_id));
  res.json({ day: todayName, planned: planned.length, visited: planned.length - unvisited.length, unvisited });
});

/* ═══════════════════════════════════════════════════
   MODULE 8: EXPIRĂRI / FRESHNESS
   ═══════════════════════════════════════════════════ */

/* ── POST /api/expiry ── Report expiry ── */
app.post("/api/expiry", auth, (req, res) => {
  const { client_id, product_name, batch_number, expiry_date, quantity, action_needed, notes } = req.body;
  if (!client_id || !product_name || !expiry_date) return res.status(400).json({ error: "Client, produs și data expirării sunt obligatorii" });
  db.prepare(`INSERT INTO expiry_reports (client_id, reported_by, product_name, batch_number, expiry_date, quantity, action_needed, notes) VALUES (?,?,?,?,?,?,?,?)`)
    .run(client_id, req.username, product_name, batch_number || "", expiry_date, quantity || 0, action_needed || "collect", notes || "");
  res.json({ ok: true });
});

/* ── GET /api/expiry ── List reports ── */
app.get("/api/expiry", auth, (req, res) => {
  let sql = `SELECT er.*, c.firma, c.nume_poc, c.oras, c.agent FROM expiry_reports er LEFT JOIN clients c ON er.client_id = c.id`;
  const params = [];
  if (req.role === "agent") {
    sql += " WHERE er.reported_by=?";
    params.push(req.username);
  }
  sql += " ORDER BY CASE er.status WHEN 'reported' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, er.expiry_date ASC LIMIT 200";
  res.json(db.prepare(sql).all(...params));
});

/* ── PUT /api/expiry/:id ── Update status (SPV/Admin) ── */
app.put("/api/expiry/:id", auth, (req, res) => {
  const { status, notes } = req.body;
  if (status === "resolved") {
    db.prepare("UPDATE expiry_reports SET status='resolved', resolved_by=?, resolved_at=datetime('now'), notes=COALESCE(?,notes) WHERE id=?")
      .run(req.username, notes || null, req.params.id);
  } else if (status) {
    db.prepare("UPDATE expiry_reports SET status=? WHERE id=?").run(status, req.params.id);
  }
  res.json({ ok: true });
});

/* ── GET /api/expiry/alerts ── Upcoming expirations ── */
app.get("/api/expiry/alerts", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT er.*, c.firma, c.nume_poc, c.oras, c.agent FROM expiry_reports er
    LEFT JOIN clients c ON er.client_id = c.id
    WHERE er.status != 'resolved' AND er.expiry_date <= date('now', '+30 days')
    ORDER BY er.expiry_date ASC LIMIT 100
  `).all();
  res.json(rows);
});

/* ── GET /api/agents/list ── Helper: list all agents (for SPV/Admin dropdowns) ── */
app.get("/api/agents/list", auth, (req, res) => {
  const agents = db.prepare("SELECT id, username, display_name, sales_rep FROM users WHERE role='agent' AND active=1 ORDER BY display_name").all();
  res.json(agents);
});

/* ═══════════ SECȚIUNEA CLIENȚI — API ENDPOINTS ═══════════ */

/* ── Upload config for Excel imports (balances, Coface) ── */
const balanceUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const d = "./uploads/balances"; if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (req, file, cb) => cb(null, `balance_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.xlsx`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: excelFileFilter
});

/* ══════ 1. SOLDURI CRITICE ══════ */

/* POST /api/solduri/upload — Upload balance Excel (SPV/Admin) */
app.post("/api/solduri/upload", auth, balanceUpload.single("file"), (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Doar SPV/Admin pot încărca solduri" });
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  try {

    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: "Fișier Excel gol" });

    const sheetRows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!sheetRows || sheetRows.length === 0) return res.status(400).json({ error: "Fișier Excel gol" });

    const today = new Date().toISOString().slice(0, 10);
    // Clear old data for today
    db.prepare("DELETE FROM critical_balances WHERE upload_date=?").run(today);

    const ins = db.prepare("INSERT INTO critical_balances (client_code, client_name, agent, balance, overdue_days, due_date, upload_date, uploaded_by) VALUES (?,?,?,?,?,?,?,?)");
    let imported = 0;
    const insertTx = db.transaction((rows) => { for (const r of rows) { ins.run(...r); imported++; } });

    // Find header row (look for "cod" or "code" column in first 5 rows)
    let headerRow = 0;
    let colMap = {};
    for (let r = 0; r < Math.min(5, sheetRows.length); r++) {
      const row = sheetRows[r];
      for (let c = 0; c < row.length; c++) {
        const v = String(row[c] || "").toLowerCase().trim();
        if (v.includes("cod")) colMap.code = c;
        if (v.includes("client") || v.includes("firma") || v.includes("denumire")) colMap.name = c;
        if (v.includes("agent") || v.includes("dtr")) colMap.agent = c;
        if (v.includes("sold") || v.includes("balance") || v.includes("rest")) colMap.balance = c;
        if (v.includes("zile") || v.includes("days") || v.includes("intarz") || v.includes("overdue")) colMap.days = c;
        if (v.includes("scaden") || v.includes("due") || v.includes("termen")) colMap.due = c;
      }
      if (colMap.code !== undefined || colMap.balance !== undefined) { headerRow = r; break; }
    }

    const rows = [];
    for (let r = headerRow + 1; r < sheetRows.length; r++) {
      const row = sheetRows[r];
      const code = String(row[colMap.code !== undefined ? colMap.code : 0] || "").trim();
      if (!code) continue;
      const name = String(row[colMap.name !== undefined ? colMap.name : 1] || "").trim();
      const agent = String(row[colMap.agent !== undefined ? colMap.agent : 2] || "").trim().toUpperCase();
      const balance = parseFloat(row[colMap.balance !== undefined ? colMap.balance : 3]) || 0;
      const days = parseInt(row[colMap.days !== undefined ? colMap.days : 4]) || 0;
      const due = row[colMap.due !== undefined ? colMap.due : 5];
      const dueStr = due instanceof Date ? due.toISOString().slice(0, 10) : String(due || "");
      rows.push([code, name, agent, balance, days, dueStr, today, req.username]);
    }
    insertTx(rows);

    res.json({ ok: true, imported, message: `${imported} solduri importate` });
  } catch (ex) {
    console.error("[Solduri upload]", ex.message);
    res.status(500).json({ error: "Eroare import: " + ex.message });
  }
});

/* GET /api/solduri — List critical balances (>60 days) */
app.get("/api/solduri", auth, (req, res) => {
  // Get latest upload date
  const latest = db.prepare("SELECT MAX(upload_date) as d FROM critical_balances").get();
  if (!latest || !latest.d) return res.json([]);

  let sql = `SELECT * FROM critical_balances WHERE upload_date=? AND overdue_days >= 60`;
  const params = [latest.d];

  if (req.role === "agent") {
    // Match agent by sales_rep
    sql += " AND UPPER(agent) = UPPER(?)";
    params.push(req.agentDtr);
  }
  sql += " ORDER BY overdue_days DESC, balance DESC";
  const rows = db.prepare(sql).all(...params);
  res.json({ upload_date: latest.d, data: rows });
});

/* GET /api/solduri/all — All balances (not just >60 days), for SPV */
app.get("/api/solduri/all", auth, (req, res) => {
  const latest = db.prepare("SELECT MAX(upload_date) as d FROM critical_balances").get();
  if (!latest || !latest.d) return res.json([]);
  let sql = `SELECT * FROM critical_balances WHERE upload_date=?`;
  const params = [latest.d];
  if (req.role === "agent") {
    sql += " AND UPPER(agent) = UPPER(?)";
    params.push(req.agentDtr);
  }
  sql += " ORDER BY overdue_days DESC, balance DESC";
  res.json({ upload_date: latest.d, data: db.prepare(sql).all(...params) });
});

/* ══════ SCADENȚAR QUATRO (Import Mentor) ══════ */

const scadentarUpload = multer({ dest: "uploads/", limits: { fileSize: 30 * 1024 * 1024 } });

/* Helper: lookup division for agent name (fuzzy match) */
function lookupDivision(agentName) {
  if (!agentName || agentName === '... nedefinit ...') return 'NECUNOSCUT';
  const clean = agentName.trim().replace(/\s+/g, ' ').toUpperCase();
  // Exact match
  const exact = db.prepare("SELECT division FROM agent_divisions WHERE UPPER(REPLACE(agent_name,'  ',' ')) = ?").get(clean);
  if (exact) return exact.division;
  // Fuzzy: match first + last name
  const parts = clean.split(' ').filter(p => p.length > 1);
  if (parts.length >= 2) {
    const rows = db.prepare("SELECT agent_name, division FROM agent_divisions").all();
    for (const r of rows) {
      const rParts = r.agent_name.toUpperCase().split(' ').filter(p => p.length > 1);
      if (parts[0] === rParts[0] && parts.some(p => rParts.includes(p) && p !== parts[0])) return r.division;
    }
  }
  return 'NECUNOSCUT';
}

/* POST /api/scadentar/upload — Upload Scadențar Quatro Excel */
app.post("/api/scadentar/upload", auth, scadentarUpload.single("file"), (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Doar SPV/Admin pot încărca scadențarul" });
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  try {
    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: "Fișier Excel gol" });
    const rows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!rows || rows.length < 3) return res.status(400).json({ error: "Fișier prea scurt" });

    // Detect column count to handle both formats (8-col divisional, 10-col BB, 12-col Quatro)
    const numCols = rows[0] ? rows[0].length : 0;

    const today = new Date().toISOString().slice(0, 10);
    // Delete previous import for same date
    const oldImport = db.prepare("SELECT id FROM scadentar_imports WHERE import_date=?").get(today);
    if (oldImport) {
      db.prepare("DELETE FROM scadentar WHERE import_id=?").run(oldImport.id);
      db.prepare("DELETE FROM scadentar_imports WHERE id=?").run(oldImport.id);
    }

    const ins = db.prepare(`INSERT INTO scadentar (import_id, nr_crt, partener, valoare, rest, document, depasire_termen, agent, serie_document, cifra_afaceri_curent, cifra_afaceri_prec, cod_fiscal, blocat, divizie) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    let imported = 0;
    let totalRest = 0;
    const dataRows = [];

    // Data starts at row 3 (index 2), skip header rows and total rows
    for (let i = 2; i < rows.length; i++) {
      const r = rows[i];
      const nrCrt = r[0];
      // Skip total rows and empty rows
      if (nrCrt === undefined || nrCrt === null || nrCrt === '') continue;
      if (typeof nrCrt === 'string' && (nrCrt.startsWith('Total') || nrCrt.startsWith('TOTAL'))) continue;

      const partener = String(r[1] || '').trim();
      if (!partener) continue;

      const valoare = parseFloat(r[2]) || 0;
      const rest = parseFloat(r[3]) || 0;
      const document_str = String(r[4] || '').trim();
      const depasire = parseInt(r[5]) || 0;
      const agent = String(r[6] || '').trim();
      const serie = String(r[7] || '').trim();

      // Extra columns for Quatro/BB format
      const cifraC = numCols >= 9 ? (parseFloat(r[8]) || 0) : 0;
      const cifraP = numCols >= 10 ? (parseFloat(r[9]) || 0) : 0;
      const codFiscal = numCols >= 11 ? String(r[10] || '').trim() : '';
      const blocat = numCols >= 12 ? String(r[11] || 'NU').trim() : 'NU';

      const div = lookupDivision(agent);
      totalRest += rest;
      dataRows.push([nrCrt, partener, valoare, rest, document_str, depasire, agent, serie, cifraC, cifraP, codFiscal, blocat, div]);
    }

    // Create import record
    const impResult = db.prepare("INSERT INTO scadentar_imports (filename, import_date, total_rows, total_rest_plata, imported_by) VALUES (?,?,?,?,?)").run(req.file.originalname, today, dataRows.length, totalRest, req.username);
    const importId = impResult.lastInsertRowid;

    const insertTx = db.transaction((rows) => {
      for (const r of rows) {
        ins.run(importId, ...r);
        imported++;
      }
    });
    insertTx(dataRows);

    // Cleanup upload
    try { fs.unlinkSync(req.file.path); } catch {}

    // Count by division
    const divCounts = db.prepare("SELECT divizie, COUNT(*) as cnt, SUM(rest) as total_rest FROM scadentar WHERE import_id=? GROUP BY divizie ORDER BY total_rest DESC").all(importId);

    res.json({ ok: true, imported, total_rest: totalRest, divisions: divCounts, message: `${imported} facturi importate din scadențar` });
  } catch (ex) {
    console.error("[Scadentar upload]", ex.message);
    res.status(500).json({ error: "Eroare import: " + ex.message });
  }
});

/* GET /api/scadentar — List scadentar data with filters */
app.get("/api/scadentar", auth, (req, res) => {
  const latestImport = db.prepare("SELECT * FROM scadentar_imports ORDER BY id DESC LIMIT 1").get();
  if (!latestImport) return res.json({ import: null, data: [], summary: {} });

  const { divizie, agent, min_depasire, max_depasire, partener, blocat } = req.query;
  let sql = "SELECT * FROM scadentar WHERE import_id=? AND depasire_termen <= 1000 AND rest > 10";
  const params = [latestImport.id];

  // Agent sees only their clients
  if (req.role === "agent") {
    const agentBase = (req.agentDtr || '').replace(/\s*(BB\d+|BBH\d+|JTI\d+|URS\d+)\s*$/i, '').trim().toUpperCase();
    sql += " AND UPPER(REPLACE(agent,'  ',' ')) LIKE ?";
    params.push('%' + agentBase + '%');
  }

  if (divizie && divizie !== 'ALL') { sql += " AND divizie=?"; params.push(divizie); }
  if (agent) { sql += " AND UPPER(agent) LIKE ?"; params.push('%' + agent.toUpperCase() + '%'); }
  if (min_depasire) { sql += " AND depasire_termen >= ?"; params.push(parseInt(min_depasire)); }
  if (max_depasire) { sql += " AND depasire_termen <= ?"; params.push(parseInt(max_depasire)); }
  if (partener) { sql += " AND UPPER(partener) LIKE ?"; params.push('%' + partener.toUpperCase() + '%'); }
  if (blocat === 'DA') { sql += " AND blocat='DA'"; }

  sql += " ORDER BY depasire_termen DESC, rest DESC";
  const data = db.prepare(sql).all(...params);

  // Summary per division
  const summary = db.prepare(`SELECT divizie, COUNT(*) as cnt, SUM(rest) as total_rest, AVG(depasire_termen) as avg_depasire, MAX(depasire_termen) as max_dep FROM scadentar WHERE import_id=? AND depasire_termen <= 1000 AND rest > 10 GROUP BY divizie ORDER BY total_rest DESC`).all(latestImport.id);

  // Summary per agent (for the filtered data)
  let agentSql = "SELECT agent, divizie, COUNT(*) as cnt, SUM(rest) as total_rest FROM scadentar WHERE import_id=? AND depasire_termen <= 1000 AND rest > 10";
  const agentParams = [latestImport.id];
  if (req.role === "agent") {
    const agentBase = (req.agentDtr || '').replace(/\s*(BB\d+|BBH\d+|JTI\d+|URS\d+)\s*$/i, '').trim().toUpperCase();
    agentSql += " AND UPPER(REPLACE(agent,'  ',' ')) LIKE ?";
    agentParams.push('%' + agentBase + '%');
  }
  if (divizie && divizie !== 'ALL') { agentSql += " AND divizie=?"; agentParams.push(divizie); }
  agentSql += " GROUP BY agent ORDER BY total_rest DESC";
  const agentSummary = db.prepare(agentSql).all(...agentParams);

  res.json({ import: latestImport, data, summary, agentSummary });
});

/* GET /api/scadentar/agents — Agents for cascading dropdown */
app.get("/api/scadentar/agents", auth, (req, res) => {
  const latestImport = db.prepare("SELECT id FROM scadentar_imports ORDER BY id DESC LIMIT 1").get();
  if (!latestImport) return res.json({ agents: [] });
  const div = req.query.divizie;
  let sql = "SELECT DISTINCT agent, divizie, COUNT(*) as cnt, SUM(rest) as total_rest FROM scadentar WHERE import_id=? AND agent != '' AND agent != '... nedefinit ...' AND depasire_termen <= 1000 AND rest > 10";
  const params = [latestImport.id];
  if (div && div !== 'ALL') { sql += " AND divizie=?"; params.push(div); }
  sql += " GROUP BY agent ORDER BY agent";
  res.json({ agents: db.prepare(sql).all(...params) });
});

/* GET /api/scadentar/partners — Partners for cascading dropdown */
app.get("/api/scadentar/partners", auth, (req, res) => {
  const latestImport = db.prepare("SELECT id FROM scadentar_imports ORDER BY id DESC LIMIT 1").get();
  if (!latestImport) return res.json({ partners: [] });
  const { agent, divizie } = req.query;
  let sql = "SELECT DISTINCT partener, COUNT(*) as cnt, SUM(rest) as total_rest FROM scadentar WHERE import_id=? AND partener != '' AND depasire_termen <= 1000 AND rest > 10";
  const params = [latestImport.id];
  if (agent) { sql += " AND UPPER(agent) LIKE '%' || UPPER(?) || '%'"; params.push(agent); }
  if (divizie && divizie !== 'ALL') { sql += " AND divizie=?"; params.push(divizie); }
  sql += " GROUP BY partener ORDER BY partener";
  res.json({ partners: db.prepare(sql).all(...params) });
});

/* GET /api/scadentar/alerts — Cross-division alerts */
app.get("/api/scadentar/alerts", auth, (req, res) => {
  const latestImport = db.prepare("SELECT id FROM scadentar_imports ORDER BY id DESC LIMIT 1").get();
  if (!latestImport) return res.json([]);

  // Find partners that appear in multiple divisions with positive rest
  const crossDiv = db.prepare(`
    SELECT partener, cod_fiscal,
           GROUP_CONCAT(DISTINCT divizie) as divisions,
           COUNT(DISTINCT divizie) as div_count,
           SUM(rest) as total_rest,
           MAX(depasire_termen) as max_depasire
    FROM scadentar
    WHERE import_id=? AND rest > 10 AND divizie != 'NECUNOSCUT' AND depasire_termen <= 1000
    GROUP BY COALESCE(NULLIF(cod_fiscal,''), partener)
    HAVING div_count > 1
    ORDER BY total_rest DESC
  `).all(latestImport.id);

  // For each cross-div partner, get detail per division
  const alerts = crossDiv.map(p => {
    const details = db.prepare(`
      SELECT divizie, agent, SUM(rest) as rest_div, COUNT(*) as nr_facturi, MAX(depasire_termen) as max_dep
      FROM scadentar WHERE import_id=? AND (partener=? OR (cod_fiscal=? AND cod_fiscal != ''))
      GROUP BY divizie
    `).all(latestImport.id, p.partener, p.cod_fiscal || '___none___');
    return { ...p, details };
  });

  res.json(alerts);
});

/* GET /api/scadentar/imports — Import history */
app.get("/api/scadentar/imports", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const imports = db.prepare("SELECT * FROM scadentar_imports ORDER BY id DESC LIMIT 10").all();
  res.json(imports);
});

/* DELETE /api/scadentar/imports/:id — Delete an import */
app.delete("/api/scadentar/imports/:id", auth, (req, res) => {
  if (req.role !== "admin") return res.status(403).json({ error: "Doar admin" });
  db.prepare("DELETE FROM scadentar WHERE import_id=?").run(req.params.id);
  db.prepare("DELETE FROM scadentar_imports WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/* GET /api/agent-divisions — List agent-division mappings */
app.get("/api/agent-divisions", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM agent_divisions ORDER BY division, agent_name").all());
});

/* POST /api/agent-divisions — Add/update mapping */
app.post("/api/agent-divisions", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const { agent_name, division } = req.body;
  if (!agent_name || !division) return res.status(400).json({ error: "Date lipsă" });
  db.prepare("INSERT OR REPLACE INTO agent_divisions (agent_name, division) VALUES (?,?)").run(agent_name.trim().toUpperCase(), division.trim().toUpperCase());
  res.json({ ok: true });
});

/* ══════ 2. ESCALADĂRI SPV ══════ */

/* POST /api/escalations — Agent creates escalation */
app.post("/api/escalations", auth, (req, res) => {
  const { client_id, message } = req.body;
  if (!client_id) return res.status(400).json({ error: "Client lipsă" });
  const client = db.prepare("SELECT id FROM clients WHERE id=?").get(client_id);
  if (!client) return res.status(404).json({ error: "Client negăsit" });

  // Check for existing pending escalation on this client by this agent
  const existing = db.prepare("SELECT id FROM escalations WHERE client_id=? AND agent_username=? AND status='pending'").get(client_id, req.username);
  if (existing) return res.status(409).json({ error: "Există deja o escaladare activă pentru acest client" });

  db.prepare("INSERT INTO escalations (client_id, agent_username, agent_name, message) VALUES (?,?,?,?)")
    .run(client_id, req.username, req.agentDtr, message || "");
  // Notify SPV/Admin about new escalation
  const cInfo = db.prepare("SELECT firma FROM clients WHERE id=?").get(client_id);
  notifyRole("spv", "🚨 Escaladare nouă", `${req.agentDtr || req.username} a escalat clientul ${cInfo ? cInfo.firma : client_id}`, "escalation", "escaladari");
  notifyRole("admin", "🚨 Escaladare nouă", `${req.agentDtr || req.username} a escalat clientul ${cInfo ? cInfo.firma : client_id}`, "escalation", "escaladari");
  res.json({ ok: true, message: "Escaladare trimisă către SPV" });
});

/* GET /api/escalations — List escalations */
app.get("/api/escalations", auth, (req, res) => {
  let sql = `SELECT e.*, c.firma, c.nume_poc, c.oras, c.agent, c.lat as client_lat, c.lon as client_lon
    FROM escalations e LEFT JOIN clients c ON e.client_id = c.id`;
  const params = [];
  if (req.role === "agent") {
    sql += " WHERE e.agent_username=?";
    params.push(req.username);
  }
  sql += " ORDER BY CASE e.status WHEN 'pending' THEN 0 ELSE 1 END, e.created_at DESC LIMIT 100";
  res.json(db.prepare(sql).all(...params));
});

/* POST /api/escalations/:id/resolve — SPV resolves with photo check-in */
app.post("/api/escalations/:id/resolve", auth, upload.single("photo"), (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Doar SPV/Admin pot rezolva escaladări" });
  const esc = db.prepare("SELECT * FROM escalations WHERE id=?").get(req.params.id);
  if (!esc) return res.status(404).json({ error: "Escaladare negăsită" });
  if (esc.status !== "pending") return res.status(409).json({ error: "Escaladarea a fost deja rezolvată" });

  const { lat, lon, note } = req.body;
  const photoUrl = req.file ? `/uploads/${req.file.filename}` : "";

  db.prepare(`UPDATE escalations SET status='resolved', resolved_by=?, resolved_at=datetime('now'),
    checkin_photo=?, checkin_lat=?, checkin_lon=?, checkin_note=? WHERE id=?`)
    .run(req.username, photoUrl, parseFloat(lat) || null, parseFloat(lon) || null, note || "", req.params.id);

  res.json({ ok: true, message: "Escaladare rezolvată cu check-in" });
});

/* GET /api/escalations/pending-count — Badge count for notifications */
app.get("/api/escalations/pending-count", auth, (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as c FROM escalations WHERE status='pending'").get().c;
  res.json({ count });
});

/* ══════ 3. ALERTĂ CLIENT ══════ */

/* POST /api/client-alerts — Agent creates alert */
app.post("/api/client-alerts", auth, (req, res) => {
  const { client_id, alert_type, reason } = req.body;
  if (!client_id) return res.status(400).json({ error: "Client lipsă" });
  if (!reason) return res.status(400).json({ error: "Motivul este obligatoriu" });

  db.prepare("INSERT INTO client_alerts (client_id, alert_type, reason, reported_by) VALUES (?,?,?,?)")
    .run(client_id, alert_type || "other", reason, req.username);
  // Notify SPV/Admin about new alert
  const alertLabels = { shop_closure: "Închidere magazin", suspicious_stock: "Lipsă marfă", payment_issues: "Probleme plată", other: "Altele" };
  const cInfoA = db.prepare("SELECT firma FROM clients WHERE id=?").get(client_id);
  notifyRole("spv", "⚠️ Alertă client", `${alertLabels[alert_type] || alert_type}: ${cInfoA ? cInfoA.firma : client_id} — ${reason.slice(0, 80)}`, "alert", "alertaClient");
  notifyRole("admin", "⚠️ Alertă client", `${alertLabels[alert_type] || alert_type}: ${cInfoA ? cInfoA.firma : client_id} — ${reason.slice(0, 80)}`, "alert", "alertaClient");
  res.json({ ok: true, message: "Alertă trimisă către SPV" });
});

/* GET /api/client-alerts — List alerts */
app.get("/api/client-alerts", auth, (req, res) => {
  let sql = `SELECT ca.*, c.firma, c.nume_poc, c.oras, c.agent
    FROM client_alerts ca LEFT JOIN clients c ON ca.client_id = c.id`;
  const params = [];
  if (req.role === "agent") {
    sql += " WHERE ca.reported_by=?";
    params.push(req.username);
  }
  sql += " ORDER BY CASE ca.status WHEN 'pending' THEN 0 ELSE 1 END, ca.reported_at DESC LIMIT 100";
  res.json(db.prepare(sql).all(...params));
});

/* POST /api/client-alerts/:id/acknowledge — SPV acknowledges alert */
app.post("/api/client-alerts/:id/acknowledge", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Doar SPV/Admin pot confirma alerte" });
  const alert = db.prepare("SELECT * FROM client_alerts WHERE id=?").get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alertă negăsită" });
  if (alert.status !== "pending") return res.status(409).json({ error: "Alerta a fost deja confirmată" });

  db.prepare("UPDATE client_alerts SET status='acknowledged', acknowledged_by=?, acknowledged_at=datetime('now') WHERE id=?")
    .run(req.username, req.params.id);
  res.json({ ok: true });
});

/* GET /api/client-alerts/pending-count — Badge count */
app.get("/api/client-alerts/pending-count", auth, (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as c FROM client_alerts WHERE status='pending'").get().c;
  res.json({ count });
});

/* ══════ 4. ALERTĂ RISC FINANCIAR (Coface) ══════ */

/* POST /api/financial-risk/upload — Upload Coface Excel */
app.post("/api/financial-risk/upload", auth, balanceUpload.single("file"), (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Doar SPV/Admin pot încărca rapoarte Coface" });
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  try {

    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: "Fișier Excel gol" });

    const sheetRows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!sheetRows || sheetRows.length === 0) return res.status(400).json({ error: "Fișier Excel gol" });

    const today = new Date().toISOString().slice(0, 10);
    db.prepare("DELETE FROM financial_risks WHERE upload_date=?").run(today);

    const ins = db.prepare("INSERT INTO financial_risks (client_code, client_name, risk_score, risk_details, upload_date, uploaded_by) VALUES (?,?,?,?,?,?)");
    let imported = 0;

    // Auto-detect columns
    let colMap = {};
    for (let r = 0; r < Math.min(5, sheetRows.length); r++) {
      const row = sheetRows[r];
      for (let c = 0; c < row.length; c++) {
        const v = String(row[c] || "").toLowerCase().trim();
        if (v.includes("cod") || v.includes("cui") || v.includes("cif")) colMap.code = c;
        if (v.includes("client") || v.includes("firma") || v.includes("denumire") || v.includes("name")) colMap.name = c;
        if (v.includes("scor") || v.includes("score") || v.includes("rating") || v.includes("risc") || v.includes("risk")) colMap.score = c;
        if (v.includes("detalii") || v.includes("details") || v.includes("motiv") || v.includes("observ")) colMap.details = c;
      }
      if (colMap.code !== undefined || colMap.name !== undefined) break;
    }

    const insertTx = db.transaction(() => {
      for (let r = 1; r < sheetRows.length; r++) {
        const row = sheetRows[r];
        const code = String(row[colMap.code !== undefined ? colMap.code : 0] || "").trim();
        if (!code) continue;
        const name = String(row[colMap.name !== undefined ? colMap.name : 1] || "").trim();
        const score = String(row[colMap.score !== undefined ? colMap.score : 2] || "").trim();
        const details = String(row[colMap.details !== undefined ? colMap.details : 3] || "").trim();
        ins.run(code, name, score, details, today, req.username);
        imported++;
      }
    });
    insertTx();
    res.json({ ok: true, imported, message: `${imported} clienți risc importați` });
  } catch (ex) {
    console.error("[Coface upload]", ex.message);
    res.status(500).json({ error: "Eroare import: " + ex.message });
  }
});

/* GET /api/financial-risk — List financial risks */
app.get("/api/financial-risk", auth, (req, res) => {
  const latest = db.prepare("SELECT MAX(upload_date) as d FROM financial_risks").get();
  if (!latest || !latest.d) return res.json([]);
  const rows = db.prepare("SELECT * FROM financial_risks WHERE upload_date=? ORDER BY risk_score DESC, client_name ASC").all(latest.d);
  res.json({ upload_date: latest.d, data: rows });
});

/* ══════ 5. VERIFICARE CUI ══════ */

/* POST /api/cui-verify — Save CUI verification */
app.post("/api/cui-verify", auth, (req, res) => {
  const { client_id, cui, company_name, address, administrator, guarantor, phone, id_series, id_number, email, gdpr_accepted } = req.body;
  if (!cui) return res.status(400).json({ error: "CUI este obligatoriu" });

  db.prepare(`INSERT INTO cui_verifications (client_id, cui, company_name, address, administrator, guarantor, phone, id_series, id_number, email, verified_by, gdpr_accepted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(client_id || null, cui, company_name || "", address || "", administrator || "", guarantor || "", phone || "", id_series || "", id_number || "", email || "", req.username, gdpr_accepted ? 1 : 0);
  res.json({ ok: true, message: "Verificare CUI salvată" });
});

/* GET /api/cui-verify — List verifications */
app.get("/api/cui-verify", auth, (req, res) => {
  let sql = `SELECT cv.*, c.firma, c.nume_poc, c.oras, c.agent FROM cui_verifications cv LEFT JOIN clients c ON cv.client_id = c.id`;
  const params = [];
  if (req.role === "agent") {
    sql += " WHERE cv.verified_by=?";
    params.push(req.username);
  }
  sql += " ORDER BY cv.verified_at DESC LIMIT 100";
  res.json(db.prepare(sql).all(...params));
});

/* GET /api/cui-verify/:id — Get single verification */
app.get("/api/cui-verify/:id", auth, (req, res) => {
  const row = db.prepare(`SELECT cv.*, c.firma, c.nume_poc, c.oras, c.agent FROM cui_verifications cv LEFT JOIN clients c ON cv.client_id = c.id WHERE cv.id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: "Verificare negăsită" });
  res.json(row);
});

/* POST /api/cui-lookup/:cui — Lookup CUI via ANAF API */
app.post("/api/cui-lookup/:cui", auth, async (req, res) => {
  const cui = req.params.cui.replace(/^RO/i, "").trim();
  if (!cui || isNaN(cui)) return res.status(400).json({ error: "CUI invalid" });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const response = await fetch("https://webservicesp.anaf.ro/AsynchWebService/api/v8/ws/tva", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ cui: parseInt(cui), data: today }])
    });
    const data = await response.json();
    if (data.found && data.found.length > 0) {
      const info = data.found[0];
      res.json({
        ok: true,
        cui: info.date_generale?.cui || cui,
        name: info.date_generale?.denumire || "",
        address: info.date_generale?.adresa || "",
        phone: info.date_generale?.telefon || "",
        status: info.date_generale?.stare_inregistrare || ""
      });
    } else {
      res.json({ ok: false, error: "CUI negăsit în baza ANAF" });
    }
  } catch (ex) {
    console.error("[CUI lookup]", ex.message);
    res.json({ ok: false, error: "Eroare la verificare ANAF: " + ex.message });
  }
});

/* ══════ END SECȚIUNEA CLIENȚI ══════ */

/* ═══════════ SECȚIUNEA PERFORMANȚĂ — API ENDPOINTS ═══════════ */

/* ══════ 1. PERFORMANȚĂ TARGETE (per producător) ══════ */

/* POST /api/producer-targets/upload — Upload producer targets Excel (SPV/Admin) */
app.post("/api/producer-targets/upload", auth, balanceUpload.single("file"), (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  try {

    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: "Fișier Excel gol" });

    const sheetRows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!sheetRows || sheetRows.length === 0) return res.status(400).json({ error: "Fișier Excel gol" });

    const month = req.body.month || new Date().toISOString().slice(0, 7);
    const producer = req.body.producer || "BB";
    let headers = {};
    const headerRow = sheetRows[0] || [];
    headerRow.forEach((val, col) => {
      const v = String(val || "").toLowerCase().trim();
      if (v.includes("agent") || v.includes("nume")) headers.agent = col;
      if (v.includes("valoare") || v.includes("target") || v.includes("val")) headers.val = col;
      if (v.includes("hl") || v.includes("hectolitr")) headers.hl = col;
      if (v.includes("client")) headers.clienti = col;
    });
    if (headers.agent === undefined) return res.status(400).json({ error: "Coloana 'Agent' negăsită" });

    const ins = db.prepare("INSERT OR REPLACE INTO producer_targets (month, agent_name, producer, target_val, target_hl, target_clienti, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let count = 0;
    const txn = db.transaction(() => {
      for (let i = 1; i < sheetRows.length; i++) {
        const row = sheetRows[i];
        const agent = String(row[headers.agent] || "").trim();
        if (!agent) continue;
        const val = Number(row[headers.val !== undefined ? headers.val : 0]) || 0;
        const hl = Number(row[headers.hl !== undefined ? headers.hl : 0]) || 0;
        const clienti = Number(row[headers.clienti !== undefined ? headers.clienti : 0]) || 0;
        ins.run(month, agent, producer, val, hl, clienti, req.username);
        count++;
      }
    });
    txn();
    res.json({ ok: true, count, month, producer });
  } catch (ex) {
    console.error("[Producer targets upload]", ex.message);
    res.status(500).json({ error: ex.message });
  }
});

/* GET /api/producer-targets — Get targets by producer & month */
app.get("/api/producer-targets", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  const producer = req.query.producer || "";
  let rows;
  if (producer) {
    rows = db.prepare("SELECT * FROM producer_targets WHERE month=? AND producer=? ORDER BY agent_name").all(month, producer);
  } else {
    rows = db.prepare("SELECT * FROM producer_targets WHERE month=? ORDER BY producer, agent_name").all(month);
  }
  // Agent filtering
  if (req.role === "agent" && req.agentDtr) {
    const agentUpper = req.agentDtr.toUpperCase();
    rows = rows.filter(r => r.agent_name.toUpperCase().includes(agentUpper));
  }
  res.json({ month, targets: rows });
});

/* ══════ 1b. TARGET CALCULATOR — Distribuție automată pe agenți ══════ */

/* POST /api/target-calc/config — Save seasonal coefficients + growth */
app.post("/api/target-calc/config", auth, adminOnly, (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: "Config key lipsă" });
    db.prepare("INSERT OR REPLACE INTO target_calc_config (config_key, config_value) VALUES (?, ?)").run(key, JSON.stringify(value));
    res.json({ ok: true });
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

/* GET /api/target-calc/config — Get all config */
app.get("/api/target-calc/config", auth, (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM target_calc_config").all();
    const config = {};
    for (const r of rows) {
      try { config[r.config_key] = JSON.parse(r.config_value); } catch(e) { config[r.config_key] = r.config_value; }
    }
    res.json({ config });
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

/* POST /api/target-calc/compute — Compute targets from producer total → per agent */
app.post("/api/target-calc/compute", auth, adminOnly, (req, res) => {
  try {
    const { month, producer, total_val, total_hl, agents_config } = req.body;
    // month: "2026-02", producer: "BB"
    // total_val: total target valoare, total_hl: total target HL
    // agents_config: [ { agent_name, weight_pct, manual_adj_pct } ]

    if (!month || !producer) return res.status(400).json({ error: "Lună și producător sunt obligatorii" });
    if (!agents_config || !agents_config.length) return res.status(400).json({ error: "Lista agenți lipsă" });

    const totalVal = Number(total_val) || 0;
    const totalHl = Number(total_hl) || 0;

    // Normalize weights to sum to 100%
    let totalWeight = agents_config.reduce((s, a) => s + (Number(a.weight_pct) || 0), 0);
    if (totalWeight === 0) totalWeight = agents_config.length; // fallback: equal distribution

    const ins = db.prepare(`INSERT OR REPLACE INTO target_calc_results
      (month, agent_name, producer, weight_pct, target_val, target_hl, manual_adj_pct, final_target_val, final_target_hl)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const results = [];
    const txn = db.transaction(() => {
      for (const ac of agents_config) {
        const name = String(ac.agent_name || "").trim();
        if (!name) continue;
        const weight = (Number(ac.weight_pct) || (100 / agents_config.length)) / totalWeight * 100;
        const adj = Number(ac.manual_adj_pct) || 0;

        const baseVal = totalVal * weight / 100;
        const baseHl = totalHl * weight / 100;
        const finalVal = Math.round(baseVal * (1 + adj / 100));
        const finalHl = Math.round(baseHl * (1 + adj / 100) * 100) / 100;

        ins.run(month, name, producer, Math.round(weight * 100) / 100, Math.round(baseVal), Math.round(baseHl * 100) / 100, adj, finalVal, finalHl);
        results.push({ agent_name: name, weight_pct: Math.round(weight * 100) / 100, base_val: Math.round(baseVal), base_hl: Math.round(baseHl * 100) / 100, adj, final_val: finalVal, final_hl: finalHl });
      }
    });
    txn();

    // Also write into producer_targets for integration with existing obiective system
    const ptIns = db.prepare("INSERT OR REPLACE INTO producer_targets (month, agent_name, producer, target_val, target_hl, target_clienti, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const ptTxn = db.transaction(() => {
      for (const r of results) {
        ptIns.run(month, r.agent_name, producer, r.final_val, r.final_hl, 0, req.username);
      }
    });
    ptTxn();

    res.json({ ok: true, count: results.length, total_val: totalVal, total_hl: totalHl, results });
  } catch (ex) {
    console.error("[target-calc compute]", ex.message);
    res.status(500).json({ error: ex.message });
  }
});

/* GET /api/target-calc/results — Get calculated targets for month */
app.get("/api/target-calc/results", auth, (req, res) => {
  try {
    const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
    const producer = req.query.producer || "";
    let rows;
    if (producer) {
      rows = db.prepare("SELECT * FROM target_calc_results WHERE month=? AND producer=? ORDER BY agent_name").all(month, producer);
    } else {
      rows = db.prepare("SELECT * FROM target_calc_results WHERE month=? ORDER BY producer, agent_name").all(month);
    }
    res.json({ month, results: rows });
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

/* POST /api/target-calc/auto-weights — Calculate agent weights from historical sales */
app.post("/api/target-calc/auto-weights", auth, adminOnly, (req, res) => {
  try {
    const { producer, months_back } = req.body;
    // Look at last N months of sales_data to determine each agent's share
    const mb = Number(months_back) || 3;

    // Get all BB agents from users table
    const bbUsers = db.prepare("SELECT agent_dtr FROM users WHERE agent_dtr LIKE '%BB%' OR role='agent'").all();

    // Get recent sales data
    const now = new Date();
    const startMonth = new Date(now.getFullYear(), now.getMonth() - mb, 1).toISOString().slice(0, 7);
    const salesRows = db.prepare("SELECT agent_name, SUM(total_val) as total_val, SUM(total_hl) as total_hl FROM sales_data WHERE month >= ? GROUP BY agent_name").all(startMonth);

    if (!salesRows.length) {
      // Fallback: use gt_targets
      const gtRows = db.prepare("SELECT agent_name, SUM(real_core + real_abi + real_total) as total_gt FROM gt_targets WHERE month >= ? GROUP BY agent_name").all(startMonth);
      if (gtRows.length) {
        const totalGt = gtRows.reduce((s, r) => s + (r.total_gt || 0), 0);
        const weights = gtRows.map(r => ({
          agent_name: r.agent_name,
          weight_pct: totalGt > 0 ? Math.round(r.total_gt / totalGt * 10000) / 100 : 0,
          source: "gt_targets"
        }));
        return res.json({ ok: true, weights, source: "gt_targets", months_back: mb });
      }
      return res.json({ ok: true, weights: [], source: "none", message: "Nu există date istorice de vânzări" });
    }

    const totalVal = salesRows.reduce((s, r) => s + (r.total_val || 0), 0);
    const weights = salesRows.filter(r => r.total_val > 0).map(r => ({
      agent_name: r.agent_name,
      weight_pct: totalVal > 0 ? Math.round(r.total_val / totalVal * 10000) / 100 : 0,
      total_val: r.total_val,
      source: "sales_data"
    })).sort((a, b) => b.weight_pct - a.weight_pct);

    res.json({ ok: true, weights, source: "sales_data", months_back: mb, total_val: totalVal });
  } catch (ex) {
    console.error("[auto-weights]", ex.message);
    res.status(500).json({ error: ex.message });
  }
});

/* POST /api/target-calc/upload-producer-total — Upload Ursus-style producer target file */
app.post("/api/target-calc/upload-producer-total", auth, adminOnly, gtUpload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
    const month = req.body.month || new Date().toISOString().slice(0, 7);
    const producer = req.body.producer || "BB";

    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: "Fișier Excel gol" });

    // Parse Ursus format: Row 6 has Quatro IS targets
    // Col 93 (CQ) = TOTAL JUDET (HL), Col 94 (CR) = GT total
    // Col 96 = GT CORE, Col 97 = GT PREMIUM
    const sheetRows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });

    let totalHl = 0, totalGt = 0, gtCore = 0, gtPremium = 0;
    let dataRow = null;

    // Find the "Quatro IS" row
    for (let i = 0; i < Math.min(sheetRows.length, 15); i++) {
      const row = sheetRows[i];
      const colB = String(row[1] || "").trim().toLowerCase();
      if (colB.includes("quatro")) {
        dataRow = row;
        break;
      }
    }

    if (!dataRow) {
      // Try row index 5 (row 6 in Excel)
      if (sheetRows.length > 5) dataRow = sheetRows[5];
    }

    if (dataRow) {
      // Search for TOTAL JUDET column (header row 4, index 3)
      const headerRow = sheetRows[3] || [];
      for (let c = 0; c < headerRow.length; c++) {
        const h = String(headerRow[c] || "").toUpperCase();
        if (h.includes("TOTAL JUDET")) totalHl = Number(dataRow[c]) || 0;
        else if (h === "GT" || h.includes("GT") && !h.includes("CORE") && !h.includes("PREMIUM")) {
          if (!totalGt) totalGt = Number(dataRow[c]) || 0;
        }
        else if (h.includes("GT CORE") || h.includes("CORE")) { if (!gtCore) gtCore = Number(dataRow[c]) || 0; }
        else if (h.includes("GT PREMIUM") || h.includes("PREMIUM")) { if (!gtPremium) gtPremium = Number(dataRow[c]) || 0; }
      }
    }

    // Extract per-brand totals
    const brands = {};
    const brandRow = sheetRows[3] || [];
    for (let c = 0; c < brandRow.length; c++) {
      const h = String(brandRow[c] || "").trim();
      if (h.startsWith("Total ") && dataRow) {
        const brandName = h.replace("Total ", "");
        const val = Number(dataRow[c]) || 0;
        if (val > 0) brands[brandName] = val;
      }
    }

    // Save config
    db.prepare("INSERT OR REPLACE INTO target_calc_config (config_key, config_value) VALUES (?, ?)").run(
      `producer_total_${producer}_${month}`,
      JSON.stringify({ month, producer, totalHl, totalGt, gtCore, gtPremium, brands })
    );

    res.json({
      ok: true, month, producer,
      totalHl: Math.round(totalHl * 100) / 100,
      totalGt: Math.round(totalGt),
      gtCore: Math.round(gtCore),
      gtPremium: Math.round(gtPremium),
      brands
    });
  } catch (ex) {
    console.error("[upload-producer-total]", ex.message);
    res.status(500).json({ error: ex.message });
  }
});

/* POST /api/producer-targets/bulk — Bulk set producer targets per agent (admin) */
app.post("/api/producer-targets/bulk", auth, adminOnly, (req, res) => {
  try {
    const { month, targets } = req.body;
    // targets = [{agent_name, producer, target_val, target_unit}]
    if (!month || !Array.isArray(targets)) return res.status(400).json({ error: "month + targets[] obligatorii" });
    const ins = db.prepare(`INSERT OR REPLACE INTO producer_targets (month, agent_name, producer, target_val, target_hl, target_clienti, target_unit, uploaded_by)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)`);
    const tx = db.transaction(() => {
      for (const t of targets) {
        ins.run(month, t.agent_name, t.producer, t.target_val || 0, t.target_unit || "valoare", req.username);
      }
    });
    tx();
    res.json({ ok: true, count: targets.length });
  } catch (ex) { res.status(500).json({ error: ex.message }); }
});

/* GET /api/producer-targets — Get all producer targets for month */
app.get("/api/producer-targets", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  let rows = db.prepare("SELECT * FROM producer_targets WHERE month=? ORDER BY agent_name, producer").all(month);
  // Role filtering
  const FULL_ACCESS_USERS = ["admin", "gmqgd", "robqgd", "mihqgd"];
  if (!FULL_ACCESS_USERS.includes(req.username)) {
    if (req.role === "agent" && req.agentDtr) {
      const norm = normalizeAgentName(req.agentDtr);
      rows = rows.filter(r => normalizeAgentName(r.agent_name) === norm);
    } else if (req.role === "spv" && req.division) {
      const divAgents = db.prepare("SELECT sales_rep FROM users WHERE division=? AND role='agent' AND sales_rep != ''").all(req.division);
      const divSet = new Set(divAgents.map(d => normalizeAgentName(d.sales_rep)));
      rows = rows.filter(r => divSet.has(normalizeAgentName(r.agent_name)));
    }
  }
  res.json({ month, targets: rows });
});

/* ══════ 1c. VÂNZĂRI ALL — Upload + Dashboard ══════ */

/* POST /api/sales-all/upload — Upload fișier zilnic vânzări ALL (suprascrie luna) */
app.post("/api/sales-all/upload", auth, adminOnly, gtUpload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
    const month = req.body.month || new Date().toISOString().slice(0, 7);

    const wb = XLSX_LIB.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: "Fișier Excel gol" });
    const rows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (rows.length < 2) return res.status(400).json({ error: "Fișier gol" });

    // Detect columns from header row
    const hdr = rows[0].map(h => String(h || "").toUpperCase().trim());
    const colMap = {};
    hdr.forEach((h, i) => {
      if (h === "CLIENT") colMap.client = i;
      else if (h === "DENUMIRE") colMap.denumire = i;
      else if (h === "DCI") colMap.dci = i;
      else if (h === "CANT") colMap.cant = i;
      else if (h === "CANTHL") colMap.canthl = i;
      else if (h === "VALOARE") colMap.valoare = i;
      else if (h === "AGENT") colMap.agent = i;
      else if (h === "GAMA") colMap.gama = i;
      else if (h === "NRDOC") colMap.nrdoc = i;
      else if (h === "DATADOC") colMap.datadoc = i;
      else if (h === "CODFISCAL") colMap.codfiscal = i;
      else if (h === "PRET_DISC") colMap.pret_disc = i;
    });

    if (colMap.agent === undefined || colMap.gama === undefined) {
      return res.status(400).json({ error: "Coloanele AGENT și GAMA sunt obligatorii" });
    }

    // DELETE old data for this month (suprascrie!)
    db.prepare("DELETE FROM sales_all WHERE month=?").run(month);

    // Insert new data in batches
    const ins = db.prepare(`INSERT INTO sales_all (month, datadoc, agent_name, gama, denumire, dci, cant, canthl, valoare, client, codfiscal, nrdoc, pret_disc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    let count = 0;
    let skipped = 0;
    const BATCH = 500;
    let batch = [];

    const flush = () => {
      const txn = db.transaction(() => { for (const b of batch) ins.run(...b); });
      txn();
      batch = [];
    };

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const agent = String(r[colMap.agent] || "").trim();
      const gama = String(r[colMap.gama] || "").trim();
      if (!agent || !gama) { skipped++; continue; }

      // Parse date
      let datadoc = "";
      if (colMap.datadoc !== undefined) {
        const raw = r[colMap.datadoc];
        if (raw) {
          const s = String(raw).trim();
          // Handle DD.MM.YYYY or Excel serial or ISO
          if (s.includes(".")) {
            const parts = s.split(".");
            if (parts.length === 3) datadoc = `${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`;
          } else if (s.includes("-")) {
            datadoc = s.slice(0, 10);
          } else if (!isNaN(Number(s))) {
            // Excel serial date
            const d = new Date((Number(s) - 25569) * 86400000);
            datadoc = d.toISOString().slice(0, 10);
          }
        }
      }

      // Filter out non-sales GAMA (garantie, ambalaje) — DISCOUNT rămâne, diminuează valorile!
      const gamaUpper = gama.toUpperCase();
      if (gamaUpper.includes("GARANTIE") || gamaUpper.includes("AMBALAJE")) {
        skipped++;
        continue;
      }

      batch.push([
        month, datadoc, agent, gama,
        String(r[colMap.denumire !== undefined ? colMap.denumire : 0] || "").trim().slice(0, 200),
        String(r[colMap.dci !== undefined ? colMap.dci : 0] || "").trim(),
        Number(r[colMap.cant !== undefined ? colMap.cant : 0]) || 0,
        Number(r[colMap.canthl !== undefined ? colMap.canthl : 0]) || 0,
        Number(r[colMap.valoare !== undefined ? colMap.valoare : 0]) || 0,
        String(r[colMap.client !== undefined ? colMap.client : 0] || "").trim().slice(0, 100),
        String(r[colMap.codfiscal !== undefined ? colMap.codfiscal : 0] || "").trim(),
        String(r[colMap.nrdoc !== undefined ? colMap.nrdoc : 0] || "").trim(),
        Number(r[colMap.pret_disc !== undefined ? colMap.pret_disc : 0]) || 0
      ]);
      count++;

      if (batch.length >= BATCH) flush();
    }
    if (batch.length) flush();

    // Cleanup temp file
    try { require("fs").unlinkSync(req.file.path); } catch(e) {}

    res.json({ ok: true, month, count, skipped, message: `${count} rânduri importate, ${skipped} sărite (garanții/discounturi)` });
  } catch (ex) {
    console.error("[sales-all upload]", ex.message);
    res.status(500).json({ error: ex.message });
  }
});

/* GET /api/sales-all/dashboard — Dashboard target vs realizat per agent per gama */
app.get("/api/sales-all/dashboard", auth, (req, res) => {
  try {
    const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);

    // 0. Build agent name mapping: sales_all names → canonical users.sales_rep
    // This handles mismatches like "CHIRIAC ROMEU" (Excel) → "CHIRIAC ELIAN-ROMEO BB4" (users table)
    const distinctSalesAgents = db.prepare("SELECT DISTINCT agent_name FROM sales_all WHERE month=?").all(month);
    const agentNameToCanonical = {}; // sales_all name (normalized) → canonical sales_rep
    const allUsers = db.prepare("SELECT sales_rep FROM users WHERE role='agent' AND sales_rep != ''").all();
    for (const sa of distinctSalesAgents) {
      const norm = normalizeAgentName(sa.agent_name);
      const match = matchSalesAgentToApp(sa.agent_name);
      if (match) {
        agentNameToCanonical[norm] = normalizeAgentName(match.app_sales_rep);
      } else {
        agentNameToCanonical[norm] = norm; // fallback to self
      }
    }
    // Also map producer_targets names to canonical
    const distinctTargetAgents = db.prepare("SELECT DISTINCT agent_name FROM producer_targets WHERE month=?").all(month);
    for (const ta of distinctTargetAgents) {
      const norm = normalizeAgentName(ta.agent_name);
      const match = matchSalesAgentToApp(ta.agent_name);
      if (match) {
        agentNameToCanonical[norm] = normalizeAgentName(match.app_sales_rep);
      } else if (!agentNameToCanonical[norm]) {
        agentNameToCanonical[norm] = norm;
      }
    }
    // Helper: get canonical agent name
    function canonAgent(name) {
      const norm = normalizeAgentName(name);
      return agentNameToCanonical[norm] || norm;
    }
    console.log(`[dashboard] Agent mapping: ${Object.keys(agentNameToCanonical).length} entries, targets: ${distinctTargetAgents.length}, sales: ${distinctSalesAgents.length}`);

    // 0c. Load all targets upfront (needed by GAMA alias builder)
    const bbTargets = db.prepare("SELECT agent_name, bb_total_val as t_val, bb_total_hl as t_hl, clienti_2sku as t_cl FROM sales_targets WHERE month=?").all(month);
    const bbTargetMap = {};
    for (const t of bbTargets) bbTargetMap[canonAgent(t.agent_name)] = t;
    const gtTargets = db.prepare("SELECT agent_name, target_core, target_abi, target_total, real_core, real_abi, real_total FROM gt_targets WHERE month=?").all(month);
    const gtMap = {};
    for (const g of gtTargets) gtMap[canonAgent(g.agent_name)] = g;
    const prodTargets = db.prepare("SELECT agent_name, producer, target_val, target_hl, target_unit FROM producer_targets WHERE month=?").all(month);
    const ptMap = {};
    for (const p of prodTargets) {
      const key = canonAgent(p.agent_name) + "|" + p.producer.toUpperCase().trim();
      ptMap[key] = p;
    }

    // 0d. Build GAMA alias map: sales GAMA → target producer name
    // Handles: TYMBARKWET→WET, DRYINSTANT+DRYPANGROUP→DRY, SPRING HARGHITA→SPRING,
    //          COTNARI+CVC→COTNARI SI CVC, MELLOW DRINKS+RED BULL+DACARDI+TIBEST→combined
    const gamaAliases = {}; // UPPER(sales gama) → target producer name
    const targetProducerNames = [...new Set(prodTargets.map(p => p.producer))];
    // Build raw sales GAMA list
    const rawGamas = db.prepare("SELECT DISTINCT gama FROM sales_all WHERE month=? AND UPPER(gama) != 'URSUS'").all(month).map(r => r.gama);
    const rawGamasUpper = rawGamas.map(g => g.toUpperCase().trim());

    for (const tp of targetProducerNames) {
      const tpUpper = tp.toUpperCase().trim();
      if (tpUpper === "ALTELE") continue; // ALTELE handled separately
      if (tpUpper.startsWith("URSUS")) continue; // handled by BERG split
      // Direct match?
      if (rawGamasUpper.includes(tpUpper)) { gamaAliases[tpUpper] = tp; continue; }
      // Combined targets: split by " SI " or ","
      let parts = [];
      if (tpUpper.includes(" SI ")) parts = tpUpper.split(" SI ").map(s => s.trim());
      else if (tpUpper.includes(",")) parts = tpUpper.split(",").map(s => s.trim());
      if (parts.length > 1) {
        for (const part of parts) {
          // Exact match for part
          if (rawGamasUpper.includes(part)) { gamaAliases[part] = tp; continue; }
          // Substring: sales GAMA contains the part
          for (const sg of rawGamasUpper) {
            if (!gamaAliases[sg] && sg.includes(part)) gamaAliases[sg] = tp;
          }
        }
        continue;
      }
      // Substring match: any sales GAMA contains target name
      for (const sg of rawGamasUpper) {
        if (!gamaAliases[sg] && sg.includes(tpUpper)) gamaAliases[sg] = tp;
      }
      // Prefix match: any sales GAMA starts with target name
      for (const sg of rawGamasUpper) {
        if (!gamaAliases[sg] && sg.startsWith(tpUpper)) gamaAliases[sg] = tp;
      }
    }
    console.log(`[dashboard] GAMA aliases: ${JSON.stringify(gamaAliases)}`);

    function resolveGama(rawGama) {
      const upper = (rawGama || "").toUpperCase().trim();
      return gamaAliases[upper] || rawGama;
    }

    // 1. Aggregate sales per agent per gama (excl. URSUS — will split into CORE/ABI)
    // COTNARI 5L/10L: dacă denumirea conține 5L sau 10L, cantitatea se înmulțește cu 5/10 (bag-in-box = mai multe sticle)
    const salesAgg = db.prepare(`
      SELECT agent_name, gama,
        SUM(valoare) as total_val,
        SUM(canthl) as total_hl,
        SUM(CASE
          WHEN UPPER(gama) LIKE '%COTNARI%' AND UPPER(denumire) LIKE '%10L%' THEN cant * 10
          WHEN UPPER(gama) LIKE '%COTNARI%' AND UPPER(denumire) LIKE '%5L%' THEN cant * 5
          ELSE cant
        END) as total_cant,
        COUNT(DISTINCT client) as nr_clienti,
        COUNT(*) as nr_linii
      FROM sales_all
      WHERE month=? AND UPPER(gama) != 'URSUS'
      GROUP BY agent_name, gama
      ORDER BY agent_name, gama
    `).all(month);

    // 1b. URSUS split: get individual rows for URSUS to classify into CORE/ABI
    // Uses same logic as BUGET GT: sku_mapping + gt_prices + brand fallback
    // Wrapped in try-catch: if split fails, fallback to simple URSUS aggregation
    const bergAgg = {}; // normAgent → { "Ursus CORE": {...}, "Ursus ABI": {...} }
    let bergSplitOk = false;
    try {
      const bergRows = db.prepare(`
        SELECT agent_name, denumire, valoare, canthl, cant, client
        FROM sales_all
        WHERE month=? AND UPPER(gama) = 'URSUS'
      `).all(month);

      // Build SKU mapping and GT price caches (same as GT import)
      const dashSkuMap = {};
      const dashSkuAll = db.prepare("SELECT denumire_dtr, sku_bb, sku_local FROM sku_mapping").all();
      for (const m of dashSkuAll) {
        const local = (m.sku_local || "").trim();
        dashSkuMap[m.denumire_dtr.toLowerCase()] = local || m.sku_bb;
      }
      const dashPriceMap = {};
      const dashPriceAll = db.prepare("SELECT sku_bb, gt_hl, grupa_obiectiv, brand FROM gt_prices").all();
      for (const p of dashPriceAll) dashPriceMap[p.sku_bb.toLowerCase()] = { gt_hl: p.gt_hl, grupa: p.grupa_obiectiv, brand: p.brand || "" };

      function dashGetGrupa(skuName) {
        const lower = (skuName || "").toLowerCase();
        if (lower.startsWith("ursus") || lower.startsWith("timisoreana")) return "CORE";
        if (lower.startsWith("stella") || lower.startsWith("beck") || lower.startsWith("staropramen") ||
            lower.startsWith("leffe") || lower.startsWith("hoegaarden") || lower.startsWith("corona") ||
            lower.startsWith("franziskaner") || lower.startsWith("fresh 0.0%") || lower.startsWith("fresh na") ||
            lower.startsWith("praha") || lower.startsWith("miller") || lower.startsWith("madri")) return "ABI";
        return "CORE"; // default fallback for unclassified BB products
      }

      for (const r of bergRows) {
        const normAgent = canonAgent(r.agent_name);
        if (!bergAgg[normAgent]) {
          bergAgg[normAgent] = {
            agent_name: r.agent_name,
            "Ursus CORE": { val: 0, hl: 0, cant: 0, clients: new Set(), linii: 0 },
            "Ursus ABI": { val: 0, hl: 0, cant: 0, clients: new Set(), linii: 0 }
          };
        }
        let grupa = "CORE";
        const skuLocal = dashSkuMap[(r.denumire || "").toLowerCase()];
        if (skuLocal) {
          const price = dashPriceMap[skuLocal.toLowerCase()];
          if (price && price.grupa) {
            grupa = price.grupa.toUpperCase().includes("ABI") ? "ABI" : "CORE";
          } else {
            grupa = dashGetGrupa(skuLocal);
          }
        } else {
          grupa = dashGetGrupa(r.denumire || "");
        }
        const key = grupa === "ABI" ? "Ursus ABI" : "Ursus CORE";
        bergAgg[normAgent][key].val += (r.valoare || 0);
        bergAgg[normAgent][key].hl += (r.canthl || 0);
        bergAgg[normAgent][key].cant += (r.cant || 0);
        if (r.client) bergAgg[normAgent][key].clients.add(r.client);
        bergAgg[normAgent][key].linii++;
      }
      bergSplitOk = true;
      console.log(`[dashboard] URSUS split OK: ${bergRows.length} rows → ${Object.keys(bergAgg).length} agents`);
    } catch (bergErr) {
      console.error("[dashboard] URSUS split FAILED, falling back to simple aggregation:", bergErr.message);
      // Fallback: include URSUS in simple aggregation
      const bergFallback = db.prepare(`
        SELECT agent_name, 'URSUS' as gama,
          SUM(valoare) as total_val, SUM(canthl) as total_hl, SUM(cant) as total_cant,
          COUNT(DISTINCT client) as nr_clienti, COUNT(*) as nr_linii
        FROM sales_all WHERE month=? AND UPPER(gama) = 'URSUS'
        GROUP BY agent_name
      `).all(month);
      // Will be handled below as regular salesAgg entries
      salesAgg.push(...bergFallback);
    }

    // 5. Build dashboard data per agent
    const agentMap = {};

    // 5a. Add non-URSUS sales (with GAMA alias resolution — merges TYMBARKWET→WET etc.)
    for (const s of salesAgg) {
      const normAgent = canonAgent(s.agent_name);
      if (!agentMap[normAgent]) {
        agentMap[normAgent] = {
          agent_name: s.agent_name,
          game: {},
          total_val: 0,
          total_hl: 0,
          total_clienti: 0,
          bb_target: bbTargetMap[normAgent] || null,
          gt_target: gtMap[normAgent] || null
        };
      }
      // Resolve GAMA alias (e.g. TYMBARKWET → WET, COTNARI → COTNARI SI CVC)
      const resolvedGama = resolveGama(s.gama);
      // Look up target for this agent+resolved gama
      const ptKey = normAgent + "|" + resolvedGama.toUpperCase().trim();
      const pt = ptMap[ptKey] || null;
      // Merge into existing game entry if already exists (e.g. DRYINSTANT + DRYPANGROUP both → DRY)
      if (agentMap[normAgent].game[resolvedGama]) {
        const existing = agentMap[normAgent].game[resolvedGama];
        existing.val += Math.round(s.total_val);
        existing.hl += Math.round(s.total_hl * 100) / 100;
        existing.cant += s.total_cant;
        existing.clienti += s.nr_clienti;
        existing.linii += s.nr_linii;
      } else {
        agentMap[normAgent].game[resolvedGama] = {
          val: Math.round(s.total_val),
          hl: Math.round(s.total_hl * 100) / 100,
          cant: s.total_cant,
          clienti: s.nr_clienti,
          linii: s.nr_linii,
          target: pt ? pt.target_val : null,
          target_unit: pt ? (pt.target_unit || "valoare") : null
        };
      }
      agentMap[normAgent].total_val += s.total_val;
      agentMap[normAgent].total_hl += s.total_hl;
    }

    // 5b. Add URSUS CORE/ABI from split (only if split succeeded)
    if (bergSplitOk) for (const [normAgent, bdata] of Object.entries(bergAgg)) {
      if (!agentMap[normAgent]) {
        agentMap[normAgent] = {
          agent_name: bdata.agent_name,
          game: {},
          total_val: 0,
          total_hl: 0,
          total_clienti: 0,
          bb_target: bbTargetMap[normAgent] || null,
          gt_target: gtMap[normAgent] || null
        };
      }
      for (const key of ["Ursus CORE", "Ursus ABI"]) {
        const d = bdata[key];
        if (d.val === 0 && d.cant === 0 && d.linii === 0) continue;
        const ptKey = normAgent + "|" + key.toUpperCase().trim();
        const pt = ptMap[ptKey] || null;
        agentMap[normAgent].game[key] = {
          val: Math.round(d.val),
          hl: Math.round(d.hl * 100) / 100,
          cant: d.cant,
          clienti: d.clients.size,
          linii: d.linii,
          target: pt ? pt.target_val : null,
          target_unit: pt ? (pt.target_unit || "valoare") : null
        };
        agentMap[normAgent].total_val += d.val;
        agentMap[normAgent].total_hl += d.hl;
      }
    }

    // Add agents who have targets but no sales yet
    for (const pt of prodTargets) {
      const normAgent = canonAgent(pt.agent_name);
      if (!agentMap[normAgent]) {
        agentMap[normAgent] = {
          agent_name: pt.agent_name,
          game: {},
          total_val: 0,
          total_hl: 0,
          total_clienti: 0,
          bb_target: bbTargetMap[normAgent] || null,
          gt_target: gtMap[normAgent] || null
        };
      }
      // Add target info to game entry even if no sales
      if (!agentMap[normAgent].game[pt.producer]) {
        agentMap[normAgent].game[pt.producer] = { val: 0, hl: 0, cant: 0, clienti: 0, linii: 0, target: pt.target_val, target_unit: pt.target_unit || "valoare" };
      }
    }

    // ALTELE logic: acumulează toate vânzările netargetate în categoria ALTELE
    // (ALTELE = toate vânzările care NU au target specific pe producător)
    for (const k of Object.keys(agentMap)) {
      const agent = agentMap[k];
      let otherVal = 0, otherHl = 0, otherCant = 0, otherClienti = 0, otherLinii = 0;
      const gamaKeys = Object.keys(agent.game);
      const toDelete = [];
      for (const gama of gamaKeys) {
        if (gama.toUpperCase() === "ALTELE") continue; // skip ALTELE itself
        const info = agent.game[gama];
        if (!info.target || info.target <= 0) {
          // Această GAMA nu are target specific → adaugă la ALTELE
          otherVal += (info.val || 0);
          otherHl += (info.hl || 0);
          otherCant += (info.cant || 0);
          otherClienti += (info.clienti || 0);
          otherLinii += (info.linii || 0);
          toDelete.push(gama);
        }
      }
      // Șterge GAMA-urile netargetate individuale
      for (const gm of toDelete) delete agent.game[gm];
      // Adaugă/acumulează în ALTELE
      if (otherVal !== 0 || otherCant !== 0) {
        if (agent.game["ALTELE"]) {
          agent.game["ALTELE"].val += Math.round(otherVal);
          agent.game["ALTELE"].hl += Math.round(otherHl * 100) / 100;
          agent.game["ALTELE"].cant += otherCant;
          agent.game["ALTELE"].clienti += otherClienti;
          agent.game["ALTELE"].linii += otherLinii;
        } else {
          // Verifică dacă există target ALTELE
          const altKey = k + "|ALTELE";
          const altTarget = ptMap[altKey];
          agent.game["ALTELE"] = {
            val: Math.round(otherVal),
            hl: Math.round(otherHl * 100) / 100,
            cant: otherCant,
            clienti: otherClienti,
            linii: otherLinii,
            target: altTarget ? altTarget.target_val : null,
            target_unit: altTarget ? (altTarget.target_unit || "valoare") : null
          };
        }
      }
    }

    // Calculate target_total (CIFRA AFACERI) per agent — use exact Excel value if seeded
    for (const k of Object.keys(agentMap)) {
      const cifraKey = k + "|__CIFRA_AFACERI__";
      const cifraEntry = ptMap[cifraKey];
      let targetTotal = 0;
      if (cifraEntry && cifraEntry.target_val > 0) {
        targetTotal = cifraEntry.target_val;
      } else {
        // Fallback: sum individual targets
        for (const [gama, info] of Object.entries(agentMap[k].game)) {
          if (info.target && info.target_unit === "valoare") targetTotal += info.target;
        }
      }
      agentMap[k].target_total = Math.round(targetTotal);
      agentMap[k].total_val = Math.round(agentMap[k].total_val);
      agentMap[k].total_hl = Math.round(agentMap[k].total_hl * 100) / 100;
      agentMap[k].pct_total = targetTotal > 0 ? Math.round(agentMap[k].total_val / targetTotal * 10000) / 100 : 0;
    }

    // ── Filter: DOAR agenți cu producer_targets (ceilalți sunt din alte divizii) ──
    // Exclude __CIFRA_AFACERI__ from game entries (it's metadata, not a real game)
    for (const k of Object.keys(agentMap)) {
      delete agentMap[k].game["__CIFRA_AFACERI__"];
    }
    const targetAgentSet = new Set(prodTargets.filter(p => p.producer !== "__CIFRA_AFACERI__").map(p => canonAgent(p.agent_name)));
    console.log(`[dashboard] Target agents (${targetAgentSet.size}): ${[...targetAgentSet].join(", ")}`);

    // Role-based filtering:
    // admin, gmqgd, robqgd, mihqgd → see all agents WITH targets
    // spv → see only agents from their division WITH targets
    // agent → see only their own data
    const FULL_ACCESS_USERS = ["admin", "gmqgd", "robqgd", "mihqgd"];
    let agents = Object.values(agentMap).filter(a => targetAgentSet.has(canonAgent(a.agent_name)));
    if (FULL_ACCESS_USERS.includes(req.username)) {
      // Full access — no further filter (already filtered by targetAgentSet)
    } else if (req.role === "agent" && req.agentDtr) {
      const agentUpper = req.agentDtr.toUpperCase();
      agents = agents.filter(a => a.agent_name.toUpperCase().includes(agentUpper));
    } else if (req.role === "spv" && req.division) {
      // SPV sees agents from their division
      const divAgents = db.prepare("SELECT sales_rep FROM users WHERE division=? AND role='agent' AND sales_rep != ''").all(req.division);
      const divSet = new Set(divAgents.map(d => canonAgent(d.sales_rep)));
      agents = agents.filter(a => divSet.has(canonAgent(a.agent_name)));
    }

    // Totals company
    const companyTotal = {
      val: agents.reduce((s, a) => s + a.total_val, 0),
      hl: Math.round(agents.reduce((s, a) => s + a.total_hl, 0) * 100) / 100
    };

    // All GAMA list
    const allGama = [...new Set(salesAgg.map(s => s.gama))].sort();

    // GAMA totals
    const gamaTotals = {};
    for (const s of salesAgg) {
      if (!gamaTotals[s.gama]) gamaTotals[s.gama] = { val: 0, hl: 0 };
      gamaTotals[s.gama].val += Math.round(s.total_val);
      gamaTotals[s.gama].hl += Math.round(s.total_hl * 100) / 100;
    }

    // Row count in DB for this month
    const dbCount = db.prepare("SELECT COUNT(*) as cnt FROM sales_all WHERE month=?").get(month);

    res.json({
      month,
      agents: agents.sort((a, b) => b.total_val - a.total_val),
      allGama,
      gamaTotals,
      companyTotal,
      dbRows: dbCount.cnt,
      producer_targets: prodTargets
    });
  } catch (ex) {
    console.error("[sales-all dashboard]", ex.message);
    res.status(500).json({ error: ex.message });
  }
});

/* GET /api/sales-all/status — Check if data exists for month */
app.get("/api/sales-all/status", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  const cnt = db.prepare("SELECT COUNT(*) as cnt FROM sales_all WHERE month=?").get(month);
  const dates = db.prepare("SELECT DISTINCT datadoc FROM sales_all WHERE month=? ORDER BY datadoc").all(month).map(r => r.datadoc);
  const lastUpload = db.prepare("SELECT MAX(id) as last_id FROM sales_all WHERE month=?").get(month);
  res.json({ month, rows: cnt.cnt, dates, hasData: cnt.cnt > 0 });
});

/* POST /api/sales-all/export-excel — Export dashboard as Excel (server-side) */
app.post("/api/sales-all/export-excel", auth, async (req, res) => {
  try {
    const month = req.body.month || new Date().toISOString().slice(0, 7);
    const dashData = req.body;
    if (!dashData.agents || dashData.agents.length === 0) return res.status(400).json({ error: "No agents data" });

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Dashboard Vanzari");

    const hdrFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF217346" } };
    const hdrFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    const borderThin = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };

    // Collect all targeted producers
    const allProducers = new Set();
    for (const a of dashData.agents) {
      for (const [g, info] of Object.entries(a.game || {})) {
        if (info.target != null && info.target > 0) allProducers.add(g);
      }
    }
    const producers = [...allProducers].sort();

    // Columns
    const cols = [{ header: "Agent", key: "agent", width: 32 }];
    for (const p of producers) {
      cols.push({ header: `${p} Target`, key: `t_${p}`, width: 14 });
      cols.push({ header: `${p} Realizat`, key: `r_${p}`, width: 14 });
      cols.push({ header: `${p} %`, key: `p_${p}`, width: 8 });
    }
    cols.push({ header: "CIFRA AF. Target", key: "cifra_target", width: 16 });
    cols.push({ header: "CIFRA AF. Realizat", key: "cifra_real", width: 16 });
    cols.push({ header: "CIFRA AF. %", key: "cifra_pct", width: 10 });
    ws.columns = cols;

    const hdrRow = ws.getRow(1);
    hdrRow.eachCell(c => { c.fill = hdrFill; c.font = hdrFont; c.border = borderThin; c.alignment = { horizontal: "center" }; });

    for (const a of dashData.agents) {
      const row = { agent: a.agent_name };
      for (const p of producers) {
        const info = (a.game || {})[p];
        if (info && info.target > 0) {
          const isBuc = info.target_unit === "bucati";
          row[`t_${p}`] = info.target;
          row[`r_${p}`] = isBuc ? (info.cant || 0) : (info.val || 0);
          row[`p_${p}`] = info.target > 0 ? Math.round((isBuc ? (info.cant || 0) : (info.val || 0)) / info.target * 100) : 0;
        } else {
          row[`t_${p}`] = 0;
          row[`r_${p}`] = info ? (info.val || 0) : 0;
          row[`p_${p}`] = 0;
        }
      }
      row.cifra_target = a.target_total || 0;
      row.cifra_real = a.total_val || 0;
      row.cifra_pct = a.pct_total || 0;
      const r = ws.addRow(row);
      r.eachCell(c => { c.border = borderThin; });
    }

    // Total row
    const totalRow = { agent: "TOTAL" };
    for (const p of producers) {
      totalRow[`t_${p}`] = dashData.agents.reduce((s, a) => s + ((a.game || {})[p]?.target || 0), 0);
      const isBuc = dashData.agents.some(a => (a.game || {})[p]?.target_unit === "bucati");
      totalRow[`r_${p}`] = dashData.agents.reduce((s, a) => {
        const info = (a.game || {})[p];
        return s + (info ? (isBuc ? (info.cant || 0) : (info.val || 0)) : 0);
      }, 0);
      totalRow[`p_${p}`] = totalRow[`t_${p}`] > 0 ? Math.round(totalRow[`r_${p}`] / totalRow[`t_${p}`] * 100) : 0;
    }
    totalRow.cifra_target = dashData.agents.reduce((s, a) => s + (a.target_total || 0), 0);
    totalRow.cifra_real = dashData.agents.reduce((s, a) => s + (a.total_val || 0), 0);
    totalRow.cifra_pct = totalRow.cifra_target > 0 ? Math.round(totalRow.cifra_real / totalRow.cifra_target * 100) : 0;
    const tRow = ws.addRow(totalRow);
    tRow.eachCell(c => { c.font = { bold: true }; c.border = borderThin; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F5E9" } }; });

    ws.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Dashboard_Vanzari_${month}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (ex) {
    console.error("[export-excel]", ex.message);
    res.status(500).json({ error: ex.message });
  }
});

/* GET /api/divisions — Get division config (admin/spv) */
app.get("/api/divisions", auth, (req, res) => {
  const users = db.prepare("SELECT id, username, display_name, role, sales_rep, division FROM users WHERE role IN ('agent','spv') ORDER BY division, role, display_name").all();
  const divisions = [...new Set(users.filter(u => u.division).map(u => u.division))].sort();
  res.json({ users, divisions });
});

/* POST /api/divisions/assign — Assign users to divisions (admin only) */
app.post("/api/divisions/assign", auth, adminOnly, (req, res) => {
  try {
    const { assignments } = req.body; // [{userId, division}]
    if (!Array.isArray(assignments)) return res.status(400).json({ error: "Format invalid" });
    const upd = db.prepare("UPDATE users SET division=? WHERE id=?");
    const tx = db.transaction(() => {
      for (const a of assignments) {
        upd.run(a.division || "", a.userId);
      }
    });
    tx();
    res.json({ ok: true, count: assignments.length });
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

/* ══════ 2. RANKING AGENȚI ══════ */

/* POST /api/rankings/compute — Compute monthly rankings (SPV/Admin) */
app.post("/api/rankings/compute", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const month = req.body.month || new Date().toISOString().slice(0, 7);

  // Get obiective data
  const targets = db.prepare("SELECT * FROM sales_targets WHERE month=? ORDER BY agent_name").all(month);
  const sales = db.prepare("SELECT * FROM sales_data WHERE month=? ORDER BY agent_name").all(month);
  const salesMap = {};
  for (const s of sales) salesMap[s.agent_name.toUpperCase().trim()] = s;

  // Get visit counts per agent this month
  const visitCounts = db.prepare(`
    SELECT visited_by, COUNT(*) as cnt FROM visits
    WHERE visited_at >= ? AND visited_at < ?
    GROUP BY visited_by
  `).all(month + "-01", month < "9999-12" ? (parseInt(month.split("-")[0]) + (parseInt(month.split("-")[1]) === 12 ? 1 : 0)) + "-" + String(parseInt(month.split("-")[1]) === 12 ? 1 : parseInt(month.split("-")[1]) + 1).padStart(2, "0") + "-01" : "9999-12-31");
  const visitMap = {};
  for (const v of visitCounts) visitMap[v.visited_by.toUpperCase().trim()] = v.cnt;

  // Get avg audit score per agent
  const auditScores = db.prepare(`
    SELECT v.visited_by, AVG(v.score) as avg_score FROM visits v
    WHERE v.visited_at >= ? AND v.visited_at < ? AND v.score > 0
    GROUP BY v.visited_by
  `).all(month + "-01", month < "9999-12" ? (parseInt(month.split("-")[0]) + (parseInt(month.split("-")[1]) === 12 ? 1 : 0)) + "-" + String(parseInt(month.split("-")[1]) === 12 ? 1 : parseInt(month.split("-")[1]) + 1).padStart(2, "0") + "-01" : "9999-12-31");
  const auditMap = {};
  for (const a of auditScores) auditMap[a.visited_by.toUpperCase().trim()] = a.avg_score;

  const rankings = [];
  const ins = db.prepare("INSERT OR REPLACE INTO agent_rankings (month, agent_name, app_sales_rep, kpi_val_pct, kpi_hl_pct, kpi_clienti_pct, kpi_visits, kpi_audit_score, total_score, rank_position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

  for (const t of targets) {
    const s = salesMap[t.agent_name.toUpperCase().trim()] || {};
    const kpiVal = t.bb_total_val > 0 ? Math.round(((s.total_valoare || 0) / t.bb_total_val) * 1000) / 10 : 0;
    const kpiHl = t.bb_total_hl > 0 ? Math.round(((s.total_hl || 0) / t.bb_total_hl) * 1000) / 10 : 0;
    const kpiClienti = t.clienti_2sku > 0 ? Math.round(((s.clienti_2sku || 0) / t.clienti_2sku) * 1000) / 10 : 0;
    const visits = visitMap[t.agent_name.toUpperCase().trim()] || visitMap[t.app_sales_rep.toUpperCase().trim()] || 0;
    const auditScore = auditMap[t.agent_name.toUpperCase().trim()] || auditMap[t.app_sales_rep.toUpperCase().trim()] || 0;

    // Weighted score: 40% value, 20% HL, 20% clients, 10% visits (capped at 100), 10% audit
    const visitScore = Math.min(visits, 100);
    const totalScore = Math.round((kpiVal * 0.4 + kpiHl * 0.2 + kpiClienti * 0.2 + visitScore * 0.1 + auditScore * 0.1) * 10) / 10;

    rankings.push({ agent_name: t.agent_name, app_sales_rep: t.app_sales_rep, kpiVal, kpiHl, kpiClienti, visits, auditScore: Math.round(auditScore * 10) / 10, totalScore });
  }

  // Sort by total score descending
  rankings.sort((a, b) => b.totalScore - a.totalScore);

  const txn = db.transaction(() => {
    rankings.forEach((r, i) => {
      ins.run(month, r.agent_name, r.app_sales_rep, r.kpiVal, r.kpiHl, r.kpiClienti, r.visits, r.auditScore, r.totalScore, i + 1);
    });
  });
  txn();

  res.json({ ok: true, month, count: rankings.length, rankings });
});

/* GET /api/rankings — Get rankings for a month */
app.get("/api/rankings", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  const rows = db.prepare("SELECT * FROM agent_rankings WHERE month=? ORDER BY rank_position").all(month);
  res.json({ month, rankings: rows });
});

/* ══════ 3. CONTROL DISCOUNTURI ══════ */

/* POST /api/discounts/upload — Upload discount analysis Excel (SPV/Admin) */
app.post("/api/discounts/upload", auth, balanceUpload.single("file"), async (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  try {

    const wb = XLSX_LIB.readFile(req.file.path, { cellStyles:false, cellHTML:false, cellFormula:false, cellDates:false, sheetStubs:false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: "Fișier Excel gol" });
    const allRows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    wb.Sheets = {}; wb.SheetNames = [];
    if (allRows.length < 2) return res.status(400).json({ error: "Fișier Excel gol" });

    const month = req.body.month || new Date().toISOString().slice(0, 7);
    let headers = {};
    const hdrRow = allRows[0] || [];
    for (let c = 0; c < hdrRow.length; c++) {
      const v = String(hdrRow[c] || "").toLowerCase().trim();
      if (v.includes("agent")) headers.agent = c;
      if (v.includes("cod") && v.includes("client")) headers.clientCode = c;
      if (v.includes("client") && !v.includes("cod")) headers.clientName = c;
      if (v.includes("produs") || v.includes("articol") || v.includes("denumire")) headers.product = c;
      if (v.includes("lista") || v.includes("list") || v.includes("pret")) headers.listPrice = c;
      if (v.includes("vanzare") || v.includes("sold") || v.includes("vendido")) headers.soldPrice = c;
      if (v.includes("discount") || v.includes("reducere")) headers.discount = c;
      if (v.includes("cantitate") || v.includes("qty")) headers.qty = c;
      if (v.includes("pierdere") || v.includes("loss") || v.includes("diferenta")) headers.loss = c;
    }
    if (headers.agent == null) return res.status(400).json({ error: "Coloana 'Agent' negăsită" });

    // Delete old data for this month
    db.prepare("DELETE FROM discount_alerts WHERE month=?").run(month);

    const ins = db.prepare("INSERT INTO discount_alerts (month, agent, client_code, client_name, product, list_price, sold_price, discount_pct, quantity, total_loss, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    let count = 0;
    const txn = db.transaction(() => {
      for (let r = 1; r < allRows.length; r++) {
        const row = allRows[r] || [];
        const agent = String(row[headers.agent] || "").trim();
        if (!agent) continue;
        const clientCode = String(row[headers.clientCode != null ? headers.clientCode : 0] || "").trim();
        const clientName = String(row[headers.clientName != null ? headers.clientName : 0] || "").trim();
        const product = String(row[headers.product != null ? headers.product : 0] || "").trim();
        const listPrice = Number(row[headers.listPrice != null ? headers.listPrice : 0]) || 0;
        const soldPrice = Number(row[headers.soldPrice != null ? headers.soldPrice : 0]) || 0;
        const discount = headers.discount != null ? (Number(row[headers.discount]) || 0) : (listPrice > 0 ? Math.round(((listPrice - soldPrice) / listPrice) * 1000) / 10 : 0);
        const qty = Number(row[headers.qty != null ? headers.qty : 0]) || 0;
        const loss = headers.loss != null ? (Number(row[headers.loss]) || 0) : ((listPrice - soldPrice) * qty);
        ins.run(month, agent, clientCode, clientName, product, listPrice, soldPrice, discount, qty, loss, req.username);
        count++;
      }
    });
    txn();
    res.json({ ok: true, count, month });
  } catch (ex) {
    console.error("[Discount upload]", ex.message);
    res.status(500).json({ error: ex.message });
  }
});

/* GET /api/discounts — Get discount alerts for a month */
app.get("/api/discounts", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  let rows;
  if (req.role === "agent" && req.agentDtr) {
    rows = db.prepare("SELECT * FROM discount_alerts WHERE month=? AND UPPER(agent) = UPPER(?) ORDER BY total_loss DESC").all(month, req.agentDtr);
  } else {
    // SPV sees top 50 by loss
    rows = db.prepare("SELECT * FROM discount_alerts WHERE month=? ORDER BY total_loss DESC LIMIT 50").all(month);
  }
  const summary = db.prepare("SELECT agent, COUNT(*) as cnt, SUM(total_loss) as total FROM discount_alerts WHERE month=? GROUP BY agent ORDER BY total DESC").all(month);
  res.json({ month, alerts: rows, summary });
});

/* ═══════════ SECȚIUNEA CONTRACTE — API ENDPOINTS ═══════════ */

/* POST /api/contracts — Create new contract */
app.post("/api/contracts", auth, (req, res) => {
  const { client_id, cui, company_name, address, orc_number, administrator, guarantor, guarantor_address, phone, id_series, id_number, email, contract_date, gdpr_accepted } = req.body;
  if (!cui) return res.status(400).json({ error: "CUI obligatoriu" });
  const r = db.prepare("INSERT INTO client_contracts (client_id, cui, company_name, address, orc_number, administrator, guarantor, guarantor_address, phone, id_series, id_number, email, contract_date, gdpr_accepted, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    client_id || null, cui, company_name || "", address || "", orc_number || "", administrator || "", guarantor || "", guarantor_address || "", phone || "", id_series || "", id_number || "", email || "", contract_date || new Date().toISOString().slice(0, 10), gdpr_accepted ? 1 : 0, req.username
  );
  res.json({ ok: true, id: r.lastInsertRowid });
});

/* GET /api/contracts — List contracts */
app.get("/api/contracts", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT cc.*, c.firma, c.code as client_code, c.agent
    FROM client_contracts cc
    LEFT JOIN clients c ON cc.client_id = c.id
    ORDER BY cc.created_at DESC
  `).all();
  // Agent filter
  let filtered = rows;
  if (req.role === "agent" && req.agentDtr) {
    filtered = rows.filter(r => (r.agent || "").toUpperCase() === req.agentDtr.toUpperCase() || r.created_by === req.username);
  }
  res.json(filtered);
});

/* GET /api/contracts/:id — Get single contract */
app.get("/api/contracts/:id", auth, (req, res) => {
  const row = db.prepare("SELECT cc.*, c.firma, c.code as client_code FROM client_contracts cc LEFT JOIN clients c ON cc.client_id = c.id WHERE cc.id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Contract negăsit" });
  res.json(row);
});

/* GET /api/contracts/:id/download-contract — Generate & download filled Contract DOCX */
app.get("/api/contracts/:id/download-contract", auth, async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM client_contracts WHERE id=?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Contract negăsit" });
    const buf = await generateContractB2B({
      denumire_societate: row.company_name || "",
      sediu_social: row.address || "",
      strada: row.street || "",
      numar: row.street_number || "",
      judet: row.county || "",
      adresa_punct_lucru: row.work_point || row.address || "",
      orc_nr: row.orc_number || "",
      cui: row.cui || "",
      iban: row.iban || "",
      banca: row.bank || "",
      administrator: row.administrator || "",
      administrator_functia: row.admin_function || "Administrator",
      fidejusor_nume: row.guarantor || row.administrator || "",
      cnp: row.cnp || ""
    });
    const safeName = (row.company_name || "contract").replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 40);
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="Contract_${safeName}_${row.id}.docx"`
    });
    res.send(buf);
  } catch (e) {
    console.error("Contract generation error:", e);
    res.status(500).json({ error: "Eroare generare contract: " + e.message });
  }
});

/* GET /api/contracts/:id/download-gdpr — Generate & download filled GDPR DOCX */
app.get("/api/contracts/:id/download-gdpr", auth, async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM client_contracts WHERE id=?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Contract negăsit" });
    const buf = await generateGDPRB2B({
      administrator: row.administrator || "",
      fidejusor_nume: row.guarantor || row.administrator || row.company_name || "",
      fidejusor_tel: row.phone || "",
      email: row.email || "",
      fidejusor_ci_seria: row.id_series || "",
      fidejusor_ci_nr: row.id_number || ""
    });
    const safeName = (row.company_name || "gdpr").replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 40);
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="GDPR_${safeName}_${row.id}.docx"`
    });
    res.send(buf);
  } catch (e) {
    console.error("GDPR generation error:", e);
    res.status(500).json({ error: "Eroare generare GDPR: " + e.message });
  }
});

/* ═══════════ CONTRACTE B2C (Evenimente PF) — API ENDPOINTS ═══════════ */

/* GET /api/contracts-b2c — List all B2C contracts (SPV only) */
app.get("/api/contracts-b2c", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const rows = db.prepare("SELECT * FROM contracts_b2c ORDER BY created_at DESC").all();
  res.json(rows);
});

/* POST /api/contracts-b2c — Create new B2C contract */
app.post("/api/contracts-b2c", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const d = req.body;
  const stmt = db.prepare(`INSERT INTO contracts_b2c
    (nume_complet, cnp, ci_seria, ci_nr, ci_emitent, ci_data, localitate, strada, nr_strada, bloc, scara, apartament, judet, telefon, email, tip_eveniment, data_eveniment, pret_total, adresa_livrare, suporta_transport, data_livrare, interval_orar, iban_retur, ci_photo, gdpr_accepted, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const info = stmt.run(
    d.nume_complet||'', d.cnp||'', d.ci_seria||'', d.ci_nr||'', d.ci_emitent||'', d.ci_data||'',
    d.localitate||'', d.strada||'', d.nr_strada||'', d.bloc||'', d.scara||'', d.apartament||'',
    d.judet||'', d.telefon||'', d.email||'', d.tip_eveniment||'', d.data_eveniment||'',
    d.pret_total||'', d.adresa_livrare||'', d.suporta_transport||'Cumpărător',
    d.data_livrare||'', d.interval_orar||'', d.iban_retur||'', d.ci_photo||'',
    d.gdpr_accepted ? 1 : 0, 'activ', req.user
  );
  res.json({ id: info.lastInsertRowid });
});

/* PUT /api/contracts-b2c/:id — Update B2C contract */
app.put("/api/contracts-b2c/:id", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const d = req.body;
  db.prepare(`UPDATE contracts_b2c SET
    nume_complet=?, cnp=?, ci_seria=?, ci_nr=?, ci_emitent=?, ci_data=?,
    localitate=?, strada=?, nr_strada=?, bloc=?, scara=?, apartament=?, judet=?,
    telefon=?, email=?, tip_eveniment=?, data_eveniment=?, pret_total=?,
    adresa_livrare=?, suporta_transport=?, data_livrare=?, interval_orar=?, iban_retur=?,
    gdpr_accepted=?, updated_at=datetime('now') WHERE id=?`).run(
    d.nume_complet||'', d.cnp||'', d.ci_seria||'', d.ci_nr||'', d.ci_emitent||'', d.ci_data||'',
    d.localitate||'', d.strada||'', d.nr_strada||'', d.bloc||'', d.scara||'', d.apartament||'',
    d.judet||'', d.telefon||'', d.email||'', d.tip_eveniment||'', d.data_eveniment||'',
    d.pret_total||'', d.adresa_livrare||'', d.suporta_transport||'Cumpărător',
    d.data_livrare||'', d.interval_orar||'', d.iban_retur||'',
    d.gdpr_accepted ? 1 : 0, req.params.id
  );
  res.json({ ok: true });
});

/* DELETE /api/contracts-b2c/:id */
app.delete("/api/contracts-b2c/:id", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  db.prepare("DELETE FROM contracts_b2c WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/* POST /api/contracts-b2c/:id/ocr-ci — OCR scan CI for B2C */
app.post("/api/contracts-b2c/:id/ocr-ci", auth, upload.single("file"), async (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  try {
    const { extracted, rawText } = await extractFromDocument(req.file.buffer, "buletin");
    // Auto-update the contract with OCR data
    if (req.params.id !== "0") {
      const updates = [];
      const vals = [];
      if (extracted.fidejusor_nume) { updates.push("nume_complet=?"); vals.push(extracted.fidejusor_nume); }
      if (extracted.cnp) { updates.push("cnp=?"); vals.push(extracted.cnp); }
      if (extracted.fidejusor_ci_seria) { updates.push("ci_seria=?"); vals.push(extracted.fidejusor_ci_seria); }
      if (extracted.fidejusor_ci_nr) { updates.push("ci_nr=?"); vals.push(extracted.fidejusor_ci_nr); }
      if (extracted.fidejusor_domiciliu) {
        updates.push("localitate=?"); vals.push(extracted.fidejusor_domiciliu);
      }
      if (updates.length > 0) {
        updates.push("updated_at=datetime('now')");
        vals.push(req.params.id);
        db.prepare(`UPDATE contracts_b2c SET ${updates.join(",")} WHERE id=?`).run(...vals);
      }
    }
    res.json({ ok: true, extracted, rawText: rawText.substring(0, 500) });
  } catch (e) {
    console.error("[B2C OCR] Error:", e);
    res.status(500).json({ error: "Eroare OCR: " + e.message });
  }
});

/* POST /api/contracts-b2c/ocr-preview — OCR scan CI without saving (for new contracts) */
app.post("/api/contracts-b2c/ocr-preview", auth, upload.single("file"), async (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  try {
    const { extracted, rawText } = await extractFromDocument(req.file.buffer, "buletin");
    res.json({ ok: true, extracted, rawText: rawText.substring(0, 500) });
  } catch (e) {
    console.error("[B2C OCR Preview] Error:", e);
    res.status(500).json({ error: "Eroare OCR: " + e.message });
  }
});

/* GET /api/contracts-b2c/:id/download-contract — Generate & download B2C Contract DOCX */
app.get("/api/contracts-b2c/:id/download-contract", auth, async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM contracts_b2c WHERE id=?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Contract B2C negăsit" });
    const buf = await generateContractB2C(row);
    const safeName = (row.nume_complet || "B2C").replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 40);
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="Contract_B2C_${safeName}_${row.id}.docx"`
    });
    res.send(buf);
  } catch (e) {
    console.error("Contract B2C generation error:", e);
    res.status(500).json({ error: "Eroare generare contract B2C: " + e.message });
  }
});

/* GET /api/contracts-b2c/:id/download-gdpr — Generate & download B2C GDPR DOCX */
app.get("/api/contracts-b2c/:id/download-gdpr", auth, async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM contracts_b2c WHERE id=?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Contract B2C negăsit" });
    const buf = await generateGDPRB2C(row);
    const safeName = (row.nume_complet || "B2C").replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 40);
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="GDPR_B2C_${safeName}_${row.id}.docx"`
    });
    res.send(buf);
  } catch (e) {
    console.error("GDPR B2C generation error:", e);
    res.status(500).json({ error: "Eroare generare GDPR B2C: " + e.message });
  }
});

/* POST /api/contracts-b2c/:id/send-email — Send B2C contract + GDPR via email */
app.post("/api/contracts-b2c/:id/send-email", auth, async (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  try {
    const row = db.prepare("SELECT * FROM contracts_b2c WHERE id=?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Contract B2C negăsit" });

    const emailTo = req.body.email || row.email;
    if (!emailTo) return res.status(400).json({ error: "Adresa email lipsește" });

    // Generate both docs
    const contractBuf = await generateContractB2C(row);
    const gdprBuf = await generateGDPRB2C(row);
    const safeName = (row.nume_complet || "B2C").replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 40);

    // Create transport
    const smtpHost = process.env.REPORT_SMTP_HOST;
    const smtpUser = process.env.REPORT_SMTP_USER;
    const smtpPass = process.env.REPORT_SMTP_PASS;
    const smtpPort = parseInt(process.env.REPORT_SMTP_PORT || "587", 10);
    const emailFrom = process.env.REPORT_EMAIL_FROM;
    if (!smtpHost || !smtpUser) return res.status(500).json({ error: "SMTP neconfigurat" });

    const nodemailer = require("nodemailer");
    const transport = nodemailer.createTransport({
      host: smtpHost, port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
      tls: { rejectUnauthorized: false }
    });

    const eveniment = row.tip_eveniment || "eveniment";
    const dataEv = row.data_eveniment || "";

    await transport.sendMail({
      from: emailFrom,
      to: emailTo,
      cc: emailFrom,
      subject: `Contract Vânzare-Cumpărare B2C + Acord GDPR — ${row.nume_complet || "Client"} — ${eveniment}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px">
        <h2 style="color:#2c3e50">Contract Vânzare-Cumpărare B2C</h2>
        <p>Stimate/Stimată <strong>${row.nume_complet || "Client"}</strong>,</p>
        <p>Atașat găsiți contractul de vânzare-cumpărare și acordul GDPR pentru evenimentul <strong>${eveniment}</strong>${dataEv ? ` din data de <strong>${dataEv}</strong>` : ""}.</p>
        <p>Vă rugăm să verificați datele și să ne contactați pentru orice neclaritate.</p>
        <br><p>Cu stimă,<br><strong>QUATRO GRUP DISTRIBUTION S.R.L.</strong><br>Tel: 0232-XXX-XXX<br>Email: ${emailFrom}</p>
      </div>`,
      attachments: [
        { filename: `Contract_B2C_${safeName}.docx`, content: contractBuf },
        { filename: `Acord_GDPR_${safeName}.docx`, content: gdprBuf }
      ]
    });

    // Mark as sent
    db.prepare("UPDATE contracts_b2c SET email_sent=1, email_sent_at=datetime('now') WHERE id=?").run(row.id);
    console.log(`[B2C Email] Contract + GDPR sent to ${emailTo} for contract #${row.id}`);
    res.json({ ok: true, sentTo: emailTo });
  } catch (e) {
    console.error("[B2C Email] Error:", e);
    res.status(500).json({ error: "Eroare trimitere email: " + e.message });
  }
});

/* ═══════════ SECȚIUNEA OBIECTIVE LUNARE — API ENDPOINTS ═══════════ */

/* POST /api/smart-targets — Set SMART targets for an agent/month */
app.post("/api/smart-targets", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const { month, agent_name, app_sales_rep, prev_year_val, prev_month_val, producer_target, seasonal_coeff, growth_coeff, manual_adjustment, computed_target_val, computed_target_hl, computed_target_clienti, final_target_val, notes } = req.body;
  if (!month || !agent_name) return res.status(400).json({ error: "Luna și agentul sunt obligatorii" });

  db.prepare("INSERT OR REPLACE INTO smart_targets (month, agent_name, app_sales_rep, prev_year_val, prev_month_val, producer_target, seasonal_coeff, growth_coeff, computed_target_val, computed_target_hl, computed_target_clienti, manual_adjustment, final_target_val, notes, set_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    month, agent_name, app_sales_rep || "", prev_year_val || 0, prev_month_val || 0, producer_target || 0, seasonal_coeff || 1.0, growth_coeff || 1.0, computed_target_val || 0, computed_target_hl || 0, computed_target_clienti || 0, manual_adjustment || 0, final_target_val || 0, notes || "", req.username
  );
  res.json({ ok: true });
});

/* POST /api/smart-targets/compute — Auto-compute targets for all agents */
app.post("/api/smart-targets/compute", auth, (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  const month = req.body.month || new Date().toISOString().slice(0, 7);
  const seasonalCoeff = req.body.seasonal_coeff || 1.0;
  const growthCoeff = req.body.growth_coeff || 1.0;

  // Parse month
  const [y, m] = month.split("-").map(Number);
  const prevMonth = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`;
  const prevYear = `${y - 1}-${String(m).padStart(2, "0")}`;

  // Get agents from sales_targets
  const agents = db.prepare("SELECT DISTINCT agent_name, app_sales_rep FROM sales_targets WHERE month=? OR month=? ORDER BY agent_name").all(prevMonth, month);
  // Get previous month sales
  const prevMonthSales = db.prepare("SELECT * FROM sales_data WHERE month=?").all(prevMonth);
  const pmMap = {};
  for (const s of prevMonthSales) pmMap[s.agent_name.toUpperCase().trim()] = s;
  // Get previous year sales
  const prevYearSales = db.prepare("SELECT * FROM sales_data WHERE month=?").all(prevYear);
  const pyMap = {};
  for (const s of prevYearSales) pyMap[s.agent_name.toUpperCase().trim()] = s;
  // Get producer targets for this month
  const prodTargets = db.prepare("SELECT * FROM producer_targets WHERE month=?").all(month);
  const ptMap = {};
  for (const p of prodTargets) ptMap[p.agent_name.toUpperCase().trim()] = p;

  const results = [];
  const ins = db.prepare("INSERT OR REPLACE INTO smart_targets (month, agent_name, app_sales_rep, prev_year_val, prev_month_val, producer_target, seasonal_coeff, growth_coeff, computed_target_val, computed_target_hl, computed_target_clienti, final_target_val, set_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");

  const txn = db.transaction(() => {
    for (const a of agents) {
      const key = a.agent_name.toUpperCase().trim();
      const pm = pmMap[key] || {};
      const py = pyMap[key] || {};
      const pt = ptMap[key] || {};

      const prevMonthVal = pm.total_valoare || 0;
      const prevYearVal = py.total_valoare || 0;
      const prodTarget = pt.target_val || 0;

      // Base = max(prev_year * seasonal * growth, prev_month * growth, producer_target)
      const base1 = prevYearVal * seasonalCoeff * growthCoeff;
      const base2 = prevMonthVal * growthCoeff;
      const base3 = prodTarget;
      const computedVal = Math.round(Math.max(base1, base2, base3));
      const computedHl = pt.target_hl || 0;
      const computedClienti = pt.target_clienti || 0;

      ins.run(month, a.agent_name, a.app_sales_rep, prevYearVal, prevMonthVal, prodTarget, seasonalCoeff, growthCoeff, computedVal, computedHl, computedClienti, computedVal, req.username);
      results.push({ agent_name: a.agent_name, computedVal, prevMonthVal, prevYearVal, prodTarget });
    }
  });
  txn();

  res.json({ ok: true, month, count: results.length, targets: results });
});

/* GET /api/smart-targets — Get SMART targets for a month */
app.get("/api/smart-targets", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  let rows = db.prepare("SELECT * FROM smart_targets WHERE month=? ORDER BY agent_name").all(month);
  if (req.role === "agent" && req.agentDtr) {
    const agentUpper = req.agentDtr.toUpperCase();
    rows = rows.filter(r => r.agent_name.toUpperCase().includes(agentUpper) || (r.app_sales_rep || "").toUpperCase() === agentUpper);
  }
  // Compute SPV total
  const spvTotal = {
    final_target_val: rows.reduce((s, r) => s + (r.final_target_val || 0), 0),
    computed_target_hl: rows.reduce((s, r) => s + (r.computed_target_hl || 0), 0),
    computed_target_clienti: rows.reduce((s, r) => s + (r.computed_target_clienti || 0), 0)
  };
  res.json({ month, targets: rows, spv_total: spvTotal });
});

/* ═══════════ SECȚIUNEA BUGETE PROMO — API ENDPOINTS ═══════════ */

/* POST /api/promo-budgets/upload — Upload promo budget Excel (SPV/Admin) */
app.post("/api/promo-budgets/upload", auth, balanceUpload.single("file"), async (req, res) => {
  if (req.role === "agent") return res.status(403).json({ error: "Acces interzis" });
  if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
  try {

    const wb = XLSX_LIB.readFile(req.file.path, { cellStyles:false, cellHTML:false, cellFormula:false, cellDates:false, sheetStubs:false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ error: "Fișier Excel gol" });
    const allRows = XLSX_LIB.utils.sheet_to_json(ws, { header: 1, defval: "" });
    wb.Sheets = {}; wb.SheetNames = [];
    if (allRows.length < 2) return res.status(400).json({ error: "Fișier Excel gol" });

    const month = req.body.month || new Date().toISOString().slice(0, 7);
    let headers = {};
    const hdrRow = allRows[0] || [];
    for (let c = 0; c < hdrRow.length; c++) {
      const v = String(hdrRow[c] || "").toLowerCase().trim();
      if (v.includes("promo") || v.includes("campanie") || v.includes("promotie")) headers.promo = c;
      if (v.includes("agent")) headers.agent = c;
      if (v.includes("buget") && v.includes("total")) headers.totalBudget = c;
      if (v.includes("buget") && v.includes("agent")) headers.agentBudget = c;
      if (v.includes("cheltui") || v.includes("spent")) headers.spent = c;
      if (v.includes("producator") || v.includes("producer")) headers.producer = c;
    }
    if (headers.promo == null && headers.agent == null) return res.status(400).json({ error: "Coloane 'Promo' sau 'Agent' negăsite" });

    // Delete old data for this month
    db.prepare("DELETE FROM promo_budgets WHERE month=?").run(month);

    const ins = db.prepare("INSERT INTO promo_budgets (month, promo_name, producer, total_budget, agent, agent_budget, agent_spent, uploaded_by) VALUES (?,?,?,?,?,?,?,?)");
    let count = 0;
    const txn = db.transaction(() => {
      for (let r = 1; r < allRows.length; r++) {
        const row = allRows[r] || [];
        const promo = String(row[headers.promo != null ? headers.promo : 0] || "").trim();
        if (!promo) continue;
        const agent = String(row[headers.agent != null ? headers.agent : 0] || "").trim();
        const producer = headers.producer != null ? String(row[headers.producer] || "Ursus") : "Ursus";
        const totalBudget = Number(row[headers.totalBudget != null ? headers.totalBudget : 0]) || 0;
        const agentBudget = Number(row[headers.agentBudget != null ? headers.agentBudget : 0]) || 0;
        const spent = Number(row[headers.spent != null ? headers.spent : 0]) || 0;
        ins.run(month, promo, producer, totalBudget, agent, agentBudget, spent, req.username);
        count++;
      }
    });
    txn();
    res.json({ ok: true, count, month });
  } catch (ex) {
    console.error("[Promo budget upload]", ex.message);
    res.status(500).json({ error: ex.message });
  }
});

/* GET /api/promo-budgets — Get promo budgets for a month */
app.get("/api/promo-budgets", auth, (req, res) => {
  const month = (req.query.month && validateMonthFormat(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  let rows = db.prepare("SELECT * FROM promo_budgets WHERE month=? ORDER BY promo_name, agent").all(month);
  if (req.role === "agent" && req.agentDtr) {
    rows = rows.filter(r => (r.agent || "").toUpperCase() === req.agentDtr.toUpperCase() || !r.agent);
  }
  // Summary per promo
  const summary = db.prepare(`
    SELECT promo_name, producer,
           MAX(total_budget) as total_budget,
           SUM(agent_budget) as allocated,
           SUM(agent_spent) as spent,
           COUNT(DISTINCT agent) as agents
    FROM promo_budgets WHERE month=? AND agent != ''
    GROUP BY promo_name ORDER BY promo_name
  `).all(month);
  res.json({ month, budgets: rows, summary });
});

/* POST /api/promo-budgets/update-spent — Update spent amount for an agent's promo */
app.post("/api/promo-budgets/update-spent", auth, (req, res) => {
  const { id, agent_spent } = req.body;
  if (!id) return res.status(400).json({ error: "ID lipsă" });
  db.prepare("UPDATE promo_budgets SET agent_spent=? WHERE id=?").run(agent_spent || 0, id);
  res.json({ ok: true });
});


/* ── Seed changelog entries ── */
try {
  const cnt = db.prepare("SELECT COUNT(*) as c FROM app_changelog").get();
  if (!cnt || cnt.c === 0) {
    const entries = [
      ["v2.0", "2026-02-18", "Notificări in-app", "Sistem complet de notificări cu badge, panou dropdown și marcare citit/necitit.", "general", "feature", "all"],
      ["v2.0", "2026-02-18", "Ce e nou? la login", "Popup automat cu modificările recente la fiecare autentificare.", "general", "feature", "all"],
      ["v2.0", "2026-02-18", "Buton Ajutor pe module", "Buton ❓ pe fiecare modul cu explicații detaliate.", "general", "feature", "all"],
      ["v2.0", "2026-02-18", "Geocodare adresă automată", "Geocodare cu 4 strategii fallback via Nominatim/OpenStreetMap.", "census", "feature", "admin"],
      ["v2.0", "2026-02-18", "Extracție GPS din EXIF foto", "Coordonatele GPS se extrag automat din metadatele pozelor.", "vizite", "feature", "all"],
      ["v2.0", "2026-02-18", "Calendar vizual cu grid", "Calendar lunar cu grid, multi-select clienți, rută Google Maps.", "calendar", "feature", "all"],
      ["v2.0", "2026-02-18", "Modal achiziții client", "Vizualizare ultima achiziție și totaluri per produs (HL + RON).", "calendar", "feature", "all"],
      ["v2.0", "2026-02-18", "Filtre cascadă în Census", "Filtrare oraș → județ în cascadă pentru Census.", "census", "improvement", "all"],
      ["v2.0", "2026-02-18", "Clienți nealocați", "Vizibilitate clienți NEALOCAT în Calendar din aceleași zone.", "calendar", "feature", "all"],
      ["v2.0", "2026-02-18", "No-cache headers", "Fișierele statice nu mai sunt cache-uite, update instant.", "general", "fix", "admin"],
    ];
    const stmt = db.prepare("INSERT INTO app_changelog (version, change_date, title, description, module, change_type, visibility) VALUES (?,?,?,?,?,?,?)");
    entries.forEach(e => stmt.run(...e));
    console.log("[Changelog] Seeded", entries.length, "entries");
  }
} catch(e) { console.error("[Changelog] Seed error:", e.message); }

/* ── SPA fallback ── */
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ═══════════════ TEMPORARY CLEANUP (remove after use) ═════════════════ */
app.post("/api/admin/cleanup-test-data", auth, (req, res) => {
  if (req.role !== "admin") return res.status(403).json({ error: "Admin only" });
  try {
    const report = {};

    // 1. Visits
    report.visits = db.prepare("SELECT COUNT(*) as c FROM visits").get().c;
    db.prepare("DELETE FROM visits").run();

    // 2. Visits checkin
    try { report.visits_checkin = db.prepare("SELECT COUNT(*) as c FROM visits_checkin").get().c; db.prepare("DELETE FROM visits_checkin").run(); } catch(e) {}

    // 3. Status proposals
    report.status_proposals = db.prepare("SELECT COUNT(*) as c FROM status_proposals").get().c;
    db.prepare("DELETE FROM status_proposals").run();

    // 4. Notifications
    report.notifications = db.prepare("SELECT COUNT(*) as c FROM notifications").get().c;
    db.prepare("DELETE FROM notifications").run();

    // 5. Announcements
    report.announcements = db.prepare("SELECT COUNT(*) as c FROM announcements").get().c;
    db.prepare("DELETE FROM announcements").run();

    // 6. Tasks
    report.tasks = db.prepare("SELECT COUNT(*) as c FROM tasks").get().c;
    db.prepare("DELETE FROM tasks").run();

    // 7. GPS locations
    report.gps_locations = db.prepare("SELECT COUNT(*) as c FROM gps_locations").get().c;
    db.prepare("DELETE FROM gps_locations").run();

    // 8. Competition reports
    report.competition_reports = db.prepare("SELECT COUNT(*) as c FROM competition_reports").get().c;
    db.prepare("DELETE FROM competition_reports").run();

    // 9. Fridge audits
    report.fridge_audits = db.prepare("SELECT COUNT(*) as c FROM fridge_audits").get().c;
    db.prepare("DELETE FROM fridge_audits").run();

    // 10. Promo activations
    report.promo_activations = db.prepare("SELECT COUNT(*) as c FROM promo_activations").get().c;
    db.prepare("DELETE FROM promo_activations").run();

    // 11. Beat plans
    report.beat_plans = db.prepare("SELECT COUNT(*) as c FROM beat_plans").get().c;
    db.prepare("DELETE FROM beat_plans").run();

    // 12. Escalations
    report.escalations = db.prepare("SELECT COUNT(*) as c FROM escalations").get().c;
    db.prepare("DELETE FROM escalations").run();

    // 13. Client alerts
    report.client_alerts = db.prepare("SELECT COUNT(*) as c FROM client_alerts").get().c;
    db.prepare("DELETE FROM client_alerts").run();

    // 14. CUI verifications
    report.cui_verifications = db.prepare("SELECT COUNT(*) as c FROM cui_verifications").get().c;
    db.prepare("DELETE FROM cui_verifications").run();

    // 15. Agent rankings
    report.agent_rankings = db.prepare("SELECT COUNT(*) as c FROM agent_rankings").get().c;
    db.prepare("DELETE FROM agent_rankings").run();

    // 16. Expiry reports
    report.expiry_reports = db.prepare("SELECT COUNT(*) as c FROM expiry_reports").get().c;
    db.prepare("DELETE FROM expiry_reports").run();

    // 17. Incasari
    report.incasari = db.prepare("SELECT COUNT(*) as c FROM incasari").get().c;
    db.prepare("DELETE FROM incasari").run();

    // 18. Promotions
    try { report.promotions = db.prepare("SELECT COUNT(*) as c FROM promotions").get().c; db.prepare("DELETE FROM promotions").run(); } catch(e) {}

    // 19. Client contracts
    try { report.client_contracts = db.prepare("SELECT COUNT(*) as c FROM client_contracts").get().c; db.prepare("DELETE FROM client_contracts").run(); } catch(e) {}

    // 20. Smart targets
    try { report.smart_targets = db.prepare("SELECT COUNT(*) as c FROM smart_targets").get().c; db.prepare("DELETE FROM smart_targets").run(); } catch(e) {}

    // 21. Reset user-edited fields on clients (notes, photo_url, contact_person, email)
    db.prepare("UPDATE clients SET notes=NULL, photo_url=NULL WHERE notes IS NOT NULL OR photo_url IS NOT NULL").run();

    res.json({ ok: true, message: "Test data cleaned", report });
  } catch(e) {
    console.error("[Error]", e.message); res.status(500).json({ error: "Operație eșuată. Contactează administratorul." });
  }
});

/* ═══════════════ CLIENT NOU B2B — API ENDPOINTS ════════════════ */

/* ── Multer: document upload (image/PDF) for Client Nou ── */
const clientNouUploadDir = path.join(uploadDir, "client_nou");
if (!fs.existsSync(clientNouUploadDir)) fs.mkdirSync(clientNouUploadDir, { recursive: true });

const ALLOWED_DOC_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];
const ALLOWED_DOC_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
function docFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_DOC_EXTS.includes(ext)) cb(null, true);
  else cb(new Error("Doar fișiere imagine (JPG, PNG, WEBP) sau PDF sunt permise"), false);
}
const clientNouUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: docFileFilter
});

/* ── Geocode helper (Nominatim) ── */
function nominatimGeocode(query) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=ro`;
    https.get(url, { headers: { "User-Agent": "QMapsAuditBB/1.0" } }, (resp) => {
      let body = "";
      resp.on("data", chunk => body += chunk);
      resp.on("end", () => {
        try {
          const results = JSON.parse(body);
          if (results.length > 0) resolve({ lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) });
          else resolve(null);
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

/* ── List all Client Nou entries ── */
app.get("/api/client-nou", auth, (req, res) => {
  try {
    const user = req.user || {};
    const role = user.role || "";
    let rows;
    if (role === "admin" || role === "spv") {
      rows = db.prepare("SELECT * FROM client_nou ORDER BY created_at DESC").all();
    } else {
      rows = db.prepare("SELECT * FROM client_nou WHERE created_by=? OR agent=? ORDER BY created_at DESC")
        .all(req.username, user.sales_rep || req.username);
    }
    res.json({ ok: true, entries: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Get single Client Nou entry ── */
app.get("/api/client-nou/:id", auth, (req, res) => {
  try {
    const entry = db.prepare("SELECT * FROM client_nou WHERE id=?").get(req.params.id);
    if (!entry) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, entry });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Verificare CUI la ANAF ── */
app.post("/api/client-nou/verifica-anaf", auth, async (req, res) => {
  try {
    let { cui } = req.body;
    if (!cui) return res.status(400).json({ error: "CUI lipsă" });
    cui = String(cui).replace(/\D/g, "");
    if (!cui || cui.length < 2 || cui.length > 10) return res.status(400).json({ error: "CUI invalid" });
    const today = new Date().toISOString().slice(0, 10);
    const https = require("https");
    const postData = JSON.stringify([{ cui: parseInt(cui), data: today }]);
    const anafRes = await new Promise((resolve, reject) => {
      const options = {
        hostname: "webservicesp.anaf.ro",
        path: "/api/PlatitorTvaRest/v9/tva",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
        timeout: 15000
      };
      const r = https.request(options, (resp) => {
        let data = "";
        resp.on("data", c => data += c);
        resp.on("end", () => {
          try { resolve(JSON.parse(data)); } catch(e) { reject(new Error("Răspuns ANAF invalid")); }
        });
      });
      r.on("error", reject);
      r.on("timeout", () => { r.destroy(); reject(new Error("Timeout ANAF")); });
      r.write(postData);
      r.end();
    });
    if (!anafRes.found || anafRes.found.length === 0) {
      if (anafRes.notFound && anafRes.notFound.length > 0) return res.json({ found: false, message: "CUI negăsit în baza ANAF" });
      return res.status(502).json({ error: "ANAF: Răspuns neașteptat" });
    }
    const f = anafRes.found[0];
    const dg = f.date_generale || {};
    const si = f.stare_inactiv || {};
    const tva = f.inregistrare_scop_Tva || {};
    const adr = f.adresa_sediu_social || {};
    const adresaFull = dg.adresa || "";
    const judet = adr.sdenumire_Judet || "";
    const strada = adr.sdenumire_Strada || "";
    const numar = adr.snumar_Strada || "";
    const localitate = adr.sdenumire_Localitate || "";
    const activa = !si.statusInactivi && dg.stare_inregistrare && dg.stare_inregistrare.toUpperCase().includes("INREGISTRAT");
    res.json({
      found: true,
      denumire_societate: dg.denumire || "",
      cui: String(dg.cui || cui),
      orc_nr: dg.nrRegCom || "",
      sediu_social: adresaFull,
      strada, numar, judet, localitate,
      cod_CAEN: dg.cod_CAEN || "",
      telefon: dg.telefon || "",
      iban: dg.iban || "",
      stare_inregistrare: dg.stare_inregistrare || "",
      activa,
      status_inactiv: si.statusInactivi || false,
      platitor_tva: tva.scpTVA || false,
      data_inregistrare: dg.data_inregistrare || "",
      adresa_completa: adresaFull
    });
  } catch(e) {
    console.error("[ANAF] Eroare verificare CUI:", e.message);
    res.status(500).json({ error: "Eroare la verificare ANAF: " + e.message });
  }
});

/* ── Create Client Nou entry ── */
app.post("/api/client-nou", auth, (req, res) => {
  try {
    const d = req.body;
    const user = req.user || {};
    const agentName = user.sales_rep || user.display_name || req.username;
    const result = db.prepare(`INSERT INTO client_nou (
      denumire_societate, sediu_social, strada, numar, judet, orc_nr, cui,
      administrator, cnp, fidejusor_ci_seria, fidejusor_ci_nr, fidejusor_domiciliu,
      telefon, email, iban, banca, adresa_punct_lucru,
      foto_lat, foto_lon, foto_magazin,
      created_by, agent
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      d.denumire_societate || "", d.sediu_social || "", d.strada || "", d.numar || "",
      d.judet || "", d.orc_nr || "", d.cui || "",
      d.administrator || "", d.cnp || "", d.fidejusor_ci_seria || "",
      d.fidejusor_ci_nr || "", d.fidejusor_domiciliu || "",
      d.telefon || "", d.email || "", d.iban || "", d.banca || "",
      d.adresa_punct_lucru || "",
      d.foto_lat || null, d.foto_lon || null, d.foto_magazin || null,
      req.username, agentName
    );
    const created = db.prepare("SELECT * FROM client_nou WHERE id=?").get(result.lastInsertRowid);
    res.json({ ok: true, entry: created });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Update Client Nou entry ── */
app.post("/api/client-nou/update", auth, (req, res) => {
  try {
    const d = req.body;
    if (!d.id) return res.status(400).json({ error: "ID lipsă" });
    db.prepare(`UPDATE client_nou SET
      denumire_societate=?, sediu_social=?, strada=?, numar=?, judet=?, orc_nr=?, cui=?,
      administrator=?, cnp=?, fidejusor_ci_seria=?, fidejusor_ci_nr=?, fidejusor_domiciliu=?,
      telefon=?, email=?, iban=?, banca=?, adresa_punct_lucru=?,
      foto_lat=?, foto_lon=?, foto_magazin=?,
      contract_b2b_complet=?, gdpr_complet=?,
      updated_at=datetime('now')
    WHERE id=?`).run(
      d.denumire_societate || "", d.sediu_social || "", d.strada || "", d.numar || "",
      d.judet || "", d.orc_nr || "", d.cui || "",
      d.administrator || "", d.cnp || "", d.fidejusor_ci_seria || "",
      d.fidejusor_ci_nr || "", d.fidejusor_domiciliu || "",
      d.telefon || "", d.email || "", d.iban || "", d.banca || "",
      d.adresa_punct_lucru || "",
      d.foto_lat || null, d.foto_lon || null, d.foto_magazin || null,
      d.contract_b2b_complet ? 1 : 0, d.gdpr_complet ? 1 : 0,
      d.id
    );
    const updated = db.prepare("SELECT * FROM client_nou WHERE id=?").get(d.id);
    res.json({ ok: true, entry: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Upload foto magazin for Client Nou ── */
app.post("/api/client-nou/upload-foto", auth, clientNouUpload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
    const { client_nou_id, foto_lat, foto_lon } = req.body;
    if (!client_nou_id) return res.status(400).json({ error: "ID client lipsă" });
    const ext = path.extname(req.file.originalname).toLowerCase();
    let buffer = req.file.buffer;
    let finalExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
    // Convert HEIC/non-standard formats to JPG using sharp
    if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
      try {
        buffer = await require("sharp")(req.file.buffer).jpeg({ quality: 85 }).toBuffer();
        finalExt = ".jpg";
      } catch (convErr) {
        console.error("[upload-foto] Conversie imagine eșuată:", convErr.message);
        finalExt = ".jpg";
      }
    }
    const fname = `clientnou_foto_${client_nou_id}_${Date.now()}${finalExt}`;
    const fpath = path.join(clientNouUploadDir, fname);
    fs.writeFileSync(fpath, buffer);
    const photoUrl = `/uploads/client_nou/${fname}`;
    const updates = ["foto_magazin=?", "updated_at=datetime('now')"];
    const vals = [photoUrl];
    if (foto_lat && foto_lon) {
      updates.push("foto_lat=?", "foto_lon=?");
      vals.push(parseFloat(foto_lat), parseFloat(foto_lon));
    }
    vals.push(client_nou_id);
    db.prepare(`UPDATE client_nou SET ${updates.join(",")} WHERE id=?`).run(...vals);
    res.json({ ok: true, photo_url: photoUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Upload document photo (CUI or CI) for Client Nou — no OCR, just store ── */
app.post("/api/client-nou/upload-doc", auth, clientNouUpload.single("document"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fișier lipsă" });
    const { client_nou_id, doc_type } = req.body;
    if (!client_nou_id) return res.status(400).json({ error: "ID client lipsă" });
    if (!["cui", "ci", "buletin"].includes(doc_type)) return res.status(400).json({ error: "Tip document invalid" });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let buffer = req.file.buffer;
    let finalExt = [".jpg",".jpeg",".png",".webp"].includes(ext) ? ext : ".jpg";
    // Convert HEIC/non-standard formats to JPG using sharp
    if (![".jpg",".jpeg",".png",".webp"].includes(ext)) {
      try {
        buffer = await require("sharp")(req.file.buffer).jpeg({ quality: 85 }).toBuffer();
        finalExt = ".jpg";
      } catch (convErr) {
        console.error("[upload-doc] Conversie imagine eșuată:", convErr.message);
        finalExt = ".jpg";
      }
    }
    const fname = `clientnou_${doc_type}_${client_nou_id}_${Date.now()}${finalExt}`;
    const fpath = path.join(clientNouUploadDir, fname);
    fs.writeFileSync(fpath, buffer);
    const fileUrl = `/uploads/client_nou/${fname}`;

    const col = (doc_type === "cui") ? "scan_cui" : "scan_ci";
    db.prepare(`UPDATE client_nou SET ${col}=?, updated_at=datetime('now') WHERE id=?`).run(fileUrl, client_nou_id);

    res.json({ ok: true, path: fileUrl });
  } catch(e) {
    console.error("[Client Nou] Upload error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ── Download Contract B2B DOCX ── */
app.get("/api/client-nou/:id/contract-b2b", auth, async (req, res) => {
  try {
    const entry = db.prepare("SELECT * FROM client_nou WHERE id=?").get(req.params.id);
    if (!entry) return res.status(404).json({ error: "Not found" });
    const buffer = await generateContractB2B(entry);
    db.prepare("UPDATE client_nou SET contract_b2b_complet=1, updated_at=datetime('now') WHERE id=?").run(entry.id);
    const safeName = (entry.denumire_societate || "Client").replace(/[^a-zA-Z0-9 ]/g, "_");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="Contract_B2B_${safeName}.docx"`);
    res.send(buffer);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Download GDPR B2B DOCX ── */
app.get("/api/client-nou/:id/gdpr-b2b", auth, async (req, res) => {
  try {
    const entry = db.prepare("SELECT * FROM client_nou WHERE id=?").get(req.params.id);
    if (!entry) return res.status(404).json({ error: "Not found" });
    const data = {
      ...entry,
      fidejusor_nume: entry.administrator,
      fidejusor_tel: entry.telefon,
      name: entry.administrator
    };
    const buffer = await generateGDPRB2B(data);
    db.prepare("UPDATE client_nou SET gdpr_complet=1, updated_at=datetime('now') WHERE id=?").run(entry.id);
    const safeName = (entry.denumire_societate || "Client").replace(/[^a-zA-Z0-9 ]/g, "_");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="GDPR_B2B_${safeName}.docx"`);
    res.send(buffer);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Finalize Client Nou: validate, geocode, notify, email ── */
app.post("/api/client-nou/finalize", auth, async (req, res) => {
  try {
    const { id } = req.body;
    const entry = db.prepare("SELECT * FROM client_nou WHERE id=?").get(id);
    if (!entry) return res.status(404).json({ error: "Not found" });

    // Validation
    const errors = [];
    if (!entry.denumire_societate) errors.push("Denumire societate lipsă");
    if (!entry.cui) errors.push("CUI lipsă");
    if (!entry.administrator) errors.push("Administrator lipsă");
    if (!entry.scan_cui) errors.push("Copie CUI nescanată");
    if (!entry.scan_ci) errors.push("Copie CI nescanată");
    if (errors.length > 0) return res.json({ ok: false, errors });

    // Geocode: prefer foto GPS, fallback to address
    let lat = null, lon = null, geoSource = "";
    if (entry.foto_lat && entry.foto_lon) {
      lat = parseFloat(entry.foto_lat);
      lon = parseFloat(entry.foto_lon);
      geoSource = "foto GPS";
    }
    if (!lat && entry.adresa_punct_lucru) {
      const query = `${entry.adresa_punct_lucru}, ${entry.judet || ""}, Romania`;
      const geo = await nominatimGeocode(query);
      if (geo) { lat = geo.lat; lon = geo.lon; geoSource = "geocodare adresă"; }
    }
    if (!lat && entry.sediu_social) {
      const geo = await nominatimGeocode(`${entry.sediu_social}, ${entry.judet || ""}, Romania`);
      if (geo) { lat = geo.lat; lon = geo.lon; geoSource = "geocodare sediu"; }
    }

    // Update status
    db.prepare(`UPDATE client_nou SET status='finalizat', lat=?, lon=?, notificare_trimisa=1, updated_at=datetime('now') WHERE id=?`)
      .run(lat, lon, id);

    // Notify SPV + admin users
    const agentName = (req.user || {}).display_name || (req.user || {}).sales_rep || req.username;
    const notifTitle = `🆕 Client Nou: ${entry.denumire_societate}`;
    const notifMsg = `Agentul ${agentName} a adăugat client nou: ${entry.denumire_societate} (CUI: ${entry.cui}). Tel: ${entry.telefon || "N/A"}. ${lat ? `Localizat via ${geoSource}.` : "Fără coordonate GPS."}`;
    notifyRole("admin", notifTitle, notifMsg, "client_nou", "client_nou");
    notifyRole("spv", notifTitle, notifMsg, "client_nou", "client_nou");

    // Send email async (don't block response)
    sendClientNouEmail(entry, agentName).then(() => {
      db.prepare("UPDATE client_nou SET email_trimis=1, updated_at=datetime('now') WHERE id=?").run(id);
      console.log(`[Client Nou] #${id} email sent`);
    }).catch(emailErr => {
      console.error(`[Client Nou] #${id} email FAILED:`, emailErr.message);
    });

    const geoMsg = lat ? `Localizat pe hartă via ${geoSource} (${lat.toFixed(4)}, ${lon.toFixed(4)}).` : "Nu s-a putut localiza pe hartă.";
    res.json({ ok: true, message: `Client Nou finalizat! ${geoMsg} Notificare trimisă SPV + admin.` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Email sending for Client Nou ── */
async function sendClientNouEmail(entry, agentName) {
  // Use same SMTP config as emailReports
  const smtpHost = process.env.REPORT_SMTP_HOST || "mail.quatrogrup.com";
  const smtpPort = parseInt(process.env.REPORT_SMTP_PORT || "465", 10);
  const smtpUser = process.env.REPORT_SMTP_USER || "";
  const smtpPass = process.env.REPORT_SMTP_PASS || "";
  const emailFrom = process.env.REPORT_EMAIL_FROM || smtpUser;

  if (!smtpHost || !smtpUser) {
    console.log("[Client Nou] Email skip: SMTP not configured");
    return;
  }

  const nodemailerLib = require("nodemailer");
  const transport = nodemailerLib.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
    tls: { rejectUnauthorized: false }
  });

  const safeName = (entry.denumire_societate || "Client").replace(/[^a-zA-Z0-9 ]/g, "_");
  const attachments = [];

  // Generate Contract B2B
  try {
    const contractBuf = await generateContractB2B(entry);
    attachments.push({ filename: `Contract_B2B_${safeName}.docx`, content: contractBuf });
  } catch(e) { console.log("[Client Nou] Contract B2B gen error:", e.message); }

  // Generate GDPR B2B
  try {
    const gdprData = { ...entry, fidejusor_nume: entry.administrator, fidejusor_tel: entry.telefon, name: entry.administrator };
    const gdprBuf = await generateGDPRB2B(gdprData);
    attachments.push({ filename: `GDPR_B2B_${safeName}.docx`, content: gdprBuf });
  } catch(e) { console.log("[Client Nou] GDPR gen error:", e.message); }

  // Attach scanned documents
  for (const { col, label } of [
    { col: "scan_cui", label: "Copie_CUI" },
    { col: "scan_ci", label: "Copie_CI" }
  ]) {
    if (entry[col]) {
      const fileName = path.basename(entry[col]);
      const filePath = path.join(clientNouUploadDir, fileName);
      if (fs.existsSync(filePath)) {
        attachments.push({ filename: `${label}_${safeName}${path.extname(filePath)}`, path: filePath });
      }
    }
  }

  // Determine recipients: SPV + admin emails
  const recipients = [];
  try {
    const admins = db.prepare("SELECT username FROM users WHERE role IN ('admin','spv') AND active=1").all();
    // Use default BB recipients
    const defaultTo = (process.env.REPORT_EMAIL_TO || "raportzilnic@quatrogrup.com,ibrian@quatrogrup.com").split(",").map(s => s.trim()).filter(Boolean);
    recipients.push(...defaultTo);
  } catch(e) {}
  if (recipients.length === 0) recipients.push("ibrian@quatrogrup.com");

  const today = new Date();
  const dateStr = `${today.getDate().toString().padStart(2, "0")}.${(today.getMonth() + 1).toString().padStart(2, "0")}.${today.getFullYear()}`;

  const html = `
    <h2>Client Nou B2B — ${entry.denumire_societate}</h2>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
      <tr><td style="background:#f0f0f0"><b>Denumire Societate</b></td><td>${entry.denumire_societate || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>CUI</b></td><td>${entry.cui || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>Nr. ORC</b></td><td>${entry.orc_nr || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>Sediu Social</b></td><td>${entry.sediu_social || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>Județ</b></td><td>${entry.judet || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>Administrator</b></td><td>${entry.administrator || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>CNP</b></td><td>${entry.cnp || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>Telefon</b></td><td>${entry.telefon || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>Email</b></td><td>${entry.email || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>IBAN</b></td><td>${entry.iban || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>Bancă</b></td><td>${entry.banca || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>Adresa Punct Lucru</b></td><td>${entry.adresa_punct_lucru || "-"}</td></tr>
      <tr><td style="background:#f0f0f0"><b>Agent</b></td><td>${agentName}</td></tr>
      <tr><td style="background:#f0f0f0"><b>Data</b></td><td>${dateStr}</td></tr>
    </table>
    <p><b>Atașamente:</b> ${attachments.map(a => a.filename).join(", ")}</p>
    <p style="color:#666;font-size:12px"><i>Email generat automat de QMaps Audit Ursus</i></p>
  `;

  await transport.sendMail({
    from: `"QMaps Audit Ursus" <${emailFrom}>`,
    to: recipients.join(", "),
    subject: `Client Nou B2B: ${entry.denumire_societate} — ${agentName} — ${dateStr}`,
    html,
    attachments
  });

  return { to: recipients.join(", "), attachments: attachments.map(a => a.filename) };
}

/* ── Delete Client Nou (draft only) ── */
app.post("/api/client-nou/delete", auth, (req, res) => {
  try {
    const { id } = req.body;
    const entry = db.prepare("SELECT * FROM client_nou WHERE id=?").get(id);
    if (!entry) return res.status(404).json({ error: "Not found" });
    if (entry.status === "finalizat") return res.status(400).json({ error: "Nu se poate șterge un client finalizat" });
    db.prepare("DELETE FROM client_nou WHERE id=?").run(id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Global multer error handler ── */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Fișierul este prea mare" });
    return res.status(400).json({ error: `Eroare upload: ${err.message}` });
  }
  if (err && err.message && err.message.includes("sunt permise")) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

/* ── Start ── */
function startServer() {
  if (SELF_HOSTED && SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
    const sslOptions = {
      cert: fs.readFileSync(SSL_CERT),
      key: fs.readFileSync(SSL_KEY)
    };
    https.createServer(sslOptions, app).listen(HTTPS_PORT, () => {
      console.log(`🔒 QMaps Audit Ursus HTTPS on port ${HTTPS_PORT}`);
    });
    // HTTP redirect to HTTPS
    http.createServer((req, res) => {
      res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
      res.end();
    }).listen(PORT, () => {
      console.log(`↪ HTTP redirect on port ${PORT} → HTTPS ${HTTPS_PORT}`);
    });
  } else {
    const srv = app.listen(PORT, () => {
      console.log(`QMaps Audit Ursus running on port ${PORT}`);
    });
    srv.timeout = 180000; /* 3 min for large file uploads */
  }
  emailReports.startScheduler(db, getProductsForClient);
}
startServer();
