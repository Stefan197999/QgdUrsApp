/**
 * DOCX Template Generator for QMaps Audit BB
 * Uses docxtemplater for ALL templates (contract mandat, GDPR, B2B contract, B2B GDPR).
 * Templates with underscore/dot placeholders are converted to {tags} at runtime.
 */
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const TEMPLATE_DIR = path.join(__dirname, "templates");

/* ═══════════════════════════════════════════════════
   XML helpers — entity encode/decode for needle matching
   ═══════════════════════════════════════════════════ */

function unescapeXml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ═══════════════════════════════════════════════════
   Phase 1 — Replace placeholder text → {tag} in OOXML
   Handles text split across multiple <w:r> runs.
   ═══════════════════════════════════════════════════ */

function replaceAcrossRuns(xml, needle, replacement) {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (para) => {
    const textMatches = [];
    const re = /<w:t([^>]*)>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(para)) !== null) {
      textMatches.push({ index: m.index, length: m[0].length, attrs: m[1], text: m[2] });
    }
    if (textMatches.length === 0) return para;

    // Unescape XML entities for matching
    const rawXmlText = textMatches.map((t) => t.text).join("");
    const plainText = unescapeXml(rawXmlText);
    if (!plainText.includes(needle)) return para;

    // Do replacement on plain text, then re-escape
    const newPlainText = plainText.replace(needle, replacement);
    const newXmlText = escapeXml(newPlainText);

    // Put ALL text into the first <w:t> node, empty out the rest
    let result = para;
    for (let i = textMatches.length - 1; i >= 0; i--) {
      const t = textMatches[i];
      if (i === 0) {
        result =
          result.slice(0, t.index) +
          `<w:t xml:space="preserve">${newXmlText}</w:t>` +
          result.slice(t.index + t.length);
      } else {
        result =
          result.slice(0, t.index) +
          `<w:t xml:space="preserve"></w:t>` +
          result.slice(t.index + t.length);
      }
    }
    return result;
  });
}

/* ═══════════════════════════════════════════════════
   Convert a DOCX template: underscore/dot placeholders → {tag}
   Returns a PizZip-compatible binary string
   ═══════════════════════════════════════════════════ */

function convertTemplate(templatePath, placeholderMap) {
  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);

  let xml = zip.file("word/document.xml").asText();

  for (const { needle, tag } of placeholderMap) {
    xml = replaceAcrossRuns(xml, needle, tag);
  }

  zip.file("word/document.xml", xml);
  return zip.generate({ type: "string", compression: "DEFLATE" });
}

// Cache converted templates
const _templateCache = {};

function getCachedTemplate(key, templatePath, placeholderMap) {
  if (_templateCache[key]) return _templateCache[key];
  _templateCache[key] = convertTemplate(templatePath, placeholderMap);
  return _templateCache[key];
}

/* ═══════════════════════════════════════════════════
   Phase 2 — Fill {tags} with docxtemplater
   ═══════════════════════════════════════════════════ */

function renderFromBinary(templateBin, data, blankValue) {
  const zip = new PizZip(templateBin);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => blankValue || "_______________",
  });
  doc.render(data);
  return doc.getZip().generate({ type: "nodebuffer" });
}

/* ═══════════════════════════════════════════════════
   Contract Mandat SIS (dots template)
   ═══════════════════════════════════════════════════ */

async function generateContract(data) {
  const templatePath = path.join(TEMPLATE_DIR, "contract_template.docx");
  if (!fs.existsSync(templatePath)) throw new Error("Template contract negăsit");

  const today = new Date();
  const dateStr =
    data.contract_date ||
    `${today.getDate().toString().padStart(2, "0")}.${(today.getMonth() + 1).toString().padStart(2, "0")}.${today.getFullYear()}`;

  const placeholders = [
    { needle: "………………………… / …………………………", tag: "{ct_number} / {ct_date}" },
    { needle: "Societatea ……………………………………………………,", tag: "Societatea {ct_company}," },
    { needle: "în ……………………………………………………, Jud.", tag: "în {ct_address}, Jud." },
    { needle: "nr. …………………………, având", tag: "nr. {ct_orc}, având" },
    { needle: "CUI …………………………, reprezentată", tag: "CUI {ct_cui}, reprezentată" },
    { needle: "administrator …………………………, în calitate", tag: "administrator {ct_admin}, în calitate" },
    { needle: "Dl./Dna …………………………, cu", tag: "Dl./Dna {ct_guarantor}, cu" },
    { needle: "în ……………………………………………………, posesor", tag: "în {ct_guarantor_addr}, posesor" },
    { needle: "Seria ...... nr. …………………………, tel.", tag: "Seria {ct_id_series} nr. {ct_id_number}, tel." },
    { needle: "tel. …………………………, în calitate", tag: "tel. {ct_phone}, în calitate" },
  ];

  const templateBin = getCachedTemplate("contract_mandat", templatePath, placeholders);

  return renderFromBinary(templateBin, {
    ct_number: data.contract_number || "______",
    ct_date: dateStr,
    ct_company: data.company_name || "______",
    ct_address: data.address || "______",
    ct_orc: data.orc_number || "______",
    ct_cui: data.cui || "______",
    ct_admin: data.administrator || "______",
    ct_guarantor: data.guarantor || "______",
    ct_guarantor_addr: data.guarantor_address || data.address || "______",
    ct_id_series: data.id_series || "__",
    ct_id_number: data.id_number || "______",
    ct_phone: data.phone || "______",
  });
}

/* ═══════════════════════════════════════════════════
   GDPR Accord (bracket/underscore template)
   ═══════════════════════════════════════════════════ */

async function generateGDPR(data) {
  const templatePath = path.join(TEMPLATE_DIR, "gdpr_template.docx");
  if (!fs.existsSync(templatePath)) throw new Error("Template GDPR negăsit");

  const today = new Date();
  const day = today.getDate().toString().padStart(2, "0");
  const month = (today.getMonth() + 1).toString().padStart(2, "0");
  const year = today.getFullYear();

  const placeholders = [
    { needle: "Nr. înreg.: _______ / Data: ____ / ____ / ________", tag: "Nr. înreg.: _______ / Data: {gdpr_data}" },
    { needle: "Nume & prenume: [_____]", tag: "Nume & prenume: {gdpr_name}" },
    { needle: "Telefon: [_____]", tag: "Telefon: {gdpr_phone}" },
    { needle: "E-mail: [_____]", tag: "E-mail: {gdpr_email}" },
    { needle: "Serie și nr. CI/BI (după caz): [_____]", tag: "Serie și nr. CI/BI (după caz): {gdpr_ci}" },
    { needle: "Nume & prenume: ____________________", tag: "Nume & prenume: {gdpr_name}" },
    { needle: "Data: ____ / ____ / ______", tag: "Data: {gdpr_data}" },
  ];

  const templateBin = getCachedTemplate("gdpr_accord", templatePath, placeholders);

  const name = data.name || "______";
  const ciStr = ((data.id_series || "") + " " + (data.id_number || "")).trim() || "______";

  return renderFromBinary(
    templateBin,
    {
      gdpr_data: `${day} / ${month} / ${year}`,
      gdpr_name: name,
      gdpr_phone: data.phone || "______",
      gdpr_email: data.email || "______",
      gdpr_ci: ciStr,
    },
    "______"
  );
}

/* ═══════════════════════════════════════════════════
   Contract B2B (underscore template)
   ═══════════════════════════════════════════════════ */

async function generateContractB2B(data) {
  const templatePath = path.join(TEMPLATE_DIR, "contract_b2b_template.docx");
  if (!fs.existsSync(templatePath)) throw new Error("Template contract B2B negăsit");

  const today = new Date();
  const day = today.getDate().toString().padStart(2, "0");
  const month = (today.getMonth() + 1).toString().padStart(2, "0");
  const year = today.getFullYear();

  const placeholders = [
    { needle: "Nr. _____ din ___/___/2025", tag: "Nr. _____ din {b2b_data}" },
    { needle: "și SC _________________________________, sed.", tag: "și SC {b2b_denumire}, sed." },
    { needle: "sed. în _________________, Str.", tag: "sed. în {b2b_sediu}, Str." },
    { needle: "Str. _________________ Nr.", tag: "Str. {b2b_strada} Nr." },
    { needle: "Nr. ____, jud.", tag: "Nr. {b2b_numar}, jud." },
    { needle: "jud. _____________, pct.", tag: "jud. {b2b_judet}, pct." },
    { needle: "pct. lucru _________________________________, J", tag: "pct. lucru {b2b_punct_lucru}, J" },
    { needle: "J___/___/________, CUI", tag: "{b2b_orc}, CUI" },
    { needle: "CUI _________________, cont", tag: "CUI {b2b_cui}, cont" },
    { needle: "cont _________________________________ – Banca", tag: "cont {b2b_iban} – Banca" },
    { needle: "Banca _________________, repr.", tag: "Banca {b2b_banca}, repr." },
    { needle: "repr. prin _________________________________ –", tag: "repr. prin {b2b_administrator} –" },
    { needle: "funcția _________________, în calitate", tag: "funcția {b2b_functia}, în calitate" },
    { needle: "astăzi ___/___/2025", tag: "astăzi {b2b_data}" },
    { needle: "SC _________________________________", tag: "SC {b2b_denumire}" },
    { needle: "Adm.: _________________________", tag: "Adm.: {b2b_administrator}" },
    { needle: "Numele _________________________ CNP", tag: "Numele {b2b_fidejusor} CNP" },
    { needle: "CNP _________________________ Semnătura", tag: "CNP {b2b_cnp} Semnătura" },
  ];

  const blank = "_______________";
  const templateBin = getCachedTemplate("contract_b2b", templatePath, placeholders);

  return renderFromBinary(templateBin, {
    b2b_data: `${day}/${month}/${year}`,
    b2b_denumire: data.denumire_societate || blank,
    b2b_sediu: data.sediu_social || blank,
    b2b_strada: data.strada || blank,
    b2b_numar: data.numar || "____",
    b2b_judet: data.judet || blank,
    b2b_punct_lucru: data.adresa_punct_lucru || data.sediu_social || blank,
    b2b_orc: data.orc_nr || "J___/___/________",
    b2b_cui: data.cui || blank,
    b2b_iban: data.iban || blank,
    b2b_banca: data.banca || blank,
    b2b_administrator: data.administrator || blank,
    b2b_functia: data.administrator_functia || "Administrator",
    b2b_fidejusor: data.fidejusor_nume || data.administrator || blank,
    b2b_cnp: data.cnp || blank,
  });
}

/* ═══════════════════════════════════════════════════
   GDPR B2B (bracket/underscore template)
   ═══════════════════════════════════════════════════ */

async function generateGDPRB2B(data) {
  const templatePath = path.join(TEMPLATE_DIR, "gdpr_b2b_template.docx");
  if (!fs.existsSync(templatePath)) throw new Error("Template GDPR B2B negăsit");

  const today = new Date();
  const day = today.getDate().toString().padStart(2, "0");
  const month = (today.getMonth() + 1).toString().padStart(2, "0");
  const year = today.getFullYear();

  const placeholders = [
    { needle: "Nr. înreg.: _______ / Data: ____ / ____ / ________", tag: "Nr. înreg.: _______ / Data: {gdpr_data}" },
    { needle: "Nume & prenume: [_____]", tag: "Nume & prenume: {gdpr_name}" },
    { needle: "Telefon: [_____]", tag: "Telefon: {gdpr_phone}" },
    { needle: "E-mail: [_____]", tag: "E-mail: {gdpr_email}" },
    { needle: "Serie și nr. CI/BI (după caz): [_____]", tag: "Serie și nr. CI/BI (după caz): {gdpr_ci}" },
    { needle: "Nume & prenume: ____________________", tag: "Nume & prenume: {gdpr_name}" },
    { needle: "Data: ____ / ____ / ______", tag: "Data: {gdpr_data}" },
  ];

  const templateBin = getCachedTemplate("gdpr_b2b", templatePath, placeholders);

  const name = data.fidejusor_nume || data.administrator || "______";
  const phone = data.fidejusor_tel || "______";
  const email = data.email || "______";
  const ciStr = ((data.fidejusor_ci_seria || "") + " " + (data.fidejusor_ci_nr || "")).trim() || "______";

  return renderFromBinary(
    templateBin,
    {
      gdpr_data: `${day} / ${month} / ${year}`,
      gdpr_name: name,
      gdpr_phone: phone,
      gdpr_email: email,
      gdpr_ci: ciStr,
    },
    "______"
  );
}

/* ═══════════════════════════════════════════════════
   CONTRACT B2C (Vânzare-Cumpărare Persoană Fizică Evenimente)
   ═══════════════════════════════════════════════════ */

async function generateContractB2C(data) {
  const templatePath = path.join(TEMPLATE_DIR, "contract_b2c_template.docx");
  if (!fs.existsSync(templatePath)) throw new Error("Template contract B2C negăsit");

  const today = new Date();
  const day = today.getDate().toString().padStart(2, "0");
  const month = (today.getMonth() + 1).toString().padStart(2, "0");
  const year = today.getFullYear();

  const placeholders = [
    { needle: "Nr. _____ din ___/___/2025", tag: "Nr. {b2c_nr} din {b2c_data}" },
    { needle: "Dl./Dna. _________________________________", tag: "Dl./Dna. {b2c_nume}" },
    { needle: "domiciliat(ă) în _________________", tag: "domiciliat(ă) în {b2c_localitate}" },
    { needle: "Str. _________________ Nr. ____", tag: "Str. {b2c_strada} Nr. {b2c_nr_strada}" },
    { needle: "Bl. ____, Sc. ____, Ap. ____", tag: "Bl. {b2c_bloc}, Sc. {b2c_scara}, Ap. {b2c_apartament}" },
    { needle: "jud./sect. _____________", tag: "jud./sect. {b2c_judet}" },
    { needle: "C.I. seria ____ nr. __________", tag: "C.I. seria {b2c_ci_seria} nr. {b2c_ci_nr}" },
    { needle: "eliberat(ă) de _________________ la data ___/___/________", tag: "eliberat(ă) de {b2c_ci_emitent} la data {b2c_ci_data}" },
    { needle: "CNP _________________________________", tag: "CNP {b2c_cnp}" },
    { needle: "tel. _________________", tag: "tel. {b2c_telefon}" },
    { needle: "e-mail _________________________________", tag: "e-mail {b2c_email}" },
    { needle: "evenimentului: _________________________________", tag: "evenimentului: {b2c_eveniment}" },
    { needle: "din data de ___/___/_____", tag: "din data de {b2c_data_eveniment}" },
    { needle: "de __________ RON", tag: "de {b2c_pret} RON" },
    { needle: "Cumpărătorului: _________________________________", tag: "Cumpărătorului: {b2c_adresa_livrare}" },
    { needle: "de către _________________________", tag: "de către {b2c_transport}" },
    { needle: "Data livrării/ridicării: ___/___/_____", tag: "Data livrării/ridicării: {b2c_data_livrare}" },
    { needle: "interval orar: _____–_____", tag: "interval orar: {b2c_interval_orar}" },
    { needle: "IBAN _________________________________", tag: "IBAN {b2c_iban}" },
    { needle: "Contact DPO/responsabil: _________________________________", tag: "Contact DPO/responsabil: popa.stefan@quatrogrup.com" },
    { needle: "astăzi ___/___/____", tag: "astăzi {b2c_data}" },
    { needle: "Dl./Dna. _________________________", tag: "Dl./Dna. {b2c_nume}" },
  ];

  const blank = "_______________";
  const templateBin = getCachedTemplate("contract_b2c", templatePath, placeholders);

  const dateStr = `${day}/${month}/${year}`;

  return renderFromBinary(templateBin, {
    b2c_nr: data.id ? data.id.toString() : "____",
    b2c_data: dateStr,
    b2c_nume: data.nume_complet || blank,
    b2c_localitate: data.localitate || blank,
    b2c_strada: data.strada || blank,
    b2c_nr_strada: data.nr_strada || "____",
    b2c_bloc: data.bloc || "____",
    b2c_scara: data.scara || "____",
    b2c_apartament: data.apartament || "____",
    b2c_judet: data.judet || blank,
    b2c_ci_seria: data.ci_seria || "____",
    b2c_ci_nr: data.ci_nr || "________",
    b2c_ci_emitent: data.ci_emitent || blank,
    b2c_ci_data: data.ci_data || "___/___/________",
    b2c_cnp: data.cnp || blank,
    b2c_telefon: data.telefon || blank,
    b2c_email: data.email || blank,
    b2c_eveniment: data.tip_eveniment || blank,
    b2c_data_eveniment: data.data_eveniment || "___/___/_____",
    b2c_pret: data.pret_total || "__________",
    b2c_adresa_livrare: data.adresa_livrare || blank,
    b2c_transport: data.suporta_transport || "Cumpărător",
    b2c_data_livrare: data.data_livrare || "___/___/_____",
    b2c_interval_orar: data.interval_orar || "_____–_____",
    b2c_iban: data.iban_retur || blank,
  });
}

/* ═══════════════════════════════════════════════════
   GDPR B2C (Acord GDPR Persoană Fizică Evenimente)
   ═══════════════════════════════════════════════════ */

async function generateGDPRB2C(data) {
  /* Reuse same GDPR B2B template — same structure,
     just fill with B2C person data */
  const templatePath = path.join(TEMPLATE_DIR, "gdpr_b2b_template.docx");
  if (!fs.existsSync(templatePath)) throw new Error("Template GDPR B2C negăsit");

  const today = new Date();
  const day = today.getDate().toString().padStart(2, "0");
  const month = (today.getMonth() + 1).toString().padStart(2, "0");
  const year = today.getFullYear();

  const placeholders = [
    { needle: "Nr. înreg.: _______ / Data: ____ / ____ / ________", tag: "Nr. înreg.: _______ / Data: {gdpr_data}" },
    { needle: "Nume & prenume: [_____]", tag: "Nume & prenume: {gdpr_name}" },
    { needle: "Telefon: [_____]", tag: "Telefon: {gdpr_phone}" },
    { needle: "E-mail: [_____]", tag: "E-mail: {gdpr_email}" },
    { needle: "Serie și nr. CI/BI (după caz): [_____]", tag: "Serie și nr. CI/BI (după caz): {gdpr_ci}" },
    { needle: "Nume & prenume: ____________________", tag: "Nume & prenume: {gdpr_name}" },
    { needle: "Data: ____ / ____ / ______", tag: "Data: {gdpr_data}" },
  ];

  const templateBin = getCachedTemplate("gdpr_b2c", templatePath, placeholders);

  const name = data.nume_complet || "______";
  const phone = data.telefon || "______";
  const email = data.email || "______";
  const ciStr = ((data.ci_seria || "") + " " + (data.ci_nr || "")).trim() || "______";

  return renderFromBinary(
    templateBin,
    {
      gdpr_data: `${day} / ${month} / ${year}`,
      gdpr_name: name,
      gdpr_phone: phone,
      gdpr_email: email,
      gdpr_ci: ciStr,
    },
    "______"
  );
}

/* ═══════════════════════════════════════════════════
   Exports — backward-compatible fillDocxTemplate kept for any other use
   ═══════════════════════════════════════════════════ */

async function fillDocxTemplate(templateBuffer, replacements) {
  // Legacy helper — kept for backward compat but no longer used internally
  const content = templateBuffer.toString("binary");
  const zip = new PizZip(content);
  let xml = zip.file("word/document.xml").asText();

  for (const { find, replace } of replacements) {
    xml = replaceAcrossRuns(xml, find, replace);
  }

  zip.file("word/document.xml", xml);
  return zip.generate({ type: "nodebuffer" });
}

module.exports = { generateContract, generateGDPR, generateContractB2B, generateGDPRB2B, generateContractB2C, generateGDPRB2C, fillDocxTemplate };
